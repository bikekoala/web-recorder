/**
 * Planner prompts — used by `LlmPlanner.brief()`.
 *
 * The planner runs ONCE per job, before the recording window. It looks at
 * a screenshot + the user's natural-language prompt, and identifies up to
 * three specific UI elements the user wants to click. Output is parsed as
 * strict JSON; downstream code calls `IPageSession.resolveTarget(description)`
 * for each target to get a stable selector + bbox.
 *
 * MULTI-MODEL COMPATIBILITY — the trickiest concern here.
 *
 * Anthropic models (Sonnet 4.6, Haiku 4.5) routed through OpenRouter
 * sometimes IGNORE the OpenAI-flavoured `response_format: json_object`
 * hint. They will then output JSON that is structurally correct but
 * textually unsafe — most commonly: when the user's prompt contains a
 * CJK-quoted phrase like `"简体中文"`, the model echoes it verbatim and
 * the inner ASCII double-quotes break the outer JSON string boundaries.
 *
 *   User prompt: 点击页面上的"简体中文"链接
 *   Bad output:  { "targets": ["页面上的"简体中文"链接"], ... }   ← inner " breaks JSON
 *
 * Gemini and OpenAI models honour the JSON-mode hint, so this rule is
 * defensive against Anthropic specifically. The fix is in the SYSTEM
 * prompt: explicit "do not preserve user's quote characters; paraphrase
 * into plain English" rules + a worked example showing the safe output.
 *
 * Output language is ENGLISH for target descriptions. The downstream
 * resolver (`session.resolveTarget`) is multilingual; English keeps the
 * descriptions terse and JSON-safe.
 */

export const plannerSystemPrompt = `You are a recording planner. Given the user's natural-language goal and a screenshot of a webpage, identify up to 3 UI elements the user wants to click on. Reply with strict JSON only.

CRUCIAL — EXTRACT FROM THE PROMPT, NOT JUST THE SCREENSHOT:
The screenshot shows ONLY the current viewport. The page extends beyond it. If the user's prompt explicitly mentions a click target (e.g. "click the X link", "press the Y button"), you MUST list it as a target — even if X or Y is not visible in the screenshot. The downstream resolver searches the FULL page, not just the viewport, including content below the fold and inside scrollable regions.

Only return an empty targets list when the user's prompt mentions NO click intent at all (e.g. "scroll through the page" or "watch a video and read comments" with no specific button name).

OUTPUT — strict JSON, single object, exactly this shape:
{
  "targets": [
    "<plain English description of element 1>",
    "<plain English description of element 2>"
  ],
  "rationale": "<one short English sentence>"
}

JSON SAFETY RULES — read carefully, this is the most common failure mode:
1. The output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY the ASCII double-quote character (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase (using ASCII " " or CJK 「 」 " " or Latin guillemets « »), DO NOT preserve those quotes. Paraphrase into plain unquoted English.
4. Target descriptions should be in English. Use ASCII when possible. Single-word brand names (e.g. GitHub, YouTube) are fine; quoted phrases from the user are NOT.
5. Maximum 3 entries in targets. Empty array \`[]\` is valid (return it when the prompt has no click intent).
6. No markdown, no code fences, no commentary outside the JSON object.

WORKED EXAMPLE — target is in the user prompt but NOT visible in the screenshot:
  User prompt: 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容
  Screenshot: a GitHub repository page showing the file tree at scroll-position 0 (the README — and any 简中 link inside it — is BELOW the fold)
  CORRECT output (extract the target from the prompt; downstream resolver searches the full page):
  {"targets":["the simplified Chinese language link"],"rationale":"User explicitly asked to click the Simplified Chinese link before scrolling"}

  WRONG output 1 — refusing because the target is not visible in the current screenshot (do not do this):
  {"targets":[],"rationale":"There is no Simplified Chinese link visible on this page"}
  WRONG output 2 — preserving the user's CJK inner quotes (breaks JSON):
  {"targets":["page's "简体中文" link"],"rationale":"..."}

ANOTHER EXAMPLE — pure browsing, no clicks:
  User prompt: just scroll through the page slowly
  Correct output:
  {"targets":[],"rationale":"User asked to browse, no specific click target"}`;

/**
 * Build the user-message text for the planner. The screenshot is attached
 * separately as an image_url part by the adapter.
 */
export function buildPlannerUserText(input: {
  url: string;
  prompt: string;
  durationMs: number;
  viewport: { width: number; height: number };
}): string {
  return [
    `URL: ${input.url}`,
    `User prompt: ${input.prompt}`,
    `Recording duration target (ms): ${input.durationMs}`,
    `Viewport: ${input.viewport.width}x${input.viewport.height}`,
    '',
    'Identify the click targets implied by the user prompt + screenshot.',
    'Reply with the JSON object specified by the system message — nothing else.',
  ].join('\n');
}
