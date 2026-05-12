import { z } from 'zod';

import { Bbox } from './action-log.js';

/**
 * The product of the reconnaissance phase: a complete, pre-resolved, paced
 * action sequence the PerformanceDirector plays back deterministically.
 * The "prophet recording" core type — see ADR §0034.
 *
 * Schema-first (CLAUDE.md hard rule #2): the recon LLM emits JSON matching
 * this exactly; LlmReconnoiterer parses + validates and throws ReconError
 * on mismatch.
 */

/** Scroll velocity profiles — same set the IPageSession.scroll() port uses. */
export const ScrollEasingSchema = z.enum(['inOutQuad', 'outQuart', 'outExpo', 'linear']);
export type ScrollEasing = z.infer<typeof ScrollEasingSchema>;

/** Named keys the `key` step may press. */
export const PerformanceKeySchema = z.enum([
  'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace',
]);
export type PerformanceKey = z.infer<typeof PerformanceKeySchema>;

/** What the playback director checks after a navigation-causing step. */
export const ExpectAfterSchema = z.object({
  urlContains: z.string().min(1).optional(),
  visibleText: z.array(z.string().min(1)).max(3).optional(),
});
export type ExpectAfter = z.infer<typeof ExpectAfterSchema>;

/** A click/type target the recon phase has already resolved to a selector + bbox. */
export const ResolvedTargetSchema = z.object({
  selector: z.string().min(1),
  bbox: Bbox,
  description: z.string().min(1),
});
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

/**
 * Sentinel `selector` for a click/type target the recon couldn't resolve
 * eagerly (at scrollY 0, right after `goto`). The rehearsal walk re-resolves
 * such targets at the actual page state the step will run in — and if the
 * re-resolve also fails, it's a divergence → reconverge. A target carrying
 * this sentinel must never reach the on-camera Performance; the walk drops any
 * survivor defensively. (`'__unresolved__'` is a valid non-empty `selector`,
 * and a zero `Bbox` is valid, so a sentinel target Zod-validates fine.)
 */
export const UNRESOLVED_SENTINEL = '__unresolved__';

export const PerformanceStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    target: ResolvedTargetSchema,
    anticipationMs: z.number().int().min(0).max(3000),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('scroll'),
    deltaPx: z.number().int().refine((n) => Math.abs(n) >= 50 && Math.abs(n) <= 4000, 'deltaPx magnitude must be 50..4000'),
    durationMs: z.number().int().min(200).max(4000),
    easing: ScrollEasingSchema,
    dwellAfterMs: z.number().int().min(0).max(2000),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('type'),
    target: ResolvedTargetSchema,
    text: z.string().min(1),
    preMs: z.number().int().min(0).max(2000),
    keystrokeMs: z.number().int().min(0).max(500),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('key'),
    key: PerformanceKeySchema,
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('dwell'),
    durationMs: z.number().int().min(100).max(8000),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('back'),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('done'),
    reasoning: z.string().min(1),
  }),
]);
export type PerformanceStep = z.infer<typeof PerformanceStepSchema>;

/**
 * Health summary of the off-camera rehearsal walk (see ADR §0034 / the
 * rehearsing-reconnoiterer spec). The operator canary: high `divergences` /
 * `truncated: true` means the LLM's first-draft planning is weak for that site.
 */
export const RehearsalTraceSchema = z.object({
  walkedSteps: z.number().int().nonnegative(),
  divergences: z.number().int().nonnegative(),
  reconverges: z.number().int().nonnegative(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
export type RehearsalTrace = z.infer<typeof RehearsalTraceSchema>;

/**
 * Outcome of the off-camera blocker dismisser (Task #20). Lives on the
 * Performance like RehearsalTrace — it's metadata about how the page was
 * prepared, surfaced in RunMetrics as an operator canary.
 */
export const BlockerDismissalReportSchema = z.object({
  /** detect→click iterations that ran (0 = the page was already clean). */
  rounds: z.number().int().nonnegative(),
  /** descriptions of the elements we clicked, in order. */
  dismissed: z.array(z.string()),
  /** a blocker still seemed present when we stopped (cap hit / error / undismissable). */
  stillBlocked: z.boolean(),
});
export type BlockerDismissalReport = z.infer<typeof BlockerDismissalReportSchema>;

export const PerformanceSchema = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  steps: z.array(PerformanceStepSchema).min(1),
  totalEstimatedMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
  /** Present iff the recon ran a rehearsal walk (config.reconRehearse). */
  rehearsal: RehearsalTraceSchema.optional(),
  /** Present iff the recon ran the off-camera blocker dismisser (config.blockerDismiss). */
  blockerDismissal: BlockerDismissalReportSchema.optional(),
});
export type Performance = z.infer<typeof PerformanceSchema>;
