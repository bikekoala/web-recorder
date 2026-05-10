import type { ClickVerifyInput } from '../ports/click-verifier.js';

/**
 * Click-verifier prompts.
 *
 * The verifier runs ONCE per click action. Tight scope: given a target
 * description and a post-click screenshot, judge whether the click hit
 * what it described.
 *
 * Output is small (1 boolean + ≤ 30-word reason), so we use
 * `response_format: json_object` and a small fast model
 * (`config.llmDeciderModel` — gpt-4o-mini reuses the decider's model).
 *
 * Default to optimistic on uncertainty: false negatives waste budget on
 * retries that don't help. The verifier is a SAFETY NET, not a perfectionist.
 */

export const clickVerifierSystemPrompt = `You are a click verifier for a browser-recording agent. The agent just executed a click on a target it described in plain language. Your job: judge whether the click actually hit (or achieved the user-visible effect of) the intended target.

You will receive:
- The TARGET DESCRIPTION the agent intended to click (e.g., "the YouTube search bar")
- A SCREENSHOT taken IMMEDIATELY AFTER the click resolved
- Two boolean signals: did URL change? did page title change?

Output JSON ONLY, exactly:
{
  "matched": <boolean>,
  "reason": "<short explanation, ≤ 30 words>"
}

JUDGEMENT RULES:
- "matched": true means the click clearly succeeded — the target element responded as a user would expect. For an input/text-field target: it gained focus (cursor visible, input outline). For a link/button: navigation happened, a modal opened, or visible content updated. For SPA pages it's normal for URL to NOT change but title or content does.
- "matched": false means the click clearly hit the WRONG element. Classic failures: a sidebar / hamburger menu opened when the target was a search input. An unrelated overlay appeared. Nothing changed AND the target is plainly visible+unaffected in the screenshot.
- WHEN UNCERTAIN, return matched: true. False positives are OK; false negatives waste recording budget on retries.

Output JSON only, no markdown, no commentary.`;

/**
 * Build the user-message text for the verifier. The screenshot is
 * attached separately as an image_url part by the adapter.
 */
export function buildClickVerifierUserText(input: Pick<ClickVerifyInput, 'targetDescription' | 'urlChanged' | 'titleChanged'>): string {
  return [
    `TARGET DESCRIPTION: ${input.targetDescription}`,
    `URL changed since click: ${input.urlChanged}`,
    `Title changed since click: ${input.titleChanged}`,
    '',
    'Look at the screenshot below. Did the click hit the right target?',
    'Reply with the JSON object specified by the system message — nothing else.',
  ].join('\n');
}
