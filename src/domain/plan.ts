import { z } from 'zod';

import { Viewport } from './action-log.js';

/**
 * TimelinePlan — the deterministic schedule the runner executes inside the
 * recording window.
 *
 * The plan is produced by `IPlanner` from a single `(url, prompt, durationMs)`
 * request. Once produced it is treated as authoritative — the runner does not
 * re-call the LLM during execution. This is the key design choice that keeps
 * recording-window latency low.
 *
 * Time semantics:
 * - `targetDurationMs` is what the user asked for ("录制 10s" → 10000).
 * - Each step has its own `durationMs`; their sum should approximate
 *   `targetDurationMs` minus the planner's expected slack for stability waits.
 * - The runner enforces a wall-clock watchdog (Phase 4) so even if step
 *   durations underestimate, recording stops near targetDurationMs.
 */

const ScrollStep = z.object({
  type: z.literal('scroll'),
  /** Positive = down, negative = up. */
  deltaY: z.number(),
  /** Soft target — the smooth-scroll easing fits this duration. */
  durationMs: z.number().int().positive(),
  /** Optional reasoning for the log. */
  why: z.string().optional(),
});

const ClickStep = z.object({
  type: z.literal('click'),
  /**
   * Natural-language description of the target. The runner passes this
   * to the page session's observer (Stagehand) to resolve into a selector.
   * Pre-resolution happens BEFORE recording begins so the click itself is
   * an instantaneous Playwright call (no LLM in the recording window).
   */
  target: z.string().min(1),
  /**
   * Soft window for "the click happens" — usually 200-500ms.
   * The actual click is instantaneous; this is mostly for pacing the timeline.
   */
  durationMs: z.number().int().nonnegative().default(200),
  why: z.string().optional(),
});

const WaitStep = z.object({
  type: z.literal('wait'),
  durationMs: z.number().int().nonnegative(),
  why: z.string().optional(),
});

const StableStep = z.object({
  type: z.literal('stable'),
  /** Treat as "wait until DOM has been quiet for quietMs, max maxMs." */
  quietMs: z.number().int().positive().default(400),
  maxMs: z.number().int().positive().default(2000),
  why: z.string().optional(),
});

export const PlanStep = z.discriminatedUnion('type', [
  ScrollStep,
  ClickStep,
  WaitStep,
  StableStep,
]);
export type PlanStep = z.infer<typeof PlanStep>;
export type ClickStep = z.infer<typeof ClickStep>;

export const TimelinePlan = z.object({
  version: z.literal(1),
  /** What the user asked for, in ms. The runner respects this as a hard cap. */
  targetDurationMs: z.number().int().positive(),
  steps: z.array(PlanStep).min(1),
  /** LLM's free-form reasoning. Used only for logging / debugging. */
  notes: z.string().optional(),
});
export type TimelinePlan = z.infer<typeof TimelinePlan>;

/**
 * Visible candidate element collected by the page session before planning.
 * The planner may use these to ground its decisions in what actually exists,
 * but it is also free to invent new targets that the runner will resolve at
 * pre-resolve time.
 */
export const DomCandidate = z.object({
  description: z.string(),
  selectorHint: z.string().optional(),
});
export type DomCandidate = z.infer<typeof DomCandidate>;

export const PlanRequest = z.object({
  url: z.string().url(),
  /** Natural-language instruction from the user. */
  prompt: z.string().min(1),
  /** Target recording duration in ms. */
  durationMs: z.number().int().positive(),
  viewport: Viewport,
  /**
   * Up to a few dozen candidate elements observed on the page after load.
   * The planner uses these as ground truth for what exists.
   */
  candidates: z.array(DomCandidate).max(50),
});
export type PlanRequest = z.infer<typeof PlanRequest>;
