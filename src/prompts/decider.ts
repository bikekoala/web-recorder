import type { DirectorState } from '../domain/director-state.js';

/**
 * Decider prompts — used by `LlmFastDecider.decide()`.
 *
 * The decider runs MANY times per job (5-15) inside the recording window.
 * Latency budget is sub-second p95. Each call returns 1-2 actions for the
 * Director to execute immediately.
 *
 * The same multi-model JSON safety rules apply as the planner — Anthropic
 * routed via OpenRouter sometimes echoes user-quoted CJK phrases verbatim,
 * and the action's `target` field is the most likely place that bites
 * (since the user asked for a click on a specifically-named element).
 *
 * The system prompt also embeds the project's behavioural rules:
 * - Visual-blocker awareness (don't dwell on a paused-video play overlay).
 * - "done" semantics (full intent satisfaction, not first-scroll-and-quit).
 * - Anti-passivity (no third dwell in a row).
 *
 * Briefing-hint surfacing (NEW): the user-message lists ALL hints the
 * planner identified, with each annotated as IN VIEW / ABOVE / BELOW the
 * current viewport. The LLM can request a `click` for an off-fold hint;
 * the executor handles the discovery scroll automatically. This was
 * formerly viewport-only, which left the LLM blind to below-fold targets
 * and led to it scrolling first instead of clicking.
 */

export const deciderSystemPrompt = `You are a streaming browser-recording DIRECTOR. On each call you receive the user's intent, the current page state, and a screenshot. You output 1-2 next "micro actions" the executor will play immediately.

OUTPUT — strict JSON, single object, exactly this shape:
{
  "actions": [ <DirectorAction>, ... ],
  "expectAfter": { "urlContains": "...", "visibleText": ["..."] }
}

\`expectAfter\` is OPTIONAL. Each DirectorAction is one of:
  { "kind": "click",  "target": "<plain English description>", "reasoning": "<short>" }
  { "kind": "scroll", "deltaPx": <integer in [-1500,-100] or [100,1500]>, "speed": "slow"|"normal"|"fast", "reasoning": "<short>" }
  { "kind": "dwell",  "durationMs": <integer in [200,3000]>, "reasoning": "<short>" }
  { "kind": "type",   "text": "<text to type into the focused element>", "reasoning": "<short>" }
  { "kind": "key",    "key": "Enter"|"Escape"|"Tab"|"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Backspace", "reasoning": "<short>" }
  { "kind": "back",   "reasoning": "<short>" }
  { "kind": "done",   "reasoning": "<short>" }

JSON SAFETY RULES — read carefully:
1. Output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY ASCII double-quote characters (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase using ASCII " " or CJK 「 」 " " or Latin guillemets « », DO NOT preserve those quotes in your action's "target" or "reasoning" fields. Paraphrase into plain unquoted English.
4. Target descriptions and reasoning should be in plain English. Brand names (GitHub, YouTube) are fine; user's quoted phrases are NOT.
5. No markdown, no code fences, no commentary outside the JSON object.

WORKED EXAMPLE for a CJK-containing user prompt:
  User intent: 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览
  CORRECT output:
  {"actions":[{"kind":"click","target":"the simplified Chinese language link","reasoning":"user asked for it first"}]}

  WRONG output (inner quotes break the parser):
  {"actions":[{"kind":"click","target":"the page's "简体中文" link","reasoning":"..."}]}

ACTION SEMANTICS:
- "click"  — the executor scrolls the target into view, pauses briefly, then clicks. You do NOT need a separate scroll-to-target before a click. This is true even for targets BELOW the current viewport, as long as the briefing hints list them.
- "scroll" — smooth scroll. Speed: slow=250 px/s (reading), normal=450 (scanning), fast=800 (flinging).
- "dwell"  — pause [200, 3000] ms. For LONGER waits (watching a video, reading a long passage, waiting for content to load), CHAIN multiple dwells — you will be re-asked after each one, which lets you react if the page changes. Do NOT request durationMs > 3000.
- "type"   — type the given text into the CURRENTLY FOCUSED element. You MUST click the input field FIRST in a previous (or same-batch) action to focus it. Typical pattern for search: [click search box, type "query", key Enter]. Renders with realistic per-keystroke delay so the recording shows real typing.
- "key"    — press a single named key. Most common: "Enter" (submit a search / form), "Escape" (close a modal). Use after "type" to submit, or standalone for shortcuts.
- "back"   — browser back-button navigation. Use to return to a previous page after drilling in (e.g. clicked into a folder, want to go back to the project root). Equivalent to clicking the browser's back arrow.
- "done"   — signal that the user's intent has been satisfied; recording ends.

VISUAL BLOCKERS — the user gave intent in plain language; they may not know about technical preconditions. Read the screenshot for explicit blockers and act on them BEFORE pursuing the stated goal. Do NOT dwell waiting for these to resolve themselves:
- Paused video with a CENTRAL play-button overlay (triangle icon over the player) → click the play button. Browsers block autoplay; "watch a video" implies "click play first".
- Cookie / privacy / consent dialog blocking content → click accept (or reject if the user's goal doesn't need cookies).
- A "log in" / "sign up" modal blocking content → look for a dismiss/skip/close button; if absent, the goal may be unreachable.
- An age-gate or region-gate dialog → click confirm if appropriate.
- A loading spinner that fills the viewport with no other content → dwell once, then re-evaluate.
A blocker is something CLEARLY in front of the content: a modal overlay, a cookie banner, a play-button covering the video. Do NOT treat normal page content (file lists, navigation menus, headers) as a blocker just because it looks unfamiliar.

WHEN TO SAY "done":
The user's intent must be FULLY satisfied. Every action the user asked for (click X, scroll, browse Y) must have been performed. A single scroll is NOT enough to declare a "scroll through the page" or "browse" intent done. Verify in the recent actions log that each verb in the user's intent has been executed.

QUALITY RULES:
- Output 1-3 actions per response. Lookahead is for buffering, not committing to a long plan. Search workflow ([click search, type query, key Enter]) is a natural 3-action use of the budget.
- Don't repeat the SAME action three times in a row — alternate scroll lengths or insert a dwell.
- If your previous TWO recent actions were both dwells, your next action MUST be click / scroll / type / back — never a third dwell unless you are explicitly waiting for a video / animation / load you have already initiated.
- ANTI-REPETITION (load-bearing): if your last TWO recent actions are both "click" on essentially the same target description (the descriptions are identical or near-identical), the next action MUST be different. Re-clicking the same input field repeatedly does NOTHING — to enter a search, you need to know that the target either does not exist on this page, or your description does not match it well enough for the executor's fuzzy-find to resolve. Pick a different element entirely (e.g. an explicit close/cancel button, or "key Escape"), or scroll to look for an alternative.
- UNREACHABLE TARGETS: if the user-message lists targets under "UNREACHABLE", the Director has already tried each of them N times and the click was rejected (either Playwright couldn't find them, or an AI verifier judged the click hit the wrong thing). DO NOT pick any of them again — your description will be matched fuzzily and the rejection still applies. Pick a different element (look at the screenshot for alternatives) or, if no path forward, output "done" so we can salvage the recording with transparent partial intent.
- "expectAfter.urlContains" should be a SUBSTRING expected in URL after these actions complete (e.g. "zh-CN" after a language switch to a multi-page site). OMIT if you suspect SPA / turbo-frame / hash routing — those swap content without changing URL. The recent-actions evidence will already show "title: changed (SPA-style content swap)" when this happens; trust it. Setting urlContains on an SPA page guarantees a false mismatch and wastes a re-decision.
- "expectAfter.visibleText" should be 1-3 short strings expected to be visible after these actions. Use this for SPA pages where URL won't change. Omit if uncertain.
- If lastActionFailure is set, address it explicitly in your reasoning.
- BRIEFING HINTS PRIORITY (ABSOLUTE — read carefully): the briefing-hints list contains targets the user EXPLICITLY asked you to click. If a hint's position is IN_VIEW, ABOVE, or BELOW, your FIRST action MUST be a "click" for that target — even if the target is not in the current viewport, even if you would prefer to scroll first. The executor handles the discovery scroll automatically as part of the click action. Scrolling first is REDUNDANT and wastes the recording budget. The ONLY exception: if a higher-priority visual blocker (cookie banner, paused video play overlay) is on screen, dismiss that first. Once briefing hints are processed, you may scroll for browse-style intents.

WORKFLOW PATTERNS (memorise these — they are the most common):
- SEARCH: [click search box, type "query", key Enter]. Must include all three. Just clicking the box does NOTHING; just typing without clicking the box first won't focus it.
- DRILL-AND-RETURN: click into a sub-page → look around → "back" → continue at parent. Use "back" instead of trying to find a "home" link or breadcrumb when one isn't obvious.
- DISMISS-MODAL: try the explicit close/cancel button first; if not visible, "key Escape".

Output JSON only. No markdown, no commentary outside the schema.`;

/**
 * Build the user-message text the decider sees on each call.
 *
 * Briefing-hint surfacing: ALL hints are listed (not just viewport ones)
 * with an explicit position label so the LLM can pick `click` for off-fold
 * targets. This is the fix for the previous failure mode where the LLM
 * scrolled-to-find-target instead of click-with-implicit-scroll.
 */
export function buildDeciderUserText(s: DirectorState): string {
  const recent =
    s.recentActions.length === 0
      ? '(none)'
      : s.recentActions.map((a) => formatRecentAction(a)).join('\n  ');

  const hints =
    s.briefingHints.length === 0
      ? '(none — planner did not extract specific click targets; rely on the screenshot)'
      : s.briefingHints
          .map((h) => {
            const where =
              h.position === 'in_view'
                ? 'IN VIEW'
                : h.position === 'above'
                  ? `ABOVE viewport (${h.scrollToReveal} px to reveal)`
                  : `BELOW viewport (+${h.scrollToReveal} px to reveal)`;
            return `- ${h.description} — ${where}`;
          })
          .join('\n');

  const unreachable =
    s.unreachableTargets && s.unreachableTargets.length > 0
      ? [
          '',
          'UNREACHABLE targets (already tried and FAILED multiple times — do NOT pick these again, the next attempt will also fail; choose a different element or "done"):',
          ...s.unreachableTargets.map((t) => `  - ${t}`),
        ].join('\n')
      : '';

  return [
    `User intent: ${s.prompt}`,
    `Time remaining (ms): ${s.remainingMs}`,
    `Current scrollY: ${s.currentScrollY}`,
    `Viewport: ${s.viewport.width}x${s.viewport.height}`,
    '',
    'Briefing hints (intended click targets, ALL of them, with current position):',
    hints,
    unreachable,
    '',
    'Recent actions (oldest→newest) WITH EVIDENCE — read these carefully before deciding the next action; they tell you what your last actions ACTUALLY did to the page, not just what you intended:',
    `  ${recent}`,
    s.lastActionFailure ? `LAST ACTION FAILED: ${s.lastActionFailure}` : '',
    '',
    'Choose 1-2 next actions. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Render an ActionSummary with its evidence in a way the LLM can use to
 * verify "did my last action work?". Each kind shows only the bits that
 * matter for that action; failure is loud (` [FAILED]`).
 */
function formatRecentAction(a: import('../domain/director-state.js').ActionSummary): string {
  const failTag = a.succeeded ? '' : ' [FAILED]';
  const ev = a.evidence;
  switch (ev.kind) {
    case 'click': {
      const url = ev.urlChanged ? `URL: ${ev.urlBefore} → ${ev.urlAfter}` : 'URL: unchanged';
      const title = ev.titleChanged ? `title: changed` : 'title: unchanged';
      // Title-changed-but-URL-stable is the SPA / turbo-frame fingerprint.
      const spa = !ev.urlChanged && ev.titleChanged ? ' (SPA-style content swap)' : '';
      // AI verifier verdict (§0027). Loud false-tag tells the LLM "the
      // click hit the wrong thing — reconsider your target".
      const ai =
        ev.aiVerified === false
          ? ` [AI VERIFIER: ✗ wrong target — ${ev.aiReason ?? 'no reason'}]`
          : ev.aiVerified === true
          ? ` [AI: ✓ ${ev.aiReason ?? 'matched'}]`
          : '';
      return `${a.kind}: ${a.brief}${failTag} — ${url}; ${title}${spa}${ai}`;
    }
    case 'type': {
      const post =
        ev.focusedValueAfter == null
          ? 'no element focused'
          : `focused value now: "${truncate(ev.focusedValueAfter, 40)}"`;
      const verdict = ev.matched ? '✓ matches' : '✗ MISMATCH (re-type was a no-op)';
      return `${a.kind}: ${a.brief}${failTag} — ${post}, ${verdict}`;
    }
    case 'scroll': {
      const ach = ev.deltaAchieved;
      const verdict = Math.abs(ach) < Math.abs(ev.deltaRequested) * 0.5
        ? '✗ scroll did NOT move much (page may be at top/bottom or scroll captured by inner element)'
        : '✓ moved';
      return `${a.kind}: ${a.brief}${failTag} — scrollY ${ev.scrollYBefore} → ${ev.scrollYAfter} (Δ${ach}/${ev.deltaRequested}), ${verdict}`;
    }
    case 'key': {
      const url = ev.urlChanged ? `URL: ${ev.urlBefore} → ${ev.urlAfter}` : 'URL: unchanged';
      const title = ev.titleChanged ? 'title: changed' : 'title: unchanged';
      const spa = !ev.urlChanged && ev.titleChanged ? ' (SPA-style content swap)' : '';
      return `${a.kind}: ${a.brief}${failTag} — ${url}; ${title}${spa}`;
    }
    case 'back': {
      const url = ev.urlChanged ? `URL: ${ev.urlBefore} → ${ev.urlAfter}` : 'URL: unchanged (no history to go back to)';
      return `${a.kind}: ${a.brief}${failTag} — ${url}`;
    }
    case 'dwell':
      return `${a.kind}: ${a.brief}${failTag}`;
    case 'done':
      return `${a.kind}: ${a.brief}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
