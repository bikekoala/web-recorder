/**
 * IClickVerifier — language-model verification that a click landed on the
 * intended target.
 *
 * Why this is its own port (not a method on IFastDecider): the decider
 * answers "what should I do next?" using the user's intent + page state.
 * The click verifier answers a much narrower question — "did the click I
 * just performed actually hit what its target description said it would?"
 * — and uses a tighter prompt + smaller token budget. Different concern,
 * different model knob, separate port.
 *
 * Used by the Director's `executeAction` for `click`. After the underlying
 * Playwright click resolves, the Director snaps a fresh post-click
 * screenshot and asks the verifier "did this work?". A negative verdict
 * marks the action as failed, which causes the Director's main loop to
 * clear the action queue and re-decide with the failure context — the
 * same path used for Playwright-thrown click errors.
 *
 * Returning a verdict is best-effort: implementations that fail (network,
 * model timeout) should throw, and the caller will treat the verdict as
 * "unknown / optimistic" and proceed without flagging failure.
 */
export interface IClickVerifier {
  verify(input: ClickVerifyInput): Promise<ClickVerifyResult>;
  /** Stable identifier for the underlying model — surfaced in action logs. */
  readonly modelId: string;
}

export interface ClickVerifyInput {
  /**
   * Target description the agent intended to click, e.g.
   * "the YouTube search bar". Verbatim from the DirectorAction.target field.
   */
  targetDescription: string;
  /** PNG screenshot taken IMMEDIATELY after the click resolved. */
  screenshot: Buffer;
  /** Whether URL changed between before and after the click. */
  urlChanged: boolean;
  /** Whether `document.title` changed between before and after. */
  titleChanged: boolean;
}

export interface ClickVerifyResult {
  /**
   * True iff the verifier judges the click clearly hit (or at least
   * achieved the user-visible effect of) the intended target.
   * False iff it clearly hit something else (sidebar instead of search,
   * unrelated element). When the verifier is uncertain it should default
   * to `true` — false negatives waste budget on retries.
   */
  matched: boolean;
  /** Brief human-readable explanation, ≤ 200 chars. */
  reason: string;
  /** End-to-end latency of the verification call, in ms. */
  latencyMs: number;
}
