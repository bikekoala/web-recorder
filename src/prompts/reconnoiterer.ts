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
  • \`"targetDescription"\` — a short plain-English name for that same node ("the simplified Chinese language link", "the search box in the header"). This is a SAFETY NET: if the ref turns out stale at execution time, the recorder re-finds the element by this description. Make it specific enough to disambiguate.
And for a \`click\` step, ALSO give (when the node has any):
  • \`"targetText"\` — the node's EXACT visible text, copied character-for-character ("Felidae", "Sign in", "简体中文"). This is the strongest safety net — the recorder can re-find the element by a deterministic text/role lookup that works even on a huge page where the description-based re-find can't. If the node is icon-only / image-only and shows no text, OMIT the \`targetText\` key entirely — do not set it to an empty string. (\`type\` steps don't need it.)

⚠️ DON'T NARRATE MISSING ELEMENTS: If the node you need isn't in the tree (it's lazy-loaded, or below a virtualized list), DO NOT write a sentence about that and DO NOT bail out. Pick the NEAREST visible node and add a \`scroll\` step toward it — when the recorder reaches that area it will re-look; if your plan still diverges, a re-plan with a fresh tree will fix it. Just plan the scroll-then-act and keep going.

⚠️ PRIORITY #1 — ACCOMPLISH THE GOAL. Your plan's first job is to DO WHAT THE USER ASKED. Read the user's intent and extract EVERY concrete action it requests — every "click X", "type Y", "search for Z", "go to W", "open V". Each one MUST appear as a step: a "click" step (with a \`ref\` + \`targetDescription\`) for each link/button to click, a "type" step for each thing to type, a "key" step for each Enter/etc. Pacing it naturally with scrolls and dwells comes SECOND. A plan that looks beautifully human but never clicks the link the user asked for is a FAILURE — strictly worse than a slightly clumsy plan that actually does the task. BEFORE YOU OUTPUT: re-read the user intent and check your "steps" array — is there a step for each requested action? If the user said "click the X link" and there is no "click" step pointing at X, your plan is WRONG; fix it before you emit the JSON.

OUTPUT — strict JSON, single object, exactly this shape:
{
  "prompt": "<echo the user's intent>",
  "durationMs": <the budget you were given — a single integer>,
  "steps": [ <step>, ... ],
  "rationale": "<1-3 sentences: why this plan; mention if you irreconcilably underfill the budget so the runner can flag it>"
}

Each step is exactly one of:
  { "kind": "click",  "ref": "<id from the tree, e.g. e7>", "targetDescription": "<plain English of that node>", "targetText"?: "<that node's exact visible text, e.g. Felidae — omit if it shows no text>", "anticipationMs": <0..3000>, "reasoning": "<short — one clause, under 200 chars>", "expectAfter"?: {"urlContains"?: "...", "visibleText"?: ["..."]} }
  { "kind": "scroll", "deltaPx": <int, |value| 50..4000, positive = down>, "durationMs": <200..4000>, "easing": "inOutQuad"|"outQuart"|"outExpo"|"linear", "dwellAfterMs": <0..2000>, "reasoning": "<short — one clause, under 200 chars>" }
  { "kind": "type",   "ref": "<id from the tree, e.g. e11>", "targetDescription": "<plain English of that input>", "text": "<text to type>", "preMs": <0..2000>, "keystrokeMs": <0..500>, "reasoning": "<short — one clause, under 200 chars>" }
  { "kind": "key",    "key": "Enter"|"Escape"|"Tab"|"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Backspace", "reasoning": "<short — one clause, under 200 chars>", "expectAfter"?: {...} }
  { "kind": "dwell",  "durationMs": <100..8000>, "reasoning": "<short — one clause, under 200 chars, e.g. 'reading the README intro'>" }
  { "kind": "back",   "reasoning": "<short — one clause, under 200 chars>", "expectAfter"?: {...} }
  { "kind": "goto",   "url": "<absolute URL on the SAME host as the starting URL>", "anticipationMs": <0..3000>, "reasoning": "<short — one clause, under 200 chars>", "expectAfter"?: {...} }
  { "kind": "done",   "reasoning": "<short — one clause, under 200 chars>" }

JSON SAFETY RULES — read carefully:
1. Output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY ASCII double-quote characters (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase using ASCII " " or CJK guillemets/brackets, DO NOT preserve those quotes — paraphrase into plain unquoted English in your reasoning.
4. No markdown, no code fences, no commentary outside the JSON object.
5. \`"reasoning"\` on EACH step is a SHORT phrase — one clause, ideally under ~80 characters, never over ~200. It is a label for the step, NOT a place to narrate the whole plan. Do NOT pour a paragraph of explanation into a single step's reasoning — that breaks the JSON shape (the model often loses track of brackets mid-paragraph and never closes the steps array). Each step gets its own short reasoning; the OVERALL plan's explanation goes ONLY in the top-level \`rationale\` field.
6. Emit ALL the steps for the plan — do NOT stop after one step. The \`steps\` array MUST close with \`]\` and the outer object MUST close with \`}\`. Re-check the closing punctuation before ending your response.
7. EVERY numeric value (durationMs, deltaPx, anticipationMs, preMs, keystrokeMs, dwellAfterMs, etc.) is a single JSON number literal — \`9450\`, \`-300\`, \`1.5\`. NEVER an arithmetic expression (\`500 + 800\`), variable, percentage string, or math equation. JSON.parse rejects all of those.

PACING — you decide how human this looks:
- "anticipationMs" on a click: 500-800ms for a normal click (the recorder pauses there as if locating the target). Shorter (~300ms) for an obvious button; longer (~1000ms) for an ambiguous target. NOTE: a click/key/back/goto ALSO costs ~1.5 s afterwards while the page settles (navigating, re-rendering) — that's automatic, you don't add a step for it, but DO count it when you budget the window: a click/goto is roughly anticipationMs + ~1.5 s of recording time, not just anticipationMs.
- "scroll": speed = deltaPx / durationMs. ~250-350 px/s for reading scrolls, ~450 for scanning, ~800 for a fling. Big scrolls (>2500px) should be split into a fling step + a slower approach step. \`dwellAfterMs\` (120-280ms) is the EYE-LANDING pause — the moment the eye settles after motion. It is NOT reading time. Reading is a separate \`dwell\` step that FOLLOWS the scroll.

SCROLL-TO-TARGET DISCIPLINE — read this:
- Think in viewport-heights: one screenful ≈ 720 px. To bring a target into view, scroll ROUGHLY to where you think it is — do not overshoot. NEVER plan a "scroll way past it, then scroll back up" two-step dance to position something; that reads as a robot hunting.
- Unsure of the exact position? Plan a MODERATE scroll (one or two screenfuls), then the click/type — execution will nudge the element the rest of the way into view if needed. Under-shooting slightly is fine; a wild overshoot is not.
- A "slowly scroll down through the README / page" intent is a FEW moderate \`scroll\` steps (each ~600-900 px, easing "inOutQuad", "dwellAfterMs" ~200-400) interleaved with brief \`dwell\` steps — NOT one giant scroll to the bottom.
- "type": "preMs" 200-400ms (a beat before typing starts — short strings look script-injected without it). "keystrokeMs" 60-140ms.
- Insert "dwell" steps for naturalness: a 2-3s dwell after navigating to a content-rich page ("reading"), an opening 200-500ms dwell as the very first step ("absorbing the page"), a brief dwell after a search loads.

READING RHYTHM (for prompts whose intent is to read / browse a long page):
- The cadence a human reads at is \`scroll → DWELL 1800-5000ms (read what just came into view) → scroll → DWELL 1800-5000ms → …\`. That dwell is a SEPARATE \`dwell\` step, not the scroll's tiny \`dwellAfterMs\`.
- VARIANCE IS THE POINT — not "vary a bit", actually vary. Two adjacent dwells should NEVER be within 400ms of each other; aim for a real spread (e.g. 1600ms, 4200ms, 2300ms, 3800ms, 1900ms). A real reader skims short paragraphs in ~1.5s and lingers on dense ones for 4-5s. If every dwell in your plan is ~2500ms, the judge will read it as a robot — even though every individual value is "in the range".
- For plans with ≥5 dwells (typical of ≥20s reading prompts): include AT LEAST ONE "lingering" dwell of 4500-7000ms on the densest / most content-rich section. Without that outlier, even a varied plan of 7+ scroll-dwell pairs falls into a perceived 3-4s cycle that reads as a metronome over the full duration. The lingering dwell breaks the meta-rhythm.
- Same rule for scroll deltaPx: two adjacent scrolls within 100 px of each other is the metronome anti-pattern. Mix sizes — e.g. 850 px, 420 px, 700 px, 1100 px, 300 px (a small "refinement" scroll). A reader covers a paragraph, then a heading, then a longer chunk, then a small adjustment — not the same chunk again and again.
- A metronomic rhythm — uniform scroll + uniform dwell — reads as robot scanning, not human reading. The judge flags it almost every time.
- Each scroll should be a substantive chunk (~300-1100 px). Many tiny ~150 px scrolls + short dwellAfterMs is the metronome anti-pattern, even if the total adds up to the same distance.
- For a long article: 4-6 \`(scroll, dwell)\` pairs over 20 s is natural; 11 small scrolls every second is not.
- Closing-dwell discipline: the LAST dwell before \`done\` should be SHORT (≤ 1500ms). A reader who has finished doesn't stare at the bottom of the page — they move on. A long closing dwell reads as the agent giving up.

END-OF-CONTENT — don't stare:
- If you reach the bottom of meaningful content with budget remaining, you have two natural choices: (1) click into something interesting on the page (a top result, a comment thread, a linked article), or (2) end with \`done\`. DO NOT plan a multi-second static \`dwell\` at the literal bottom of the page just to consume time — that 5-second motionless stare reads as the agent giving up.
- A brief 1-2 s dwell AT a content section worth lingering on is fine. A 4-5 s dwell at the bottom of an empty footer or below the last result is not.

WHEN TO USE \`goto\` (direct URL navigation — ADR §0041):
- Use \`goto\` when the user's intent names or strongly implies a destination URL AND no obvious click path exists on the current page in budget. Example: starting at \`github.com\`, the user says "看本周热门项目" — you know the URL is \`github.com/trending\`, but the homepage's nav doesn't expose it as a click. Plan \`{ "kind": "goto", "url": "https://github.com/trending", "anticipationMs": 800, ... }\` instead of hunting through dropdown menus.
- A \`goto\` plays as: \`anticipationMs\` of stillness (the user typing the URL — silent on camera; ~600-1200ms is natural) → the page loads. Cost is ~anticipationMs + ~1500ms of recording time (same as a click).
- Prefer \`click\` over \`goto\` when a visible link/button leads to the destination — that's what a real user does first. \`goto\` is the "I know the URL, just go there" shortcut, not the default tool.
- HARD CONSTRAINT — same-host only: the \`goto\` URL's hostname MUST equal the starting URL's hostname (paths and query strings are free to differ). \`github.com → github.com/trending\` ✓; \`github.com → docs.github.com\` ✗ (different subdomain — use a click); \`github.com → google.com\` ✗ (different site — never). Cross-host gotos are dropped by the runner.

DURATION & SCOPE (hard constraint — supersedes the soft ~15% mention in PACING):
- Your plan MUST fit the durationMs you are given. **You don't compute the cost — the runner does, deterministically.** A rough mental model for sizing the plan (NOT for you to sum on paper):
    click / goto:         anticipation (0.5-0.8 s) + page settle (~1.5 s) ≈ a **2-second commitment**
    key / back:           page settle ~1.5 s + step overhead ~0.3 s ≈ a **2-second commitment**
    dwell:                its own duration + step overhead
    scroll / type:        their declared time + small overhead
  Sizing intuition: a 10-second budget fits **~2 acting steps + a couple of read dwells**, NOT a full click→read→back→scroll→click→read→back. A drill-and-return (click + dwell + back) costs ≈ 4 s + the read; plan at most one of those in a 10 s window. The runner's cost recompute is the source of truth — if your plan overshoots the budget, the runner will reconverge (give you the exact gap and ask you to drop steps), then if you still overshoot it falls through to mechanical compression which crushes dwells to unreadable durations. Aim to land it on the first draft.
- SCROLL-BUDGET — when the user message lists a \`Scrollable height below the current scroll position\` value, the page has FINITE vertical room. Scrolling past the bottom is a no-op = dead air. Sum your scroll deltaPxs mentally and compare to pageScrollableHeight; if it would exceed ~1.2× of that, drop scrolls (favor fewer-but-larger over more-but-smaller — 1 well-chosen 600 px scroll beats 3 metronomic 350 px scrolls on a 500 px page). On pages with < 1 viewport-height of scroll room, prefer zero or one scroll plus reading dwells.
- If the user's prompt forbids an action (any expression — "only", "just", "no X", "don't", "without", 中英任何 — your call), your plan MUST NOT contain that action, and any filler exploration MUST respect the prohibition. We do not pattern-match the prompt for you; identifying prohibitions is your job.
- If the explicit intent does not fill durationMs, do NOT pad with mechanical generic scroll+dwell. Add steps a real person would naturally do on THIS page given THIS prompt: read a result card, scan top chips, glance at the sidebar, scroll to a specific content section worth dwelling on. Each filler step must be groundable in the accessibility tree — the rehearsal walk will verify; ungroundable filler will be dropped.
- MOTION BACKBONE — every plan must have visible activity. Two consecutive \`dwell\` steps (with no scroll/click/type/key/goto/back between them) reads as the agent freezing. NEVER plan dwell→dwell→… in sequence. For a "browse / read / look at" intent over N seconds, aim for roughly one motion step (scroll/click/type/goto) per 2-4 seconds of budget. A 15-second plan with only 1 scroll and 4 dwells is the failure mode the judge calls out as "the recording sits idle".
- If the prompt's prohibitions make any natural filler violate them (e.g. "just glance" + durationMs=60s is irreconcilable), say so in \`rationale\`. The runner will mark the run as underfilled — that is a transparent goal-#3 outcome, not your failure.

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
  const drops = input.priorAttemptDrops && input.priorAttemptDrops.length > 0
    ? ['', 'RE-PLAN — your previous draft requested these targets, but NONE of them could be located on this page (the ref + visible-text + fuzzy-description chain all missed):',
       ...input.priorAttemptDrops.map((d) => `  - ${d}`),
       'Treat those targets as NOT REACHABLE from this page. Re-plan the FULL recording WITHOUT them: either reach the same outcome a different way (different ref / a scroll first / a `goto` if the URL is known and same-host), OR honestly drop that part of the intent and fill the budget with natural browsing of what IS in the tree. Do NOT re-emit the same descriptions — they will fail again.'].join('\n')
    : '';
  // Page-size signal. Lets the LLM size the scroll plan against the actual
  // page. Without this, the LLM blindly plans 600px scrolls on a 200-px-tall
  // page → no-op scrolls → dead air (2026-05-15 HN finding). Reported as raw
  // px + a viewport-height multiplier (the unit the LLM thinks in for scroll
  // planning); no behavioral threshold is hardcoded here — A decides how to
  // use the number (goals.md #6).
  const pageSize = typeof input.pageScrollableHeight === 'number'
    ? (() => {
        const px = input.pageScrollableHeight;
        const vh = input.viewport.height;
        const mult = vh > 0 ? (px / vh).toFixed(1) : '?';
        return `Scrollable height below the current scroll position: ${px}px (≈ ${mult} viewport-heights). Plan only as many scrolls as the page can actually absorb — past the bottom is a no-op and reads as dead air to the viewer.`;
      })()
    : '';
  return [
    `User intent: ${input.prompt}`,
    `Current URL: ${input.url}`,
    `Time budget (ms): ${input.durationMs}`,
    `Viewport: ${input.viewport.width}x${input.viewport.height}`,
    pageSize,
    prior,
    drops,
    '',
    'PAGE ACCESSIBILITY TREE — every actionable node has a stable id `[ref=eN]`. For each `click`/`type` step give `"ref"` (copy the EXACT id from the line in the tree — no `ref=` prefix, no guessing) AND `"targetDescription"` (plain English for that node); for a `click`, ALSO give `"targetText"` = that node\'s exact visible text (omit only if it shows no text) — both are fallbacks if the ref goes stale. Prefer the most specific node, not a `generic` wrapper. If what you want is not in the tree (lazy-loaded), pick the nearest node and add a `scroll` step toward it.',
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
  remainingDurationMs?: number;
}): string {
  const { intent, divergedStep, observedUrl, snapshot, remainingDurationMs } = args;
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
    ...(remainingDurationMs !== undefined ? [`Remaining durationMs budget: ~${remainingDurationMs}ms — keep the rest of the plan within ±10% of this.`] : []),
    ``,
    `PAGE ACCESSIBILITY TREE (current state) — actionable nodes have \`[ref=eN]\` ids:`,
    tree,
    ``,
    `Give me the REMAINING plan from HERE — a JSON object \`{ "steps": [ ... ] }\` whose \`steps\` follow the step schema (kinds click/scroll/type/key/dwell/back/done; click/type carry a \`"ref"\` copied from a line in the tree above AND a \`"targetDescription"\`; a \`click\` ALSO carries \`"targetText"\` = the node's exact visible text unless it shows none). End with a \`done\` step. Keep it tight and paced for the time that's left.`,
    `IMPORTANT — the failed step's GOAL still matters: the action did not work AS DESCRIBED, but if it was the thing the task asks for (e.g. clicking a particular link), DON'T abandon that outcome. What you must not do is blindly re-issue the EXACT same action on the EXACT same node and hope. Instead reach the same outcome a DIFFERENT way: pick a DIFFERENT, more specific node (a different \`ref\`) than the one that failed, or \`scroll\` first to bring the right node fully into view and then act on it, or \`dwell\` so late-loading content appears and then act. Only if the goal genuinely cannot be reached from this page should you move on to whatever else the task asks for and fill the remaining time with that.`,
    `HARD CHECK before you emit: if the original task asked you to click / open / go to something (a link, a button, a page), your "steps" array MUST still contain a \`click\` (or \`key\`) step that does it — re-pointed at a different \`ref\` or preceded by a \`scroll\`. A reconverged plan that is all scroll/dwell with no attempt at the requested click is WRONG; fix it. Re-read "Original task" above and check.`,
    `Respond with ONLY that JSON object — no prose, no markdown, nothing before or after it. If a node isn't in the tree right now, plan a scroll toward the nearest one rather than narrating.`,
  ].join('\n');
}

/**
 * Plan Y slim reconverge (2026-05-15). When the walked plan overshoots
 * the budget, A doesn't need to re-plan from scratch — A just names which
 * steps to drop. We don't re-send the aria tree (A isn't re-picking
 * targets) or the screenshot. Response is a tiny `{ dropIndices: [...] }`.
 *
 * Why this exists: the original Y reconverge reused `buildReconUserText`
 * which re-sent the full aria tree (~10-20 k tokens) and asked for a full
 * `ReconDraft` response (~1000 tokens). Total LLM call ~10-15 s, almost
 * all of it output generation. This slim variant brings the call down to
 * ~2-3 s by shrinking the output to a handful of integers.
 *
 * Constraints encoded in the prompt: A may only DROP steps (not add or
 * swap), and must keep the user-intent-satisfying acting step if any.
 * The runner filters out-of-range indices server-side; A's job is just
 * to nominate.
 */
export function buildOverbudgetEditUserText(args: {
  intent: string;
  budgetMs: number;
  actualMs: number;
  previousSteps: PerformanceStep[];
}): string {
  const { intent, budgetMs, actualMs, previousSteps } = args;
  const overByMs = Math.max(0, actualMs - budgetMs);
  const targetMs = budgetMs;
  // Render each step as a one-line "N. <kind> <gist> (cost ~Xms)". The
  // costs match `sumDurations` so A can mentally subtract them and pick
  // a set that drops at least `overByMs` total.
  const lines: string[] = [];
  previousSteps.forEach((s, i) => {
    const n = i + 1;
    let label = '';
    let cost = 0;
    const overhead = s.kind === 'done' ? 0 : 280;
    switch (s.kind) {
      case 'dwell':
        label = `dwell ${s.durationMs}ms — ${s.reasoning}`;
        cost = s.durationMs + overhead;
        break;
      case 'scroll':
        label = `scroll ${s.deltaPx}px in ${s.durationMs}ms — ${s.reasoning}`;
        cost = s.durationMs + s.dwellAfterMs + overhead;
        break;
      case 'click':
        label = `click "${s.target.description}" — ${s.reasoning}`;
        cost = s.anticipationMs + 1500 + overhead;
        break;
      case 'type':
        label = `type "${s.text.slice(0, 40)}${s.text.length > 40 ? '…' : ''}" — ${s.reasoning}`;
        cost = s.preMs + s.text.length * s.keystrokeMs + overhead;
        break;
      case 'key':
        label = `key ${s.key} — ${s.reasoning}`;
        cost = 1500 + overhead;
        break;
      case 'back':
        label = `back — ${s.reasoning}`;
        cost = 1500 + overhead;
        break;
      case 'goto':
        label = `goto ${s.url} — ${s.reasoning}`;
        cost = s.anticipationMs + 1500 + overhead;
        break;
      case 'done':
        label = `done — ${s.reasoning}`;
        cost = 0;
        break;
    }
    lines.push(`  ${n}. ${label} (cost ~${cost}ms)`);
  });
  return [
    'EDIT THE PLAN — over budget.',
    `User intent: ${intent}`,
    `Budget: ${budgetMs}ms.  Walked plan would actually take ${actualMs}ms — that is ${overByMs}ms too long.`,
    'The runner computed each cost above using its deterministic model — those costs are the ground truth.',
    '',
    'Previous plan:',
    ...lines,
    '',
    `Drop one or more step indices (1-based) so the remaining plan fits ${targetMs}ms (after subtracting the dropped costs). Prefer:`,
    '  - cutting a drill-and-return: \`click → dwell → back\` is a ~6-second saving',
    '  - dropping a redundant scroll or a short bridging dwell',
    '',
    'DO NOT drop the LAST acting step that satisfies the user intent (e.g. if the user said "click the X link" do not drop the click on X — drop something else). DO NOT drop every motion step (scroll/click/type) at once — a plan of pure dwells is a static stare and the recording reads as motionless. For a read/browse intent at least one scroll MUST remain. DO NOT drop the `done` step (it costs ~0ms anyway).',
    '',
    'Output JSON only:',
    '{',
    '  "dropIndices": [<positive integer step numbers, e.g. 4 and 5>],',
    '  "rationale": "<one short sentence — why these and which intent step you preserved>"',
    '}',
    'No prose, no markdown, nothing else.',
  ].join('\n');
}
