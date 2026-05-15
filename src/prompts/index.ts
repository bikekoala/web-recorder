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
 * - `reconnoiterer.ts` — the off-camera recon call that produces a paced
 *   Performance (and is reused for re-plans). See ADR §0034.
 * - `blocker-dismisser.ts` — the off-camera detect call that picks the
 *   element clearing a cookie/consent banner or X-to-close modal. Task #20.
 * - `recording-judge.ts` — the once-per-recording naturalness grader.
 */

export { recordingJudgeSystemPrompt, buildRecordingJudgeUserText } from './recording-judge.js';
export { reconnoitererSystemPrompt, buildReconUserText, buildReconvergeUserText, buildOverbudgetEditUserText } from './reconnoiterer.js';
export { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from './blocker-dismisser.js';
