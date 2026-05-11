# `intentSatisfaction` over-counting on partial prompts

**Source**: surfaced by the §0030 LLM video judge on the same run as the
[white-screen finding](./2026-05-11-github-whitescreen.md). The judge said
`intentExecution: fail` — "agent switches language to Chinese, but fails to
navigate to build directory or open package.json". The action-log-derived
`intentSatisfaction` metric reported `level: complete, note: "all 3 hint(s)
clicked at least once + scrolling occurred"`.

## Reproduction

Run: `output/2026-05-11/11-14-38-regression-github-multistep-natural`.

- User prompt (4 verbs): switch to 中文 → 回首页 → enter build directory → open package.json
- Planner extracted 3 hints (`hintCount: 3` in the regression log)
- Recording produced 2 successful clicks; the third intended click
  ("Recordly project homepage link") failed and the run hit budget
- `intentSatisfaction` still reported `complete`

## What `descriptionsMatch` actually did

The two successful clicks (verbatim from the action log):

1. `"the simplified Chinese language switcher link in the GitHub footer"`
   tokens: `{simplified, chinese, language, switcher, link, github, footer}`
2. `"the Chinese language option"`
   tokens: `{chinese, language, option}`

Reasonable planner hints for this prompt (we don't preserve hints in the
log, but the planner prompt patterns produce something like):

| Hint (assumed) | tokens |
|---|---|
| 1: `"the simplified 简体中文 link"` | `{simplified, link, 简体, 体中, 中文}` |
| 2: `"the build directory link"`   | `{build, directory, link}` |
| 3: `"the package.json file link"` | `{package, json, file, link}` |

`descriptionsMatch` returns true iff `tokensA ∩ tokensB` is non-empty.

| Hint | Match against click 1 | Match against click 2 |
|---|---|---|
| 1 (中文) | ✓ (`simplified, link, chinese`) | ✓ (`chinese`) — legitimate |
| 2 (build) | ✓ via **`link`** — FALSE POSITIVE | ✗ |
| 3 (package) | ✓ via **`link`** — FALSE POSITIVE | ✗ |

`computeIntentSatisfaction` counts unique hints with **any** matching click.
All 3 hints get marked as satisfied. Combined with `scrollsExecuted ≥ 1`,
the result is `level: complete`.

## Root cause

Two compounding issues:

**(R1) Generic UI-noun tokens act as bridges between unrelated descriptions.**

The current `contentTokens` blocklist (`src/domain/intent-matching.ts:50`)
removes only conversational filler: `the, and, for, with, into, this, that,
click`. UI nouns that EVERY hint and EVERY click description contain —
`link, button, tab, item, option, page, section, area` — flow through and
cause spurious matches. "the X link" matches "the Y link" on the `link`
token alone.

**(R2) Matching is many-to-many, not best-match.**

A single click can satisfy multiple hints. The current loop:

```ts
const hintsClicked = hintDescriptions.filter((hint) =>
  clickDescriptions.some((cd) => descriptionsMatch(hint, cd)),
).length;
```

For each hint, checks if ANY click matches it. With overlapping vocabulary,
one click ends up "satisfying" 2-3 hints. There's no bipartite matching
constraint: each click should satisfy at most one hint, and ideally the
best-scoring one.

The disagreement with the §0030 judge — which actually watched the video
and counted verbs — is the load-bearing signal that the metric is wrong.

## Fix candidates

### A. Extend the blocklist with UI nouns

Add `link, button, tab, item, option, page, section, area, list, menu,
icon, image, text, field` (and CJK equivalents — `链接`, `按钮`, etc.) to
the `contentTokens` blocklist.

- **Pros**: 5-minute change, immediately removes the most common false-
  positive class.
- **Cons**: doesn't fix R2. Still many-to-many. A click description that
  legitimately shares ONE non-generic token with two hints will still
  satisfy both.
- **Risk**: marginal — most hints/clicks have multiple content tokens, so
  removing UI nouns rarely makes them match-empty.

### B. Best-match unique assignment

After collecting all (hint, click) match pairs, run a greedy 1-to-1
assignment: each click satisfies at most ONE hint (the hint with the
highest token-overlap score). Each hint is satisfied by at most one click.

```ts
function assignClicks(hints, clicks): SatisfiedHints {
  const scores = hints.map(h => clicks.map(c => overlapScore(h, c)));
  // Hungarian-style or greedy by descending score, with hint and click
  // marked as consumed once assigned.
}
```

- **Pros**: matches our intuition — "click X satisfies hint X, not
  several hints at once". Fixes R2 directly.
- **Cons**: ~30 lines + understanding bipartite matching. Test cases
  need updating (the existing `intentSatisfaction` tests assume the
  many-to-many semantics).
- **Risk**: low. The greedy version is correct enough for our N≤5 hints.

### C. Require multi-token overlap

Change `descriptionsMatch` to require ≥2 token overlaps, not ≥1. This
makes single-shared-word matches (the `link` case) fail.

- **Pros**: pure local change, no algorithm rework.
- **Cons**: short descriptions ("the 简中") have only 1-2 tokens — would
  fail to match anything. Breaks the CJK case that §0025 specifically
  fixed with 2-char n-grams.
- **Risk**: HIGH — likely regresses §0025's CJK matching.

### D. Use the planner's structured hints

Instead of matching by description string, give each hint a stable `id`
and have the Director's click-action carry the originating `hintId`
when it's a hint-driven click. Then `intentSatisfaction` does a set
membership check on hint IDs — no string matching at all.

- **Pros**: cleanest end-state. Eliminates the entire heuristic.
- **Cons**: requires plumbing `hintId` through DirectorAction →
  ActionEvidence → action log → metric. Multiple file touches.
  Also doesn't solve the "click happened that wasn't planned" case
  (the LLM sometimes invents clicks based on the screenshot alone).
- **Risk**: moderate. Largest change, but most durable.

## Recommendation

**A + B in one PR**. (A) takes 5 minutes and fixes the immediate
symptom. (B) is the architectural fix that makes the metric agree with
the judge in the future. Both together: ~50 lines + 2-3 new test cases
asserting `level: partial` when only 1 of 3 hints actually got clicked.

Skip (C). Skip (D) until we have another reason to plumb hint IDs (e.g.
when we wire judge feedback to the planner for self-improvement).

## How to validate the fix

After implementing A+B, re-run `intentSatisfaction` on the same action
log offline and confirm `level: partial, note: "1/3 unique hint(s) actually
clicked"`. The §0030 judge already gives us the ground truth — the
two should now agree.
