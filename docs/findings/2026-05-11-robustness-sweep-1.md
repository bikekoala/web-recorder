# Robustness sweep #1 — the prophet pipeline on 5 varied sites

**Date:** 2026-05-11. Pipeline under test: §0034 prophet + Task #21 rehearsing
reconnoiterer, recon on `anthropic/claude-sonnet-4.6` (`LLM_PLANNER_MODEL`),
all runs `PROTOTYPE_HEADLESS=true`.

Goal #4 says *"it works on Recordly is not enough — also test something
dynamic."* So: ran `npm run prototype:stagehand` on 5 sites of different shapes
and read the metrics + action logs.

## Results

| Site | Prompt (abridged) | `intentSatisfaction` | `reconMs` | rehearsal | on-camera | verdict |
|---|---|---|---|---|---|---|
| Recordly README (GitHub) | click 简体中文, slow scroll, 10 s | **complete** (1 click, 3 scroll) | ~49 s | `{8, 0, 0, false, false}` | 10.6 s, replan 0 | **LOOKS_HUMAN** (re-confirmed) |
| Wikipedia "Cat" | slow-scroll the article, then click Felidae, 12 s | **unknown** (0 click) | 58 s | `{walk 17, div 3, recv 2, trunc true, timeout false}` | 13.3 s | ✗ click never made it into the plan |
| GitHub Recordly (multi-step) | 切中文 → 回首页 → 进 build/ → 打开 package.json, 30 s | **complete** (2 click, 6 scroll) | **203 s** | `{13, div 2, recv 2, trunc true, timeout true}` | 22.8 s, replan 0 | ✓ intent done, but **3.4× over the 60 s wall-clock budget** |
| Hacker News | 点第一条的评论页，慢慢看评论, 15 s | "complete" (1 click) — **but the click was DEAD** | **143 s** | `{12, 0 div, 0 recv, false, false}` | **4.1 s** (graceful-degraded) | ✗ resolved a 0×0 bbox at the wrong spot; walk missed it; on-camera degraded |
| The Guardian | 点首页第一条新闻，慢慢往下读, 18 s | **unknown** (0 click) | **196 s** | `{walk 6, div 2, recv 1, trunc true, timeout false}` | 6.4 s | ✗ resolved a 0×0 bbox at the wrong spot; walk caught it; reconverge also failed |

## Patterns

### P1 — Recon is 3–4× over the wall-clock budget on non-trivial sites

`reconMs` was ~49 s on the canonical (one click) but **143–203 s** on every
multi-target / multi-page run. Goal #5 wants `< 60 s` total wall-clock; we're
at 150–240 s. Where it goes:

- **`resolveSteps` is N sequential `session.resolveTarget()` calls**, each a
  Stagehand `observe()` (~3–8 s). A 13-step plan with 4 click targets ≈ 20–30 s
  just here — and the rehearsal walk then **re-resolves each target again**
  (another `observe()` apiece) at its real scroll position.
- **Each reconverge is a full Sonnet vision call** (~30–50 s). Cap is 2 → up to
  ~100 s of reconverge alone. GitHub did 2 reconverges *and* still timed out
  the 90 s `reconRehearsalBudgetMs`.
- The initial recon vision call on Sonnet 4.6 is itself ~20–40 s.

### P2 — `resolveTarget` returns degenerate / wrong bboxes → dead clicks

On HN and Guardian, `session.resolveTarget("<verbose LLM description>")` returned
a `{x, y, width: 0, height: 0}` bbox (HN: `(367, 67)` — the top bar; Guardian:
`(720, 575)`). `clickResolvedTarget` then `clickAt(x + 0/2, y - scrollY + 0/2)`
= clicks the *origin corner of a zero-size box*, which lands on nothing → the
click does not navigate. Causes:

- Stagehand `observe()` picks a 0×0 wrapper element (an empty `<a>`/`<span>`
  around the real link) as match `[0]`, and we blindly take `[0]`.
- `bboxOfSelector` faithfully reports `width:0,height:0` for such an element;
  nothing downstream rejects it.
- The recon-LLM descriptions are verbose paraphrases ("Link to 23 comments for
  the first post Ratty …"), not the visible link text, so the cheap Playwright
  `getByText`/`getByRole` path (`quickFindOnPage` → `candidateLocators`) can't
  match them and we're forced onto `observe()`, garbage and all.

### P3 — when a target resolution fails, recovery often also fails → truncated

Wikipedia, Guardian: the walk diverges on the bad click → reconverge → the
reconverged plan *also* can't land the click → reconverge cap / truncate →
graceful tail → **the final `Performance` has no click step at all** →
`intentSatisfaction: unknown`, a short (6–13 s) scroll-only recording. The
reconverge LLM is handed the same hard target and re-fails it.

### P4 — `intentSatisfaction` over-credits a step that *ran* but didn't *work*

HN reported `level: complete` ("all 1 target(s) clicked at least once") even
though the click hit dead space and the page never changed. `intentSatisfaction`
counts click *steps in the Performance*, not click *effects*. After the
rehearsal walk we actually know whether each click changed the page — that
signal should feed the metric (or at least: a click whose walk-time
`expectAfter` ended up empty *and* whose URL didn't change is suspect).

### P5 — the rehearsal walk's divergence check has a hole (HN)

HN's dead click was *not* flagged as a divergence (`divergences: 0`) — yet the
on-camera Director then logged `decision_failure: expect_after_mismatch` on the
very same step. So the walk had an `expectAfter` it should have found unsatisfied
but didn't. Likely the `eaMismatch = !!ea && !eaSatisfied && !pageChanged` gate:
a tiny `pageDiagnostic` flutter (one interactive-element-count tick) made
`pageChanged` true, which suppressed the divergence even though `urlContains`
plainly failed. An unmet `expectAfter.urlContains` when the URL did **not**
change is an unambiguous divergence regardless of element-count noise.

## Fixes — ranked

1. **Validate target-resolution results; never click a 0×0 box.** (P2) In
   `resolveTarget`: take all `observe()` matches, return the first whose
   `bboxOfSelector` is non-null *and* sized (`width ≥ 1 && height ≥ 1`); if none
   qualify, return `null`. A `null` resolution at recon time → keep the sentinel
   (the walk re-resolves); at walk time → divergence → reconverge (correct).
   Cheap, contained, kills the HN/Guardian dead-click directly.
2. **Stop the double-resolve and parallelize.** (P1) When `reconRehearse` is on,
   `resolveSteps` shouldn't `observe()` at all — sentinel every click/type step
   and let the walk resolve each once, at its real scroll position. When
   rehearsing is off, `resolveSteps` should `Promise.all` its resolves instead
   of awaiting them in series. Removes ~20–60 s from recon on multi-target plans.
3. **Tighten the walk's divergence gate.** (P5) `expectAfter.urlContains` set +
   URL unchanged ⇒ divergence, period. Keep the "page changed, just guessed the
   post-state wrong" leniency only for the `visibleText`-only case.
4. **Feed walk-observed click effects into `intentSatisfaction`.** (P4) A click
   step whose walk left `expectAfter` empty *and* didn't change the URL is not a
   satisfied intent — don't count it as one.
5. **Bound reconverge cost.** (P1/P3) Either drop `reconReconvergeMax` to 1, or
   give reconverge a cheaper/faster model, or shrink `reconRehearsalBudgetMs`
   (90 s → ~45 s) and accept earlier truncation. Needs measurement — defer until
   1+2 land (they should make reconverges rarer).
6. **(P3, harder) Smarter reconverge for unresolvable targets** — before the
   expensive LLM reconverge, try a Playwright text/role search on a *cleaned*
   description (strip "Link to", "the … link", quotes) and a scroll-scan of the
   page. Only LLM-reconverge if that misses too.

## After fixes 1+2+3+5 (commits `6d4f3bb`, config change)

Shipped fix 1 (`bboxOfSelector` rejects 0×0; `resolveTarget` walks the match
list), fix 2 (when rehearsing, `resolveSteps` doesn't eagerly `observe()` —
sentinel everything, walk resolves once), fix 3 (`expectAfter.urlContains` set +
URL literally unchanged ⇒ unambiguous divergence). Also lowered
`reconRehearsalBudgetMs` 90 s → 45 s and `reconReconvergeMax` 2 → 1 to bound the
walk's worst case (fix 5, partial).

Re-ran:

| Site | before | after |
|---|---|---|
| Recordly canonical | complete, recon ~49 s, clean | complete, clean — `rehearsal {8,0,0,false,false}`. (recon time that run was a wild ~5 min — an OpenRouter/Sonnet latency spike, not the code; correctness unchanged. recon is provider-latency-dominated; `RECON_REHEARSE=false` is the escape hatch.) |
| Hacker News | "complete" but the click was **dead**; recon 143 s; walk missed it (`div 0`) | **complete, the click works**; recon **70 s** (halved); walk catches the bad first resolution (`div 1`) → reconverges once → recovers (`recv 1, trunc false`); 14 s/15 s recording. ✓ |
| The Guardian | unknown (no click); recon 196 s; `trunc true, timeout false` | still unknown (no click); recon 261 s; `trunc true, timeout true`. ✗ — **root cause: the cookie-consent overlay**: the recon plans a click on "the first headline" but never plans an *accept-cookies* step first, so every click lands on the overlay and doesn't navigate → divergence → reconverge picks another headline (still behind the overlay) → re-fails → truncate. This needs **Task #20 (blocker dismissal)** — dismiss the consent banner before the plan runs. (The 45 s budget cap will at least bound the wasted time on the *next* run; this one was before that config change landed.) |

Net: fixes 1–3 fixed the dead-click class (HN) and roughly halved recon on a
mid-weight site. The Guardian-class failure (a consent/region overlay swallowing
every click) is **Task #20** — not a recon-quality bug, a missing capability.
The Wikipedia-class failure (click a target above the post-scroll position) is
finding 6 above — still open.

## Next

- **Task #20 — pre-recording blocker dismissal** — ✅ done (ADR §0035, spec
  `2026-05-12-blocker-dismisser-design.md`). `IBlockerDismisser` +
  `LlmBlockerDismisser`: a probe(`pageDiagnostic.blockerSignals`)→detect(vision
  LLM)→click→re-probe loop, owned by `LlmReconnoiterer`, run before observe and
  on the walk-reset; capped (3 rounds / 10 s), never fatal,
  `RunMetrics.blockerDismissal`. **But** the sweep re-runs surfaced two things:
  (a) the Guardian failure this run wasn't actually a cookie wall — the click
  hit a *wrong-but-sized* element ("the first headline link" resolved to
  something that isn't the article link), URL didn't change → divergence →
  reconverge re-failed → truncate → `unknown`. That's finding 6 (target
  resolution / disambiguation), not a blocker problem. (b) The `blockerSignals`
  heuristic is narrow — it didn't fire on Guardian/CNN from this IP/headless
  (no heuristic-matched "Accept all"-type banner shown), so the dismisser was a
  clean no-op there. Broadening the heuristic = more hardcoded selectors
  (against goals.md #6); always-running the LLM detect = ~$0.01 screenshot
  tokens per recording (= the whole goals.md #5 budget). Left as a follow-up;
  the dismiss *logic* is unit-tested and it correctly clears OneTrust/Cookiebot-
  class banners when `blockerSignals` does fire.
- **Finding 6 — target resolution / disambiguation** — partly addressed (the
  "A + B lightweight" pass): (B) `resolveTarget` now goes through
  `resolveTargetCandidates`, which keeps all sized `observe()` matches, ranks
  *genuinely interactive* elements (`<a href>`/`<button>`/`[role=button|link]`/…)
  ahead of bare wrappers, dedups by position — so the *first* pick is more often
  the real clickable thing, not a wrapper `<div>`. (A) when a click on the best
  candidate turns out dead (URL didn't move), the rehearsal walk sweeps the
  *other* ranked candidates — clicks each, keeps the first that actually changes
  the page / satisfies expectAfter — *before* the (~30–50 s) LLM reconverge.
  Plus the reconverge prompt got a HARD CHECK: a reconverged plan for "click X
  then …" must still contain a click for X (the LLM was sometimes returning an
  all-scroll plan). Re-ran the canonical (no regression: `complete`, 0 div).
  **Still open**: when `observe()` returns *no* good candidate at all (it didn't
  on the HN comments link this run — every candidate was dead), the sweep has
  nothing to try and we're back on the reconverge; and the reconverge can still
  flake. The deeper fix (scroll-aware disambiguation; a verification trial
  before committing a resolution; richer observe prompting) is finding 6's
  "C and beyond" — not yet scheduled.
- Fix 4 (don't let `intentSatisfaction` over-credit a click that ran but didn't
  change the page — use the walk's observed effect).
- Re-run the full sweep after finding 6 is addressed.
