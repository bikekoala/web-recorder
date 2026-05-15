import { z } from 'zod';

import {
  BackStepSchema,
  DoneStepSchema,
  DwellStepSchema,
  ExpectAfterSchema,
  GotoStepSchema,
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
 * element), and `click` may also carry **`targetText`** (the element's exact
 * visible text). LlmReconnoiterer resolves the `ref` deterministically via
 * `IPageSession.resolveAriaRef()`; if that misses (the LLM picked a stale / wrong
 * ref — the tree can run to thousands of lines), it falls back to
 * `resolveByVisibleText(targetText)` (a deterministic role/text lookup — works on
 * huge pages) and then to a fuzzy `resolveTargetCandidates(targetDescription)` —
 * so those two are the safety net, not the primary path. scroll/key/dwell/back/done
 * are reused verbatim from `performance.ts`.
 */

export const ReconDraftClickStepSchema = z.object({
  kind: z.literal('click'),
  ref: z.string().min(1),
  targetDescription: z.string().min(1),
  /**
   * The element's exact visible text ("Felidae", "Sign in"), if it has any —
   * the LLM copies it character-for-character; for an icon-only node it has no
   * text. Used as a deterministic fallback when the `ref` misses: a Playwright
   * role/text lookup, no LLM, no DOM serialization — so it works even on huge
   * pages where the `observe()`-based `targetDescription` fallback overflows.
   *
   * The schema accepts any string (and "" / whitespace) so an LLM that emits
   * `"targetText": ""` instead of omitting the key for an icon-only node still
   * parses; an empty/blank value is just treated as "no visible text" downstream
   * (`resolveDraftSteps` skips the visible-text lookup when `targetText` is
   * falsy). Not `.min(1)` — that turned a benign `""` into a hard `ReconError`.
   */
  targetText: z.string().optional(),
  anticipationMs: z.number().int().min(0).max(3000),
  reasoning: z.string().min(1).max(300),
  expectAfter: ExpectAfterSchema.optional(),
});

export const ReconDraftTypeStepSchema = z.object({
  kind: z.literal('type'),
  ref: z.string().min(1),
  targetDescription: z.string().min(1),
  text: z.string().min(1),
  preMs: z.number().int().min(0).max(2000),
  keystrokeMs: z.number().int().min(0).max(500),
  reasoning: z.string().min(1).max(300),
});

export const ReconDraftStepSchema = z.discriminatedUnion('kind', [
  ReconDraftClickStepSchema,
  ReconDraftTypeStepSchema,
  ScrollStepSchema,
  KeyStepSchema,
  DwellStepSchema,
  BackStepSchema,
  DoneStepSchema,
  // goto has no target to resolve — identical shape in draft and Performance.
  GotoStepSchema,
]);
export type ReconDraftStep = z.infer<typeof ReconDraftStepSchema>;

export const ReconDraftSchema = z.object({
  prompt: z.string().min(1),
  steps: z.array(ReconDraftStepSchema).min(1),
  /**
   * Plan Y (2026-05-15): A no longer self-reports plan cost. B (the runner)
   * computes the deterministic cost via `sumDurations(steps)` and gates on it;
   * if A overshoots the budget, B fires a reconverge with the actual gap.
   * Kept optional so a stale-prompt LLM that still emits the field parses
   * cleanly; the value is captured into `PlanDurationFit.claimedMs` for
   * comparison but is no longer load-bearing.
   */
  totalEstimatedMs: z.number().int().nonnegative().optional(),
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
