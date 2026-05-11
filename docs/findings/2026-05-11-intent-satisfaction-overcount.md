# `intentSatisfaction` over-counting on partial prompts

**Status:** open finding, brainstorm only — no code change yet.
**Source:** surfaced by the §0030 LLM video judge on the same run as the
[white-screen finding](./2026-05-11-github-whitescreen.md). The judge said
`intentExecution: fail` — "agent switches language to Chinese, but fails to
navigate to build directory or open package.json". The action-log-derived
`intentSatisfaction` metric reported `level: complete, note: "all 3 hint(s)
clicked at least once + scrolling occurred"`.

**Files involved:**
- [src/core/record-job-runner.ts:384-443](../../src/core/record-job-runner.ts) — `computeIntentSatisfaction`
- [src/domain/intent-matching.ts:24-30](../../src/domain/intent-matching.ts) — `descriptionsMatch`
- [src/adapters/director/streaming-director.ts:222-227, 364-370](../../src/adapters/director/streaming-director.ts) — co-user of `descriptionsMatch` (constraint, see §R3 below)

## Reproduction

Run: `output/2026-05-11/11-14-38-regression-github-multistep-natural`.

| Field | Value |
|---|---|
| Prompt (zh) | "去看看 Recordly 这个项目，先把页面切换成中文版，然后回到项目首页，进 build 目录看看，最后打开 package.json 查看源码" |
| User verbs requested | 4: switch to 中文 · 回首页 · open `build/` · open `package.json` |
| Planner click hints extracted | 3 (`hintCount: 3` in the regression log) |
| Successful clicks inside recording window | 2 (third intended click — Recordly project homepage link — failed, run hit budget) |
| `intentSatisfaction.level` | `complete` |
| `intentSatisfaction.note` | `"all 3 hint(s) clicked at least once + scrolling occurred"` |
| Vision-judge `intentExecution` (§0030) | **fail** |
| Vision-judge evidence | "agent successfully switches language to Chinese, but fails to navigate to build directory or open package.json" |

Two independent observers — the action-log digest and the LLM watching the
actual video — disagree categorically. The video is ground truth (per
[`docs/goals.md`](../goals.md) hard rule #6). The metric is wrong.

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

Three compounding issues — the third is a *constraint* on which fixes are safe.

**(R1) Generic UI-noun tokens act as bridges between unrelated descriptions.**

The current `contentTokens` blocklist
([src/domain/intent-matching.ts:50](../../src/domain/intent-matching.ts))
removes only conversational filler: `the, and, for, with, into, this, that,
click`. UI nouns that EVERY hint and EVERY click description contain —
`link, button, tab, item, option, page, section, area` — flow through and
cause spurious matches. "the X link" matches "the Y link" on the `link`
token alone.

**(R2) Matching is many-to-many, not best-match.**

A single click can satisfy multiple hints. The current loop
([record-job-runner.ts:404-407](../../src/core/record-job-runner.ts)):

```ts
const hintsClicked = hintDescriptions.filter((hint) =>
  clickDescriptions.some((cd) => descriptionsMatch(hint, cd)),
).length;
```

For each hint, checks if ANY click matches it. With overlapping vocabulary,
one click ends up "satisfying" 2-3 hints. There's no bipartite matching
constraint: each click should satisfy at most one hint, and ideally the
best-scoring one.

**(R3) `descriptionsMatch` is *intentionally* lenient — and it's shared.**

Two other call sites in `StreamingDirector` rely on the leniency:
- [streaming-director.ts:222-227](../../src/adapters/director/streaming-director.ts) —
  after a successful click, the Director marks every matching briefing-hint
  as `fulfilled` so they're filtered out of subsequent `observeState` calls.
  This is the load-bearing fix for §0025 ("LLM keeps re-clicking 简体中文
  even after the click already worked").
- [streaming-director.ts:364-370](../../src/adapters/director/streaming-director.ts) —
  after `directorClickRejectionLimit` failures, all matching hints are
  filtered as unreachable (§0028).

Both Director uses *want* over-eager matching. A naïve "make
`descriptionsMatch` stricter" patch would simultaneously fix the scoring
over-count AND re-introduce the §0025 re-click loop. So any fix has to
either (a) keep `descriptionsMatch` as-is and change the *scoring algorithm*
on top, (b) introduce a separate stricter matcher used only at scoring time,
or (c) attack the upstream cause (planner / hint plumbing).

The disagreement with the §0030 judge — which actually watched the video
and counted verbs — is the load-bearing signal that the metric is wrong.

## Fix candidates

### A. Extend the blocklist with UI nouns

Add `link, button, tab, item, option, page, section, area, list, menu,
icon, image, text, field` (and CJK equivalents — `链接`, `按钮`, etc.) to
the `contentTokens` blocklist.

- **Pros**: 5-minute change. Immediately removes the most common false-
  positive class (the `link` bridge in our run).
- **Cons**: doesn't fix R2. Still many-to-many. A click description that
  legitimately shares ONE non-generic token with two hints will still
  satisfy both. Doesn't address the planner over-producing paraphrases.
- **Director impact (R3)**: same direction as Director wants — drops bridge
  tokens in the matching set, so a Director hint and an LLM click that
  truly refer to the same target still match on substantive tokens
  (`chinese`, `简体`, `package`). Low risk to §0025/§0028.
- **Risk**: marginal — most hints/clicks have multiple content tokens, so
  removing UI nouns rarely makes them match-empty.

### B. Best-match unique assignment (bipartite)

After collecting all (hint, click) match pairs, run a greedy 1-to-1
assignment: each click satisfies at most ONE hint (the hint with the
highest token-overlap score). Each hint is satisfied by at most one click.

```ts
function assignClicks(hints, clicks): SatisfiedHints {
  // Score each (hint, click) pair by overlap count or Jaccard.
  // Greedily pick highest-scoring edge, mark both endpoints consumed,
  // repeat until no positive-score edges remain.
  // Result: count of matched hints (≤ min(|hints|, |clicks|)).
}
```

- **Pros**: matches our intuition — "click X satisfies hint X, not several
  hints at once". Fixes R2 directly. Structurally bounded by
  `min(clicks, hints)` — no threshold to tune.
- **Cons**: ~30 lines + understanding bipartite matching. Test cases need
  updating (the existing `intentSatisfaction` tests assume many-to-many).
  Greedy ≠ optimal, but with N ≤ 5 it doesn't matter; swap to Hungarian
  if we ever care.
- **Director impact (R3)**: zero. Only `computeIntentSatisfaction` changes;
  `descriptionsMatch` is untouched.
- **Risk**: low. Greedy is correct enough for our N ≤ 5 hints.

### C. De-duplicate overlapping hints before scoring

The denominator of 3 is itself wrong: the planner appears to be emitting
paraphrased duplicates of one underlying target. Before scoring, cluster
hints by transitive `descriptionsMatch` and take one canonical hint per
cluster. Then run today's lenient scoring against the de-duped set.

- **Pros**: attacks the inflated denominator — even after A+B, our run
  would still report `1/3 partial`, which over-states what the user
  asked for (the 3 hints aren't 3 distinct targets). C produces
  `1/N distinct targets` which is more honest. Side benefit: Director
  also gets a smaller hint set in `observeState`.
- **Cons**: changes the semantic of `hintsResolvedPreRecording`. Anything
  reading that field (logs, dashboards, future callers) sees different
  numbers. "Near-duplicate" needs a definition — back to threshold-shaped
  questions, just at a different layer.
- **Better target for the upstream fix**: tighten the planner prompt so it
  doesn't emit paraphrased duplicates in the first place. C is downstream
  cleanup that hides the upstream bug from anyone debugging the planner.
- **Director impact (R3)**: positive (smaller hint set), but minor.

### D. Use the planner's structured hints (eliminate string matching)

Instead of matching by description string, give each hint a stable `id`
and have the Director's click-action carry the originating `hintId` when
it's a hint-driven click. Then `intentSatisfaction` does a set-membership
check on hint IDs — no string matching at all.

- **Pros**: cleanest end-state. Eliminates the entire heuristic. Bipartite
  becomes trivial (each click carries at most one `hintId`).
- **Cons**: requires plumbing `hintId` through `DirectorAction` →
  `ActionEvidence` → action log → metric. Multiple file touches. Doesn't
  solve the "click happened that wasn't planned" case (the LLM sometimes
  invents clicks based on the screenshot alone — those have no `hintId`
  and would not contribute to satisfaction).
- **Director impact (R3)**: doesn't change `descriptionsMatch` itself.
  Director can keep using it for fulfillment-filtering, OR migrate to
  `hintId` matching too — separate decision.
- **Risk**: moderate. Largest change, but most durable. Worth picking up
  if/when we wire judge feedback to the planner for self-improvement.

### Skipped: stricter `descriptionsMatch` (e.g. require ≥2 token overlap)

Looks tempting (one-line change). Two independent fatal flaws:

1. Short descriptions ("the 简中") have only 1-2 tokens — would fail to
   match anything, regressing the §0025 CJK case the matcher exists to
   support.
2. R3: `descriptionsMatch` is shared with the Director. Tightening it
   re-introduces the re-click loop §0025 fixed.

This is also exactly the kind of magic-number tuning [`docs/goals.md`](../goals.md)
hard rule #6 warns against.

## Recommendation

**A + B in one PR**.

- (A) takes 5 minutes and fixes the immediate symptom — the `link`
  bridge that caused this specific over-count.
- (B) is the architectural fix that makes the metric agree with the
  judge in the future. Both together: ~50 lines + 2-3 new test cases
  asserting `level: partial` when only 1 of 3 hints actually got clicked.

Defer (C) and (D):
- (C) only matters if we discover the planner *consistently* emits
  paraphrased duplicates. Worth measuring first; if it's a one-off,
  fix the planner prompt instead.
- (D) until we have another reason to plumb hint IDs (e.g. when we wire
  judge feedback to the planner for self-improvement).

### Second-order question (optional)

With the §0030 vision judge as authority, should
`computeIntentSatisfaction` *ever* claim `complete`? An alternative is
to demote it to "action-log digest" — only `attempted` / `partial` /
`unmet`, never `complete` — and let the vision judge be the only source
that asserts success. That side-steps the over-credit class entirely
and makes the two signals strictly complementary instead of in tension.

## How to validate the fix

After implementing A+B, re-run `intentSatisfaction` on the same action
log offline and confirm `level: partial, note: "1/3 unique hint(s) actually
clicked"`. The §0030 judge already gives us the ground truth — the two
should now agree.

### Suggested failing unit test (drop into [tests/unit/core/record-job-runner.test.ts](../../tests/unit/core/record-job-runner.test.ts))

```ts
it('does not over-credit when one click matches multiple overlapping hints', () => {
  const r = computeIntentSatisfaction(
    [
      'the simplified 简体中文 link',
      'the build directory link',
      'the package.json file link',
    ],
    [
      click(5000, 'the simplified Chinese language switcher link in the GitHub footer'),
      click(6000, 'the Chinese language option'),
      scroll(7000),
    ],
    WINDOW,
  );
  // 2 clicks, both targeting the SAME real-world Chinese switcher.
  // build & package hints were never actually visited.
  expect(r.level).toBe('partial');
  expect(r.note).toMatch(/1\/3/);
});
```

Today this returns `complete` with `"all 3 hint(s) clicked at least once"`.
Under A alone it returns `partial 2/3` (the `link` bridge is gone, but
"chinese" still bridges to the simplified-Chinese hint twice — bipartite
needed). Under A + B it returns `partial 1/3`.
