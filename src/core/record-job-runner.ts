import { resolve } from 'node:path';

import type { ActionLogEntry, RecordingWindow } from '../domain/action-log.js';
import { countMatchedHints } from '../domain/intent-matching.js';
import type { BlockerDismissalReport, Performance, PerformanceStep, PlanDurationFit, RehearsalTrace } from '../domain/performance.js';
import { trimVideo, videoDurationMs } from '../infra/ffmpeg.js';
import { logger as rootLogger } from '../infra/logger.js';
import {
  captureConfigSnapshot,
  renameRawVideo,
  RUN_JSON_SCHEMA_VERSION,
  writeRunRecord,
} from '../infra/run-record-writer.js';
import type { DirectorReport, IDirector } from '../ports/director.js';
import type { IPageSession } from '../ports/page-session.js';
import type { IReconnoiterer } from '../ports/reconnoiterer.js';

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
 *        On-page blockers (cookie/consent dialogs etc.) are folded into the
 *        Performance as its first steps — see the recon prompt.
 *
 *   3. Record window (RECORDED — owned by IDirector / PerformanceDirector)
 *      - director.run(performance, session)
 *        Deterministic playback of the Performance. Single re-plan checkpoint
 *        per step that carries an expectAfter is the only recovery path —
 *        no per-action LLM calls inside the recording window.
 *
 *   4. Stop + trim (NOT recorded)
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
  /**
   * Optional flag the runner records into `run.json.request.headless` for
   * traceability. Doesn't affect the runner's behavior — the session is
   * already constructed by the caller (which is where headless takes effect).
   * When unknown, omit and `run.json` will simply not carry the field.
   */
  headless?: boolean;
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
  reconMs: number;          // reconnoiterer.recon() call (aria snapshot + LLM + ref resolution + rehearsal walk)
  recordingMs: number;      // director.run duration
  trimMs: number;           // ffmpeg
  rawVideoMs: number | null;
  trimmedVideoMs: number | null;
  /** Steps in the original Performance the reconnoiterer produced. */
  plannedSteps: number;
  /** Re-plan checkpoints triggered during playback (from directorReport). */
  replanCount: number;
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
  /**
   * Off-camera rehearsal walk health (the §0034 rehearsing-reconnoiterer
   * canary), or `null` if recon ran without a rehearsal walk
   * (`config.reconRehearse === false`). High `divergences` / `truncated`
   * means the planner's first-draft is weak for that site.
   */
  rehearsal: RehearsalTrace | null;
  /**
   * Off-camera blocker dismisser outcome (Task #20), or `null` if recon ran
   * without one (`config.blockerDismiss === false`). `rounds > 0` means a
   * cookie/consent banner or X-to-close modal was cleared before recording;
   * `stillBlocked: true` means one slipped past — the deliverable may show it.
   */
  blockerDismissal: BlockerDismissalReport | null;
  /**
   * Requested click/type targets the recon couldn't locate on the page (ref +
   * visible-text + `observe()` fallbacks all missed), so the step was dropped —
   * mirrors `performance.unresolvedTargets`. Non-empty here means part (or all)
   * of the user's intent was never attempted; `intentSatisfaction` reflects it.
   */
  unresolvedTargets: string[];
  /**
   * Outcome of `fitPlanToBudget` (F1, ADR §0040) — mirrored verbatim from
   * `performance.planDurationFit`. `status: 'compressed-hard'` means A
   * over-planned beyond tolerance and B compressed it; `'underfilled'` means
   * A under-planned beyond tolerance and B refused to invent filler (the
   * recording will run short — `trimmedVideoMs` vs `durationMs` will show
   * it, but this field tells you *why* without inspecting steps). `'ok'` for
   * within-tolerance (silent compress allowed for the slightly-over case).
   * Optional only because adapters with very old fixtures may omit it.
   */
  planDurationFit?: PlanDurationFit;
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
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const wallClockT0 = Date.now();
    const startedAtIso = new Date(wallClockT0).toISOString();

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
        viewport: this.session.viewport,
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

    // ------------------------------------ 2. Director (owns recording window)
    const directorReport = await this.director.run(performance, this.session);

    // ------------------------------------ 3. Stop + trim
    const artifacts = await this.session.stop();

    // Probe the raw video BEFORE trimming — its length tells us how far the
    // recordVideo compositor clock lags wall time, which the trim corrects for.
    const rawVideoMs = await videoDurationMs(artifacts.videoPath).catch(() => null);

    const tTrim = Date.now();
    let videoPath = artifacts.videoPath;
    if (artifacts.recording) {
      const out = resolve(req.outputDir, 'recording.webm');
      const trim = videoRelativeTrimWindow(artifacts.recording, rawVideoMs, artifacts.actionLog.durationMs);
      if (trim.startMs !== artifacts.recording.startedAtMs || trim.endMs !== artifacts.recording.endedAtMs) {
        this.logger.info(
          { rawVideoMs, sessionWallMs: artifacts.actionLog.durationMs, wallWindow: artifacts.recording, videoWindow: trim },
          'recordVideo clock drift — trimming the recording by video-relative time',
        );
      }
      await trimVideo(artifacts.videoPath, out, trim.startMs, trim.endMs);
      videoPath = out;
    }
    const trimMs = Date.now() - tTrim;

    const trimmedVideoMs = await videoDurationMs(videoPath).catch(() => null);

    const unresolvedTargets = performance.unresolvedTargets ?? [];
    const intentSatisfaction = computeIntentSatisfaction(
      performance.steps
        .filter((s): s is Extract<PerformanceStep, { kind: 'click' }> => s.kind === 'click')
        .map((s) => s.target.description),
      artifacts.actionLog.entries,
      artifacts.recording,
      unresolvedTargets,
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
      intentSatisfaction,
      rehearsal: performance.rehearsal ?? null,
      blockerDismissal: performance.blockerDismissal ?? null,
      unresolvedTargets,
      ...(performance.planDurationFit ? { planDurationFit: performance.planDurationFit } : {}),
    };

    if (performance.planDurationFit && performance.planDurationFit.status !== 'ok') {
      this.logger.warn(
        { planDurationFit: performance.planDurationFit },
        `plan/duration fit out of tolerance (${performance.planDurationFit.status}) — the recording may not land in ±10% (goals.md #2)`,
      );
    }

    if (intentSatisfaction.level === 'unmet' || intentSatisfaction.level === 'partial') {
      this.logger.warn(
        { intentSatisfaction },
        'recording finished but user intent not fully satisfied — review action log',
      );
    } else {
      this.logger.info({ intentSatisfaction }, 'intent satisfaction summary');
    }

    // ------------------------------------ 4. Persist run record + tidy filenames
    // (see docs/output-layout.md). Rename Playwright's `page@<hash>.webm` to a
    // stable name first, so the path we record in the run.json log is the
    // post-rename one and matches what a human / future AI session will see in
    // the directory.
    const trimmed = artifacts.recording !== null;
    const rawVideoPath = await renameRawVideo(artifacts.videoPath, trimmed).catch((err) => {
      this.logger.warn({ err, rawPath: artifacts.videoPath }, 'raw video rename failed — keeping original name');
      return artifacts.videoPath;
    });
    // When there was no trim, the raw video IS the deliverable; the rename moved
    // it to `recording.webm`. Sync `videoPath` to wherever the raw landed.
    if (!trimmed) videoPath = rawVideoPath;

    const endedAtIso = new Date().toISOString();
    try {
      await writeRunRecord(req.outputDir, {
        schemaVersion: RUN_JSON_SCHEMA_VERSION,
        request: {
          url: req.url,
          prompt: req.prompt,
          durationMs: req.durationMs,
          viewport: artifacts.viewport,
          ...(req.headless !== undefined ? { headless: req.headless } : {}),
        },
        performance,
        metrics,
        directorReport,
        config: captureConfigSnapshot(),
        timings: { startedAt: startedAtIso, endedAt: endedAtIso },
      });
    } catch (err) {
      // Persisting run.json is best-effort — if it fails, the recording is
      // already done and the in-memory RunResult is still valid. Surface the
      // failure but don't fail the job.
      this.logger.warn({ err }, 'failed to write run.json — recording itself is fine');
    }

    return {
      videoPath,
      rawVideoPath,
      actionLogPath: artifacts.actionLogPath,
      performance,
      metrics,
      directorReport,
    };
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
 * Only entries inside the recording window count. Anything that happened
 * before the recording window opened is excluded — that's not user intent.
 *
 * `unresolvedTargets` are requested click/type targets the recon couldn't
 * locate on the page at all (so the step was dropped — they're not in
 * `hintDescriptions`). When non-empty, the result is never `unknown`: it's
 * `unmet` (every requested click was dropped — nothing actionable was planned)
 * or `partial` (some clicks were planned/executed, but others couldn't even be
 * attempted), with the dropped targets named in the note. `unknown` is reserved
 * for the genuinely-unjudgeable case: the Performance had no click steps AND
 * none were dropped (the prompt asked for no click — e.g. "just scroll").
 */
export function computeIntentSatisfaction(
  hintDescriptions: ReadonlyArray<string>,
  entries: ActionLogEntry[],
  window: RecordingWindow | null,
  unresolvedTargets: ReadonlyArray<string> = [],
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
  const droppedCount = unresolvedTargets.length;
  const droppedList = unresolvedTargets.join('; ');
  let level: IntentSatisfaction['level'];
  let note: string;

  if (totalHints === 0) {
    if (droppedCount > 0) {
      // Every requested click was dropped at recon time — intent never attempted.
      level = 'unmet';
      const ran = clicksExecuted || scrollsExecuted || types.length;
      note =
        `couldn't locate ${droppedCount} requested target(s): ${droppedList}; no actionable step was planned` +
        (ran ? ` (${clicksExecuted} click(s), ${scrollsExecuted} scroll(s), ${types.length} type(s) still ran)` : '');
    } else if (clicksExecuted === 0 && scrollsExecuted === 0 && types.length === 0) {
      level = 'unmet';
      note = 'no click targets, no actions executed in recording window';
    } else {
      level = 'unknown';
      note = `no click targets; ${clicksExecuted} click(s), ${scrollsExecuted} scroll(s), ${types.length} type(s)`;
    }
  } else {
    if (hintsClicked === totalHints && scrollsExecuted >= 1) {
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
    if (droppedCount > 0) {
      // Some intent was planned/executed, but other requested targets couldn't
      // even be located — that's never "complete".
      if (level === 'complete') level = 'partial';
      note = `${note}; ${droppedCount} other requested target(s) couldn't be located: ${droppedList}`;
    }
  }

  return {
    hintsResolvedPreRecording: totalHints,
    clicksExecuted,
    scrollsExecuted,
    level,
    note,
  };
}

/**
 * Map a wall-clock recording window onto the raw `recordVideo` .webm's own
 * frame timeline.
 *
 * Playwright's compositor clock lags real time — startup gap before the first
 * frame, plus dropped frames under page jank — so a ~40 s session can produce
 * a ~38.8 s video. Trimming the wall-clock `[startedAtMs, endedAtMs]` straight
 * out of the file then cuts ~2 s of valid content off the START (the start
 * edge lands past where that content actually sits in the video) and bottoms
 * out against EOF at the end — the deliverable ends up seconds short of
 * `durationMs`. We approximate the video clock as wall time scaled by
 * `f = rawVideoMs / sessionWallMs` (this folds the startup gap into a
 * slightly-smaller `f`; the lag is roughly linear over the session, so that's
 * close enough). Only applied when `f` is in a sane drift band (0.5–1.0);
 * otherwise — no probe, no measurable drift, or a pathological reading — we
 * trust the wall-clock numbers unchanged. See
 * docs/findings/2026-05-12-recordvideo-clock-drift.md.
 */
export function videoRelativeTrimWindow(
  window: { startedAtMs: number; endedAtMs: number },
  rawVideoMs: number | null,
  sessionWallMs: number,
): { startMs: number; endMs: number } {
  const { startedAtMs, endedAtMs } = window;
  if (rawVideoMs === null || rawVideoMs <= 0 || sessionWallMs <= 0) {
    return { startMs: startedAtMs, endMs: endedAtMs };
  }
  const f = rawVideoMs / sessionWallMs;
  if (!(f >= 0.5 && f < 1.0)) {
    return { startMs: startedAtMs, endMs: endedAtMs };
  }
  return { startMs: Math.round(startedAtMs * f), endMs: Math.round(endedAtMs * f) };
}

// (Helpers `descriptionsMatch` / `contentTokens` live in
//  src/domain/intent-matching.ts — shared with the reconnoiterer-side scoring.)
