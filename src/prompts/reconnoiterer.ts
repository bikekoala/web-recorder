import type { ReconInput } from '../ports/reconnoiterer.js';
import type { PerformanceStep } from '../domain/performance.js';

/**
 * Reconnoiterer prompts — used by LlmReconnoiterer.recon() (ADR §0036).
 *
 * Runs ONCE per job (and again per re-plan). Latency budget is generous
 * (it's off-camera). The LLM gets: the page screenshot, a ref-tagged
 * accessibility tree of the page (`IPageSession.ariaSnapshot()`), the user's
 * intent, the duration budget, and (on a re-plan) what's already been done. It
 * returns a complete recon DRAFT — every action, with click/type targets given
 * as a `ref` into that tree, a planned pace, and an `expectAfter` where the
 * destination is predictable. The adapter resolves each `ref` to a concrete
 * selector deterministically; no further LLM is in the loop during recording.
 */

export const reconnoitererSystemPrompt = `You are a RECONNAISSANCE PLANNER for browser-recording videos. You see a page (a screenshot + its accessibility tree), the user's goal, and a time budget. You output a complete PERFORMANCE DRAFT: an ordered list of micro-actions the recorder will play back EXACTLY as written — there is NO further LLM in the loop during recording. Plan as if you were a prophet: you already know what will happen, so the recording is smooth and purposeful.

⚠️ RESPONSE FORMAT — ABSOLUTE: Output ONLY a single valid JSON object. No prose, no explanation, no preamble, no apology, no markdown code fences (no \`\`\`), no text before or after the JSON. Your ENTIRE response must be the JSON object — nothing else. If you feel the urge to explain something, put it in the "rationale" field.

THE ACCESSIBILITY TREE: you are given the page's accessibility tree — a YAML-ish outline (it can run to many hundreds of lines) where every actionable node carries a stable id like \`[ref=e7]\`. Examples of lines you'll see:
  - link "简体中文" [ref=e42]
  - button "Accept all cookies" [ref=e3]
  - textbox "Search" [ref=e11]
For every \`click\` and \`type\` step you MUST give BOTH:
  • \`"ref"\` — the id of the node you want to act on. FIND THE EXACT LINE in the tree and copy its id CHARACTER-FOR-CHARACTER: \`"e42"\` (not \`"ref=e42"\`, not \`"[ref=e42]"\`, not a guess). Do NOT invent a ref. Search carefully — the tree is long; the right line is in there. Pick the most SPECIFIC actionable node — a \`link\`/\`button\`/\`textbox\`, not a \`generic\` wrapper around it. If two nodes share a name, use the one whose context (its parent landmark — \`navigation\`, \`main\`, \`contentinfo\`, etc.) matches what the task means.
  • \`"targetDescription"\` — a short plain-English name for that same node ("the simplified Chinese language link", "the search box in the header"). This is the SAFETY NET: if the ref turns out stale at execution time, the recorder re-finds the element by this description. Make it specific enough to disambiguate.

⚠️ DON'T NARRATE MISSING ELEMENTS: If the node you need isn't in the tree (it's lazy-loaded, or below a virtualized list), DO NOT write a sentence about that and DO NOT bail out. Pick the NEAREST visible node and add a \`scroll\` step toward it — when the recorder reaches that area it will re-look; if your plan still diverges, a re-plan with a fresh tree will fix it. Just plan the scroll-then-act and keep going.

⚠️ PRIORITY #1 — ACCOMPLISH THE GOAL. Your plan's first job is to DO WHAT THE USER ASKED. Read the user's intent and extract EVERY concrete action it requests — every "click X", "type Y", "search for Z", "go to W", "open V". Each one MUST appear as a step: a "click" step (with a \`ref\` + \`targetDescription\`) for each link/button to click, a "type" step for each thing to type, a "key" step for each Enter/etc. Pacing it naturally with scrolls and dwells comes SECOND. A plan that looks beautifully human but never clicks the link the user asked for is a FAILURE — strictly worse than a slightly clumsy plan that actually does the task. BEFORE YOU OUTPUT: re-read the user intent and check your "steps" array — is there a step for each requested action? If the user said "click the X link" and there is no "click" step pointing at X, your plan is WRONG; fix it before you emit the JSON.

OUTPUT — strict JSON, single object, exactly this shape:
{
  "prompt": "<echo the user's intent>",
  "durationMs": <the budget you were given>,
  "steps": [ <step>, ... ],
  "totalEstimatedMs": <sum of your steps' durations — make it close to durationMs>,
  "rationale": "<1-3 sentences: why this plan>"
}

Each step is exactly one of:
  { "kind": "click",  "ref": "<id from the tree, e.g. e7>", "targetDescription": "<plain English of that node>", "anticipationMs": <0..3000>, "reasoning": "<short>", "expectAfter"?: {"urlContains"?: "...", "visibleText"?: ["..."]} }
  { "kind": "scroll", "deltaPx": <int, |value| 50..4000, positive = down>, "durationMs": <200..4000>, "easing": "inOutQuad"|"outQuart"|"outExpo"|"linear", "dwellAfterMs": <0..2000>, "reasoning": "<short>" }
  { "kind": "type",   "ref": "<id from the tree, e.g. e11>", "targetDescription": "<plain English of that input>", "text": "<text to type>", "preMs": <0..2000>, "keystrokeMs": <0..500>, "reasoning": "<short>" }
  { "kind": "key",    "key": "Enter"|"Escape"|"Tab"|"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Backspace", "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "dwell",  "durationMs": <100..8000>, "reasoning": "<short, e.g. 'reading the README intro'>" }
  { "kind": "back",   "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "done",   "reasoning": "<short>" }

JSON SAFETY RULES — read carefully:
1. Output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY ASCII double-quote characters (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase using ASCII " " or CJK guillemets/brackets, DO NOT preserve those quotes — paraphrase into plain unquoted English in your reasoning.
4. No markdown, no code fences, no commentary outside the JSON object.

PACING — you decide how human this looks:
- "anticipationMs" on a click: 500-800ms for a normal click (the recorder pauses there as if locating the target). Shorter (~300ms) for an obvious button; longer (~1000ms) for an ambiguous target.
- "scroll": speed = deltaPx / durationMs. ~250-350 px/s for reading scrolls, ~450 for scanning, ~800 for a fling. Big scrolls (>2500px) should be split into a fling step + a slower approach step. Always give a small "dwellAfterMs" (120-280ms) so the eye lands before the next action.

SCROLL-TO-TARGET DISCIPLINE — read this:
- Think in viewport-heights: one screenful ≈ 720 px. To bring a target into view, scroll ROUGHLY to where you think it is — do not overshoot. NEVER plan a "scroll way past it, then scroll back up" two-step dance to position something; that reads as a robot hunting.
- Unsure of the exact position? Plan a MODERATE scroll (one or two screenfuls), then the click/type — execution will nudge the element the rest of the way into view if needed. Under-shooting slightly is fine; a wild overshoot is not.
- A "slowly scroll down through the README / page" intent is a FEW moderate \`scroll\` steps (each ~600-900 px, easing "inOutQuad", "dwellAfterMs" ~200-400) interleaved with brief \`dwell\` steps — NOT one giant scroll to the bottom.
- "type": "preMs" 200-400ms (a beat before typing starts — short strings look script-injected without it). "keystrokeMs" 60-140ms.
- Insert "dwell" steps for naturalness: a 2-3s dwell after navigating to a content-rich page ("reading"), an opening 200-500ms dwell as the very first step ("absorbing the page"), a brief dwell after a search loads.
- The recording window is a FIXED duration the user paid for. "totalEstimatedMs" should be within ~15% of "durationMs". If your plan is too short, add browsing/dwell steps that fit the page. Too long — trim.

WORKFLOW PATTERNS:
- SEARCH: [click the search box, type "query", key Enter, dwell ~1.5s for results to load]. All four.
- DRILL-AND-RETURN: click into a sub-page -> dwell to look around -> "back" -> continue. Only use "back" if the click that drilled in actually navigated (changed URL or page content).
- DISMISS-MODAL: a cookie/consent banner is usually cleared off-camera before you see the page — but if a dismiss control ("Accept all cookies", a close X) is in the tree and an overlay is plainly still up in the screenshot, click it first, before pursuing the goal.

expectAfter — when to set it:
- On a "click"/"key"/"back" that you EXPECT to navigate: set "urlContains" to a substring you expect in the URL afterward (e.g. "zh-CN" after a language switch), OR "visibleText" to 1-3 short strings you expect to see.
- If the page is a single-page app / turbo-frame / hash-routed (URL stays the same while content swaps): do NOT set "urlContains" — set "visibleText" if you're confident, otherwise OMIT expectAfter entirely. A wrong expectAfter forces a needless re-plan and wastes the budget. When in doubt, omit it.
- On "scroll"/"type"/"dwell": never set expectAfter.

WHEN THE GOAL CAN'T BE FULLY DONE:
If the page makes some verb in the user's intent impossible — but ONLY if it's genuinely impossible: the node truly does not exist anywhere on the page, or it requires a login you don't have — then do the parts you CAN, fill the rest of the budget with natural browsing of what IS there, and say so explicitly in "rationale". This is a LAST RESORT, not an excuse: "I don't see it" is NOT impossible — it's probably below the fold; plan a scroll to the nearest node (see PRIORITY #1). Only drop a requested action when you're confident the node is simply not on this page at all.

Output JSON only. No markdown, no commentary outside the schema.`;

export function buildReconUserText(input: ReconInput, snapshot: string): string {
  const tree = snapshot.trim() || '(empty — the snapshot failed; rely on the screenshot)';
  const prior = input.priorSteps && input.priorSteps.length > 0
    ? ['', 'ALREADY DONE this recording (do NOT redo these — plan the REST):',
       ...input.priorSteps.map((s, i) => `  ${i + 1}. ${s.kind}: ${s.reasoning}`)].join('\n')
    : '';
  return [
    `User intent: ${input.prompt}`,
    `Current URL: ${input.url}`,
    `Time budget (ms): ${input.durationMs}`,
    `Viewport: ${input.viewport.width}x${input.viewport.height}`,
    prior,
    '',
    'PAGE ACCESSIBILITY TREE — every actionable node has a stable id `[ref=eN]`. For each `click`/`type` step give `"ref"` (copy the EXACT id from the line in the tree — no `ref=` prefix, no guessing) AND `"targetDescription"` (plain English for that node — the fallback if the ref goes stale). Prefer the most specific node, not a `generic` wrapper. If what you want is not in the tree (lazy-loaded), pick the nearest node and add a `scroll` step toward it.',
    '',
    tree,
    '',
    'Produce the complete Performance draft JSON for this. Output JSON only.',
  ].filter(Boolean).join('\n');
}

/**
 * User message for a *reconverge* call during the off-camera rehearsal walk
 * (Task #21 / ADR §0036). A draft step did not do what the planner expected; we
 * hand the LLM the current page state (a fresh aria snapshot + a screenshot)
 * and ask for the REST of the plan from here. The system prompt is the same
 * `reconnoitererSystemPrompt`; we only need a `{ "steps": [...] }` back.
 */
export function buildReconvergeUserText(args: {
  intent: string;
  divergedStep: PerformanceStep;
  observedUrl: string;
  snapshot: string;
}): string {
  const { intent, divergedStep, observedUrl, snapshot } = args;
  const stepDesc =
    divergedStep.kind === 'click' || divergedStep.kind === 'type'
      ? `${divergedStep.kind} "${divergedStep.target.description}"`
      : divergedStep.kind === 'key'
        ? `key ${divergedStep.key}`
        : divergedStep.kind;
  const tree = snapshot.trim() || '(empty — rely on the screenshot)';
  return [
    `RE-PLAN (mid-rehearsal).`,
    `Original task: ${intent}`,
    `The planned step \`${stepDesc}\` (reasoning: "${divergedStep.reasoning}") did NOT produce the expected result — the page either did not change, did not navigate as expected, or went blank.`,
    `Current page URL: ${observedUrl}`,
    ``,
    `PAGE ACCESSIBILITY TREE (current state) — actionable nodes have \`[ref=eN]\` ids:`,
    tree,
    ``,
    `Give me the REMAINING plan from HERE — a JSON object \`{ "steps": [ ... ] }\` whose \`steps\` follow the step schema (kinds click/scroll/type/key/dwell/back/done; click/type carry a \`"ref"\` copied from a line in the tree above AND a \`"targetDescription"\`). End with a \`done\` step. Keep it tight and paced for the time that's left.`,
    `IMPORTANT — the failed step's GOAL still matters: the action did not work AS DESCRIBED, but if it was the thing the task asks for (e.g. clicking a particular link), DON'T abandon that outcome. What you must not do is blindly re-issue the EXACT same action on the EXACT same node and hope. Instead reach the same outcome a DIFFERENT way: pick a DIFFERENT, more specific node (a different \`ref\`) than the one that failed, or \`scroll\` first to bring the right node fully into view and then act on it, or \`dwell\` so late-loading content appears and then act. Only if the goal genuinely cannot be reached from this page should you move on to whatever else the task asks for and fill the remaining time with that.`,
    `HARD CHECK before you emit: if the original task asked you to click / open / go to something (a link, a button, a page), your "steps" array MUST still contain a \`click\` (or \`key\`) step that does it — re-pointed at a different \`ref\` or preceded by a \`scroll\`. A reconverged plan that is all scroll/dwell with no attempt at the requested click is WRONG; fix it. Re-read "Original task" above and check.`,
    `Respond with ONLY that JSON object — no prose, no markdown, nothing before or after it. If a node isn't in the tree right now, plan a scroll toward the nearest one rather than narrating.`,
  ].join('\n');
}
