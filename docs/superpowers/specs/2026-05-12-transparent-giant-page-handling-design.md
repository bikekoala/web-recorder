# Transparent giant-page handling — design

**Date:** 2026-05-12
**Status:** approved, implementing.
**Context:** ADR §0036's known-open case. On giant pages (Wikipedia featured
articles — the "Cat" article's `mode:'ai'` aria tree is ~775 KB even after
pruning) the recon LLM picks a wrong/unresolvable `ref` out of the truncated
tree, AND the `targetDescription` → `stagehand.observe()` fallback re-serializes
the whole page (~140 k tokens) over gpt-4o-mini's 128 k context → both miss →
the requested click step is dropped → `RunMetrics.intentSatisfaction` reports
`unknown` (the metric only goes `unknown` when the Performance has zero click
steps — a *dropped* click is invisible to it).

**Decision (the design fork):** option **C** — *accept that some giant pages
can't be planned one-shot (goals.md #3 explicitly allows `unknown` as the
transparent "intent not satisfied"), but (a) try harder with a cheap
deterministic fallback before giving up, and (b) make the failure transparent —
never report `unknown` when we actually dropped a requested action; say
`partial`/`unmet` and name what we couldn't locate.* No extra LLM calls; no
drill-down/region-pick recon pass (that's option A — not done).

## Components

### 1 — Deterministic visible-text fallback on a ref miss

- **`ReconDraftClickStepSchema` gains an optional `targetText: string`** — the
  element's *exact visible text* ("Felidae", "Sign in"). The recon LLM provides
  it; omitted for icon-only elements. (Not added to `ReconDraftTypeStepSchema` —
  textbox targets sit near the top of the tree, never truncated; out of scope.)
  Recon prompt: add `"targetText"?` to the `click` step shape + one line
  ("if the node has visible text, ALSO give `targetText` — copied
  character-for-character; it's the most reliable fallback if the ref goes
  stale, a deterministic lookup that works even on huge pages").
- **New port method `IPageSession.resolveByVisibleText(text): Promise<ObservedElement | null>`** —
  tries cheap Playwright role/text matchers in order
  (`getByRole('link', {name})` → `getByRole('button', {name})` →
  `getByText(text, {exact:true})`), returns the first match whose bbox is sized
  (≥ 1×1) and visible, else `null`. No LLM, **no DOM serialization** — a real
  locator query, so it scales to arbitrarily large pages. Never throws.
  Implemented in `StagehandPageSession`; fake adds `resolveByVisibleTextResult`.
- **`LlmReconnoiterer.resolveDraftSteps`** — for a `click` step, the resolution
  chain becomes: `resolveAriaRef(ref)` → on miss, `resolveByVisibleText(targetText)`
  (if `targetText` present and the result is sized) → on miss,
  `resolveTargetCandidates(targetDescription)[0]` (the existing `observe()`
  fuzzy path) → on miss, drop the step. `type` steps unchanged
  (`ref` → `resolveTargetCandidates`). The kept step's `target.description`
  stays the LLM's `targetDescription` (the metric/sweep fodder).
  Disambiguation note: when several elements share `targetText` (the Cat page
  has multiple "Felidae" links), `.first()` is a guess — but any of them
  navigates to the same destination, and the rehearsal walk verifies via
  `expectAfter.urlContains` anyway. Good enough; not worth more.

### 2 — Honest `intentSatisfaction` (the transparency fix)

- **`resolveDraftSteps` returns `{ steps: PerformanceStep[]; unresolved: string[] }`** —
  `unresolved` is the `targetDescription`s of the click/type steps it dropped.
  (Two call sites: the initial recon captures `unresolved`; the reconverge
  callback uses only `.steps`.)
- **`PerformanceSchema` gains `unresolvedTargets: string[]` (optional)** — set by
  `recon()` from the initial `resolveDraftSteps`' `unresolved` (only when
  non-empty), alongside `rehearsal`/`blockerDismissal`. When the aria snapshot
  had to be truncated (page too big — detected via the exported
  `ARIA_SNAPSHOT_TRUNCATION_MARKER` substring), each entry is annotated
  ("the Felidae link (page tree too large to analyze in full)") so the *reason*
  rides along in the string — no extra params anywhere.
- **`RunMetrics` gains `unresolvedTargets: string[]`** (from
  `performance.unresolvedTargets ?? []`).
- **`computeIntentSatisfaction(hintDescriptions, entries, window, unresolvedTargets = [])`**:
  - `unresolvedTargets` non-empty + `totalHints === 0` (every requested click
    was dropped) → `level: 'unmet'`, note: `couldn't locate: <joined>; nothing
    actionable was planned`.
  - `unresolvedTargets` non-empty + `totalHints > 0` → level capped at
    `'partial'` (even if all planned hints were clicked), note:
    `${hintsClicked}/${totalHints} planned target(s) clicked, but
    ${n} requested target(s) couldn't be located: <joined>`.
  - `unresolvedTargets` empty → exactly today's logic.
  - Net: `unknown` is now returned ONLY when the Performance genuinely has no
    click steps *and* none were dropped *and* some action happened (e.g.
    "just scroll the page" — there was no click intent). A dropped requested
    click is never silently `unknown` again.

### 3 — (folded into 2) "tree too large" surfaced

- Export `ARIA_SNAPSHOT_TRUNCATION_MARKER` from `stagehand-session.ts` (the
  string `ariaSnapshot()` already appends on truncation) and have `recon()`
  test `snapshot.includes(...)` to annotate the `unresolvedTargets` entries
  (see component 2). No `IPageSession.ariaSnapshot` signature change.

## Out of scope (option A — tracked, not done)

Drill-down recon: a coarse "which region is the target in?" LLM pass against the
page's landmark/heading outline, then a region-scoped `ariaSnapshot()` and a
fine `ref` pick. Costs ~1 extra LLM call on huge pages; bigger change. If C
proves insufficient (real pages where we'd genuinely want to handle a huge tree,
not just report it), this is the next pass.

## Tests

- `resolveByVisibleText` — `StagehandPageSession` unit-ish coverage via the
  candidate-locator path is hard without a real browser; instead unit-test the
  *consumer* with the fake (`FakePageSession.resolveByVisibleTextResult`).
- `resolveDraftSteps` three-arm fallback order: ref hit → uses ref;
  ref miss + targetText hit → uses targetText; ref+text miss + observe hit →
  uses observe; all miss → dropped + reported in `unresolved`.
- `computeIntentSatisfaction`: non-empty `unresolvedTargets` → `partial` (with
  some planned hints clicked) / `unmet` (none) — never `unknown`; empty →
  unchanged behavior (existing cases stay green).
- recon prompt test: the `click` step shape now mentions `targetText`.
- `npm run eval` on Wikipedia "Cat → Felidae" (`EVAL_URL` / `EVAL_PROMPT`
  override): `intentSatisfaction` is now `partial`/`complete` with a concrete
  reason in `note`, not `unknown`.
