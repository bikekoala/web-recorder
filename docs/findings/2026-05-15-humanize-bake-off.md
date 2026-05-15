# Humanize bake-off — ours vs cloakbrowser's `humanize` wrapper

**Date:** 2026-05-15. Triggered by: 2026-05-15 cloakbrowser adoption — wanted to
A/B compare our §0031/§0039 typing+mouse rendering against cloakbrowser's
`humanMove` / `humanClick` / `humanType`. The hypothesis was "their renderer
might be better than ours; if so, swap." Built a harness, ran 12 cells,
measured.

**TL;DR.** **Don't use cloakbrowser's full humanize stack as our default — it
regresses pacing + intentExecution by more than it gains motionQuality.** Their
Bezier mouse curve IS a real win on `motionQuality`. Steal just that into our
default `clickAt`; leave typing + dwell soft-align on our own.

## Method

3 scenarios × 2 strategies × 2 runs each = **12 recordings**, all judged by
Gemini 3.1 Pro per §0030 rubric.

Scenarios (URL embedded in prompt):

- `recordly` — click 简体中文 + slow-scroll on the GitHub Recordly README, 10 s
- `google` — search "mechanical keyboard" + scroll results, 15 s
- `wiki` — pure reading scroll on Wikipedia Photosynthesis, 25 s (control —
  no click/type, so both strategies should tie)

Strategies (`HUMANIZE_STRATEGY` env):

- `ours` — `page.mouse.click(x,y)` (teleport then click) + our `keyboard.type({delay})`
  + §0039 dwell soft-align ON
- `cloakbrowser` — cloakbrowser's `humanMove` (Bezier) + `humanClick` (jitter +
  hold) + `humanType` (per-char timing + mistype simulation + CDP shift events);
  §0039 dwell soft-align OFF (otherwise the two pacing layers fight)

Harness: `scripts/humanize-bake-off.ts` (removed post-experiment) spawned one
`tsx` subprocess per cell with HUMANIZE_STRATEGY in env, so each cell read a
fresh `config`. Per-cell artifact: a `recording.mp4` + `judgment.json` under
`output/2026-05-15/12-*-bake-<scenario>-<strategy>/`.

## Raw results

```
scenario   strategy        looks_h   mq    pa    ie    rec   vc
recordly   ours            1/2       1/2   2/2   2/2   2/2   2/2
recordly   cloakbrowser    0/2       2/2   0/2   0/2   2/2   2/2
google     ours            1/2       2/2   1/2   1/2   2/2   2/2
google     cloakbrowser    0/2       2/2   0/2   0/2   1/2   2/2
wiki       ours            2/2       2/2   2/2   2/2   2/2   2/2
wiki       cloakbrowser    2/2       2/2   2/2   2/2   2/2   2/2

OVERALL    ours            4/6       5/6   5/6   5/6   6/6   6/6
OVERALL    cloakbrowser    2/6       6/6   2/6   2/6   5/6   6/6
```

Legend: `mq` motionQuality, `pa` pacing, `ie` intentExecution, `rec` recovery,
`vc` visualCoherence. Numbers are `(pass count) / (total runs)`.

## Where cloakbrowser wins and where it doesn't

**Wins (mq, by +1):** Bezier curve from the previous cursor to the target is
visibly better than our teleport-then-click. The judge consistently passed it
on `motionQuality`. This is real and unsurprising — we have no mouse curve in
`ours`.

**Loses (pa, ie, by −3 each):** `cloakbrowser`'s `humanType` runs too long for
the slice the Performance budgeted. Judge quotes (all from cloakbrowser runs):

- recordly run 1: "noticeable dead air before actions"
- google run 1: "types the search query but **fails to submit it**, completely
  missing the second half"
- google run 2: "**freezes** for the remaining 7 seconds of the video, never
  submitting the search"
- google run 3: "types the search query but does so in **unnatural, blocky chunks**"

The pattern: typing eats too much budget, the Director hits hard deadline before
the post-type Enter+scroll steps run, video ends with a half-finished form on
screen. That looks worse than our slightly-stiff typing because it's
*incomplete*.

The fundamental issue is that **cloakbrowser's humanize is engineered for "a
real human at the keyboard" pacing, not for a recording with a hard `durationMs`
budget**. Their `humanType` has mistypes + correction loops + per-character
delays that can easily double the wall-clock cost of typing N characters
compared to `keyboard.type({delay: 60-140 ms})`. Our pacing model — recon plans
the slot, Director plays it — assumes the renderer doesn't blow the slot.

**Tie (wiki):** both strategies hit `looks_human` 2/2 — confirms the harness
isolates the right variable. Wiki has no click/type, only scroll (which uses our
`smoothScrollTo` in both strategies), so the strategies *should* tie there. They
did. Bake-off validated.

## Decision

**Default stays `ours` (already the case from the bake-off PR). Strategy switch
deleted post-experiment.** Per the no-escape-hatches memory item: this is now
decided, no `HUMANIZE_STRATEGY=cloakbrowser` flag.

**Take the Bezier curve:** `humanMove` from cloakbrowser is folded into our
`clickAt` ahead of `page.mouse.click(x, y)`. We get the +1 mq win without the
−3 pa/ie regression. Typing stays on `keyboard.type({delay})`, dwell soft-align
stays on (§0039).

## What this teaches

- **Naturalness != correctness within a budget.** A renderer that "looks more
  human moment-to-moment" can produce a *less natural* recording overall if it
  blows the per-step time budget. Our two-phase pipeline (plan → paced playback)
  is sensitive to renderer wall-clock cost in a way an interactive automation
  isn't. Anything we adopt has to play inside the Performance's time slots.
- **C++-level stealth is orthogonal to humanize.** cloakbrowser's real value is
  the patched Chromium binary (canvas/WebGL/audio/fonts/GPU — §0042/§0044). Their
  TypeScript humanize wrapper is opt-in and we don't have to take it to get the
  stealth.
- **The bake-off harness pattern is reusable.** Three-script-per-cell via
  `child_process.spawn + env vars` is the right shape for any "config-module-
  loaded-once" A/B — when we need another bake-off (e.g. a future Stagehand SDK
  swap), the structure is here in git history (`0893784` is the
  add-bake-off commit; the script was removed in the follow-up but is
  straightforward to bring back).

Raw judgment JSONs live in `output/2026-05-15/12-*-bake-*/judgment.json`
alongside each recording — the per-cell evidence the judge used.
