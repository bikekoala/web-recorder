import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import OpenAI from 'openai';

import { CustomOpenAIClient, Stagehand } from '@browserbasehq/stagehand';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { ActionLog, type ActionLogEntry } from '../../domain/action-log.js';
import {
  ElementNotFoundError,
  RecordingError,
  SessionStartError,
} from '../../domain/errors.js';
import type {
  IPageSession,
  ObservedElement,
  PageSessionConfig,
  ScrollEasing,
  SessionArtifacts,
} from '../../ports/page-session.js';
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

  constructor(cfg: StagehandPageSessionConfig) {
    this.cfg = {
      verbose: 1,
      ...cfg,
    };
  }

  // -------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.stagehand) {
      // Idempotent — already started.
      return;
    }

    await mkdir(this.cfg.outputDir, { recursive: true });

    // Step 1: launch Chromium via Playwright with recordVideo + a
    // remote-debugging-port so Stagehand can attach over CDP.
    try {
      this.userDataDir = await mkdtemp(join(tmpdir(), 'web-recorder-'));
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.cfg.headless,
        viewport: this.cfg.viewport,
        // 0 → Chromium picks a free port. We read it from DevToolsActivePort.
        args: ['--remote-debugging-port=0'],
        recordVideo: {
          dir: this.cfg.outputDir,
          size: this.cfg.viewport,
        },
        // `channel` is a Playwright option naming a Chromium variant
        // (chrome | msedge | ...). Undefined means "use bundled Chromium".
        ...(config.browserChannel ? { channel: config.browserChannel } : {}),
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
    this.logger.info(
      {
        model: config.llmModel,
        outputDir: this.cfg.outputDir,
        headless: this.cfg.headless,
        viewport: this.cfg.viewport,
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
    const page = this.requirePage();
    const stagehand = this.requireStagehand();

    try {
      const matches = await stagehand.observe(target, { page });
      const first = matches[0];
      if (!first) return null;
      const bbox = await this.bboxOfSelector(first.selector);
      return bbox
        ? { selector: first.selector, description: first.description, bbox }
        : { selector: first.selector, description: first.description };
    } catch (err) {
      this.logger.warn({ err, target }, 'resolveTarget failed');
      return null;
    }
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
      const handle = await locator.elementHandle({ timeout: 500 });
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

  private async bboxOfSelector(
    selector: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const page = this.requirePage();
      const handle = page.locator(selector).first();
      const box = await handle.boundingBox({ timeout: 1000 });
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
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
