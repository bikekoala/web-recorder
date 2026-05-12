import type {
  ActionLog,
  ActionLogEntry,
  Bbox,
  PageDiagnostic,
  RecordingWindow,
  Viewport,
} from '../domain/action-log.js';

export type { PageDiagnostic } from '../domain/action-log.js';

/**
 * Velocity profile for animated scrolls. See `IPageSession.scroll()` docs
 * for when to use which.
 */
export type ScrollEasing = 'inOutQuad' | 'outQuart' | 'outExpo' | 'linear';

/**
 * Part of {@link IPageSession.ariaSnapshot}'s contract: when the page's tree is
 * too large to fit the planner prompt even after pruning + scoping to `<main>`,
 * the returned string is cut at a line boundary and this exact marker is
 * appended as the last line. Consumers that want to know "was it truncated?"
 * test `snapshot.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER)`.
 */
export const ARIA_SNAPSHOT_TRUNCATION_MARKER =
  '... [accessibility tree truncated here — the page is large; nodes below this point are not shown; plan a scroll to reach them]';

/**
 * IPageSession is the only port the Stagehand prototype needs.
 *
 * Lifecycle: `start()` → many `goto/act/observe/scroll/wait` calls → `stop()`.
 * Cleanup is mandatory — callers MUST `stop()` even on error (use try/finally).
 *
 * Implementations are responsible for:
 * - Starting and tearing down the browser cleanly
 * - Recording video for the entire session window
 * - Recording an ActionLog with viewport coordinates and scrollY at each event
 * - Translating library exceptions into typed DomainErrors
 *
 * Implementations are NOT responsible for:
 * - LLM planning (that is IReconnoiterer)
 * - Cursor synthesis (that is ICursorSynthesizer — not yet defined)
 * - Final video composition (that is IComposer — not yet defined)
 */
export interface IPageSession {
  /** The viewport this session is rendering at (px). Stable for the session's lifetime. */
  readonly viewport: Viewport;

  /** Launch browser, open page, begin recording. Idempotent: safe to call once. */
  start(): Promise<void>;

  /** Navigate. Logged as a `goto` ActionLogEntry. */
  goto(url: string): Promise<void>;

  /**
   * AI-driven action. The instruction is in natural language, e.g.
   * "click the play button". The implementation resolves the target via the
   * underlying agent SDK (Stagehand for now) and performs the action.
   * Logged as an `act` ActionLogEntry.
   */
  act(instruction: string): Promise<void>;

  /**
   * AI-driven observation. Returns candidate elements matching the instruction
   * without performing any side-effecting action. Logged as `observe`.
   */
  observe(instruction: string): Promise<ObservedElement[]>;

  /**
   * Deterministic scroll. Implementations should perform a smooth scroll
   * (animated, not instantaneous) so the recording shows fluid motion.
   * Logged as `scroll`.
   *
   * Positive deltaY scrolls down. `durationMs` is a soft target; the
   * implementation may adjust ±50ms for animation framing.
   *
   * `easing` chooses the velocity profile:
   *  - 'inOutQuad' (default): symmetric S-curve. Reading-pace scrolls.
   *  - 'outQuart' : front-loaded decel. "Approach to known position".
   *  - 'outExpo'  : aggressive front-loaded. "Fling" — first stage of long scrolls.
   *  - 'linear'   : constant velocity. Mostly for debugging.
   */
  scroll(
    deltaY: number,
    opts?: { durationMs?: number; easing?: ScrollEasing },
  ): Promise<void>;

  /** Deterministic pause. Logged as `wait`. */
  wait(durationMs: number): Promise<void>;

  /**
   * Type into the currently focused element. `opts.preMs` (pause before the
   * first keystroke) and `opts.keystrokeMs` (inter-keystroke delay) override
   * the config defaults when provided. Caller must focus the field first.
   * Logged as `type`.
   */
  type(text: string, opts?: { preMs?: number; keystrokeMs?: number }): Promise<void>;

  /**
   * Press a single named key (Enter / Escape / Tab / arrow / Backspace).
   * Wraps Playwright `keyboard.press`. Logged as `key`.
   */
  pressKey(key: string): Promise<void>;

  /**
   * Browser-back navigation (equivalent to clicking the back button).
   * Wraps Playwright `page.goBack`. Logged as `back` with urlBefore/urlAfter.
   * Resolves when the navigation completes or times out.
   */
  goBack(): Promise<void>;

  /**
   * Block until the DOM has been quiet (no mutations) for `quietMs`, or
   * until the hard deadline `maxMs` is hit, whichever comes first. Use this
   * after a `goto` or after an action that triggers re-render to know that
   * the page is "visually settled" before deciding what to do next.
   *
   * Logged as a `visual_stable` ActionLogEntry with the actual time waited
   * and a `timedOut` flag.
   */
  waitForVisualStability(opts?: { quietMs?: number; maxMs?: number }): Promise<void>;

  /** Current URL of the active page. Read-only. */
  currentUrl(): Promise<string>;

  /**
   * Length of the browser history stack as seen from JS (`window.history.length`).
   * Used by the Director to decide whether `back()` is safe — when depth is 1,
   * the only entry is the initial page and `back()` will land on `about:blank`
   * (the default blank tab page). Returns 1 if the session can't read history.
   *
   * Added in §0032 after the github white-screen finding showed `back()` from
   * a single-entry history landing on about:blank and ruining the recording.
   */
  historyDepth(): Promise<number>;

  /**
   * Current document scroll position in px. Read-only. Used by the
   * Director to capture before/after evidence for `scroll` actions.
   * Returns 0 if the session can't read scroll state.
   */
  scrollY(): Promise<number>;

  /**
   * Title of the currently-loaded page. Read-only. Used by the Director
   * to detect whether a click triggered navigation/SPA-route change
   * even when the URL doesn't update (turbo-frame, hash routing).
   */
  pageTitle(): Promise<string>;

  /**
   * Read the current value of the focused input/textarea/contenteditable.
   * Returns null if nothing is focused or the focused element has no
   * meaningful "value". Used by the Director to verify that a `type`
   * action actually landed text in the right field (catches the
   * "agent typed twice because it didn't see the first one" failure).
   */
  focusedValue(): Promise<string | null>;

  /**
   * Capture a PNG screenshot of the current viewport. Used by the planner
   * to "see" the page once before recording starts. Not logged.
   *
   * Always viewport-only (not full page) — the planner cares about what's
   * visible at decision time.
   */
  screenshot(): Promise<Buffer>;

  /**
   * Capture a *ref-tagged accessibility snapshot* of the page in its current
   * state — Playwright's `mode: 'ai'`: a YAML-ish tree where every actionable
   * node carries a stable id like `[ref=e7]`, and `<iframe>` contents are
   * inlined. Returned as text, capped at `opts.depth` levels (the implementation
   * supplies a config default). On any failure, returns `''`.
   *
   * The refs are valid ONLY in the page state at snapshot time — a navigation
   * or a subsequent `ariaSnapshot()` invalidates them; resolve them (via
   * {@link resolveAriaRef}) before doing anything that changes the page.
   *
   * This is the recon planner's view of the page (it replaced `observeAll()` in
   * that role — see ADR §0036). Not an LLM call: deterministic, cheap.
   */
  ariaSnapshot(opts?: { depth?: number }): Promise<string>;

  /**
   * Resolve a ref from the most recent {@link ariaSnapshot} into a *durable*
   * target: `{selector, bbox, description}` where `selector` is a derived
   * CSS/XPath that survives a page reset (not the transient `aria-ref=eN`),
   * `bbox` is the element's box, and `description` is its accessible-ish name
   * (for logs / the dead-click sweep's fuzzy fallback — not for matching).
   *
   * The recon resolves every draft click/type `ref` through this, immediately
   * after the snapshot, while the refs are still valid. Returns null if the ref
   * is stale / detached / 0×0 / can't be given a durable selector. Never throws.
   */
  resolveAriaRef(ref: string): Promise<ObservedElement | null>;

  /**
   * Run a broad observe pass to collect candidate interactive elements
   * currently on the page. One LLM call (one observe round-trip).
   *
   * No longer used by the recon planner (which uses {@link ariaSnapshot} since
   * ADR §0036) — retained for other consumers.
   */
  observeAll(instruction?: string): Promise<ObservedElement[]>;

  /**
   * Look up an element by natural-language target description and return
   * a stable selector + bbox via Stagehand `observe()`. Returns null if the
   * target can't be resolved (no LLM error thrown).
   *
   * No longer used by the recon planner / rehearsal walk's normal path (a fuzzy
   * re-match — ADR §0036 replaced it with deterministic ref resolution).
   * {@link resolveTargetCandidates} is still used by the walk's dead-click
   * *recovery* sweep, and this is retained for other consumers.
   */
  resolveTarget(target: string): Promise<ObservedElement | null>;

  /**
   * Like `resolveTarget`, but returns ALL candidate matches that have a real
   * sized bbox (not just the best one), ranked best-first: genuinely
   * interactive elements (`<a href>`, `<button>`, `[role=link|button]`, …)
   * ahead of bare wrappers, original observe order preserved within a group,
   * de-duplicated by position. `resolveTarget` is `resolveTargetCandidates()[0]`.
   *
   * Used by the rehearsal walk: when a click on the best candidate turns out
   * dead (the page didn't change), it re-tries the remaining candidates here
   * before falling back to the (expensive) LLM reconverge. Empty array if
   * nothing resolves. Never throws.
   */
  resolveTargetCandidates(target: string): Promise<ObservedElement[]>;

  /**
   * Resolve an element by its *exact visible text* via cheap Playwright
   * role/text matchers (`getByRole('link', {name})` → `getByRole('button',
   * {name})` → `getByText(text, {exact:true})`), returning the first match
   * whose bbox is sized (≥ 1×1) and visible, else null.
   *
   * No LLM, and — unlike {@link resolveTargetCandidates} (`stagehand.observe()`)
   * — no DOM serialization, so it scales to arbitrarily large pages where the
   * `observe()`-based fallback overflows the model context. The recon uses this
   * (with the draft's `targetText`) as the first fallback when a click `ref`
   * misses. Returns null if nothing matches; never throws.
   */
  resolveByVisibleText(text: string): Promise<ObservedElement | null>;

  /**
   * Fast non-LLM element finder by natural-language description.
   *
   * Tries cheap Playwright matchers in order:
   *   1. text= match (visible text equality / substring)
   *   2. role+name match (e.g. button "Subscribe")
   *   3. partial text match (case-insensitive contains)
   *
   * Returns the first match's selector + bbox if found, else null.
   * Crucially: returns null FAST (no LLM, no full DOM walk) so the
   * Director can do an in-viewport check in milliseconds.
   *
   * Used by the Director's `click` executor:
   * - present in viewport → run discovery click
   * - not in viewport, but on page → run search loop
   * - not on page at all → bubble back to LLM as failure
   */
  quickFindInViewport(description: string): Promise<ObservedElement | null>;

  /**
   * Same as `quickFindInViewport` but searches the entire page (not just
   * the visible viewport). Used by the search loop to know whether
   * scrolling will eventually reveal the target.
   */
  quickFindOnPage(description: string): Promise<ObservedElement | null>;

  /**
   * Click an already-resolved selector. This is a Playwright-native click
   * (real OS-level events), so it triggers actual navigation, hover state,
   * etc. — unlike Stagehand's CDP-synthesized act.
   *
   * Used by the runner to execute pre-resolved click steps inside the
   * recording window without an LLM in the loop.
   *
   * Logged as a `click` ActionLogEntry.
   */
  clickSelector(selector: string, opts?: { description?: string }): Promise<void>;

  /**
   * Click at a viewport pixel (CSS px from the viewport top-left). Used when
   * we have a resolved bbox and prefer coordinate-clicking over a (possibly
   * stale) selector. Logged as a `click` entry with a synthetic `coord(...)`
   * selector. `opts.description` is carried into the log for grep-ability.
   */
  clickAt(x: number, y: number, opts?: { description?: string }): Promise<void>;

  /**
   * Click an element by natural-language description, using the search loop
   * if needed. Throws `ElementNotFoundError` if the target cannot be located
   * even after scroll-searching up to `searchBudgetPx`.
   *
   * Logged as a `click` ActionLogEntry plus zero-or-more `scroll` entries
   * for the search phase.
   */
  clickByDescription(
    description: string,
    opts?: { searchBudgetPx?: number },
  ): Promise<void>;

  /**
   * Mark the moment the *useful* recording window starts. The session has
   * been recording video since `start()`, but everything before this call
   * (browser launch, page load, settling) is "setup time" the user does not
   * want in the final clip. Trimming layers downstream consume this marker
   * to produce a clean output.
   *
   * Logged as a `recording_start` ActionLogEntry. Idempotent — second call
   * is a no-op.
   */
  beginRecording(): Promise<void>;

  /**
   * Stop the session. Closes browser context (which finalizes the recordVideo
   * file), returns the artifact paths and the validated ActionLog.
   *
   * MUST be called even if other methods threw, to guarantee cleanup.
   * Calling stop more than once is a no-op after the first call.
   */
  stop(): Promise<SessionArtifacts>;

  /**
   * Session-relative time in ms (the same clock as ActionLogEntry.t). Use
   * this when constructing entries to append via {@link appendEntry}.
   * Returns 0 before {@link start} has been called.
   */
  nowMs(): number;

  /**
   * Append an arbitrary entry to the action log. Used by upstream layers
   * (Director, RecordJobRunner) to record introspection data —
   * `decision`, `decision_failure`, `page_diagnostic` — without going
   * through one of the dedicated action methods.
   *
   * The session itself owns the action log; this is the single mutation
   * point for upstream callers.
   */
  appendEntry(entry: ActionLogEntry): void;

  /**
   * Read coarse page-health signals — title, interactive element count,
   * top visible headings, and detected blocker signals (e.g.
   * `consent_dialog`, `auth_modal`, `play_overlay`, `search_only`).
   *
   * Surfaced to the reconnoiterer (so it can fold blocker dismissal into
   * the Performance) and captured by the session itself at `recording_start`
   * as a `page_diagnostic` entry in the action log.
   *
   * The returned shape excludes `t`, `scrollY`, and `viewport` — those are
   * filled in by the caller if/when the snapshot is logged. Heuristic-only;
   * false positives/negatives are expected.
   *
   * Best-effort: implementations should never throw; on failure return a
   * conservative empty snapshot.
   */
  pageDiagnostic(): Promise<PageDiagnostic>;
}

export interface ObservedElement {
  selector: string;
  description: string;
  bbox?: Bbox;
}

export interface SessionArtifacts {
  /** Absolute path to the raw recorded video file (.webm), unedited. */
  videoPath: string;
  /** Absolute path to the persisted ActionLog JSON. */
  actionLogPath: string;
  /** Parsed ActionLog (also written to disk at actionLogPath). */
  actionLog: ActionLog;
  /** Final viewport size used during the session. */
  viewport: Viewport;
  /**
   * If `beginRecording()` was called, this is the recording window — the
   * subset of the raw video that the runner / trim layer will keep. When
   * null, treat the whole video as the recording.
   */
  recording: RecordingWindow | null;
}

/**
 * Configuration for constructing a session. Adapter-agnostic — specific
 * adapters (StagehandPageSession) may extend this with their own options.
 */
export interface PageSessionConfig {
  /** Where the video and action log will be written. Created if missing. */
  outputDir: string;
  /** Run the browser with a visible window (development) vs headless (production). */
  headless: boolean;
  /** Viewport size. */
  viewport: Viewport;
}
