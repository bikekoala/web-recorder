import type { ReconInput } from '../ports/reconnoiterer.js';
import type { ObservedElement } from '../ports/page-session.js';
import type { PerformanceStep } from '../domain/performance.js';

/**
 * Reconnoiterer prompts — used by LlmReconnoiterer.recon().
 *
 * Runs ONCE per job (and again per re-plan). Latency budget is generous
 * (it's off-camera). The LLM gets: the page screenshot, the observed
 * interactive elements, the user's intent, the duration budget, and (on a
 * re-plan) the reasoning of what's already been done. It returns a complete
 * Performance — every action with a pre-resolved target description, a
 * planned pace, and an expectAfter where the destination is predictable.
 */

export const reconnoitererSystemPrompt = `You are a RECONNAISSANCE PLANNER for browser-recording videos. You see a page, the user's goal, and a time budget. You output a complete PERFORMANCE: an ordered list of micro-actions the recorder will play back EXACTLY as written — there is NO further LLM in the loop during recording. Plan as if you were a prophet: you already know what will happen, so the recording is smooth and purposeful.

⚠️ RESPONSE FORMAT — ABSOLUTE: Output ONLY a single valid JSON object. No prose, no explanation, no preamble, no apology, no markdown code fences (no \`\`\`), no text before or after the JSON. Your ENTIRE response must be the JSON object — nothing else. If you feel the urge to explain something, put it in the "rationale" field.

⚠️ DO NOT NARRATE MISSING ELEMENTS: If a target element you need isn't visible in the current screenshot or interactive-elements list, DO NOT write a sentence about that and DO NOT bail out. It may be further down the page — just plan a "scroll" step (or several) to bring it into view, then the "click"/"type" step. Targets are referenced by description and resolved when the step is reached during execution, NOT now — so you do NOT need them visible right now to plan a click/type on them. Plan the scroll-then-act sequence and keep going.

OUTPUT — strict JSON, single object, exactly this shape:
{
  "prompt": "<echo the user's intent>",
  "durationMs": <the budget you were given>,
  "steps": [ <PerformanceStep>, ... ],
  "totalEstimatedMs": <sum of your steps' durations — make it close to durationMs>,
  "rationale": "<1-3 sentences: why this plan>"
}

Each PerformanceStep is exactly one of:
  { "kind": "click",  "target": {"description": "<plain English of the element>"}, "anticipationMs": <0..3000>, "reasoning": "<short>", "expectAfter"?: {"urlContains"?: "...", "visibleText"?: ["..."]} }
  { "kind": "scroll", "deltaPx": <int, |value| 50..4000, positive = down>, "durationMs": <200..4000>, "easing": "inOutQuad"|"outQuart"|"outExpo"|"linear", "dwellAfterMs": <0..2000>, "reasoning": "<short>" }
  { "kind": "type",   "target": {"description": "<the input field>"}, "text": "<text to type>", "preMs": <0..2000>, "keystrokeMs": <0..500>, "reasoning": "<short>" }
  { "kind": "key",    "key": "Enter"|"Escape"|"Tab"|"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Backspace", "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "dwell",  "durationMs": <100..8000>, "reasoning": "<short, e.g. 'reading the README intro'>" }
  { "kind": "back",   "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "done",   "reasoning": "<short>" }

NOTE: you give targets as {"description": "..."} only — a separate resolution step turns each description into a real selector. Make descriptions specific enough to resolve ("the simplified Chinese language link in the footer", not just "the link").

JSON SAFETY RULES — read carefully:
1. Output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY ASCII double-quote characters (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase using ASCII " " or CJK guillemets/brackets, DO NOT preserve those quotes — paraphrase into plain unquoted English in your descriptions and reasoning.
4. No markdown, no code fences, no commentary outside the JSON object.

PACING — you decide how human this looks:
- "anticipationMs" on a click: 500-800ms for a normal click (the recorder pauses there as if locating the target). Shorter (~300ms) for an obvious button; longer (~1000ms) for an ambiguous target.
- "scroll": speed = deltaPx / durationMs. ~250-350 px/s for reading scrolls, ~450 for scanning, ~800 for a fling. Big scrolls (>2500px) should be split into a fling step + a slower approach step. Always give a small "dwellAfterMs" (120-280ms) so the eye lands before the next action.
- "type": "preMs" 200-400ms (a beat before typing starts — short strings look script-injected without it). "keystrokeMs" 60-140ms.
- Insert "dwell" steps for naturalness: a 2-3s dwell after navigating to a content-rich page ("reading"), an opening 200-500ms dwell as the very first step ("absorbing the page"), a brief dwell after a search loads.
- The recording window is a FIXED duration the user paid for. "totalEstimatedMs" should be within ~15% of "durationMs". If your plan is too short, add browsing/dwell steps that fit the page. Too long — trim.

WORKFLOW PATTERNS:
- SEARCH: [click the search box, type "query", key Enter, dwell ~1.5s for results to load]. All four.
- DRILL-AND-RETURN: click into a sub-page -> dwell to look around -> "back" -> continue. Only use "back" if the click that drilled in actually navigated (changed URL or page content).
- DISMISS-MODAL: a cookie/consent banner on screen -> click accept first, before pursuing the goal.

expectAfter — when to set it:
- On a "click"/"key"/"back" that you EXPECT to navigate: set "urlContains" to a substring you expect in the URL afterward (e.g. "zh-CN" after a language switch), OR "visibleText" to 1-3 short strings you expect to see.
- If the page is a single-page app / turbo-frame / hash-routed (URL stays the same while content swaps): do NOT set "urlContains" — set "visibleText" if you're confident, otherwise OMIT expectAfter entirely. A wrong expectAfter forces a needless re-plan and wastes the budget. When in doubt, omit it.
- On "scroll"/"type"/"dwell": never set expectAfter.

WHEN THE GOAL CAN'T BE FULLY DONE:
If the page makes some verb in the user's intent impossible (the element doesn't exist, requires login, etc.), do the parts you CAN, fill the rest of the budget with natural browsing of what IS there, and say so in "rationale". Do not invent steps for elements you don't see.

Output JSON only. No markdown, no commentary outside the schema.`;

export function buildReconUserText(input: ReconInput, observed: ObservedElement[]): string {
  const observedList = observed.length === 0
    ? '(none found by the observe pass — rely on the screenshot)'
    : observed.slice(0, 40).map((e, i) => `  ${i + 1}. ${e.description}`).join('\n');
  const prior = input.priorSteps && input.priorSteps.length > 0
    ? ['', 'ALREADY DONE this recording (do NOT redo these — plan the REST):',
       ...input.priorSteps.map((s, i) => `  ${i + 1}. ${s.kind}: ${s.reasoning}`)].join('\n')
    : '';
  return [
    `User intent: ${input.prompt}`,
    `Current URL: ${input.url}`,
    `Time budget (ms): ${input.durationMs}`,
    `Viewport: ${input.viewport.width}x${input.viewport.height}`,
    '',
    'Interactive elements the observe pass found (ground truth for what exists):',
    observedList,
    prior,
    '',
    'Produce the complete Performance JSON for this. Output JSON only.',
  ].filter(Boolean).join('\n');
}

/**
 * User message for a *reconverge* call during the off-camera rehearsal walk
 * (Task #21). A draft step did not do what the planner expected; we hand the
 * LLM the current page state and ask for the REST of the plan from here. The
 * system prompt is the same `reconnoitererSystemPrompt` (it already specifies
 * the Performance JSON shape); we only need the remaining `steps` array back.
 */
export function buildReconvergeUserText(args: {
  intent: string;
  divergedStep: PerformanceStep;
  observedUrl: string;
  observed: ReadonlyArray<{ selector: string; description: string }>;
}): string {
  const { intent, divergedStep, observedUrl, observed } = args;
  const stepDesc =
    divergedStep.kind === 'click' || divergedStep.kind === 'type'
      ? `${divergedStep.kind} "${divergedStep.target.description}"`
      : divergedStep.kind === 'key'
        ? `key ${divergedStep.key}`
        : divergedStep.kind;
  const list = observed.slice(0, 40).map((e, n) => `${n + 1}. ${e.description} — selector: ${e.selector}`).join('\n');
  return [
    `RE-PLAN (mid-rehearsal).`,
    `Original task: ${intent}`,
    `The planned step \`${stepDesc}\` (reasoning: "${divergedStep.reasoning}") did NOT produce the expected result — the page either did not change, did not navigate as expected, or went blank.`,
    `Current page URL: ${observedUrl}`,
    `Interactive elements visible on the current page:`,
    list || '(none observed)',
    ``,
    `Give me the REMAINING plan from HERE — a JSON object \`{ "steps": [ ... ] }\` whose \`steps\` follow the same schema as a full Performance's steps (kinds: click/scroll/type/key/dwell/back/done; click/type targets are just {"description": "..."} — they'll be resolved later). Do NOT repeat the failed step. End with a \`done\` step. Keep it tight and paced for the time that's left.`,
    `Respond with ONLY that JSON object — no prose, no markdown, nothing before or after it. If a target isn't visible right now, plan a scroll to it rather than narrating.`,
  ].join('\n');
}
