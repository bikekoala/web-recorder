# Wild-prompts sweep — 4 unconstrained user prompts, 4 different failure shapes

**Date:** 2026-05-13. Pipeline under test: post-F1 (§0040) + run.json/judgment.json
traceability + recon JSON-discipline (commit `73ccbed`). All runs `npm run eval`
with env-overridden `EVAL_URL` / `EVAL_PROMPT` / `EVAL_DURATION_MS`, headless,
`anthropic/claude-sonnet-4.6` for recon, `google/gemini-3.1-pro-preview` for judge.

The user gave a new prompt ("打开 github 浏览下 本周热门项目 10s") that failed. Then
asked me to **stop optimizing for known cases and test what real users will give**.
Four prompts of different shapes, run back-to-back. The cross-section of failure
modes is the real product of this sweep — F1's transparency layer means each
failure now self-reports where the seam splits.

## The four runs

| # | Prompt + URL | duration | trim | `planDurationFit` | `intentSatisfaction` | judge | wall |
|---|---|---:|---:|---|---|---|---:|
| 1 | `github.com` "打开 github 浏览下 本周热门项目" | 10s | **6.9s (−31%)** | **underfilled** ratio 0.35 | **unmet** (2 named drops) | **robotic** (intentExec fail) | 80.9s |
| 2 | `github.com/trending` "看看本周 GitHub 热门项目" | 10s | 10.3s (+3%) | ok ratio 1.03 | **complete** ⚠ | **probably_synthetic** (intentExec fail) | 72.1s |
| 3 | `news.ycombinator.com/` "看看 Hacker News 最近有什么热门帖子" | 12s | ✓ | ok | ok | **probably_human** (pacing partial) | 42.4s |
| 4 | `en.wikipedia.org/wiki/Artificial_intelligence` "慢慢往下读一读这篇关于人工智能的维基百科文章" | 20s | ✓ | ok | ok | **robotic** (motion + pacing) | 68.3s |

Each `run.json` + `judgment.json` is in `output/2026-05-13/`:
- `19-07-17-eval/` — #1
- `19-12-14-eval/` — #2
- `19-14-19-eval/` — #3
- `19-15-56-eval/` — #4

## Five distinct failure patterns surfaced

### P1 — A can't reach destinations gated behind unfindable nav (#1)

`github.com` (logged out) hides Trending behind dropdown menus the LLM can't
discover in 10s. A's `rationale` says it: *"the accessibility tree does not show
a direct Trending link, but the Open Source dropdown typically contains it"* — a
hallucinated path. The rehearsal walk truncated; recovery dropped both clicks.

The action vocabulary (click / scroll / type / key / dwell / back / done) has
**no `goto` primitive**. A real user types `github.com/trending` in the URL bar
when they know the URL. A doesn't have that tool. So when the on-page UI
doesn't provide a discoverable path, the only options are blind clicking or
honest failure — `unmet` + named drops is at least the latter.

**Architectural lever:** new step kind `{ kind: "goto", url: "..." }`. The
Director already navigates via `session.goto()`; the step just exposes it to
the planner. F1 made `durationMs` first-class; this would make "I know where I
want to be" first-class. Touches: action vocabulary, recon prompt, schema,
Director, ~3 tests.

### P2 — `intentSatisfaction` over-counts clicks that ran-but-didn't-accomplish (#2)

Run #2 ran 1 click + 2 scrolls and the metric reported `complete`. The judge
watched the video and said *"agent failed to select 'This week' from the dropdown
as requested, leaving the filter on 'Today' and scrolling through the wrong
list."* The click DID happen (opened the date dropdown), the click DIDN'T
satisfy the intent (didn't select the desired option), and the metric counts
the former.

This is the F3 channel sketched in `docs/findings/2026-05-13-plan-duration-fit.md`
made concrete: **the metric is honest about target counts but blind to whether
each target's click ACCOMPLISHED its intent.** The judge — which watches the
actual video — knows. Today the judge's verdict runs *after* the metric and
doesn't feed back into it.

**Architectural lever:** `intentSatisfaction` consumes the judge's
`intentExecution` dimension (when present) as the source of truth — any
positive metric level gated by `judgment.dimensions.intentExecution.level !==
'fail'`. F3 work.

### P3 — Long-form reading produces metronomic uniform scrolls (#4)

Wikipedia AI article, 20s read intent → A planned 11 nearly-identical scroll
steps ~1s apart. Judge: *"From sec 2 to 17, the page scrolls a small amount
almost exactly every second. This metronomic, continuous rhythm is highly
unnatural for a human reading text, who would typically scroll and then pause
for several seconds to read."*

The recon prompt already says: *"a 2-3s dwell after navigating to a content-rich
page (reading)"*. But A interpreted this as a **single** opening dwell, not a
recurring scroll→long-dwell rhythm. The prompt's *"dwellAfterMs 120-280ms"* on
scroll is the eye-landing pause AFTER motion, not reading time — and A conflated
them, packing many tiny scrolls with no real reading pauses in between.

**Architectural lever:** sharpen the PACING discipline for reading intents —
make the scroll-then-DWELL-step pattern explicit, not implicit. Same prompt
file, same template-literal splice as the F1 DURATION & SCOPE section. Low cost,
hits #1 (looks human) directly. Tracking as the immediate follow-up to this
finding.

### P4 — End-of-page static stare (#3)

HN front page, 12s. Mostly clean — judge `probably_human`. The one complaint:
*"The page reaches the bottom and remains completely static for about 5 seconds
before scrolling back up, which feels like an unnaturally long pause for simply
scanning titles."* A planned a long terminal dwell at the bottom of the list,
then a scroll back up. Humans don't usually do that — they either keep going,
close the page, or click into something.

This is the same prompt-discipline shape as P3: A's instinct for "fill the
remaining time" landed on "stare at the bottom". The fix is naming that
anti-pattern explicitly: *don't plan a multi-second static dwell at the end of
content; either click into something interesting or end with `done`.*

### P5 — Wall-clock blown on 3/4 runs (#1, #2, #4)

`totalWallClockMs`: 80.9s, 72.1s, 68.3s — all over goal #5's 60s hard line. The
HN run (#3) was 42.4s — the only one in budget. The unifying variable is
**recon time**: 55.3s, 44.7s, 24.9s, 16.0s respectively. The recon LLM call's
cost is the wall-clock dominator, and it scales with page-complexity (aria tree
size + plan length).

This is the pre-existing goal #5 line — recon $ and wall-clock are the same
axis. Real fix is F2 (plan-size budget — "steps per second" + tighter recon
model or aria tree pruning). Not introduced by F1; F1 just made it visible
across more cases.

## Cross-cutting view

| Pattern | Lever | Cost | Hits |
|---|---|---|---|
| P3 (reading rhythm) | recon prompt PACING tightening | small, one prompt patch | #1 also (3s silent start), #4 directly |
| P4 (end-of-page stare) | recon prompt PACING — anti-pattern named | tiny | #3 directly, applies generally |
| P2 (metric blind to click effects) | F3 — judge intentExecution feeds metric | medium, plumbing the judge result into RunMetrics before computing intentSatisfaction | every site eventually |
| P1 (no `goto` step) | new action kind `goto` | medium, vocabulary + Director + prompt + tests | nav-gated sites (most) |
| P5 (recon cost) | F2 — parsimony budget + recon model | medium-large | every site |

## Decisions / immediate next moves

1. **Patch the recon prompt PACING for reading rhythm + end-of-page** (P3 + P4)
   — landing now, cheap, directly attacks 3 of 4 judge complaints.
2. **F3 (P2)** and **`goto` step (P1)** are real architectural moves; promote
   to design + plan once the prompt patch lands and we have a clean baseline.
3. **F2 (P5)** remains the goal-#5 follow-up; documented since the F1 finding,
   the four runs above re-confirm it.

The point of this sweep wasn't to fix github trending — it was to find what the
system fails on across **shape-of-prompt**: open-ended navigation,
multi-action-with-state, simple-list-scan, long-form-read. Each shape reveals a
different seam. F1's transparency layer means every seam now reports itself in
`run.json` / `judgment.json` instead of producing a misleading video.
