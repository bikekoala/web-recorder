/**
 * Centralized prompt store.
 *
 * All LLM prompts live here, in one directory, so they can be reviewed,
 * versioned, and tuned independently of the adapters that USE them.
 * Adapters import from `src/prompts/`; nothing else imports from
 * `src/adapters/*` for prompt content.
 *
 * Why this structure:
 * - Prompts are content, not code. They drift over time as models change
 *   (Sonnet 4.6 needs different rules than gpt-4o-mini). Co-locating them
 *   makes drift visible.
 * - Multi-model compatibility: the same prompt file can carry rules
 *   targeted at specific quirks (e.g. CJK quote escaping for Sonnet via
 *   OpenRouter), keeping adapter code generic.
 * - Single source of truth for the project's "voice" with the LLM.
 *
 * Layering:
 * - These files have no I/O and no side effects. They export plain strings
 *   (system messages) and pure functions that build user messages from a
 *   typed state.
 * - Domain types are imported from `src/domain/`; nothing else.
 *
 * One file per LLM role:
 * - `planner.ts` — the once-per-job click-target extractor.
 * - `decider.ts` — the per-action streaming director's prompts.
 * - `prelude.ts` — the BlockerPrelude's dismissal-loop prompt.
 */

export { plannerSystemPrompt, buildPlannerUserText } from './planner.js';
export { deciderSystemPrompt, buildDeciderUserText } from './decider.js';
export { buildPreludeUserPrompt } from './prelude.js';
