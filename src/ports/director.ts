import type { DirectorBriefing } from '../domain/plan.js';
import type { IPageSession } from './page-session.js';

/**
 * IDirector — owns the recording window and runs the streaming decision loop.
 *
 * Lifecycle:
 *   - The runner calls `run(briefing, session)` AFTER setup (browser + page
 *     ready, planner has produced a briefing) but BEFORE `session.beginRecording()`.
 *     The Director itself decides when to call `beginRecording()` — typically
 *     immediately, but it may insert an opening dwell first.
 *   - `run` returns when the FastDecider issues `done`, the time budget is
 *     exhausted, or an unrecoverable error occurs.
 *
 * Implementations:
 *   - `StreamingDirector` (Phase 6) — double-queue + pre-fired LLM calls.
 *   - Future: a `RecordingDirectorReplay` that takes a fixed action list (no LLM)
 *     for offline-deterministic test reruns.
 */
export interface IDirector {
  run(briefing: DirectorBriefing, session: IPageSession): Promise<DirectorReport>;
}

export interface DirectorReport {
  /** ms elapsed inside the Director.run() call. */
  totalMs: number;
  /** Total FastDecider calls made (including failures). */
  decisionCount: number;
  /** Number of times an implicit dwell was inserted because LLM was slow. */
  implicitDwellCount: number;
  /** Number of expectAfter mismatches that triggered a re-decide. */
  expectAfterMismatchCount: number;
  /** Reason for ending: 'done' | 'budget' | 'error'. */
  endReason: 'done' | 'budget' | 'error';
}
