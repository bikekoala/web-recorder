import { z } from 'zod';

import { Bbox } from './action-log.js';

/**
 * The product of the reconnaissance phase: a complete, pre-resolved, paced
 * action sequence the PerformanceDirector plays back deterministically.
 * The "prophet recording" core type — see ADR §0034.
 *
 * Schema-first (CLAUDE.md hard rule #2): the recon LLM emits a *draft*
 * ({@link ReconDraftStep} — `src/domain/recon-draft.ts`) where click/type
 * carry a `ref` into the page's aria snapshot; LlmReconnoiterer parses that,
 * resolves each ref to a {@link ResolvedTarget}, and assembles a Performance
 * matching this schema — Zod-validated, ReconError on mismatch.
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
 * The step kinds identical in a recon *draft* ({@link ReconDraftStep}) and a
 * resolved {@link Performance} (PerformanceStep): they carry no target, so
 * there's nothing to resolve. Shared between the two discriminated unions so
 * they can never drift. (click/type differ — the draft carries a `ref` into the
 * aria snapshot; the Performance carries a resolved {@link ResolvedTarget}.)
 */
export const ScrollStepSchema = z.object({
  kind: z.literal('scroll'),
  deltaPx: z.number().int().refine((n) => Math.abs(n) >= 50 && Math.abs(n) <= 4000, 'deltaPx magnitude must be 50..4000'),
  durationMs: z.number().int().min(200).max(4000),
  easing: ScrollEasingSchema,
  dwellAfterMs: z.number().int().min(0).max(2000),
  reasoning: z.string().min(1),
});
export const KeyStepSchema = z.object({
  kind: z.literal('key'),
  key: PerformanceKeySchema,
  reasoning: z.string().min(1),
  expectAfter: ExpectAfterSchema.optional(),
});
export const DwellStepSchema = z.object({
  kind: z.literal('dwell'),
  durationMs: z.number().int().min(100).max(8000),
  reasoning: z.string().min(1),
});
export const BackStepSchema = z.object({
  kind: z.literal('back'),
  reasoning: z.string().min(1),
  expectAfter: ExpectAfterSchema.optional(),
});
export const DoneStepSchema = z.object({
  kind: z.literal('done'),
  reasoning: z.string().min(1),
});

export const PerformanceStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    target: ResolvedTargetSchema,
    anticipationMs: z.number().int().min(0).max(3000),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('type'),
    target: ResolvedTargetSchema,
    text: z.string().min(1),
    preMs: z.number().int().min(0).max(2000),
    keystrokeMs: z.number().int().min(0).max(500),
    reasoning: z.string().min(1),
  }),
  ScrollStepSchema,
  KeyStepSchema,
  DwellStepSchema,
  BackStepSchema,
  DoneStepSchema,
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

/**
 * The blocker dismisser's per-round LLM detect output (crosses a boundary —
 * Hard Rule 2). `blocker: false` ⇒ no dismissable overlay (or it's a
 * paywall/login-wall we won't touch). `dismissTargetDescription` is the element
 * that clears it; omitted when `blocker` is false. Extra fields (e.g.
 * `rationale`) are ignored — only these matter.
 */
export const BlockerDismissDecisionSchema = z.object({
  blocker: z.boolean(),
  dismissTargetDescription: z.string().min(1).optional(),
}).passthrough();
export type BlockerDismissDecision = z.infer<typeof BlockerDismissDecisionSchema>;

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
  /**
   * Requested click/type targets the recon couldn't resolve to anything on the
   * page (the `ref` was stale/wrong AND the visible-text / `observe()` fallbacks
   * missed) — so the step was dropped from the plan. Present only when non-empty.
   * Each entry is the LLM's `targetDescription`, optionally annotated with
   * "(page tree too large to analyze in full)" when the aria snapshot had to be
   * truncated. Feeds `RunMetrics.intentSatisfaction` so a dropped requested
   * action is reported transparently (`partial`/`unmet` with the name), never
   * silently `unknown`. See docs/superpowers/specs/2026-05-12-transparent-giant-page-handling-design.md.
   */
  unresolvedTargets: z.array(z.string().min(1)).optional(),
  /**
   * Outcome of `fitPlanToBudget` (the F1 ±X% corrector — see ADR §0040). The
   * structured transparency channel that replaces the old silent
   * scroll+dwell pad: `compressed-hard` means the LLM over-planned by more
   * than the tolerance and B compressed (best-effort) to land it; `underfilled`
   * means the LLM under-planned by more than the tolerance and B refused to
   * invent filler — the recording will run short, surfaced here so
   * `intentSatisfaction` / the eval canary can flag it instead of pretending
   * the duration was hit. `ok` covers both "within tolerance" and the
   * still-OK light-compress case. Mirrored verbatim into `RunMetrics`.
   */
  planDurationFit: z.object({
    estimatedMs: z.number().int().nonnegative(),
    targetMs: z.number().int().nonnegative(),
    ratio: z.number(),
    status: z.enum(['ok', 'compressed-hard', 'underfilled']),
  }).optional(),
});
export type Performance = z.infer<typeof PerformanceSchema>;
