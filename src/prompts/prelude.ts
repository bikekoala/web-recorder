/**
 * Prelude prompt — used by `BlockerPrelude` (pre-recording phase).
 *
 * The prelude reuses the same `IFastDecider` instance as the Director, so
 * it inherits the decider's SYSTEM_PROMPT (visual-blocker rules etc.).
 * What's different is the USER-message: we pre-pend a `[BLOCKER PRELUDE]`
 * marker that tells the LLM "your job right now is dismissal, not the
 * user's actual task — find the modal/banner/overlay and click it away".
 *
 * Why the marker: without it the LLM sometimes interprets the user's
 * stated goal ("watch a video", "click 简体中文 link") and tries to do
 * THAT instead of dismissing the cookie banner that's covering everything.
 */

/**
 * Build the prelude prompt prefix that turns the Director's prompt into a
 * dismissal-mode prompt.
 *
 * Returns a string to put into `DirectorState.prompt` for prelude calls
 * only — the rest of DirectorState (screenshot, scrollY, etc.) is the
 * normal observation.
 */
export function buildPreludeUserPrompt(
  briefingPrompt: string,
  blockerSignals: readonly string[],
): string {
  return [
    `[BLOCKER PRELUDE — page-cleanup phase, BEFORE recording starts]`,
    `Detected blocker signals on the page: ${blockerSignals.join(', ') || '(none — but user-prompt suggests a blocker may be present)'}.`,
    `Your ONLY job right now is to dismiss whatever is blocking the content. Find the close/accept/dismiss/play button and click it. Do NOT pursue the user's stated task yet — that comes after the recording window opens.`,
    `If you don't see anything to dismiss, output a "done" action and we'll proceed.`,
    ``,
    `(For context only — the user's eventual goal is: ${briefingPrompt})`,
  ].join('\n');
}
