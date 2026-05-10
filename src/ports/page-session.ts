import type { ActionLog, ActionLogEntry, Bbox, RecordingWindow, Viewport } from '../domain/action-log.js';

/**
 * Velocity profile for animated scrolls. See `IPageSession.scroll()` docs
 * for when to use which.
 */
export type ScrollEasing = 'inOutQuad' | 'outQuart' | 'outExpo' | 'linear';

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
 * - LLM planning (that is IPlanner — not yet defined)
 * - Cursor synthesis (that is ICursorSynthesizer — not yet defined)
 * - Final video composition (that is IComposer — not yet defined)
 */
export interface IPageSession {
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
   * Capture a PNG screenshot of the current viewport. Used by the planner
   * to "see" the page once before recording starts. Not logged.
   *
   * Always viewport-only (not full page) — the planner cares about what's
   * visible at decision time.
   */
  screenshot(): Promise<Buffer>;

  /**
   * Run a broad observe pass to collect candidate interactive elements
   * currently on the page. Used by the planner as ground-truth for what
   * exists. The instruction can be left empty to ask "everything notable".
   *
   * This is one LLM call (one observe round-trip). Used at most once per
   * job, BEFORE the recording window opens.
   */
  observeAll(instruction?: string): Promise<ObservedElement[]>;

  /**
   * Look up an element by natural-language target description and return
   * a stable selector + bbox for direct Playwright actions later. Used by
   * the runner to pre-resolve all `click` targets in the plan before the
   * recording window opens — keeps the recording window LLM-free.
   *
   * Returns null if the target can't be resolved (no LLM error thrown).
   */
  resolveTarget(target: string): Promise<ObservedElement | null>;

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
