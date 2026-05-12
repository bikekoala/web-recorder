import { z } from 'zod';

import {
  BackStepSchema,
  DoneStepSchema,
  DwellStepSchema,
  ExpectAfterSchema,
  KeyStepSchema,
  ScrollStepSchema,
} from './performance.js';

/**
 * The reconnaissance LLM's *draft* — what it emits before any target is
 * resolved (ADR §0036). Crosses a boundary, so it's a Zod schema parsed before
 * use (CLAUDE.md hard rule #2).
 *
 * The only difference from a resolved {@link import('./performance.js').Performance}:
 * `click` / `type` carry a **`ref`** — a stable id (`"e7"`) into the page's
 * `IPageSession.ariaSnapshot()` tree, picked by the LLM from the snapshot it was
 * shown — **plus a `targetDescription`** (the LLM's plain-English name for the
 * element). LlmReconnoiterer resolves the `ref` deterministically via
 * `IPageSession.resolveAriaRef()`; if that misses (the LLM picked a stale / wrong
 * ref — the tree can run to thousands of lines), it falls back to a fuzzy lookup
 * by `targetDescription` (`resolveTargetCandidates`) — so the description is the
 * safety net, not the primary path. scroll/key/dwell/back/done are reused
 * verbatim from `performance.ts`.
 */

export const ReconDraftClickStepSchema = z.object({
  kind: z.literal('click'),
  ref: z.string().min(1),
  targetDescription: z.string().min(1),
  anticipationMs: z.number().int().min(0).max(3000),
  reasoning: z.string().min(1),
  expectAfter: ExpectAfterSchema.optional(),
});

export const ReconDraftTypeStepSchema = z.object({
  kind: z.literal('type'),
  ref: z.string().min(1),
  targetDescription: z.string().min(1),
  text: z.string().min(1),
  preMs: z.number().int().min(0).max(2000),
  keystrokeMs: z.number().int().min(0).max(500),
  reasoning: z.string().min(1),
});

export const ReconDraftStepSchema = z.discriminatedUnion('kind', [
  ReconDraftClickStepSchema,
  ReconDraftTypeStepSchema,
  ScrollStepSchema,
  KeyStepSchema,
  DwellStepSchema,
  BackStepSchema,
  DoneStepSchema,
]);
export type ReconDraftStep = z.infer<typeof ReconDraftStepSchema>;

export const ReconDraftSchema = z.object({
  prompt: z.string().min(1),
  steps: z.array(ReconDraftStepSchema).min(1),
  totalEstimatedMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
});
export type ReconDraft = z.infer<typeof ReconDraftSchema>;

/**
 * A *reconverge* response — emitted mid-rehearsal-walk when a step diverges
 * (ADR §0034 / §0036). The LLM is asked only for the REST of the plan from
 * here, so it's a bare `{ steps }` (no prompt/totalEstimatedMs/rationale).
 */
export const ReconvergeDraftSchema = z.object({
  steps: z.array(ReconDraftStepSchema).min(1),
});
export type ReconvergeDraft = z.infer<typeof ReconvergeDraftSchema>;
