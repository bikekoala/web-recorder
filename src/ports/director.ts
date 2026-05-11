import type { Performance } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

/**
 * IDirector — owns the recording window. Plays back a Performance built by
 * the reconnaissance phase. See ADR §0034.
 *
 * Lifecycle: the runner calls run(performance, session) AFTER setup +
 * recon, BEFORE the deliverable starts. The Director calls
 * session.beginRecording() itself (typically immediately). run() returns
 * when a `done` step is reached, the time budget is exhausted, or an
 * unrecoverable error occurs.
 */
export interface IDirector {
  run(performance: Performance, session: IPageSession): Promise<DirectorReport>;
}

export interface DirectorReport {
  /** ms elapsed inside Director.run(). */
  totalMs: number;
  /** Number of steps actually executed (excludes ones abandoned by a re-plan). */
  stepsExecuted: number;
  /** Number of re-plan checkpoints triggered. */
  replanCount: number;
  /** Reason for ending. */
  endReason: 'done' | 'budget' | 'error';
}
