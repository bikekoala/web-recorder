import type { PlanRequest, TimelinePlan } from '../domain/plan.js';

/**
 * IPlanner — turns a natural-language `(url, prompt, durationMs)` request
 * into a deterministic `TimelinePlan` that the runner can execute.
 *
 * Implementations:
 * - `LlmPlanner` (Phase 3): one LLM call with a screenshot and DOM candidates.
 *
 * Design choices encoded here:
 *
 * 1. **One-shot, not agent loop**. The planner is called exactly once per
 *    recording job. The runner does not re-invoke it mid-execution. This is
 *    deliberate — each LLM call is 1-3s and we cannot afford that latency
 *    inside the recording window.
 *
 * 2. **Image input is optional but provided when available**. The planner
 *    receives a screenshot via the `screenshot` parameter. Implementations
 *    decide whether to use it.
 *
 * 3. **Schema-validated output**. The returned plan is parsed through
 *    `TimelinePlan` Zod schema; malformed LLM output is rejected at the
 *    boundary, not allowed to propagate.
 */
export interface IPlanner {
  plan(request: PlanRequest, screenshot: Buffer | null): Promise<TimelinePlan>;
}
