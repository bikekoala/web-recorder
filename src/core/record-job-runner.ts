import { resolve } from 'node:path';

import { trimVideo, videoDurationMs } from '../infra/ffmpeg.js';
import { logger as rootLogger } from '../infra/logger.js';
import type { IPageSession } from '../ports/page-session.js';
import type { IPlanner } from '../ports/planner.js';
import type { DirectorReport, IDirector } from '../ports/director.js';
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

    // ------------------------------------ 3. Director (owns recording window)
    const directorReport = await this.director.run(briefing, this.session);

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
    };

    return {
      videoPath,
      rawVideoPath: artifacts.videoPath,
      actionLogPath: artifacts.actionLogPath,
      metrics,
      directorReport,
    };
  }

  // ----------------------------------------------------------- internals

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
