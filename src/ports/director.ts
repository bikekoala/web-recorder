import type { DirectorBriefing } from '../domain/plan.js';
import type { Pending } from '../infra/pending.js';
import type { DecisionResponse } from './fast-decider.js';
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
  run(
    briefing: DirectorBriefing,
    session: IPageSession,
    opts?: DirectorRunOpts,
  ): Promise<DirectorReport>;
}

/**
 * Optional knobs passed by the runner.
 */
export interface DirectorRunOpts {
  /**
   * A FastDecider call that the runner has ALREADY fired BEFORE the
   * recording window opened (typically during the planner brief() call or
   * the BlockerPrelude). When set, the Director uses this as Decision 1
   * instead of cold-starting.
   *
   * This hides the 1-7s cold-start LLM latency that previously ate up to
   * 70% of a 10s recording budget — the user gets to use their budget for
   * actual actions, not for waiting on the first LLM response.
   *
   * `firedAtMs` and `scrollYAtFire` are required so the Director can log a
   * faithful `decision` ActionLogEntry (latency + state at fire time).
   */
  prefiredDecision?: PrefiredDecision;
}

export interface PrefiredDecision extends Pending<DecisionResponse> {
  /** Date.now() when the LLM call was fired (for accurate latencyMs logging). */
  firedAtMs: number;
  /** scrollY at the moment the screenshot used for this call was taken. */
  scrollYAtFire: number;
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
