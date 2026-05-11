# Prophet recording — first integration run (§0034)

**Status:** ⚠️ Architecture validity in question — the canonical scenario re-plans
mid-recording, and the re-plan is heavyweight, producing ~33 s of frozen-frame
dead air. The plan's prescribed remedy ("iterate on the recon prompt") does not
address this failure mode. Needs a design decision before Task 10 can close.

Date: 2026-05-11. Branch `prophet-recording` at `f380357` (Tasks 0–9 done).

## What was run

`npm run prototype:stagehand` — GitHub Recordly README, prompt "click 简体中文,
slow scroll", `durationMs: 10000`. Then `npm run judge` on the trimmed video.

## Result

| | |
|---|---|
| Verdict (Gemini 3.1 Pro judge) | **robotic** |
| `motionQuality` | fail — "instant teleport scrolls, no animation" |
| `pacing` | fail — "7 s dead air before first scroll … ends with 15 s of complete inactivity" |
| `intentExecution` | pass (it did click the link) |
| `recovery` / `visualCoherence` | pass |
| Trimmed video | 36.1 s (target 10 s — **3.6× over**) |
| `reconMs` (off-camera) | 51 009 ms |
| `recordingMs` (on-camera) | 38 543 ms |
| `replanCount` | 1 |
| `plannedSteps` / `stepsExecuted` | 8 / 2 |
| `endReason` | budget |
| Total wall-clock | 97 261 ms |

## Action-log timeline (session-relative ms)

```
  3216  goto
  4118  visual_stable
 54326  recording_start          ← 50 s of setup+recon before the camera opens
 54831  wait 500ms               ⎫
 55634  wait 800ms               ⎬ opening hold
 58107  scroll 1468px / 2447ms
 58868  wait 757ms
 58931  click  xpath=…react-app…/…   (the "简体中文" target the recon resolved)
 59078  replan  fromStepIndex=1  reason=expect_after_mismatch
                expected {"visibleText":["简体中文"]}; URL unchanged
 …  (nothing for ~33.8 s — the re-plan's recon() call running on-camera)
 92869  session end / endRecording   ← budget exhausted; re-planned steps never ran
```

So the recorded video is: ~1.3 s opening hold → 2.4 s scroll → 0.8 s wait →
instant click → **~34 s frozen frame** → end. That frozen stretch is the
re-plan's `reconnoiterer.recon()` call (`observeAll()` + vision LLM +
per-target `resolveTarget()`), which costs roughly what the *initial* recon
costs (~30–50 s) — except it runs while the camera is rolling.

## Root causes

1. **The re-plan checkpoint is incompatible with short recordings.** Re-plan =
   a full `recon()` (~30–50 s) executed on-camera. A 10 s budget can never
   absorb that, let alone the re-planned steps afterward. "replanCount is the
   canary" (spec, Open Risk #1) — it fired on step 2 of the canonical scenario.

2. **The first plan triggered the re-plan.** The recon resolved a target for
   "简体中文" that, when clicked, didn't change the URL or surface the text it
   predicted as `expectAfter`. The recon plans from a *screenshot* — it never
   *rehearses* the plan against the live page it was handed, so a wrong target
   / wrong `expectAfter` isn't caught until the camera is already rolling. (The
   user's framing was "先收集到所有的信息，执行的时候 精准无误的就做了" — a *rehearsing*
   recon would do exactly that; the current one only *plans*.)

3. **Scroll renders as "teleport" to the judge.** Possibly a video-fps artifact
   on a 2.4 s scroll, possibly lazy-loaded React content popping in, possibly a
   real `smoothScrollTo` issue. Pre-existing (the streaming director used the
   same `session.scroll()`); flagged for separate investigation.

4. (Minor) `reconMs` ≈ 51 s and total wall-clock ≈ 97 s — slow, but off-camera,
   so it doesn't hurt the deliverable. Still worth tightening later.

## Options on the table

- **A. Make re-plan cheap.** Strip `observeAll()` + pre-`resolveTarget()` from
  the re-plan path; tiny prompt; lazy selector resolution at click time. Target
  < 3 s. Still a visible "thinking" beat, but tolerable. Doesn't help if the
  re-plan's *new* steps also overrun the budget.
- **B. No mid-recording re-plan on short budgets.** On `expectAfter` mismatch,
  if `remainingMs < replanMinRemainingMs` (or `replanCount` exhausted): log it,
  drop the now-stale steps, optionally append a gentle filler scroll + short
  dwell, end. Smooth video; the *task* may finish incomplete (didn't reach
  "简体中文"). Honest trade for a 10 s budget.
- **C. Rehearsing recon (the real fix, bigger).** The recon already gets the
  live `IPageSession`. Have it *execute* its draft plan off-camera, observe the
  actual resulting states, and bake those into `expectAfter` — and reconverge
  when a draft step doesn't pan out. The on-camera playback then re-does the
  *verified* sequence. This is closest to the "prophet" idea and would make
  mid-recording re-plans genuinely rare. Cost: recon gets slower and more
  complex; needs care so the off-camera rehearsal leaves the page in a state
  the on-camera run can reproduce (re-navigate to the start URL before
  recording).
- **D. Hybrid:** B as the always-on safety net, C as the quality lever, A as
  the fallback when C's reconverge still leaves a mismatch and there's budget.

## Recommendation

Ship **B now** (small, contained, makes the canonical scenario *smooth* even if
incomplete) + open a sub-project for **C** (the rehearsing recon — that's the
actual answer to "make it look like a person *and* land the task"). Treat #3
(scroll-teleport) as its own bug.

## Update — after the "B" fix (commit `050d39d`, 2026-05-11)

`PerformanceDirector` now only does the heavyweight on-camera re-plan when
`remainingMs >= config.replanMinRemainingMs` (default 60 s); below that it logs
a `decision_failure`, drops the stale step tail, appends a short gentle closing
scroll + dwell, and ends. Re-ran the canonical scenario:

| | before B | after B |
|---|---|---|
| Verdict | robotic | **probably_synthetic** |
| `pacing` | fail ("33 s freeze") | partial ("~2 s between scroll and click feels slightly mechanical") |
| `motionQuality` | fail | fail ("initial scroll extremely fast & linear") |
| `intentExecution` | pass | partial ("requested 'slow scroll', executed fast") |
| Trimmed video | 36.1 s (3.6× over) | 6.9 s (under) |
| `replanCount` | 1 | 0 |
| dead air | ~33 s frozen frame | none |
| Total wall-clock | 97 s | 53 s |

**The architecture-level problem (on-camera re-plan = dead air) is solved.** What
remains is *recon plan quality*: (a) the recon resolved a wrong target for
"简体中文" (clicked a deep `react-app` div, not the README's language link) → the
click did nothing → graceful degradation kicked in (hence `intentSatisfaction:
partial`, "1/2 targets clicked"); (b) it emitted one 2.4 s / 600 px·s⁻¹ scroll
for a prompt that said "slow scroll" instead of slow/chunked scrolling;
(c) the scroll still reads as "fast & linear" to the judge — possibly low video
fps over a short scroll, possibly the `smoothScrollTo` easing, possibly lazy
React content. All three are recon-plan-quality / rendering issues, not the
recovery-architecture issue this doc opened on — tracked in Task #21
(rehearsing reconnoiterer + the scroll-rendering investigation).

`replanMinRemainingMs` default 60 s means: for the typical short (10–30 s)
recording there is now effectively *no* mid-recording re-plan — a divergence is
absorbed by graceful degradation. A re-plan only happens on long recordings
(≳ 75 s) where a ~30–50 s recon can fit. That's the right trade until the
rehearsing recon (Task #21) makes divergences rare enough that re-plan can be
re-enabled more aggressively.

## Update — after the rehearsing reconnoiterer (Task #21, 2026-05-11)

The rehearsing reconnoiterer landed: `recon()` now walks its draft `Performance`
against the live page **off-camera** (instant scrolls, skipped dwells), executes
each click/type/key/back, re-resolves each click/type target at the actual
scroll position it runs in, rewrites each acting step's `expectAfter` to the
*observed* post-state, reconverges (capped 2) where the draft diverges, then
re-navigates to the start URL and returns the verified plan. Plus: the recon
prompt grew a **PRIORITY #1 — accomplish the goal** mandate (extract every
requested action, each must be a step, re-check before emitting) and
**scroll-to-target discipline** (think in viewport-heights, no overshoot, no
scroll-past-then-back, "slow scroll" = a few moderate scrolls + dwells); the
reconverge prompt now says "the failed step's GOAL still matters — reach the
same outcome a *different* way, don't blindly re-issue the exact same action";
unresolvable click/type steps are no longer eagerly dropped (kept with a
sentinel, re-resolved during the walk, divergence → reconverge if still
unresolvable).

Re-ran the canonical scenario (GitHub Recordly README, "click 简体中文, slow
scroll", 10 s):

| | after B | after Task #21 |
|---|---|---|
| Verdict | probably_synthetic | **LOOKS_HUMAN** |
| `motionQuality` | fail ("fast & linear scroll") | **pass** |
| `pacing` | partial | **pass** |
| `intentExecution` | partial ("requested slow scroll, executed fast") | **pass** |
| `recovery` / `visualCoherence` | pass | pass |
| `intentSatisfaction` | partial (wrong 简体中文 target) | **complete** (1 click, 3 scrolls) |
| `replanCount` (on-camera) | 0 | 0 |
| `rehearsal` | — | `{walkedSteps: 8, divergences: 0, reconverges: 0, truncated: false}` |
| Trimmed video | 6.9 s (under) | 10.6 s (target 10 s, +6.4%) |
| `reconMs` (off-camera, incl. the walk) | ~31 s | ~49 s |
| Total wall-clock | 53 s | 72 s |

Judge summary on the Task #21 run: *"The recording perfectly executes the
user's prompt with natural-looking behavior. The scrolling is smooth, and the
pacing between locating the target link, clicking it, and scrolling the
subsequent page feels entirely human."* — the canonical complaint ("页面打开后等
了好久突然跳到简中页面然后开始滑动 — 这不像人") is resolved: no dead air, the click is
verified off-camera so it lands first try, the scroll is paced and smooth.

Cost: the off-camera walk adds ~15–20 s to recon (≈49 s vs ≈31 s) and ~20 s to
total wall-clock — off-camera, so it doesn't touch the deliverable; slows dev
iteration only. `RECON_REHEARSE=false` is the escape hatch.

### Known remaining gap — multi-screenful "scroll then click X" (Wikipedia "Cat → Felidae")

Tried a harder probe — `PROTOTYPE_URL=…/wiki/Cat`,
`PROTOTYPE_PROMPT="慢慢向下滚动浏览这篇关于猫的文章，然后点击 Felidae 链接"`, 12 s. The
recon planned scroll-down ~1900 px then `click "Felidae link"` *without
scrolling back* to where the link is (the taxobox "Family: Felidae" is at the
top-right and scrolls away; inline body "Felidae" links are further down) → the
rehearsal walk's re-resolve of "Felidae link" at scrollY ≈ 1900 returned
nothing → divergence → 2 reconverges (both also failed to land a working
Felidae click) → truncated + graceful tail → final `Performance` had no click
step → `intentSatisfaction: unknown`. Two contributing weaknesses:

1. **Recon plan quality** — the LLM doesn't reason about *where the target will
   be after the scrolls it just planned*; it plans "scroll down, then click X"
   even when X is above the scroll position. (The scroll-to-target discipline
   prompt rule helps for "scroll *to* X" but not for "scroll past, then click an
   earlier X".)
2. **`resolveTarget` ambiguity** — a long article has several "Felidae" links
   (taxobox, body text, navboxes); Stagehand `observe("Felidae link")` on that
   state didn't pin one. Possibly chunking, possibly the ambiguity.

Not blocking the canonical scenario, but the next recon-plan-quality lever:
either teach the recon to scroll the target back into view before clicking it
(or to click it *before* scrolling away), or make `resolveTarget` scroll-aware
and disambiguate. Tracked as a follow-up, not yet scheduled.
