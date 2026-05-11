# §0030 video judge — second batch (after §0031-0033)

**Date**: 2026-05-11 (afternoon)
**Recordings**: `output/2026-05-11/{13-59..14-03}-regression-*`
**Compared against**: [first batch](./2026-05-11-judge-first-batch.md) (morning, pre-§0031)

## Verdict comparison

| Case | First batch (pre-fix) | Second batch (post-fix) | Δ |
|---|---|---|---|
| github-multistep-natural | robotic | robotic | — |
| github-multistep-distracting | robotic | robotic | — |
| youtube-creator-natural | probably_synthetic | probably_synthetic | — |
| youtube-creator-distracting | **looks_human** | robotic | ↓ |
| gmaps-search-stay-natural | probably_synthetic | robotic | ↓ |
| gmaps-search-stay-distracting | robotic | robotic | — |

Headline distribution went from `1 looks_human / 2 probably_synthetic / 3 robotic` → `0 / 1 / 5`. **The verdicts got worse, not better.**

## What actually happened — the regressions are recording variance, not code regressions

### youtube-distracting (looks_human → robotic)

Different run, different LLM choices. The morning run typed at a comfortable pace and scrolled smoothly; this run's recording shows "instantaneous text entry" and a "teleport scroll on the search results page". But the typing actually took **933ms** (7 chars × ~130ms — the §0031 pre-typing pause + slower keystrokes DID apply, confirmed in the action log). The judge calling 933ms "instantaneous" is partly harshness, partly that YouTube's search-autocomplete dropdown appears within ~1 frame of the first keystroke so the visible "typing" window is short. With N=1 per case, a one-notch verdict swing is within noise.

### gmaps-natural (probably_synthetic → robotic)

The morning run's gmaps click on the search box *happened to* resolve and focus; this run's didn't. Action log:

```
0ms     recording_start
365ms   wait (opening hold)
2967ms  scroll (discovery scroll toward the search box)
3717ms  wait (scroll tail)
3755ms  click "the search input box on Google Maps"
8835ms  decision_failure click_failed  ← verifier: "did not gain focus"  (verifier took 5006ms!)
9123ms  4× implicit dwell
15751ms budget_exceeded  ← re-decision LLM call never returned before budget
```

So the recording is: 3s of nothing → a scroll → a click that produced zero visible change (Maps search box didn't focus) → 12s of dead air waiting for a re-decision that never landed. The judge correctly reports "entire 15-second video consists of dead air". This is the **gmaps search fragility** — a known weak spot (canvas-heavy page, search box hard to resolve), not caused by §0031-0033.

## What the fixes DID achieve (confirmed)

- **§0033 (intent metric)**: both github cases now report `intentSatisfaction: partial 1/3` — agreeing with the judge's `intentExecution: fail`. Pre-§0033 the metric falsely said `complete 3/3`. The bipartite assignment works.
- **§0032 (about:blank)**: **zero** `about_blank_recovered` events in this batch — no white-screen recordings. (Whether that's because the LLM avoided `back` per the new prompt rule, or because no run happened to trigger it, can't be told from one batch — but the recovery path is in place and tested.)
- **§0031 (rendering)**: applied as designed — opening hold 359ms, typing 933ms with the pre-pause, scroll tails present in the logs. The rendering parameters are doing their job at the frame level.

## The real diagnosis: §0031's pauses are too small for the dominant problem

Every "robotic" / "dead air" flag in this batch traces to ONE thing: **multi-second stalls from LLM/verifier tail latency, rendered as static frames by the implicit-dwell mechanism**.

- gmaps: the §0027 verifier took **5 seconds**, then the re-decision LLM call ate the rest of the budget. 12s of static frames.
- github: the agent kept needing to re-decide (clicks landing on the wrong element / hitting unreachable targets), each re-decision a 3-7s LLM round-trip, filled with implicit dwells.
- youtube-distracting: "sits completely idle on the channel page for the final 10 seconds" — the agent ran out of useful actions and the anti-idle prompt rule (§0031) either didn't fire or the decision to browse came back too late.

§0031's opening hold (300ms) and scroll tail (200ms) are noise next to a 5-12s dead-air block. They make the *good* parts slightly more human but can't rescue a recording whose middle is a frozen screen.

## What would actually move the needle (ranked)

1. **Verifier latency is a budget killer on short recordings.** On a 15s gmaps recording, one 5s verifier call is a third of the budget. Options: (a) skip the §0027 verifier when `durationMs ≤ ~20s`; (b) make the verifier fire-and-forget — continue acting, only react to a negative verdict if the queue hasn't moved past it; (c) use a faster verifier model. (b) is the principled fix but the most code.

2. **Implicit dwells should not be the only thing filling LLM latency.** A frozen screen for 5-12s is the #1 robot tell. Candidates: a tiny natural-looking scroll-and-settle during long waits (risky — could look like a tic), or — the structural answer — **cursor synth**, where the synthesized cursor drifts/hovers during waits and reads as "user is looking at the page" rather than "frozen". Cursor synth is the single highest-leverage remaining item.

3. **gmaps search fragility** — the Maps search box doesn't reliably resolve/focus. Either a Maps-specific selector hint, or accept that canvas-heavy pages are out of scope for now and drop gmaps from the regression set (it's testing a negative — "don't drag the map" — but the recording is unwatchable when the search itself fails).

4. **Recording variance is high enough that N=1 per case is too noisy to judge improvements.** Future judge batches should run each case 2-3× and compare modal verdicts, or at minimum acknowledge that a one-notch verdict swing is within noise.

## Honest bottom line

§0032 and §0033 are real, confirmed fixes (state-awareness + metric correctness). §0031 is correctly implemented but addresses the wrong-sized problem — the rendering polish is real but invisible next to the multi-second dead-air blocks that dominate every "robotic" verdict. The next work that will actually change the judge's verdict is either (1) killing the dead air (verifier latency + implicit-dwell-fill) or (2) cursor synth (makes "dead air" read as "looking around"). Both are bigger than a prompt tweak.
