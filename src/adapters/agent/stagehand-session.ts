import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import OpenAI from 'openai';

import { CustomOpenAIClient, Stagehand } from '@browserbasehq/stagehand';
import { chromium, devices as playwrightDevices, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { ensureBinary as cloakEnsureBinary, getDefaultStealthArgs as cloakDefaultStealthArgs, binaryInfo as cloakBinaryInfo } from 'cloakbrowser';
import { humanMove as cloakHumanMove, humanClick as cloakHumanClick, humanType as cloakHumanType, resolveConfig as cloakResolveHumanConfig, type HumanConfig as CloakHumanConfig } from 'cloakbrowser/human';

import {
  ActionLog,
  type ActionLogEntry,
  type PageDiagnostic,
  type Viewport,
} from '../../domain/action-log.js';
import {
  ElementNotFoundError,
  RecordingError,
  SessionStartError,
} from '../../domain/errors.js';
import type {
  DeviceKind,
  IPageSession,
  ObservedElement,
  PageSessionConfig,
  ScrollEasing,
  SessionArtifacts,
} from '../../ports/page-session.js';
import { ARIA_SNAPSHOT_TRUNCATION_MARKER } from '../../ports/page-session.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';

/**
 * StagehandPageSession — IPageSession backed by Playwright (browser + recording)
 * + Stagehand v3 (AI-driven `act` / `observe`) connected via CDP.
 *
 * See `docs/decisions.md` §0006 for why this hybrid layout is necessary:
 * Stagehand v3 cannot configure `recordVideo` itself, so Playwright owns the
 * browser and recording. Stagehand attaches via Chrome's `--remote-debugging-port`
 * CDP endpoint and is passed our Playwright `Page` on every call.
 *
 * Resource ownership (cleanup order at stop):
 *   1. stagehand.close()    — detach the AI handler
 *   2. context.close()      — finalize the .webm file (this also kills the
 *                              persistent-context Chromium process)
 *   3. rm(userDataDir)      — remove the temp profile directory
 *
 * If start() throws partway through, partial resources are cleaned up before
 * the error propagates.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pure aria-tree + candidate-ranking helpers — extracted to a sibling file so
// they can be reused by a future agent-SDK-swap adapter (CLAUDE.md hard rule 1).
import { rankCandidates, pruneAriaSnapshot, type RankableCandidate } from './aria-helpers.js';

export interface StagehandPageSessionConfig extends PageSessionConfig {
  /** Stagehand verbose level (0|1|2). 1 prints high-level steps. */
  verbose?: 0 | 1 | 2;
}

/**
 * How long to wait for Chromium to write its `DevToolsActivePort` file
 * after launchPersistentContext resolves. Normally appears within ~50ms.
 */
const DEVTOOLS_PORT_FILE_TIMEOUT_MS = 5000;
const DEVTOOLS_PORT_FILE_POLL_MS = 50;

/**
 * Map each {@link DeviceKind} to a Playwright `devices[…]` preset name. The
 * preset is spread into `launchPersistentContext` so UA / isMobile / hasTouch /
 * deviceScaleFactor / viewport all come from Playwright's auto-maintained
 * table (no hand-pasted UA strings to age out — goals.md #6 / no-hardcoded-logic
 * memory). Sites that serve different HTML/CSS for mobile actually see a real
 * mobile UA + touch + the right viewport; desktop stays at the request's
 * viewport (the preset's viewport is overridden by the caller for desktop).
 *
 * Why these specific presets: chromium-native (so the engine matches the UA
 * — no Blink-rendering-while-claiming-WebKit weirdness). iPhone/iPad presets
 * are WebKit-native so we use Pixel 7 / Galaxy Tab S9 instead.
 */
const DEVICE_PRESET_NAME: Record<DeviceKind, string> = {
  desktop: 'Desktop Chrome',
  mobile: 'Pixel 7',
  tablet: 'Galaxy Tab S9',
};

/**
 * Playwright's default Chromium args include two flags that defeat
 * cloakbrowser's stealth: `--enable-automation` (sets navigator.webdriver
 * back to true through the CDP-side runtime, even though cloakbrowser
 * patches the C++ side) and `--enable-unsafe-swiftshader` (a tell for GPU
 * fingerprinters). cloakbrowser exports an `IGNORE_DEFAULT_ARGS` list with
 * exactly these two strings (verified in v0.3.28 / `dist/config.js`) but
 * doesn't re-export from the package root. We inline them here — short
 * enough that copy-paste maintenance is cheaper than deep-importing private
 * paths, and the constants are intrinsic Chrome flag names, not their
 * choice. Re-sync if cloakbrowser's list changes.
 */
const CLOAK_IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];

/**
 * Browser-side runtime helpers, injected via `context.addInitScript`.
 *
 * IMPORTANT: this is a plain-JS *string*, not transpiled by tsx/esbuild.
 * Do not refactor it into a TypeScript function passed to `page.evaluate` —
 * esbuild will hoist `__name` / `keepNames` helpers that don't exist in the
 * browser's global scope, causing runtime ReferenceErrors.
 *
 * Add new helpers here when you need browser-side logic; the rest of the
 * adapter calls them via tiny `window.__webRecorder.*` invocations.
 */
const RUNTIME_HELPERS_SCRIPT = `
(function () {
  if (window.__webRecorder) return;
  var ns = window.__webRecorder = {};

  ns.scrollY = function () {
    return Math.round(window.scrollY);
  };

  // Easing curves available to smoothScrollTo. Each maps t∈[0,1] → e∈[0,1].
  //
  // - inOutQuad : symmetric S-curve. Gentle accel + gentle decel. Good for
  //               "reading scrolls" where the viewer is moving through
  //               content at a steady pace.
  // - outQuart  : front-loaded — fast initial velocity, sustained then
  //               eased out. Feels like tracking a moving target. Good
  //               for "approach to a known position" phases.
  // - outExpo   : aggressively front-loaded — almost instant initial
  //               motion, dramatic deceleration. Feels like a "fling".
  //               Use for the first phase of a long two-stage scroll.
  ns.scrollEasings = {
    inOutQuad: function (t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; },
    outQuart:  function (t) { return 1 - Math.pow(1 - t, 4); },
    outExpo:   function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    linear:    function (t) { return t; },
  };

  ns.smoothScrollTo = function (deltaY, durationMs, easingName) {
    return new Promise(function (resolve) {
      var ease = ns.scrollEasings[easingName] || ns.scrollEasings.inOutQuad;
      var startY = window.scrollY;
      var targetY = Math.max(0, startY + deltaY);
      var t0 = performance.now();
      function step(now) {
        var t = Math.min((now - t0) / durationMs, 1);
        var eased = ease(t);
        window.scrollTo(0, startY + (targetY - startY) * eased);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  };

  // Resolve when the DOM has been quiet for quietMs (no mutations) OR maxMs
  // has been reached. Returns { waitedMs, timedOut }.
  // A MutationObserver on documentElement subtree resets a "quiet timer" on
  // every mutation. The first time the quiet timer fires, we resolve. A
  // separate hard deadline guarantees bounded wait.
  ns.waitVisuallyStable = function (quietMs, maxMs) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      var done = false;
      var quietTimer = null;
      var deadlineTimer = null;
      var observer = new MutationObserver(function () {
        if (done) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finishQuiet, quietMs);
      });
      function finishQuiet() {
        if (done) return;
        done = true;
        observer.disconnect();
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve({ waitedMs: Math.round(performance.now() - t0), timedOut: false });
      }
      function finishDeadline() {
        if (done) return;
        done = true;
        observer.disconnect();
        if (quietTimer) clearTimeout(quietTimer);
        resolve({ waitedMs: Math.round(performance.now() - t0), timedOut: true });
      }
      observer.observe(document.documentElement, {
        attributes: true, childList: true, subtree: true, characterData: true
      });
      quietTimer = setTimeout(finishQuiet, quietMs);
      deadlineTimer = setTimeout(finishDeadline, maxMs);
    });
  };
})();
`;

export class StagehandPageSession implements IPageSession {
  private readonly cfg: Required<StagehandPageSessionConfig>;
  private readonly logger = rootLogger.child({ component: 'StagehandPageSession' });

  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private stagehand: Stagehand | null = null;
  private userDataDir: string | null = null;

  private startedAtMs = 0;
  private startedAtIso = '';
  private entries: ActionLogEntry[] = [];
  private cachedArtifacts: SessionArtifacts | null = null;

  /**
   * Session-relative ms when `beginRecording()` was first called.
   * Null until the user marks it.
   */
  private recordingStartedAtMs: number | null = null;

  /**
   * Running mouse position — only meaningful when `humanizeStrategy === 'cloakbrowser'`
   * (their `humanMove` needs the start point to draw a Bezier path). Initialized
   * to viewport center on first use. Each `humanMove(...endX, endY)` updates it.
   */
  private cursor: { x: number; y: number } | null = null;

  /**
   * Cached CDP session for cloakbrowser's `humanType` — lets it dispatch shift
   * symbols as `isTrusted=true` keyboard events (vs the detectable
   * `page.evaluate` fallback). Created lazily on first type() call.
   */
  private cdpSession: CDPSession | null = null;

  /** Resolved cloakbrowser human-config (Bezier curve params, typing speed, etc). */
  private humanConfig: CloakHumanConfig | null = null;

  constructor(cfg: StagehandPageSessionConfig) {
    this.cfg = {
      verbose: 1,
      device: 'desktop',
      ...cfg,
    };
  }

  /** The viewport this session renders at (px). Stable for the session's lifetime. */
  get viewport(): Viewport {
    return this.cfg.viewport;
  }

  // -------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.stagehand) {
      // Idempotent — already started.
      return;
    }

    await mkdir(this.cfg.outputDir, { recursive: true });

    // Launch cloakbrowser's stealth Chromium via Playwright with recordVideo
    // + a remote-debugging-port so Stagehand can attach over CDP.
    //
    // cloakbrowser's C++-patched build handles canvas / WebGL / audio / fonts
    // / GPU / WebRTC fingerprint spoofing at compile time. We consume only
    // `ensureBinary()` (executablePath) and `getDefaultStealthArgs()` (the
    // matching flag set) — Stagehand attaches over CDP identically to a
    // vanilla launch.
    //
    // We deliberately do NOT use cloakbrowser's wrapper API (which has its
    // own `humanize` option for mouse curves / typing / scroll). Our own
    // naturalness pipeline (§0031 / §0039 / judge §0030) owns on-camera
    // rendering.
    //
    // Optional `storageState` (STORAGE_STATE_PATH) preloads cookies/local
    // storage for sites that need a logged-in start — goals.md non-goal:
    // we don't manage credentials, only honor pre-prepared session files.
    try {
      this.userDataDir = await mkdtemp(join(tmpdir(), 'web-recorder-'));
      const cloakBinaryPath = await cloakEnsureBinary().catch((err: unknown) => {
        throw new SessionStartError(
          'cloakbrowser binary unavailable — first run downloads ~150 MB to ~/.cloakbrowser; ' +
            'check network or pre-fetch with `npm run cloakbrowser:install`.',
          err,
        );
      });
      const cloakStealthArgs = cloakDefaultStealthArgs();
      // Resolve the device preset: desktop uses the caller's viewport (so e.g.
      // a 1280×720 vs 1920×1080 desktop both work); mobile/tablet inherit the
      // preset's viewport so the device is internally consistent (a Pixel 7 UA
      // at 1280×720 would be obviously fake to a serving-mobile-html sniffer).
      const device: DeviceKind = this.cfg.device ?? 'desktop';
      const preset = playwrightDevices[DEVICE_PRESET_NAME[device]];
      if (!preset) {
        // Belt-and-braces — Playwright reorganized preset names once before.
        throw new SessionStartError(`Playwright preset missing: ${DEVICE_PRESET_NAME[device]} (for device=${device})`);
      }
      const resolvedViewport = device === 'desktop' ? this.cfg.viewport : preset.viewport;
      // Pin the cfg.viewport to the resolved one so every downstream consumer
      // (`this.cfg.viewport` reads scattered through scroll/click math, the
      // public `viewport` getter the runner persists to run.json, etc.) sees
      // the actual emulated viewport — never the request's stale 1280×720 on
      // a `mobile` session.
      this.cfg.viewport = resolvedViewport;
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        ...preset,
        executablePath: cloakBinaryPath,
        ignoreDefaultArgs: CLOAK_IGNORE_DEFAULT_ARGS,
        headless: this.cfg.headless,
        viewport: resolvedViewport,
        args: [
          ...cloakStealthArgs,
          '--remote-debugging-port=0',
          // Local-dev only (no effect headless). When BROWSER_WINDOW_POSITION
          // is set, place the window at those screen coords AND pin its size to
          // the viewport — position alone lets Chromium pick its own size and
          // can still overlap. See `src/infra/config.ts` / `.env.example`.
          ...(config.browserWindowPosition
            ? [
                `--window-position=${config.browserWindowPosition.x},${config.browserWindowPosition.y}`,
                `--window-size=${resolvedViewport.width},${resolvedViewport.height}`,
              ]
            : []),
        ],
        recordVideo: {
          dir: this.cfg.outputDir,
          size: resolvedViewport,
        },
        // Optional persistent login state. The storage-state file is
        // produced offline by `npx playwright codegen --save-storage=...`
        // (or any other Playwright session). We do NOT manage credentials
        // here — see `docs/goals.md` non-goals.
        ...(config.storageStatePath
          ? { storageState: config.storageStatePath }
          : {}),
      });

      // launchPersistentContext returns a context with one page already open.
      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());

      // Register browser-side runtime helpers BEFORE any goto. addInitScript
      // runs on every new document (including subsequent navigations of the
      // existing about:blank page), so all later `window.__webRecorder.*`
      // calls will resolve.
      await this.context.addInitScript({ content: RUNTIME_HELPERS_SCRIPT });
    } catch (err) {
      await this.cleanupPartial();
      throw new SessionStartError('Failed to launch Playwright Chromium', err);
    }

    // Step 2: read the CDP URL Chromium picked.
    let cdpUrl: string;
    try {
      cdpUrl = await this.resolveCdpUrl(this.userDataDir);
    } catch (err) {
      await this.cleanupPartial();
      throw new SessionStartError('Failed to resolve Chromium CDP URL', err);
    }

    // Step 3: connect Stagehand. We build a Stagehand `LLMClient` backed by
    // a stock OpenAI client pointed at OpenRouter — OpenRouter is OpenAI-API
    // compatible, so this is the cheapest possible bridge.
    // Capture which cloakbrowser binary the session is running against —
    // surfaces into run.json indirectly via the structured log + makes a
    // "did this run use the stealth Chromium?" question a one-grep answer
    // for future triage.
    let cloakInfo: ReturnType<typeof cloakBinaryInfo> | null = null;
    try { cloakInfo = cloakBinaryInfo(); } catch { /* ignore — log will just omit it */ }
    this.logger.info(
      {
        model: config.llmModel,
        outputDir: this.cfg.outputDir,
        headless: this.cfg.headless,
        viewport: this.cfg.viewport,
        cloakbrowser: cloakInfo ? { version: cloakInfo.version, platform: cloakInfo.platform } : null,
      },
      'starting Stagehand session',
    );

    const llmClient = new CustomOpenAIClient({
      modelName: config.llmModel,
      client: new OpenAI({
        baseURL: config.openrouterBaseUrl,
        apiKey: config.openrouterApiKey,
      }),
    });

    try {
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        llmClient,
        verbose: this.cfg.verbose,
        localBrowserLaunchOptions: {
          cdpUrl,
        },
      });
      await this.stagehand.init();
    } catch (err) {
      await this.cleanupPartial();
      throw new SessionStartError('Failed to initialize Stagehand', err);
    }

    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
  }

  async stop(): Promise<SessionArtifacts> {
    if (this.cachedArtifacts) {
      return this.cachedArtifacts;
    }
    if (!this.page || !this.context) {
      throw new RecordingError('stop() called before successful start()');
    }

    const durationMs = Date.now() - this.startedAtMs;
    const page = this.page;

    // Get the video handle BEFORE closing the context — Playwright finalizes
    // the .webm file during context.close(), but the path is known via the
    // Page.video() handle obtained while the page is alive.
    const videoHandle = page.video();

    // Cleanup order: detach Stagehand → close context → drop refs → rm temp dir.
    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch (err) {
        this.logger.warn({ err }, 'Stagehand close threw — continuing');
      }
      this.stagehand = null;
    }

    try {
      await this.context.close();
    } catch (err) {
      this.logger.warn({ err }, 'BrowserContext close threw — continuing');
    }
    this.context = null;
    this.page = null;

    if (this.userDataDir) {
      const dir = this.userDataDir;
      this.userDataDir = null;
      // Best-effort: a leaked temp dir is annoying but not fatal.
      rm(dir, { recursive: true, force: true }).catch((err) => {
        this.logger.warn({ err, dir }, 'failed to remove user data dir');
      });
    }

    if (!videoHandle) {
      throw new RecordingError(
        'Page had no video handle — recordVideo was not configured correctly',
      );
    }

    let videoPath: string;
    try {
      videoPath = await videoHandle.path();
    } catch (err) {
      throw new RecordingError('Could not resolve video file path', err);
    }

    const recordingWindow =
      this.recordingStartedAtMs !== null
        ? { startedAtMs: this.recordingStartedAtMs, endedAtMs: durationMs }
        : null;

    const actionLog = ActionLog.parse({
      version: 1,
      startedAt: this.startedAtIso,
      durationMs,
      recording: recordingWindow,
      entries: this.entries,
    });

    const actionLogPath = resolve(this.cfg.outputDir, 'action-log.json');
    await writeFile(actionLogPath, JSON.stringify(actionLog, null, 2), 'utf8');

    const artifacts: SessionArtifacts = {
      videoPath: resolve(videoPath),
      actionLogPath,
      actionLog,
      viewport: this.cfg.viewport,
      recording: recordingWindow,
    };
    this.cachedArtifacts = artifacts;

    this.logger.info(
      {
        videoPath: artifacts.videoPath,
        actionLogPath,
        entries: actionLog.entries.length,
      },
      'session stopped',
    );

    return artifacts;
  }

  // ------------------------------------------------------------------- primitives

  async goto(url: string): Promise<void> {
    const page = this.requirePage();
    this.logger.debug({ url }, 'goto');

    // Use only `domcontentloaded` here. Many modern sites (GitHub, Twitter,
    // Stripe, anything with long-poll / SSE / service workers) never reach
    // `networkidle`, so blocking on it would silently waste 5s+ per goto.
    // Visual readiness is a separate concern — call waitForVisualStability()
    // after goto to know when the page has stopped re-rendering.
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const scrollY = await this.readScrollY();
    this.recordEntry({
      t: this.elapsed(),
      type: 'goto',
      url,
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  async waitForVisualStability(
    opts: { quietMs?: number; maxMs?: number } = {},
  ): Promise<void> {
    const page = this.requirePage();
    const quietMs = opts.quietMs ?? 400;
    const maxMs = opts.maxMs ?? 3000;

    type Result = { waitedMs: number; timedOut: boolean };
    const result = await page.evaluate(
      (args: number[]) =>
        (window as unknown as {
          __webRecorder: {
            waitVisuallyStable: (q: number, m: number) => Promise<Result>;
          };
        }).__webRecorder.waitVisuallyStable(args[0]!, args[1]!),
      [quietMs, maxMs],
    );

    const scrollY = await this.readScrollY();
    this.recordEntry({
      t: this.elapsed(),
      type: 'visual_stable',
      waitedMs: result.waitedMs,
      timedOut: result.timedOut,
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  async currentUrl(): Promise<string> {
    return this.requirePage().url();
  }

  async screenshot(): Promise<Buffer> {
    const page = this.requirePage();
    return page.screenshot({ type: 'png', fullPage: false });
  }

  async ariaSnapshot(opts: { depth?: number } = {}): Promise<string> {
    try {
      const page = this.requirePage();
      const depth = opts.depth ?? config.ariaSnapshotDepth;
      const max = config.ariaSnapshotMaxChars;
      // Prune content/wrapper noise — the planner needs "what can I act on / where
      // am I", not the prose. Cuts a content page's tree several× → cheaper recon
      // prompt (goal #5) AND a smaller haystack for ref-picking. (Even mode:'ai'
      // keeps generic divs + text content, for agents that want them — we don't.)
      const rawSnap = await page.ariaSnapshot({ mode: 'ai', depth });
      let snap = pruneAriaSnapshot(rawSnap);
      if (snap.length !== rawSnap.length) {
        this.logger.info({ rawChars: rawSnap.length, prunedChars: snap.length }, 'ariaSnapshot: pruned content/wrapper noise');
      }
      if (snap.length > max) {
        // Still too big for the planner prompt (a Wikipedia featured article):
        // scope to the main content region — drops the global nav / sidebar /
        // footer, so what's left starts with the actual content (hatnotes,
        // infoboxes, the intro — where "click X" targets near the top of a page
        // live). Refs from a scoped ariaSnapshot still resolve via
        // page.locator('aria-ref=eN').
        const mainLoc = page.locator('main, [role="main"]').first();
        if ((await mainLoc.count().catch(() => 0)) > 0) {
          const scoped = pruneAriaSnapshot(await mainLoc.ariaSnapshot({ mode: 'ai', depth }).catch(() => ''));
          if (scoped.length > 0 && scoped.length < snap.length) {
            this.logger.info({ fullChars: snap.length, scopedChars: scoped.length }, 'ariaSnapshot: page large — scoped to <main>');
            snap = scoped;
          }
        }
      }
      if (snap.length > max) {
        // Still too big — keep the top of the tree (cut at a line boundary) and
        // tell the planner the rest is below it (so it plans a scroll to reach it).
        const cut = snap.lastIndexOf('\n', max);
        const head = cut > 0 ? snap.slice(0, cut) : snap.slice(0, max);
        this.logger.info({ origChars: snap.length, keptChars: head.length }, 'ariaSnapshot: page still large — truncated the tree to its top');
        snap = head + '\n' + ARIA_SNAPSHOT_TRUNCATION_MARKER;
      }
      return snap;
    } catch (err) {
      this.logger.warn({ err }, 'ariaSnapshot failed; returning empty tree');
      return '';
    }
  }

  async resolveAriaRef(ref: string): Promise<ObservedElement | null> {
    try {
      const page = this.requirePage();
      const id = ref.trim().replace(/^(aria-)?ref=/i, '');
      if (!id) return null;
      const locator = page.locator(`aria-ref=${id}`).first();
      const box = await locator.boundingBox({ timeout: 1000 });
      // 0×0 wrapper / unloaded node — not a clickable target. See sweep-1 P2.
      if (!box || box.width < 1 || box.height < 1) return null;
      // A durable selector (xpath snapshot) — `aria-ref=eN` itself is only valid
      // until the next snapshot, so it's useless for on-camera playback.
      const selector = await this.locatorSelectorFallback(locator);
      if (!selector) return null;
      const description = await locator
        .evaluate((el) => {
          const e = el as HTMLElement;
          const text =
            e.getAttribute('aria-label') ||
            (e.textContent ?? '').trim() ||
            e.getAttribute('title') ||
            e.getAttribute('alt') ||
            e.getAttribute('value') ||
            e.getAttribute('placeholder') ||
            '';
          return text.replace(/\s+/g, ' ').trim().slice(0, 120);
        })
        .catch(() => '');
      return {
        selector,
        description: description || `aria-ref ${id}`,
        bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    } catch (err) {
      this.logger.debug({ err, ref }, 'resolveAriaRef failed');
      return null;
    }
  }

  async observeAll(instruction?: string): Promise<ObservedElement[]> {
    const page = this.requirePage();
    const stagehand = this.requireStagehand();

    const finalInstruction =
      instruction ??
      'List all visible interactive or notable elements on the page (links, buttons, headings, language switchers, video players, comment sections). Include their visible text.';

    let raw: { selector: string; description: string }[];
    try {
      const result = await stagehand.observe(finalInstruction, { page });
      raw = result.map((m) => ({ selector: m.selector, description: m.description }));
    } catch (err) {
      this.logger.warn({ err }, 'observeAll failed; returning empty list');
      return [];
    }

    return Promise.all(
      raw.map(async (m) => {
        const bbox = await this.bboxOfSelector(m.selector);
        return bbox ? { ...m, bbox } : m;
      }),
    );
  }

  async resolveTarget(target: string): Promise<ObservedElement | null> {
    const candidates = await this.resolveTargetCandidates(target);
    return candidates[0] ?? null;
  }

  async resolveTargetCandidates(target: string): Promise<ObservedElement[]> {
    const page = this.requirePage();
    const stagehand = this.requireStagehand();

    let matches: { selector: string; description: string }[];
    try {
      matches = await stagehand.observe(target, { page });
    } catch (err) {
      this.logger.warn({ err, target }, 'resolveTargetCandidates: observe failed');
      return [];
    }

    // Resolve each match to a real sized bbox + whether it's a genuinely
    // interactive element. `observe()` sometimes ranks a 0×0 wrapper element —
    // or a non-clickable <div>/<span> around the real link — first; a target
    // without a clickable area (or a wrapper) is worse than no target (a coord
    // click on its origin lands on nothing / on the wrapper). Drop 0×0,
    // rank interactive-first, dedup by position. See sweep-1 P2 / finding 6.
    const resolved: RankableCandidate[] = [];
    for (const m of matches) {
      const meta = await this.elementMetaOfSelector(m.selector);
      if (!meta) continue; // unresolvable, 0×0, or detached
      resolved.push({ selector: m.selector, description: m.description, bbox: meta.bbox, interactive: meta.interactive });
    }
    return rankCandidates(resolved).map(({ selector, description, bbox }) => ({ selector, description, bbox }));
  }

  async resolveByVisibleText(text: string): Promise<ObservedElement | null> {
    let page: Page;
    try {
      page = this.requirePage();
    } catch {
      return null;
    }
    const t = text.trim();
    if (!t) return null;
    // Role-first (a click target is almost always a link/button), then a bare
    // exact-text match as a last resort. All Playwright locator queries — no
    // LLM, no DOM serialization — so this is safe on arbitrarily large pages.
    const candidates = [
      page.getByRole('link', { name: t }),
      page.getByRole('button', { name: t }),
      page.getByRole('menuitem', { name: t }),
      page.getByRole('tab', { name: t }),
      page.getByText(t, { exact: true }),
    ];
    for (const locator of candidates) {
      try {
        const handle = locator.first();
        if ((await handle.count().catch(() => 0)) === 0) continue;
        if (!(await handle.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const box = await handle.boundingBox({ timeout: 500 }).catch(() => null);
        if (!box || box.width < 1 || box.height < 1) continue; // 0×0 wrapper — not clickable
        const sel = await this.locatorSelectorFallback(handle);
        if (!sel) continue;
        return {
          selector: sel,
          description: t,
          bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async quickFindInViewport(description: string): Promise<ObservedElement | null> {
    const candidates = this.candidateLocators(description);

    for (const locator of candidates) {
      try {
        const handle = locator.first();
        if ((await handle.count()) === 0) continue;
        const bbox = await handle.boundingBox({ timeout: 500 });
        if (!bbox) continue;
        // Viewport check — bbox.y/x are viewport-relative.
        const inViewport =
          bbox.y >= 0 &&
          bbox.y < this.cfg.viewport.height &&
          bbox.x >= 0 &&
          bbox.x < this.cfg.viewport.width;
        if (!inViewport) continue;
        const sel = await this.locatorSelectorFallback(handle);
        return {
          selector: sel ?? '',
          description,
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        };
      } catch {
        // ignore — try next candidate
      }
    }
    return null;
  }

  async quickFindOnPage(description: string): Promise<ObservedElement | null> {
    const candidates = this.candidateLocators(description);

    for (const locator of candidates) {
      try {
        const handle = locator.first();
        if ((await handle.count()) === 0) continue;
        const bbox = await handle.boundingBox({ timeout: 500 });
        if (!bbox) continue;
        const sel = await this.locatorSelectorFallback(handle);
        return {
          selector: sel ?? '',
          description,
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        };
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Generate a small ordered list of Playwright Locators that might match
   * a natural-language description. Cheapest matchers first.
   */
  private candidateLocators(description: string) {
    const page = this.requirePage();
    const trimmed = description.trim();
    return [
      page.getByText(trimmed, { exact: false }),
      page.getByRole('link', { name: new RegExp(escapeRegex(trimmed), 'i') }),
      page.getByRole('button', { name: new RegExp(escapeRegex(trimmed), 'i') }),
      page.locator(`text=${trimmed}`),
    ];
  }

  /**
   * Best-effort: get a stable selector string for a Playwright locator
   * we just resolved by description. Falls back to an empty string when
   * Playwright can't serialize the locator (in which case the caller can
   * still re-query by description).
   */
  private async locatorSelectorFallback(
    locator: ReturnType<Page['locator']>,
  ): Promise<string | null> {
    // Playwright doesn't expose a stable serializer; we just round-trip via
    // an XPath snapshot computed in the page. If that fails, return null
    // and the caller will re-query by description.
    try {
      const handle = await locator.elementHandle({ timeout: 1500 });
      if (!handle) return null;
      const xpath = await handle.evaluate((el: Element) => {
        function getXPath(node: Element): string {
          const segs: string[] = [];
          for (let n: Element | null = node; n && n.nodeType === 1; n = n.parentElement) {
            let i = 1;
            for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
              if (s.tagName === n.tagName) i += 1;
            }
            segs.unshift(`${n.tagName.toLowerCase()}[${i}]`);
          }
          return '/' + segs.join('/');
        }
        return getXPath(el);
      });
      await handle.dispose();
      return `xpath=${xpath}`;
    } catch {
      return null;
    }
  }

  /**
   * Click an element identified by a natural-language description.
   *
   * Pipeline:
   *   1. quickFindInViewport(description) → if found, run discovery click.
   *   2. quickFindOnPage(description) → if found but off-screen, run a
   *      search loop: scroll toward target's expected direction, re-find
   *      after each scroll, click when in viewport. Hard cap on total
   *      scroll distance (proportional to remaining time budget if
   *      provided).
   *   3. Neither found → throw ElementNotFoundError.
   *
   * The Director uses this for `click(target)` actions. It is the path
   * that turns "the LLM said click X" into the real human-feeling
   * scroll-search-click sequence.
   */
  async clickByDescription(
    description: string,
    opts: { searchBudgetPx?: number } = {},
  ): Promise<void> {
    this.logger.debug({ description }, 'clickByDescription');

    // Branch 1: already in viewport.
    const inView = await this.quickFindInViewport(description);
    if (inView && inView.selector) {
      await this.clickSelector(inView.selector, { description });
      return;
    }

    // Branch 2: on page but off-screen — search loop.
    const onPage = await this.quickFindOnPage(description);
    if (onPage && onPage.selector) {
      // bbox is always present in practice (quickFindOnPage skips null bboxes),
      // but TS narrowing requires a fallback. Default to "below viewport" so
      // direction defaults to "scroll down", the common off-screen case.
      const targetPageY = onPage.bbox?.y ?? this.cfg.viewport.height;
      const desiredViewportY = this.cfg.viewport.height * 0.35;
      const initialDeltaY = Math.round(targetPageY - desiredViewportY);
      const direction = Math.sign(initialDeltaY) || 1;
      const budgetPx = opts.searchBudgetPx ?? 1500;
      const stepPx = 600;
      let scrolled = 0;

      while (scrolled < budgetPx) {
        // Try in-viewport find (target may have come into view via prior scroll).
        const found = await this.quickFindInViewport(description);
        if (found && found.selector) {
          await this.clickSelector(found.selector, { description });
          return;
        }
        // Scroll one step in target direction.
        // Search-loop scrolls intentionally slower than default scroll() —
        // ~250 px/s reading pace so the viewer perceives a person scanning,
        // not a fast scroll-jump.
        const remaining = budgetPx - scrolled;
        const thisStep = direction * Math.min(stepPx, remaining);
        await this.scroll(thisStep, {
          durationMs: Math.max(800, Math.abs(thisStep) / 250 * 1000),
          easing: 'outQuart',
        });
        scrolled += Math.abs(thisStep);
      }
      // One last viewport check — the element may have entered the viewport
      // on the final scroll step. Without this, a target whose distance
      // exactly equals the budget always fails.
      const afterLast = await this.quickFindInViewport(description);
      if (afterLast && afterLast.selector) {
        await this.clickSelector(afterLast.selector, { description });
        return;
      }
      throw new ElementNotFoundError(
        `search budget exhausted (${budgetPx}px) without locating: ${description}`,
      );
    }

    // Branch 3: Playwright fast matchers failed. Fall back to LLM-based
    // Stagehand observe via `resolveTarget` — slower (~3-8s) but smart
    // enough to handle complex descriptions ("the 简体中文 link", etc.)
    // that Playwright's literal text/role matchers miss.
    const resolved = await this.resolveTarget(description);
    if (resolved && resolved.selector && resolved.bbox) {
      const targetPageY = resolved.bbox.y;
      const desiredViewportY = this.cfg.viewport.height * 0.35;
      const initialDeltaY = Math.round(targetPageY - desiredViewportY);

      // If the target is within ~viewport height of comfortable position,
      // discovery click can scroll directly to it.
      if (Math.abs(initialDeltaY) <= this.cfg.viewport.height * 1.2) {
        await this.clickSelector(resolved.selector, { description });
        return;
      }

      // Otherwise, scroll most of the way (leave 600px for clickSelector's
      // approach choreography), then let clickSelector finish.
      const direction = Math.sign(initialDeltaY) || 1;
      const preScroll = direction * (Math.abs(initialDeltaY) - 600);
      await this.scroll(preScroll, {
        durationMs: Math.max(800, Math.abs(preScroll) / 600 * 1000),
        easing: 'outQuart',
      });
      await this.clickSelector(resolved.selector, { description });
      return;
    }

    // Truly not on page (even LLM couldn't find it).
    throw new ElementNotFoundError(`target not found on page: ${description}`);
  }

  /**
   * Click with **discovery choreography** — the recorded video should look
   * like a human reading the page, finding the target, and clicking.
   *
   * Phases:
   *   1. APPROACH    — smooth-scroll until the target sits at ~35% of the
   *                    viewport (a comfortable reading position). Speed is
   *                    "slow scroll" (~300 px/s) so the viewer perceives a
   *                    person scanning content, not a teleport.
   *                    Skipped if the target is already near the desired
   *                    spot in the current viewport.
   *
   *   2. ANTICIPATE  — a 500-800ms hold AFTER scroll completes. Models the
   *                    micro-pause a human takes after their eyes lock on
   *                    the target ("ah, there it is") and before clicking.
   *                    Randomized so consecutive runs don't feel identical.
   *
   *   3. CLICK       — Playwright's native click on the (now-in-viewport)
   *                    target. No `scrollIntoViewIfNeeded` — that would
   *                    undo the choreography and cause the "teleport" feel.
   *
   * Rationale (see `docs/decisions.md` §0017):
   *   Pre-resolution gives us the *knowledge* of where things are. The
   *   viewer should not see that knowledge directly — they should see the
   *   discovery process. The executor uses pre-resolved selectors to make
   *   the click certain, but stages the journey so it looks discovered.
   *
   * Each phase that records visible motion (the approach scroll, the wait,
   * the click) writes its own `ActionLogEntry` so downstream layers
   * (cursor synth) can render them faithfully.
   */
  async clickSelector(
    selector: string,
    opts: { description?: string } = {},
  ): Promise<void> {
    const page = this.requirePage();
    this.logger.debug({ selector }, 'clickSelector (with discovery)');

    const locator = page.locator(selector).first();

    // Fresh bbox for approach computation. May fail if the element is
    // detached / hidden — fall back to instant click in that case.
    let initialBbox: { x: number; y: number; width: number; height: number } | null = null;
    try {
      initialBbox = (await locator.boundingBox({ timeout: 1500 })) ?? null;
    } catch {
      initialBbox = null;
    }

    if (initialBbox) {
      // Phase 1: APPROACH
      // Position the target at ~35% from the top of the viewport.
      // bbox.y is in viewport coords; the desired final viewport-y is
      // `viewport.height * 0.35`. We scroll by the delta to get there.
      //
      // Distance-adaptive choreography:
      //   - small  (≤ 60 px)            : skip — target already in zone
      //   - short  (60-1000 px)          : single slow scroll, outQuart
      //   - medium (1000-2500 px)        : single medium scroll, outQuart
      //   - long   (> 2500 px)           : two-stage = fling (outExpo) +
      //                                    micro-pause + slow approach (outQuart).
      //                                    Mimics how a real human handles
      //                                    a far target: throw the page up,
      //                                    then carefully line up the last bit.
      const desiredYInViewport = this.cfg.viewport.height * 0.35;
      const deltaY = Math.round(initialBbox.y - desiredYInViewport);
      const absDelta = Math.abs(deltaY);
      const direction = Math.sign(deltaY);

      const SCROLL_THRESHOLD_PX = 60;
      const SHORT_BAND_PX = 1000;
      const LONG_BAND_PX = 2500;

      if (absDelta > SCROLL_THRESHOLD_PX) {
        if (absDelta <= SHORT_BAND_PX) {
          // Short: 300 px/s "reading pace". Single shot.
          await this.scrollWithProfile(deltaY, 300, 'outQuart', 800, 2200);
        } else if (absDelta <= LONG_BAND_PX) {
          // Medium: 600 px/s "scanning pace". Single shot.
          await this.scrollWithProfile(deltaY, 600, 'outQuart', 1200, 2800);
        } else {
          // Long: two-stage.
          // Stage A — fling: cover all but the last 600px at high speed.
          const flingPx = absDelta - 600;
          await this.scrollWithProfile(direction * flingPx, 1500, 'outExpo', 1000, 2200);
          // Stage B — micro-pause: human "catches up" visually before fine
          // adjustment. ~150-250ms randomized.
          await this.wait(150 + Math.floor(Math.random() * 100));
          // Stage C — slow approach: the final 600px at reading pace.
          await this.scrollWithProfile(direction * 600, 300, 'outQuart', 1500, 2200);
        }
      }

      // Phase 2: ANTICIPATE — 500-800ms hold, randomized.
      const anticipationMs = 500 + Math.floor(Math.random() * 300);
      await this.wait(anticipationMs);
    }

    // Phase 3: CLICK
    const scrollY = await this.readScrollY();
    const urlBefore = page.url();

    try {
      const finalBbox = (await locator.boundingBox({ timeout: 1000 })) ?? null;
      await locator.click({ timeout: 5000 });
      const urlAfter = page.url();

      this.recordEntry({
        t: this.elapsed(),
        type: 'click',
        selector,
        ...(opts.description ? { description: opts.description } : {}),
        ...(finalBbox
          ? {
              bbox: {
                x: finalBbox.x,
                y: finalBbox.y,
                width: finalBbox.width,
                height: finalBbox.height,
              },
            }
          : {}),
        scrollY,
        viewport: this.cfg.viewport,
        urlBefore,
        urlAfter,
      });
    } catch (err) {
      throw new ElementNotFoundError(`click failed for selector: ${selector}`, err);
    }
  }

  /**
   * Lazy-init the cloakbrowser HumanConfig (idempotent). Only consumed when
   * `config.humanizeStrategy === 'cloakbrowser'`; otherwise this never runs.
   */
  private getHumanConfig(): CloakHumanConfig {
    if (!this.humanConfig) this.humanConfig = cloakResolveHumanConfig('default');
    return this.humanConfig;
  }

  /** Lazy CDPSession for shift-symbol typing via `Input.dispatchKeyEvent`. */
  private async getCdpSession(): Promise<CDPSession | null> {
    if (this.cdpSession) return this.cdpSession;
    const ctx = this.context;
    const page = this.page;
    if (!ctx || !page) return null;
    try {
      this.cdpSession = await ctx.newCDPSession(page);
      return this.cdpSession;
    } catch (err) {
      this.logger.warn({ err }, 'CDPSession unavailable — humanType will use evaluate fallback');
      return null;
    }
  }

  /** Center-of-viewport seed for the first humanMove (no real "current" cursor on launch). */
  private seedCursor(): { x: number; y: number } {
    if (this.cursor) return this.cursor;
    this.cursor = {
      x: Math.round(this.cfg.viewport.width / 2),
      y: Math.round(this.cfg.viewport.height / 2),
    };
    return this.cursor;
  }

  async clickAt(
    x: number,
    y: number,
    opts: { description?: string } = {},
  ): Promise<void> {
    const page = this.requirePage();
    this.logger.debug({ x, y, description: opts.description, strategy: config.humanizeStrategy }, 'clickAt');

    const scrollY = await this.readScrollY();
    const urlBefore = page.url();

    if (config.humanizeStrategy === 'cloakbrowser') {
      // cloakbrowser path: Bezier mouse curve from the current cursor to the
      // target, then humanClick (small jitter + hold duration). `humanClick`
      // clicks at wherever the mouse currently is — humanMove just landed it
      // at (x, y), so this is effectively click-at-target.
      const cfg = this.getHumanConfig();
      const cur = this.seedCursor();
      const raw = page.mouse;
      await cloakHumanMove(raw, cur.x, cur.y, x, y, cfg);
      await cloakHumanClick(raw, /*isInput*/ false, cfg);
      this.cursor = { x, y };
    } else {
      await page.mouse.click(x, y);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    const urlAfter = page.url();

    this.recordEntry({
      t: this.elapsed(),
      type: 'click',
      selector: `coord(${Math.round(x)},${Math.round(y)})`,
      ...(opts.description ? { description: opts.description } : {}),
      bbox: { x, y, width: 0, height: 0 },
      scrollY,
      viewport: this.cfg.viewport,
      urlBefore,
      urlAfter,
    });
  }

  async beginRecording(): Promise<void> {
    if (this.recordingStartedAtMs !== null) {
      return; // idempotent
    }
    const t = this.elapsed();
    this.recordingStartedAtMs = t;

    const scrollY = await this.readScrollY();
    this.recordEntry({
      t,
      type: 'recording_start',
      scrollY,
      viewport: this.cfg.viewport,
    });

    this.logger.info({ tMs: t }, 'recording window opened');

    // Capture page-health diagnostic right at recording_start. Best-effort —
    // never let this block the recording itself.
    try {
      const diag = await this.pageDiagnostic();
      this.recordEntry({
        t: this.elapsed(),
        type: 'page_diagnostic',
        url: diag.url,
        title: diag.title,
        interactiveElementCount: diag.interactiveElementCount,
        visibleHeadings: diag.visibleHeadings,
        blockerSignals: diag.blockerSignals,
        scrollY,
        viewport: this.cfg.viewport,
      });
    } catch (err) {
      this.logger.debug({ err }, 'page_diagnostic gathering failed; continuing');
    }
  }

  async act(instruction: string): Promise<void> {
    const page = this.requirePage();
    const stagehand = this.requireStagehand();
    this.logger.debug({ instruction }, 'act');

    // Best-effort: observe first to capture the resolved target's bbox before
    // the action mutates the DOM. If observe fails or returns nothing we still
    // call act() — Stagehand's act has its own internal resolution.
    let target:
      | { selector: string; bbox: { x: number; y: number; width: number; height: number } }
      | undefined;
    try {
      const matches = await stagehand.observe(instruction, { page });
      const first = matches[0];
      if (first) {
        const bbox = await this.bboxOfSelector(first.selector);
        if (bbox) {
          target = { selector: first.selector, bbox };
        }
      }
    } catch (err) {
      this.logger.debug({ err, instruction }, 'observe-before-act failed; continuing');
    }

    const scrollYBefore = await this.readScrollY();
    const urlBefore = page.url();

    try {
      await stagehand.act(instruction, { page });
    } catch (err) {
      throw new ElementNotFoundError(instruction, err);
    }

    const urlAfter = page.url();

    this.recordEntry({
      t: this.elapsed(),
      type: 'act',
      instruction,
      ...(target ? { target } : {}),
      scrollY: scrollYBefore,
      viewport: this.cfg.viewport,
      urlBefore,
      urlAfter,
    });
  }

  async observe(instruction: string): Promise<ObservedElement[]> {
    const page = this.requirePage();
    const stagehand = this.requireStagehand();
    this.logger.debug({ instruction }, 'observe');

    const scrollY = await this.readScrollY();

    let raw: { selector: string; description: string }[];
    try {
      const result = await stagehand.observe(instruction, { page });
      raw = result.map((m) => ({
        selector: m.selector,
        description: m.description,
      }));
    } catch (err) {
      throw new ElementNotFoundError(instruction, err);
    }

    // Resolve bboxes for each match in parallel (best-effort).
    const enriched: ObservedElement[] = await Promise.all(
      raw.map(async (m) => {
        const bbox = await this.bboxOfSelector(m.selector);
        return bbox ? { ...m, bbox } : m;
      }),
    );

    this.recordEntry({
      t: this.elapsed(),
      type: 'observe',
      instruction,
      matches: raw,
      scrollY,
      viewport: this.cfg.viewport,
    });

    return enriched;
  }

  async scroll(
    deltaY: number,
    opts: { durationMs?: number; easing?: ScrollEasing } = {},
  ): Promise<void> {
    const page = this.requirePage();
    const durationMs =
      opts.durationMs ?? Math.min(2000, Math.max(400, Math.abs(deltaY) * 1.5));
    const easing: ScrollEasing = opts.easing ?? 'inOutQuad';

    const fromScrollY = await this.readScrollY();

    // Delegate to the browser-side helper installed by addInitScript.
    // This call site is intentionally trivial so esbuild has nothing to
    // mangle — see RUNTIME_HELPERS_SCRIPT for why.
    await page.evaluate(
      (args: { dy: number; dur: number; easing: string }) =>
        (window as unknown as {
          __webRecorder: {
            smoothScrollTo: (dy: number, dur: number, easing: string) => Promise<void>;
          };
        }).__webRecorder.smoothScrollTo(args.dy, args.dur, args.easing),
      { dy: deltaY, dur: durationMs, easing },
    );

    const toScrollY = await this.readScrollY();

    this.recordEntry({
      t: this.elapsed(),
      type: 'scroll',
      deltaY,
      fromScrollY,
      toScrollY,
      durationMs,
      viewport: this.cfg.viewport,
    });
  }

  async wait(durationMs: number): Promise<void> {
    const page = this.requirePage();
    const scrollY = await this.readScrollY();

    await page.waitForTimeout(durationMs);

    this.recordEntry({
      t: this.elapsed(),
      type: 'wait',
      durationMs,
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  /**
   * Type into the focused element with human-paced rendering. Two parts:
   *   1. A pre-typing "look at field" pause (`typingPreMs` range) — without
   *      this, short strings (≤3 chars) appear within ~2-3 frames at 30fps
   *      and read as "script-injected" to a viewer. The judge flagged this
   *      twice on gmaps (see docs/findings/2026-05-11-judge-first-batch.md
   *      §P2).
   *   2. Per-keystroke delay (`typingKeystrokeMs` range) via Playwright's
   *      `keyboard.type({ delay })`. One delay value per call — randomising
   *      per-char would need split `.press()` calls and the realism gain is
   *      marginal compared to the pre-typing pause above.
   *
   * Caller must focus the field first via clickSelector / clickByDescription.
   */
  async type(
    text: string,
    opts: { preMs?: number; keystrokeMs?: number } = {},
  ): Promise<void> {
    const page = this.requirePage();
    const scrollY = await this.readScrollY();
    const t0 = this.elapsed();
    const startedAtWall = Date.now();

    if (config.humanizeStrategy === 'cloakbrowser') {
      // cloakbrowser owns the typing rhythm — skip our pre-pause and let
      // humanType do the per-character timing + mistype simulation. CDP
      // session is best-effort; if null, humanType falls back to
      // page.evaluate (still works, just slightly detectable).
      const cfg = this.getHumanConfig();
      const cdp = await this.getCdpSession();
      await cloakHumanType(page, page.keyboard, text, cfg, cdp);
    } else {
      const preMs = opts.preMs ?? randInRange(config.typingPreMinMs, config.typingPreMaxMs);
      if (preMs > 0) {
        await page.waitForTimeout(preMs);
      }
      const delay = opts.keystrokeMs ?? randInRange(config.typingKeystrokeMinMs, config.typingKeystrokeMaxMs);
      await page.keyboard.type(text, { delay });
    }

    this.recordEntry({
      t: t0,
      type: 'type',
      text,
      durationMs: Date.now() - startedAtWall,
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  /**
   * Press a single named key. Wraps Playwright `keyboard.press`.
   */
  async pressKey(key: string): Promise<void> {
    const page = this.requirePage();
    const scrollY = await this.readScrollY();
    await page.keyboard.press(key);
    this.recordEntry({
      t: this.elapsed(),
      type: 'key',
      key,
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  /**
   * Browser-back navigation. Resolves when the back navigation completes
   * (DOM ready) or after a 5s timeout. Logged with urlBefore/urlAfter.
   */
  async goBack(): Promise<void> {
    const page = this.requirePage();
    const scrollY = await this.readScrollY();
    const urlBefore = page.url();
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
    } catch {
      // The page may have no history (we navigated only once). That's not
      // fatal — log the no-op and let the Director re-decide. Same idea as
      // a click that lands on a noop element.
    }
    const urlAfter = page.url();
    this.recordEntry({
      t: this.elapsed(),
      type: 'back',
      ...(urlBefore ? { urlBefore } : {}),
      ...(urlAfter ? { urlAfter } : {}),
      scrollY,
      viewport: this.cfg.viewport,
    });
  }

  // ---------------------------------------------------------------------- internals

  /**
   * Scroll a given delta using a target speed (px/s), an easing curve,
   * and inclusive [min, max] duration clamps. Internal helper used by
   * the discovery-click choreography to keep its math readable.
   */
  private async scrollWithProfile(
    deltaY: number,
    speedPxPerSec: number,
    easing: ScrollEasing,
    minDurationMs: number,
    maxDurationMs: number,
  ): Promise<void> {
    const computedMs = (Math.abs(deltaY) / speedPxPerSec) * 1000;
    const durationMs = Math.round(
      Math.min(maxDurationMs, Math.max(minDurationMs, computedMs)),
    );
    await this.scroll(deltaY, { durationMs, easing });
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new RecordingError('Session is not active. Did you call start()?');
    }
    return this.page;
  }

  private requireStagehand(): Stagehand {
    if (!this.stagehand) {
      throw new RecordingError('Stagehand is not initialized. Did you call start()?');
    }
    return this.stagehand;
  }

  private elapsed(): number {
    return Date.now() - this.startedAtMs;
  }

  // -------------------------- IPageSession introspection extensions

  /** Public session-relative timestamp; matches ActionLogEntry.t. */
  nowMs(): number {
    return this.startedAtMs > 0 ? this.elapsed() : 0;
  }

  /** Public action-log append, used by Director / RecordJobRunner. */
  appendEntry(entry: ActionLogEntry): void {
    this.recordEntry(entry);
  }

  /**
   * Read coarse page-health signals: title, interactive element count,
   * top visible headings, and a list of detected blocker signals
   * (consent_dialog | auth_modal | play_overlay | search_only).
   *
   * Best-effort: every step is wrapped in try/catch and degrades to
   * defaults so a partial failure here never breaks the recording.
   * Heuristic-only — false positives/negatives are expected.
   *
   * Public per IPageSession.pageDiagnostic — surfaced to the reconnoiterer
   * (so it can fold blocker dismissal into the Performance) and used by
   * `beginRecording` to capture a snapshot at recording_start.
   */
  async pageDiagnostic(): Promise<PageDiagnostic> {
    const page = this.requirePage();
    const url = page.url();
    let title = '';
    try {
      title = await page.title();
    } catch {
      /* leave blank */
    }

    const probe = await page
      .evaluate(() => {
        const safe = <T>(fn: () => T, fallback: T): T => {
          try {
            return fn();
          } catch {
            return fallback;
          }
        };

        // Count clickable / focusable elements. Cheap broad selector pass.
        const interactiveCount = safe(
          () =>
            document.querySelectorAll(
              'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
            ).length,
          0,
        );

        // Visible h1/h2/h3 texts in document order, top 5.
        const headings: string[] = safe(() => {
          const out: string[] = [];
          const list = document.querySelectorAll('h1, h2, h3');
          for (const el of Array.from(list)) {
            if (out.length >= 5) break;
            const rect = (el as HTMLElement).getBoundingClientRect();
            const text = (el as HTMLElement).innerText?.trim();
            if (text && rect.width > 0 && rect.height > 0) {
              out.push(text.slice(0, 100));
            }
          }
          return out;
        }, []);

        // Blocker heuristics. Each returns a string tag if present.
        const signals: string[] = [];

        // play_overlay: look for known platform big-play buttons OR a
        // visible button/svg with aria-label matching "play" that's
        // sized like a video overlay (>40x40, near center of viewport).
        const playOverlay = safe(() => {
          const wellKnown = document.querySelector(
            '.ytp-large-play-button, .vjs-big-play-button, [class*="play-button"][class*="overlay"]',
          );
          if (wellKnown) {
            const r = (wellKnown as HTMLElement).getBoundingClientRect();
            if (r.width >= 40 && r.height >= 40) return true;
          }
          // Generic: large aria-label="Play" near center.
          const candidates = document.querySelectorAll(
            'button[aria-label*="Play" i], button[aria-label*="play" i]',
          );
          const cx = window.innerWidth / 2;
          const cy = window.innerHeight / 2;
          for (const c of Array.from(candidates)) {
            const r = (c as HTMLElement).getBoundingClientRect();
            if (
              r.width >= 40
              && r.height >= 40
              && Math.abs(r.left + r.width / 2 - cx) < window.innerWidth / 4
              && Math.abs(r.top + r.height / 2 - cy) < window.innerHeight / 3
            ) {
              return true;
            }
          }
          return false;
        }, false);
        if (playOverlay) signals.push('play_overlay');

        // consent_dialog: presence of cookie/privacy dialog. Common
        // platforms use known classes; fallback to text match.
        const consent = safe(() => {
          if (
            document.querySelector(
              '#cookiebot, #onetrust-banner-sdk, [class*="cookie-consent" i], [class*="cookieBanner" i], [aria-label*="cookie" i]',
            )
          ) {
            return true;
          }
          // Visible "accept all" or "I agree" button often sits in a banner.
          const buttons = document.querySelectorAll('button');
          for (const b of Array.from(buttons)) {
            const text = (b as HTMLElement).innerText?.trim().toLowerCase() ?? '';
            if (
              (text === 'accept all'
                || text === 'i agree'
                || text === '同意'
                || text === '接受所有 cookie'
                || text === 'accept all cookies')
              && (b as HTMLElement).getBoundingClientRect().width > 0
            ) {
              return true;
            }
          }
          return false;
        }, false);
        if (consent) signals.push('consent_dialog');

        // auth_modal: dialog requiring sign-in.
        const authModal = safe(() => {
          const dialogs = document.querySelectorAll(
            '[role="dialog"], [aria-modal="true"]',
          );
          for (const d of Array.from(dialogs)) {
            const r = (d as HTMLElement).getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const text = ((d as HTMLElement).innerText || '').toLowerCase();
            if (
              text.includes('sign in')
              || text.includes('log in')
              || text.includes('登录')
              || text.includes('登入')
            ) {
              return true;
            }
          }
          return false;
        }, false);
        if (authModal) signals.push('auth_modal');

        // search_only: page is essentially just a search box (logged-out
        // YouTube etc.). Heuristic: very few interactive elements AND
        // a search input is present.
        const searchOnly = safe(() => {
          const hasSearch =
            !!document.querySelector(
              'input[type="search"], input[role="combobox"], input[aria-label*="search" i]',
            );
          return hasSearch && interactiveCount < 15;
        }, false);
        if (searchOnly) signals.push('search_only');

        return { interactiveCount, headings, signals };
      })
      .catch(() => ({ interactiveCount: 0, headings: [] as string[], signals: [] as string[] }));

    return {
      url,
      title,
      interactiveElementCount: probe.interactiveCount,
      visibleHeadings: probe.headings,
      blockerSignals: probe.signals,
    };
  }

  private async readScrollY(): Promise<number> {
    try {
      const page = this.requirePage();
      // Browser-side helper; falls back to inline read if init script hasn't
      // run yet (e.g. before the first navigation).
      return await page.evaluate(() => {
        const w = window as unknown as { __webRecorder?: { scrollY: () => number } };
        return w.__webRecorder ? w.__webRecorder.scrollY() : Math.round(window.scrollY);
      });
    } catch {
      return 0;
    }
  }

  // ---------------------- Public read-only state probes (Director evidence)

  async scrollY(): Promise<number> {
    return this.readScrollY();
  }

  async pageTitle(): Promise<string> {
    try {
      return await this.requirePage().title();
    } catch {
      return '';
    }
  }

  async focusedValue(): Promise<string | null> {
    try {
      return await this.requirePage().evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        // Plain inputs / textareas
        const inputLike = el as HTMLInputElement | HTMLTextAreaElement;
        if (typeof inputLike.value === 'string') return inputLike.value;
        // Contenteditable (rich-text inputs, search bars on some sites)
        if (el.isContentEditable) return el.innerText ?? '';
        return null;
      });
    } catch {
      return null;
    }
  }

  async historyDepth(): Promise<number> {
    try {
      return await this.requirePage().evaluate(() => window.history.length);
    } catch {
      return 1;
    }
  }

  private async bboxOfSelector(
    selector: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const page = this.requirePage();
      const handle = page.locator(selector).first();
      const box = await handle.boundingBox({ timeout: 1000 });
      // A degenerate 0×0 box (an empty wrapper <a>/<span>, an unloaded <img>,
      // a layout-less node) is NOT a clickable target — clicking its origin
      // corner lands on nothing. Treat it like "no box" so callers
      // (resolveTarget, observeAll) skip it / fall through, rather than
      // emitting a dead coordinate click. See robustness-sweep-1 finding P2.
      if (!box || box.width < 1 || box.height < 1) return null;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    } catch {
      return null;
    }
  }

  /**
   * `bboxOfSelector` plus a cheap "is this element itself genuinely clickable
   * (vs a non-interactive wrapper)?" probe. Only used by `resolveTargetCandidates`
   * (a handful of calls per resolve) — `observeAll` keeps the plain
   * `bboxOfSelector` so it doesn't pay the extra evaluate() per element.
   */
  private async elementMetaOfSelector(
    selector: string,
  ): Promise<{ bbox: { x: number; y: number; width: number; height: number }; interactive: boolean } | null> {
    try {
      const page = this.requirePage();
      const handle = page.locator(selector).first();
      const box = await handle.boundingBox({ timeout: 1000 });
      if (!box || box.width < 1 || box.height < 1) return null;
      const interactive = await handle
        .evaluate((el) => {
          const e = el as HTMLElement;
          const tag = e.tagName.toLowerCase();
          if (tag === 'a' && e.hasAttribute('href')) return true;
          if (['button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
          const role = e.getAttribute('role');
          if (role && ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(role)) return true;
          if (e.hasAttribute('onclick')) return true;
          // A wrapper around the real clickable element — NOT itself the target.
          if (e.querySelector('a[href], button, [role="button"], [role="link"]')) return false;
          return false;
        })
        .catch(() => false);
      return { bbox: { x: box.x, y: box.y, width: box.width, height: box.height }, interactive };
    } catch {
      return null;
    }
  }

  private recordEntry(entry: ActionLogEntry): void {
    this.entries.push(entry);
  }

  /**
   * After Chromium starts with `--remote-debugging-port=0`, it writes the
   * actual port to `<userDataDir>/DevToolsActivePort`. We poll for the file,
   * read the first line as the port, then call `/json/version` to get the
   * browser-level CDP WebSocket URL Stagehand expects in `cdpUrl`.
   */
  private async resolveCdpUrl(userDataDir: string): Promise<string> {
    const portFile = join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + DEVTOOLS_PORT_FILE_TIMEOUT_MS;

    let portContent: string | null = null;
    while (Date.now() < deadline) {
      try {
        portContent = await readFile(portFile, 'utf8');
        if (portContent.includes('\n')) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, DEVTOOLS_PORT_FILE_POLL_MS));
    }
    if (!portContent) {
      throw new Error(
        `DevToolsActivePort not found in ${userDataDir} after ${DEVTOOLS_PORT_FILE_TIMEOUT_MS}ms`,
      );
    }
    const firstLine = portContent.split('\n')[0];
    if (!firstLine) {
      throw new Error('DevToolsActivePort file was empty');
    }
    const port = Number.parseInt(firstLine, 10);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid port in DevToolsActivePort: ${firstLine}`);
    }

    const versionUrl = `http://127.0.0.1:${port}/json/version`;
    const res = await fetch(versionUrl);
    if (!res.ok) {
      throw new Error(`GET ${versionUrl} returned ${res.status}`);
    }
    const json = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!json.webSocketDebuggerUrl) {
      throw new Error('webSocketDebuggerUrl missing from /json/version response');
    }
    return json.webSocketDebuggerUrl;
  }

  /**
   * Best-effort cleanup when start() fails partway through. Whatever was
   * acquired is released; errors are swallowed so the original failure is
   * the one that propagates.
   */
  private async cleanupPartial(): Promise<void> {
    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch {
        /* ignore */
      }
      this.stagehand = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* ignore */
      }
      this.context = null;
      this.page = null;
    }
    if (this.userDataDir) {
      const dir = this.userDataDir;
      this.userDataDir = null;
      rm(dir, { recursive: true, force: true }).catch(() => {
        /* ignore */
      });
    }
  }
}

/** Inclusive random int helper for randomized rendering parameters. */
function randInRange(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
