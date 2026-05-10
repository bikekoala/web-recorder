import { z } from 'zod';

import { Bbox } from './action-log.js';
import { DirectorAction } from './director-action.js';

// =====================================================================
// Director-based pipeline types (post-Director redesign)
// See docs/superpowers/specs/2026-05-10-streaming-director-design.md
// =====================================================================

export const ClickHint = z.object({
  description: z.string().min(1),
  selector: z.string().min(1),
  bboxAtRest: Bbox,
});
export type ClickHint = z.infer<typeof ClickHint>;

export const DirectorBriefing = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  hints: z.array(ClickHint),
  rationale: z.string(),
  /**
   * Planner's draft action sequence — the agent's "rough plan" of what to
   * do, like a person thinks "first I'll click X, then type Y, then Enter".
   *
   * The Director seeds its action queue with this sequence and executes
   * it as-is unless something goes wrong (action evidence shows mismatch,
   * expectAfter fails). When adaptation is needed, the Director falls
   * back to the streaming decider as before.
   *
   * Empty array is valid (planner had nothing to plan, e.g. pure-scroll
   * intents). When non-empty, this REPLACES the cold-start LLM call —
   * letting the recording window start with action immediately rather
   * than waiting 1-7s for the first decider response.
   *
   * See ADR §0026 — "self-check evidence + draft-then-react planning".
   */
  draftSequence: z.array(DirectorAction).default([]),
});
export type DirectorBriefing = z.infer<typeof DirectorBriefing>;
