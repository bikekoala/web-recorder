import type { Viewport } from '../domain/action-log.js';
import type { Performance, PerformanceStep } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

/**
 * IReconnoiterer — the reasoning component of the prophet architecture.
 * Runs OFF-CAMERA (before the recording window, and again on each re-plan
 * checkpoint). Observes the page, resolves every target, decides per-step
 * pacing, sets expectAfter, and returns a complete Performance.
 *
 * Used in two places:
 *   - RecordJobRunner, once per job, before beginRecording().
 *   - PerformanceDirector, on a re-plan checkpoint — same instance, reused.
 *
 * Best-effort contract: throw on LLM/network failure or a Performance that
 * fails Zod validation. The runner surfaces a recon failure (no recording);
 * the PerformanceDirector treats a re-plan failure as "stop gracefully".
 */
export interface IReconnoiterer {
  recon(input: ReconInput, session: IPageSession): Promise<Performance>;
  /** Stable identifier for the underlying model — surfaced in logs. */
  readonly modelId: string;
}

export interface ReconInput {
  /** Current URL — the original URL on the first recon; wherever the page is on a re-plan. */
  url: string;
  /** The user's ORIGINAL natural-language intent — unchanged across re-plans. */
  prompt: string;
  /** On the first recon: the full recording budget. On a re-plan: the REMAINING budget. */
  durationMs: number;
  /** Browser viewport size. */
  viewport: Viewport;
  /** PNG screenshot of the current page, or null if it couldn't be taken. */
  screenshot: Buffer | null;
  /**
   * Re-plan context only: the (kind, reasoning) of each step already
   * executed this recording, in order — so the LLM plans the REST without
   * redoing what's done. Undefined / empty on the first recon.
   */
  priorSteps?: Array<{ kind: PerformanceStep['kind']; reasoning: string }>;
  /**
   * Reconverge-on-drop context (ADR §0042 / P13 fix): plain-English
   * descriptions of click/type targets that A's previous draft requested
   * but the resolver couldn't locate on the current page. The next recon
   * call hands these back to A as "don't try these again" — A should plan
   * the FULL recording without relying on them. Undefined / empty when
   * no drops happened.
   */
  priorAttemptDrops?: string[];
  /**
   * Reconverge-on-overbudget context (plan Y, 2026-05-15): when the previous
   * draft's deterministic cost recomputation was over budget by more than the
   * tolerance, the next recon call hands A the actual gap so A can drop steps.
   * Undefined / omitted when no overbudget retry is happening.
   *
   * AI-first: B (the runner) computes cost; A only acts on the feedback. A's
   * self-reported `totalEstimatedMs` is no longer trusted (HN run showed A
   * routinely under-counts by 30-100% on multi-step sums).
   */
  priorAttemptOverBudgetMs?: {
    /** B's deterministic recomputation of the previous plan's cost in ms. */
    actualMs: number;
    /** The original budget A was given (== `durationMs`). */
    budgetMs: number;
  };
  /**
   * Maximum scrollable pixel offset of the current page
   * (`document.scrollHeight − viewport.height`). 0 means the page fits in
   * one viewport. Surfaced into the recon prompt so the planner LLM can
   * size its scroll plan against the page that actually exists, instead of
   * blindly planning a stack of 600px scrolls on a 200-px-tall page (the
   * 2026-05-15 HN failure). Optional — pre-2026-05-15 fixtures omit it.
   */
  pageScrollableHeight?: number;
}
