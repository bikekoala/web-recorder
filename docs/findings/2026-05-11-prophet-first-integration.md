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
