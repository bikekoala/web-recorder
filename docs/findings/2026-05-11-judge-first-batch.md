# §0030 video judge — first regression batch (6 runs)

**Date**: 2026-05-11
**Recordings**: `output/2026-05-11/{11-14..11-18}-regression-*`
**Judge model**: `google/gemini-3.1-pro-preview` via OpenRouter
**Latency per call**: 17-28s (mean ~22s)
**Cost per call**: ~$0.02-0.05 (videos 1.7-3.0 MB base64)

## Headline

| Verdict | Count | Cases |
|---|---|---|
| `looks_human` | 1 | youtube-creator-distracting |
| `probably_synthetic` | 2 | youtube-creator-natural, gmaps-search-stay-natural |
| `robotic` | 3 | github-multistep-natural, github-multistep-distracting, gmaps-search-stay-distracting |

**1/6 passes the judge as "looks human".** The judge is operating on the
"default to skeptical" rule (per §0030 prompt design), so this is a
deliberate lower-bound — but it's the first machine-graded measurement of
where we actually stand on goals.md #1 ("looks human, not scripted").

## Cross-cutting patterns (most actionable first)

### P1. "Dead air at start" — flagged in 5/6 runs

> "video begins with 7 seconds of complete dead air before any action"
> — github-multistep-distracting @0s
>
> "long period of dead air (over 5 seconds) at the beginning"
> — gmaps-search-stay-natural @2s
>
> "begins with over 5 seconds of complete dead air"
> — gmaps-search-stay-distracting @0s

This is the SAME failure the user originally identified ("等待了好久 突然
跳到简中页面"). §0029 opening hold (200-500ms) was meant to address this, but the judge is seeing dead air of **5-7 seconds**, far longer than our
intentional hold. The 5-7s is real — it's the discovery-scroll-then-click
sequence playing without any visible cursor making it look intentional.

**Diagnosis**: when the first action is a discovery click on a below-fold
target, the executor does (a) scroll-to-target (~2-3s), (b) anticipation
pause (~0.6s), (c) click — total ~3-4s. From a viewer's perspective with no
cursor sprite, this reads as "the page scrolled by itself for no reason,
then a thing changed". Not strictly "dead air" (motion is happening) but
the judge's `pacing` rubric correctly flags it as having no human-explainable
intent.

**Most likely fix**: this gap closes naturally with cursor synth (B1-B3).
A visible cursor moving toward the target turns "page scrolls for no reason"
into "user is heading toward something". This is the structural answer
goals.md #1 already pointed at.

**Cheap stopgap**: introduce a 200-400ms "settle" pause AFTER the discovery
scroll completes and BEFORE the click anticipation — gives the viewer time
to see *where* the page landed before the action fires. Naturalness-catalog
A6 (inter-scroll micro-pause) covers this.

### P2. Instant typing — flagged in 2/6 runs (both gmaps)

> "text '纽约' appears instantaneously in the search box rather than being
> typed out sequentially, suggesting script-based text injection"
> — gmaps-search-stay-natural @6s
>
> "text 'New York' appears instantly in the search box all at once,
> lacking any natural keystroke progression"
> — gmaps-search-stay-distracting @6s

**Diagnosis**: `StagehandPageSession.type` (in `src/adapters/agent/`) is
likely calling Playwright's `page.keyboard.type(text)` with no `delay`
parameter, so all characters fire as fast as the input dispatches them.

**Fix**: pass `{ delay: rand(50, 150) }` to Playwright's `type`, which gives
human-paced per-keystroke timing. Single config knob (`TYPE_DELAY_MIN_MS` /
`MAX_MS`). 10-line change. Catalog F2 ("variable typing speed").

### P3. "Teleport scroll" — flagged in 1/6 runs

> "Instant teleport scroll down the file list with no animation frames"
> — github-multistep-distracting @7s, @16s, @22s

Inconsistent with other runs that scored `motionQuality: pass` on the
same scroll implementation. Two hypotheses:

- The judge confused a normal-speed scroll for a teleport in this case
  (`probably_synthetic` would be more honest than `robotic` here)
- The scroll deltas were unusually small (~50px) and the easing curve at
  short distances does collapse to near-instant

Action: re-judge this video at a higher temperature (T=0.3) and see if
the verdict shifts. If the teleport finding is stable, look at the
short-distance scroll easing curve.

### P4. Trailing idle after main task complete — flagged in 2/6 runs

> "agent spends the last 12 seconds of the recording completely idle on
> the channel page" — youtube-creator-natural @13s
>
> "page sits completely idle for 15 seconds with no actions taken after
> the initial click" — github-multistep-natural @2s

Both runs hit `budget_exceeded` after running out of reachable targets
(§0028 retry cap fired). The remaining recording window has the
already-loaded page sitting still until the trim cuts it.

**Most likely fix**: when the Director would otherwise sit idle (queue
empty, no more useful actions to take, but time remains), fill the
budget with **natural browsing motion** — small variable scrolls
emulating "reading what's on screen". §0019 Director was supposed to
keep this loop going; the trailing idle suggests the LLM is outputting
`done` or low-effort `dwell` runs when it should output `scroll` for
content-rich pages. Prompt-side fix in `src/prompts/decider.ts`.

### P5. intentExecution failures correlate with budget exhaustion

3/6 runs failed `intentExecution`: the two github runs and one of the
youtube runs. In all three, the agent completed 1-2 of the prompt's
verbs and then ran out of budget or hit unreachable targets.

This is the same signal the action-log-side `intentSatisfaction` metric
SHOULD report but doesn't due to the over-count bug
([2026-05-11-intent-satisfaction-overcount.md](./2026-05-11-intent-satisfaction-overcount.md)).
Fixing that metric will make the disagreement smaller, but the
underlying behaviour problem (agent declares done too early or runs out
of time) is real.

## Single-case bugs (not cross-cutting)

- **github-multistep-natural 18s white-screen** —
  [dedicated finding](./2026-05-11-github-whitescreen.md).
  `back()` from a state where no real navigation occurred pops to
  `about:blank`. Root: the LLM mis-clicked a `<p>` paragraph as a
  language link, so no nav happened, but it still chose `back()` to
  return to "home".

## Recommendation: priority order

1. **P2 typing delay** — 10 lines, immediate naturalness win on every
   case that types. Catalog F2.
2. **P1 stopgap inter-scroll micro-pause** — 10 lines + a new config
   knob. Catalog A6.
3. **White-screen fix** — option C (history-depth hint to decider) +
   option A (about:blank recovery) per the dedicated finding doc.
4. **intentSatisfaction over-count fix** — option A (UI-noun blocklist)
   + option B (best-match unique assignment) per its finding doc.
5. **P4 trailing idle** — decider prompt rule. Slot into a prompts-only
   commit.
6. **P3 short-distance scroll easing** — re-judge first, only act if
   the finding is stable.

The bigger structural answer for goals.md #1 remains **cursor synth**
(catalog B1-B3). That alone reframes most of the "no human-explainable
intent" findings from `fail` to `pass` in the judge's eyes.

## Variance note

Single judge call per recording. Inter-run variance unmeasured — a
3-run sample per video would be needed to put error bars on each
verdict. For now we treat single-call verdicts as point estimates and
trust the *patterns* across all 6 videos more than any individual
verdict.
