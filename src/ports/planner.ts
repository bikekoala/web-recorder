import type { DirectorBriefing, PlanRequest, TimelinePlan } from '../domain/plan.js';
import type { IPageSession } from './page-session.js';

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
  /** @deprecated Use brief() instead. Kept until cleanup-task migration. */
  plan(request: PlanRequest, screenshot: Buffer | null): Promise<TimelinePlan>;

  /**
   * Produce a DirectorBriefing for the streaming Director.
   *
   * Implementations:
   * 1. Make ONE LLM call with the screenshot, asking for likely click targets.
   * 2. For each named target, call `session.resolveTarget(name)` to get a selector + bbox.
   * 3. Return briefing with hints + verbatim prompt + duration.
   */
  brief(input: BriefRequest, session: IPageSession): Promise<DirectorBriefing>;
}

export interface BriefRequest {
  url: string;
  prompt: string;
  durationMs: number;
  viewport: { width: number; height: number };
  screenshot: Buffer | null;
}
