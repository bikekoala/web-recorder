import { z } from 'zod';

import { DirectorAction } from '../domain/director-action.js';
import type { DirectorState } from '../domain/director-state.js';

/**
 * IFastDecider — single LLM round-trip that picks the next 1-N micro actions.
 *
 * Latency budget: ≤1s p95. The Director relies on this to hide LLM lag
 * under animation time. If the implementation cannot meet the budget on a
 * given network/route, the Director's implicit-dwell fallback covers it.
 *
 * Output is validated by `DecisionResponse` Zod schema — adapters MUST parse
 * before returning so callers never see malformed actions.
 */
export interface IFastDecider {
  decide(state: DirectorState): Promise<DecisionResponse>;
}

export const ExpectAfter = z.object({
  urlContains: z.string().optional(),
  visibleText: z.array(z.string()).optional(),
});
export type ExpectAfter = z.infer<typeof ExpectAfter>;

export const DecisionResponse = z.object({
  /** 1-3 actions of lookahead. */
  actions: z.array(DirectorAction).min(1).max(3),
  /** Optional cheap-validation hint from the LLM about expected post-state. */
  expectAfter: ExpectAfter.optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;
