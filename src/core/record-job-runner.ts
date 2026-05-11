import { resolve } from 'node:path';

import type { ActionLogEntry, RecordingWindow, Viewport } from '../domain/action-log.js';
import { countMatchedHints } from '../domain/intent-matching.js';
import type { Performance, PerformanceStep } from '../domain/performance.js';
import { trimVideo, videoDurationMs } from '../infra/ffmpeg.js';
import { logger as rootLogger } from '../infra/logger.js';
import type { DirectorReport, IDirector } from '../ports/director.js';
import type { IPageSession } from '../ports/page-session.js';
import type { IReconnoiterer } from '../ports/reconnoiterer.js';
import type { BlockerPrelude, BlockerPreludeReport } from './blocker-prelude.js';

/**
 * Orchestrates a single recording job end-to-end ("prophet" pipeline, ADR §0034).
 *
 * Pipeline (this is the canonical path; see decisions §0001/§0034):
 *
 *   1. Page setup (NOT recorded)
 *      - session.start()              browser + recordVideo begin
 *      - session.goto(url)
 *      - session.waitForVisualStability()
 *
 *   2. Reconnaissance (NOT recorded — happens BEFORE the recording window)
 *      - session.screenshot()         visual context for the reconnoiterer
 *      - reconnoiterer.recon(...)     ALL reasoning happens here: observe the
 *        page, resolve every target to a selector+bbox, decide per-step
 *        pacing, set expectAfter → returns a complete, paced Performance.
 *
 *   3. BlockerPrelude (NOT recorded — also BEFORE the recording window)
 *      - blockerPrelude.run(...)      probe → dismiss loop → re-probe.
 *        Skipped if the runner was constructed without one.
 *        Why pre-recording: dismissing in the deliverable shows clicks the
 *        user did not ask for and eats the budget. Doing it here is free
 *        and produces a cleaner deliverable. (goals.md #2 #3.)
 *
 *   4. Record window (RECORDED — owned by IDirector / PerformanceDirector)
 *      - director.run(performance, session)
 *        Deterministic playback of the Performance. Single re-plan checkpoint
 *        per step that carries an expectAfter is the only recovery path —
 *        no per-action LLM calls inside the recording window.
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
  /** The pre-resolved, paced Performance produced by reconnaissance. */
  performance: Performance;
  metrics: RunMetrics;
  directorReport: DirectorReport;
}

export interface RunMetrics {
  totalWallClockMs: number;
  setupMs: number;          // session.start through screenshot
  reconMs: number;          // reconnoiterer.recon() call (includes resolveTarget calls)
  recordingMs: number;      // director.run duration
  trimMs: number;           // ffmpeg
  rawVideoMs: number | null;
  trimmedVideoMs: number | null;
  /** Steps in the original Performance the reconnoiterer produced. */
  plannedSteps: number;
  /** Re-plan checkpoints triggered during playback (from directorReport). */
  replanCount: number;
  /** BlockerPrelude summary, or null if the runner was constructed without one. */
  blockerPrelude: BlockerPreludeReport | null;
  /**
   * Best-effort categorical answer to "did we do what the user asked?".
   *
   * The contract this project promises (see docs/goals.md hard
   * non-negotiable #3): user intent is satisfied OR transparently not.
   * This field is the "transparently" half — operators reviewing a run
   * can see at a glance whether every click target the reconnoiterer
   * resolved actually got executed inside the recording window, and
   * whether any scroll happened.
   *
   * Heuristic only: when the Performance has no `click` steps
   * (`hintsResolvedPreRecording === 0`), we return `level: 'unknown'`
   * rather than guessing. The action log is still the source of truth —
   * this is a digest.
   */
  intentSatisfaction: IntentSatisfaction;
}

export interface IntentSatisfaction {
  /** Count of `click` steps in the planned Performance. */
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
    private readonly reconnoiterer: IReconnoiterer,
    private readonly director: IDirector,
    /**
     * Optional pre-recording blocker dismissal phase. When null, the runner
     * skips it and goes straight from recon() → director.run.
     */
    private readonly blockerPrelude: BlockerPrelude | null = null,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const wallClockT0 = Date.now();

    // ----------------------------------- 1. Setup
    const tSetup = Date.now();
    await this.session.start();
    await this.session.goto(req.url);

    // Take an early screenshot for the reconnoiterer. Stability wait runs in
    // parallel via Promise.all below.
    const tScreenshot = Date.now();
    const screenshot = await this.session.screenshot().catch(() => null);
    const screenshotMs = Date.now() - tScreenshot;

    // Reconnaissance runs in parallel with visual stability.
    const tRecon = Date.now();
    const reconTask = this.reconnoiterer.recon(
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
    const [performance] = await Promise.all([reconTask, stabilityTask]);
    const reconMs = Date.now() - tRecon;
    const setupMs = Date.now() - tSetup;
    this.logger.info(
      { setupMs, screenshotMs, reconMs, plannedSteps: performance.steps.length },
      'setup + recon complete',
    );

    // ------------------------------------ 2. BlockerPrelude (NOT recorded)
    // Probe the page for visual blockers (cookie/consent dialogs, paused-video
    // play overlays, login modals). If any are present, dismiss them BEFORE
    // the recording window opens so the deliverable starts on a clean page.
    // Failures here never break the run — see BlockerPrelude.run() docs.
    const blockerPreludeReport = this.blockerPrelude
      ? await this.blockerPrelude.run(this.session, req.prompt)
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

    // ------------------------------------ 3. Director (owns recording window)
    const directorReport = await this.director.run(performance, this.session);

    // ------------------------------------ 4. Stop + trim
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
      performance.steps
        .filter((s): s is Extract<PerformanceStep, { kind: 'click' }> => s.kind === 'click')
        .map((s) => s.target.description),
      artifacts.actionLog.entries,
      artifacts.recording,
    );

    const metrics: RunMetrics = {
      totalWallClockMs: Date.now() - wallClockT0,
      setupMs,
      reconMs,
      recordingMs: directorReport.totalMs,
      trimMs,
      rawVideoMs,
      trimmedVideoMs,
      plannedSteps: performance.steps.length,
      replanCount: directorReport.replanCount,
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
      performance,
      metrics,
      directorReport,
    };
  }

  // ----------------------------------------------------------- internals

  private viewportFromSession(): Viewport {
    // The session config currently isn't exposed via IPageSession; we read it
    // via a fallback to a sensible default. Acceptable for now — see "future
    // improvement" comment in IPageSession (no method for this yet).
    const viewport = (this.session as unknown as {
      cfg?: { viewport: Viewport };
    }).cfg?.viewport;
    return viewport ?? { width: 1280, height: 720 };
  }
}

/**
 * Categorize "did the agent do what the user asked?" using only the action
 * log + the reconnoiterer's resolved click-target descriptions. Heuristic —
 * when the Performance has no `click` steps we return `'unknown'`.
 *
 * Crucially: counts UNIQUE targets that received at least one click, not
 * total clicks. Re-clicking the same input field 8 times does NOT count
 * as 8 targets satisfied — it counts as ONE.
 *
 * Target↔click matching uses 1-to-1 best-match assignment (§0033): each
 * click satisfies at most ONE target; greedy descending overlap score picks
 * the global pairing. This is intentionally lenient on the *content* of each
 * description — the reconnoiterer's target description and the click
 * description rarely match verbatim ("the simplified Chinese link" vs
 * "click 简体中文链接") — but strict on cardinality, so a single click can't
 * be credited toward multiple unrelated targets via a shared UI noun.
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
    // No click steps in the Performance — can't score against targets.
    if (clicksExecuted === 0 && scrollsExecuted === 0 && types.length === 0) {
      level = 'unmet';
      note = 'no click targets, no actions executed in recording window';
    } else {
      level = 'unknown';
      note = `no click targets; ${clicksExecuted} click(s), ${scrollsExecuted} scroll(s), ${types.length} type(s)`;
    }
  } else if (hintsClicked === totalHints && scrollsExecuted >= 1) {
    level = 'complete';
    note = `all ${totalHints} target(s) clicked at least once + scrolling occurred`;
  } else if (hintsClicked === totalHints) {
    level = 'partial';
    note = `all ${totalHints} target(s) clicked but no scrolling — user may have asked for both`;
  } else if (hintsClicked > 0) {
    level = 'partial';
    note = `${hintsClicked}/${totalHints} unique target(s) actually clicked`;
  } else {
    level = 'unmet';
    note = `0/${totalHints} target(s) actually clicked (clicksExecuted=${clicksExecuted} but none matched target descriptions)`;
  }

  return {
    hintsResolvedPreRecording: totalHints,
    clicksExecuted,
    scrollsExecuted,
    level,
    note,
  };
}

// (Helpers `descriptionsMatch` / `contentTokens` live in
//  src/domain/intent-matching.ts — shared with the reconnoiterer-side scoring.)
