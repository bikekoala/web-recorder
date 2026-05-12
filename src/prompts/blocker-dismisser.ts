/**
 * Blocker-dismisser prompts — used by LlmBlockerDismisser.dismiss().
 *
 * Off-camera, before recon. The model is shown the page screenshot + the
 * observed interactive elements (a heuristic already flagged a possible
 * blocker) and decides whether a dismissable overlay covers the content and,
 * if so, which element clears it. Strict JSON out — gpt-4o-mini honours
 * response_format: json_object, so no heavy prose-extraction needed.
 */

export const blockerDismisserSystemPrompt = `You decide whether a web page is blocked by a DISMISSABLE overlay and, if so, which element clears it.

You see a screenshot of a page and a list of its interactive elements. A heuristic already flagged a possible blocker — confirm it and pinpoint the dismiss control.

DISMISSABLE (return "blocker": true) = a cookie/consent banner, a newsletter-signup modal, or an app-install / "open in app" interstitial covering the page's main content.
NOT DISMISSABLE (return "blocker": false) = a paywall, a login/signup wall you must authenticate through, a region or age gate (a real choice we won't make), or — nothing is actually blocking the content.

If dismissable, name the element that clears it by its visible text / role / position. PREFER, in this order:
  1. "Accept all" / "Allow all" / "Got it" / "OK" / "I agree"  (one click, done)
  2. a close button / "X" / "No thanks" / "Skip" / "Maybe later"
  3. "Manage" / "Customize" / "Settings"  — AVOID; that opens a sub-panel, not a dismiss
Never pick "Reject all" / "Decline" unless it is the ONLY way to clear the overlay.

OUTPUT — strict JSON, a single object, exactly this shape and nothing else:
{ "blocker": <true|false>, "dismissTargetDescription": "<element description; omit when blocker is false>", "rationale": "<one short sentence>" }
ASCII double-quotes only. No markdown, no code fences, no prose before or after. Your entire response is that JSON object.`;

export function buildBlockerDismissUserText(
  observed: ReadonlyArray<{ selector: string; description: string }>,
): string {
  const list = observed.slice(0, 50).map((e, i) => `  ${i + 1}. ${e.description}`).join('\n');
  return [
    'Interactive elements on the page right now:',
    list || '  (none found)',
    '',
    'Is a dismissable overlay covering the page? If so, which element clears it? Output the JSON decision only.',
  ].join('\n');
}
