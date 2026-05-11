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

export const PerformanceSchema = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  steps: z.array(PerformanceStepSchema).min(1),
  totalEstimatedMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
});
export type Performance = z.infer<typeof PerformanceSchema>;
