import { resolve } from 'node:path';

import type { ActionLogEntry, RecordingWindow } from '../domain/action-log.js';
import type { BriefingHintForState } from '../domain/director-state.js';
import { countMatchedHints } from '../domain/intent-matching.js';
import { trimVideo, videoDurationMs } from '../infra/ffmpeg.js';
import { logger as rootLogger } from '../infra/logger.js';
import { track } from '../infra/pending.js';
import type { DirectorReport, IDirector, PrefiredDecision } from '../ports/director.js';
import type { IFastDecider } from '../ports/fast-decider.js';
import type { IPageSession } from '../ports/page-session.js';
import type { IPlanner } from '../ports/planner.js';
import type { BlockerPrelude, BlockerPreludeReport } from './blocker-prelude.js';

/**
 * Orchestrates a single recording job end-to-end.
 *
 * Pipeline (this is the canonical path; see decisions §0001/§0006):
 *
 *   1. Page setup (NOT recorded)
 *      - session.start()              browser + recordVideo begin
 *      - session.goto(url)
 *      - session.waitForVisualStability()
 *
 *   2. Brief + pre-resolve (NOT recorded — happens BEFORE the recording window)
 *      - session.screenshot()         visual context for planner
 *      - planner.brief(...)           ONE LLM call → DirectorBriefing
 *        (resolveTarget calls happen inside brief())
 *
 *   3. BlockerPrelude (NOT recorded — also BEFORE the recording window)
 *      - blockerPrelude.run(...)      probe → dismiss loop → re-probe.
 *        Skipped if the runner was constructed without one.
 *        Why pre-recording: dismissing in the deliverable shows clicks the
 *        user did not ask for and eats the budget. Doing it here is free
 *        and produces a cleaner deliverable. (goals.md #2 #3.)
 *
 *   4. Record window (RECORDED — owned by IDirector)
 *      - director.run(briefing, session)
 *
 *   5. Stop + trim (NOT recorded)
 *      - session.stop()               raw .webm finalized
 *      - ffmpeg trim raw → recording.webm using session.recording window
 *
 * The runner owns the *job*, not the session. Sessions can be reused (with
 * different runners) in the future if we want batched jobs in one browser.
 */

export interface RunRequest {
  url: string;
  prompt: string;
  durationMs: number;
  /** Output directory for video + log artifacts. Created if missing. */
  outputDir: string;
}

export interface RunResult {
  /** Trimmed video (the deliverable). */
  videoPath: string;
  /** Raw video before trim. Useful for debugging / cursor synth later. */
  rawVideoPath: string;
  actionLogPath: string;
  metrics: RunMetrics;
  directorReport: DirectorReport;
}

export interface RunMetrics {
  totalWallClockMs: number;
  setupMs: number;          // session.start through screenshot
  planMs: number;           // planner.brief() call (includes resolveTarget calls)
  preResolveMs: number;     // always 0 — hints are pre-resolved inside brief()
  recordingMs: number;      // director.run duration
  trimMs: number;           // ffmpeg
  rawVideoMs: number | null;
  trimmedVideoMs: number | null;
  /** Number of click hints that resolved successfully before recording. */
  resolvedClicks: number;
  /** Number of click steps that fell back to runtime resolution (slow path). */
  fallbackClicks: number;
  /** Stable-step deadline timeouts during recording. */
  stableTimeouts: number;
  /** BlockerPrelude summary, or null if the runner was constructed without one. */
  blockerPrelude: BlockerPreludeReport | null;
  /**
   * Best-effort categorical answer to "did we do what the user asked?".
   *
   * The contract this project promises (see docs/goals.md hard
   * non-negotiable #3): user intent is satisfied OR transparently not.
   * This field is the "transparently" half — operators reviewing a run
   * can see at a glance whether every click hint extracted by the planner
   * actually got executed inside the recording window, and whether any
   * scroll happened.
   *
   * Heuristic only: when the planner can't extract specific click hints
   * from a vague prompt (`hintsResolvedPreRecording === 0`), we return
   * `level: 'unknown'` rather than guessing. The action log is still the
   * source of truth — this is a digest.
   */
  intentSatisfaction: IntentSatisfaction;
}

export interface IntentSatisfaction {
  /** == briefing.hints.length. Click targets the planner identified. */
  hintsResolvedPreRecording: number;
  /** Count of `click` ActionLogEntry inside the recording window. */
  clicksExecuted: number;
  /** Count of `scroll` ActionLogEntry inside the recording window. */
  scrollsExecuted: number;
  level: 'complete' | 'partial' | 'unmet' | 'unknown';
  /** One-sentence human-readable summary. */
  note: string;
}

export class RecordJobRunner {
  private readonly logger = rootLogger.child({ component: 'RecordJobRunner' });

  constructor(
    private readonly session: IPageSession,
    private readonly planner: IPlanner,
    private readonly director: IDirector,
    /**
     * Optional pre-recording blocker dismissal phase. When null, the runner
     * skips it and goes straight from brief() → director.run.
     */
    private readonly blockerPrelude: BlockerPrelude | null = null,
    /**
     * Optional FastDecider used for COLD-START PRE-FIRE. When provided, the
     * runner fires Decision 1 IN PARALLEL with the BlockerPrelude (using a
     * fresh post-prelude screenshot), so by the time `recording_start`
     * happens, the LLM call is already in flight or complete. The Director
     * then uses the pre-fired decision instead of cold-starting.
     *
     * This hides the 1-7s LLM cold-start latency that previously consumed
     * up to 70% of a 10s recording budget. Architectural improvement, not a
     * tunable — leave null only for tests that don't want streaming.
     */
    private readonly preFireDecider: IFastDecider | null = null,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const wallClockT0 = Date.now();

    // ----------------------------------- 1. Setup
    const tSetup = Date.now();
    await this.session.start();
    await this.session.goto(req.url);

    // Take an early screenshot for the Planner. Stability wait runs in
    // parallel via Promise.all below.
    const tScreenshot = Date.now();
    const screenshot = await this.session.screenshot().catch(() => null);
    const screenshotMs = Date.now() - tScreenshot;

    // Planner brief() runs in parallel with visual stability.
    const tBrief = Date.now();
    const briefingTask = this.planner.brief(
      {
        url: req.url,
        prompt: req.prompt,
        durationMs: req.durationMs,
        viewport: this.viewportFromSession(),
        screenshot,
      },
      this.session,
    );
    const stabilityTask = this.session.waitForVisualStability({
      quietMs: 400,
      maxMs: 3000,
    });
    const [briefing] = await Promise.all([briefingTask, stabilityTask]);
    const briefMs = Date.now() - tBrief;
    const setupMs = Date.now() - tSetup;
    this.logger.info({ setupMs, screenshotMs, briefMs, hintCount: briefing.hints.length }, 'setup + brief complete');

    // ------------------------------------ 2. BlockerPrelude (NOT recorded)
    // Probe the page for visual blockers (cookie/consent dialogs, paused-video
    // play overlays, login modals). If any are present, dismiss them BEFORE
    // the recording window opens so the deliverable starts on a clean page.
    // Failures here never break the run — see BlockerPrelude.run() docs.
    const blockerPreludeReport = this.blockerPrelude
      ? await this.blockerPrelude.run(this.session, briefing)
      : null;
    if (blockerPreludeReport) {
      this.logger.info(
        {
          iterations: blockerPreludeReport.iterations,
          endReason: blockerPreludeReport.endReason,
          resolved: blockerPreludeReport.resolvedSignals,
          remaining: blockerPreludeReport.remainingSignals,
          totalMs: blockerPreludeReport.totalMs,
        },
        'blocker prelude complete',
      );
    }

    // ------------------------------------ 2b. Cold-start pre-fire (NOT recorded)
    // Fire the Director's first decision NOW, before recording_start, using
    // a fresh post-prelude screenshot. The LLM call runs in parallel with
    // the recording-window animation, hiding its 1-7s cold-start latency.
    // See ports/director.ts PrefiredDecision for the contract.
    const prefiredDecision = this.preFireDecider
      ? await this.prefireFirstDecision(briefing, this.preFireDecider)
      : null;

    // ------------------------------------ 3. Director (owns recording window)
    const directorReport = await this.director.run(
      briefing,
      this.session,
      prefiredDecision ? { prefiredDecision } : {},
    );

    // ------------------------------------ 3. Stop + trim
    const artifacts = await this.session.stop();

    const tTrim = Date.now();
    let videoPath = artifacts.videoPath;
    if (artifacts.recording) {
      const out = resolve(req.outputDir, 'recording.webm');
      await trimVideo(
        artifacts.videoPath,
        out,
        artifacts.recording.startedAtMs,
        artifacts.recording.endedAtMs,
      );
      videoPath = out;
    }
    const trimMs = Date.now() - tTrim;

    const rawVideoMs = await videoDurationMs(artifacts.videoPath).catch(() => null);
    const trimmedVideoMs = await videoDurationMs(videoPath).catch(() => null);

    const intentSatisfaction = computeIntentSatisfaction(
      briefing.hints.map((h) => h.description),
      artifacts.actionLog.entries,
      artifacts.recording,
    );

    const metrics: RunMetrics = {
      totalWallClockMs: Date.now() - wallClockT0,
      setupMs,
      planMs: briefMs,
      preResolveMs: 0,                         // hints are pre-resolved inside brief()
      recordingMs: directorReport.totalMs,
      trimMs,
      rawVideoMs,
      trimmedVideoMs,
      resolvedClicks: briefing.hints.length,
      fallbackClicks: 0,
      stableTimeouts: 0,                       // tracked by Director if needed
      blockerPrelude: blockerPreludeReport,
      intentSatisfaction,
    };

    if (intentSatisfaction.level === 'unmet' || intentSatisfaction.level === 'partial') {
      this.logger.warn(
        { intentSatisfaction },
        'recording finished but user intent not fully satisfied — review action log',
      );
    } else {
      this.logger.info({ intentSatisfaction }, 'intent satisfaction summary');
    }

    return {
      videoPath,
      rawVideoPath: artifacts.videoPath,
      actionLogPath: artifacts.actionLogPath,
      metrics,
      directorReport,
    };
  }

  // ----------------------------------------------------------- internals

  /**
   * Fire the Director's first FastDecider call now (before recording_start)
   * using a fresh screenshot. Returns a `PrefiredDecision` the Director will
   * use as its Decision 1 instead of cold-starting.
   *
   * Best-effort: if anything in here throws (screenshot fail, session not
   * ready), we log and return null — the Director will cold-start as a
   * fallback. We never let pre-fire break a recording.
   */
  private async prefireFirstDecision(
    briefing: import('../domain/plan.js').DirectorBriefing,
    decider: IFastDecider,
  ): Promise<PrefiredDecision | null> {
    try {
      const screenshot = await this.session.screenshot();
      const scrollY = (this.session as unknown as { scrollY?: number }).scrollY ?? 0;
      const viewport = this.viewportFromSession();
      // Approximate "remainingMs" — actual recording window starts moments
      // after this fires. Pass durationMs as a lower bound; the LLM treats
      // this as a hint, not a hard constraint.
      const state = {
        prompt: briefing.prompt,
        remainingMs: briefing.durationMs,
        currentScrollY: scrollY,
        viewport,
        screenshot,
        briefingHints: enrichHintsForState(briefing.hints, scrollY, viewport),
        recentActions: [],
      };
      const firedAtMs = Date.now();
      const tracked = track(decider.decide(state));
      this.logger.info(
        { firedAtMs, scrollYAtFire: scrollY, hintCount: state.briefingHints.length },
        'pre-fired Decision 1 (cold-start hidden)',
      );
      // Build the PrefiredDecision shape required by the Director.
      return {
        promise: tracked.promise,
        get isResolved() { return tracked.isResolved; },
        get value() { return tracked.value; },
        get error() { return tracked.error; },
        firedAtMs,
        scrollYAtFire: scrollY,
      };
    } catch (err) {
      this.logger.warn({ err }, 'pre-fire failed; Director will cold-start');
      return null;
    }
  }

  private viewportFromSession(): { width: number; height: number } {
    // The session config currently isn't exposed via IPageSession; we read it
    // via a fallback to the global config. Acceptable for now — see "future
    // improvement" comment in IPageSession (no method for this yet).
    const viewport = (this.session as unknown as {
      cfg?: { viewport: { width: number; height: number } };
    }).cfg?.viewport;
    return viewport ?? { width: 1280, height: 720 };
  }
}

/**
 * Surface ALL planner hints with viewport-relative position. Same algorithm
 * as the StreamingDirector's `enrichHints` — kept here so the runner's
 * pre-fire path doesn't need to import an internal of an adapter. Both
 * sides agree on shape via `BriefingHintForState`.
 */
function enrichHintsForState(
  hints: import('../domain/plan.js').ClickHint[],
  scrollY: number,
  viewport: { width: number; height: number },
): BriefingHintForState[] {
  return hints.map((h) => {
    const yInView = h.bboxAtRest.y - scrollY;
    if (yInView >= 0 && yInView < viewport.height) {
      return { description: h.description, position: 'in_view' as const, scrollToReveal: 0 };
    }
    if (yInView < 0) {
      return {
        description: h.description,
        position: 'above' as const,
        scrollToReveal: Math.round(yInView - viewport.height * 0.35),
      };
    }
    return {
      description: h.description,
      position: 'below' as const,
      scrollToReveal: Math.round(yInView - viewport.height * 0.35),
    };
  });
}

/**
 * Categorize "did the agent do what the user asked?" using only the action
 * log + the planner's pre-resolved hint descriptions. Heuristic — when the
 * planner couldn't extract specific click targets we return `'unknown'`.
 *
 * Crucially: counts UNIQUE hints that received at least one click, not
 * total clicks. Re-clicking the same input field 8 times does NOT count
 * as 8 hints satisfied — it counts as ONE hint satisfied.
 *
 * Hint↔click matching uses normalized substring overlap: each hint
 * description is reduced to its content words and we count a hint as
 * "clicked" if some click's description shares ≥1 content word with it.
 * This is intentionally lenient — the planner's hint and the LLM's click
 * description rarely match verbatim ("the simplified Chinese link" vs
 * "click 简体中文链接").
 *
 * Only entries inside the recording window count. Setup-phase clicks
 * (BlockerPrelude dismissals) are excluded — those are not user intent.
 */
export function computeIntentSatisfaction(
  hintDescriptions: ReadonlyArray<string>,
  entries: ActionLogEntry[],
  window: RecordingWindow | null,
): IntentSatisfaction {
  const inWindow = (e: ActionLogEntry): boolean =>
    !window ? true : e.t >= window.startedAtMs && e.t <= window.endedAtMs;

  const windowEntries = entries.filter(inWindow);
  const clicks = windowEntries.filter(
    (e): e is ActionLogEntry & { type: 'click'; description?: string } =>
      e.type === 'click',
  );
  const scrolls = windowEntries.filter((e) => e.type === 'scroll');
  const types = windowEntries.filter((e) => e.type === 'type');

  const clicksExecuted = clicks.length;
  const scrollsExecuted = scrolls.length;

  // Count UNIQUE click targets via 1-to-1 best-match assignment (§0033).
  // Each click satisfies at most ONE hint; greedy descending overlap score
  // picks the global pairing. Replaces the prior many-to-many `filter+some`
  // loop that over-credited when descriptions shared a single UI noun
  // (e.g. "the X link" matching "the Y link" on bare "link").
  const clickDescriptions = clicks.map((c) => c.description ?? '').filter(Boolean);
  const hintsClicked = countMatchedHints(hintDescriptions, clickDescriptions);

  const totalHints = hintDescriptions.length;
  let level: IntentSatisfaction['level'];
  let note: string;

  if (totalHints === 0) {
    // Vague prompt — can't score against hints.
    if (clicksExecuted === 0 && scrollsExecuted === 0 && types.length === 0) {
      level = 'unmet';
      note = 'no hints, no actions executed in recording window';
    } else {
      level = 'unknown';
      note = `no specific click hints; ${clicksExecuted} click(s), ${scrollsExecuted} scroll(s), ${types.length} type(s)`;
    }
  } else if (hintsClicked === totalHints && scrollsExecuted >= 1) {
    level = 'complete';
    note = `all ${totalHints} hint(s) clicked at least once + scrolling occurred`;
  } else if (hintsClicked === totalHints) {
    level = 'partial';
    note = `all ${totalHints} hint(s) clicked but no scrolling — user may have asked for both`;
  } else if (hintsClicked > 0) {
    level = 'partial';
    note = `${hintsClicked}/${totalHints} unique hint(s) actually clicked`;
  } else {
    level = 'unmet';
    note = `0/${totalHints} hint(s) actually clicked (clicksExecuted=${clicksExecuted} but none matched hint descriptions)`;
  }

  return {
    hintsResolvedPreRecording: totalHints,
    clicksExecuted,
    scrollsExecuted,
    level,
    note,
  };
}

// (Helpers `descriptionsMatch` / `contentTokens` moved to
//  src/domain/intent-matching.ts — shared with StreamingDirector.)
