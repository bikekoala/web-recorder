# Plan–duration fit is a single architectural seam, not three site bugs

**Date:** 2026-05-13. Pipeline under test: §0034 prophet + §0036 + §0037 +
§0038 + §0039, recon on `anthropic/claude-sonnet-4.6`, `npm run regression`
(3 sites × 2 prompts = 6 runs) + the canonical `npm run eval`. Triggered by a
post-run review where I almost wrote two site-shaped point-fixes ("pad gmaps
harder", "make youtube recon faster") — the user pulled me back: **范式，不要硬编码**.

This finding writes the range of symptoms back into one architectural seam so
the next change moves the seam, not a site.

## The seven runs, side by side

| # | Site / prompt (durationMs) | `reconMs` | `plannedSteps` | `recordingMs` | trim Δ vs target | `intentSatisfaction` | judge / shape |
|---|---|---:|---:|---:|---:|---|---|
| 1 | Recordly README "简中 + slow scroll" (10 s) | ~21 s | 7 | 10.0 s | **+0 %** | complete | LOOKS_HUMAN — canonical |
| 2 | GitHub "简中 → back → folder → file source" (30 s) | n/a | 16 | 30.0 s | +0 % | complete (5/5) | ok |
| 3 | GitHub, distracting variant (30 s) | n/a | n/a | 30.0 s | +0 % | complete (3/3) | ok |
| 4 | YouTube "search → MrBeast → browse" (25 s) | n/a | n/a | 25.0 s | +0 % | complete (2/2) | ok |
| 5 | YouTube, distracting variant (25 s) | **61.8 s** | **24** | 25.0 s | +0 % | passed | **recon blows goal #5 (<60 s wall-clock)** |
| 6 | Google Maps "search NY, JUST observe — no canvas drag" (15 s) | ~36 s | 4 | **6.6 s** | **−56 %** | **complete** (1 click + 1 scroll) | **录到一半就停了；metric 仍说 complete** |
| 7 | Google Maps, distracting variant (15 s) | ~36 s | 4 | ~6.6 s | −56 % | passed | 同上 |

The `+0 %` column on rows 1–5 is §0039 working as designed. Rows 6–7 are
where the seam splits open. Row 5 is the same seam splitting in the opposite
direction.

## Pattern: there is one seam, not three

The pipeline currently expresses "plan that fits `durationMs`" through three
sequential layers:

| Layer | Code | What it actually does today |
|---|---|---|
| **A. Recon LLM** | `reconnoiterer` prompt → `ReconDraft` | proposes a plan of *whatever length the LLM judged natural for the intent*; `durationMs` is mentioned in the prompt as guidance, not as a hard constraint |
| **B. `fitPlanToBudget`** | `src/adapters/recon/llm-reconnoiterer.ts` | **mechanically** compresses (scale scroll/dwell/anticipation) **or pads** (append exactly one `scroll + dwell` pair) to reach `durationMs` |
| **C. Director soft-align** | `src/adapters/director/performance-director.ts` (§0039) | nudges each `dwell` at playback time by at most `[directorDwellMinMs, +directorDwellStretchMaxMs=2000]` around its declared duration |

The seven runs say the three layers are doing the wrong jobs:

- **Row 6 (gmaps underfill, −56 %).** "JUST observe" naturally yields a 3 s
  plan. B's padder appends one `scroll+dwell` (~3 s worth, clamped by the
  appended-step durations themselves). C can stretch at most +2 s. Total reach:
  ~8 s on a 15 s target — short by half. **B is being asked to *invent
  content*** (what should a human do for 9 spare seconds on a Maps results
  page that we just told it *not* to drag?). It can't — only A has the
  prompt + page tree + "what's natural here without violating the user's
  prohibition" context to answer.
- **Row 5 (youtube overfill, recon 61.8 s, 24 steps).** A produced a 24-step
  draft to fill a 25 s open-ended prompt on a content-rich page. B will
  happily run that as-is (it only compresses if `estimatedMs > durationMs`,
  not "if step count is excessive"). The rehearsal walk then pays the cost
  of every step, plus reconverge if any diverges. Wall-clock blows past 60 s.
  **A has no incentive to be parsimonious** — the prompt rewards
  "fill the time" but doesn't bound "steps per second".
- **Rows 1–4 (good).** These are cases where A's natural plan length and B's
  scaling and C's ±2 s collectively land inside the budget without
  exercising any of the failure modes. They don't mean the seam is fine —
  they mean the seam happens not to be stressed on these prompts.

The pattern under all three rows: **`durationMs` is a soft suggestion in A,
a mechanical constraint in B, and a tail correction in C — and "what natural
human filler / pacing looks like for THIS prompt on THIS page" lives entirely
in A's head, not in B's**. So whenever the gap between "natural plan length"
and `durationMs` exceeds what C can stretch, B's mechanical layer is asked to
do A's job, and either makes a robot filler (underfill) or stands aside
(overfill).

This is the same shape as §0036 was for target resolution: the wrong layer
was carrying the semantic load. The fix there wasn't a smarter `observe()`
heuristic — it was *moving the choice into the LLM with structured grounding*
(ref-tagged tree). The seam here is symmetric.

## Two pre-existing metric/cost issues that the rows surface but aren't caused by this seam

These are real, and orthogonal to the seam above — calling them out so they
don't get bundled into the fix and quietly hardcoded.

### M1 — `intentSatisfaction` rewards positive hits, doesn't penalise prohibited actions

Row 6: prompt says **"JUST observe — no canvas drag"**. Plan does 1 click +
1 scroll → metric: `complete`. If the plan *had* dragged the canvas, the
metric would still say `complete` — there is no "the user told us not to do X"
channel. Today this leaks goal #3 ("intent satisfied OR transparently not")
on prohibition-style prompts. The judge (vision LLM) is where prohibition
checks naturally belong — it watches the video and can see the canvas drag —
but the metric should at minimum be *honest about its blindness* (it currently
claims `level: complete` as if the prohibition didn't exist).

### M2 — recon cost is unbounded by design

Row 5's 61.8 s recon is not a YouTube bug. `reconRehearsalBudgetMs` already
caps the **walk** at 45 s, but the **initial vision call + plan size + tree
size** are uncapped per-page. Goal #5 wants total wall-clock < 60 s; on
distracting prompts on info-dense pages, recon alone can eat the whole budget.
This is the same goal-#5 lever as "cheaper recon model" — they're the same
axis (cost = `model_$/tok × tokens × calls`), but the lever shape here is
**plan size cap**, not model swap. Both belong to one decision, not two.

## What the architecture should look like instead

These are sketches for the design discussion, not commitments. Each one moves
**a seam**, not a site.

### F1 — `durationMs` is a first-class constraint in A (recon), not a hint

Recon's contract becomes: *produce a plan whose `totalEstimatedMs` is within
±X % of `durationMs`, filled with exploration that's natural for THIS prompt
on THIS page and that respects the prompt's prohibitions*. The LLM is the
only layer that knows what natural filler looks like for "JUST observe on
Maps" (look at the results card, read the chips, peek at the side panel) vs
"watch a video page" (scroll down to comments). The recon prompt has to
*give it the duration* and *give it the responsibility*.

The rehearsal walk then verifies the filler is achievable — same machinery
we already have. Reconverge handles overshoot/undershoot the same way it
handles target misses today.

B (`fitPlanToBudget`) becomes a **±X % corrector**, symmetric with C
(`directorDwellMinMs/StretchMaxMs`). B is allowed to scale, but it's no longer
allowed to *invent* steps — if the plan A returned is more than X % off, that
is a recon-quality miss to be surfaced (telemetry / regression canary), not
papered over by appending generic scrolls.

This is the architectural answer to **both** row-6 (underfill) and row-5
(overfill) at once: parsimony and naturalness are both A's job, and the
mechanical layers stop being load-bearing.

### F2 — recon cost gets a real budget knob, expressed in plan size

`reconnoiterer` prompt declares a soft cap: *prefer ≤ N steps; only exceed
when the intent literally cannot be expressed shorter*. Combined with F1
(`durationMs` is first-class), N can be expressed naturally as "≈ one step
per K seconds of `durationMs`", which gives the LLM a coherent budget rather
than two unrelated dials. Walk cost falls out of step count, so this knob
hits goal #5 directly without touching `LLM_RECON_MODEL`.

Crucially: not a hardcoded `if (plannedSteps > 20) drop()`. A natural-language
guideline in the prompt + a canary in `npm run eval` / regression that *fails
loudly* when reconMs > 60 s, leaving the choice (relax prompt, swap model,
shrink scope) to design rather than to runtime heuristic.

### F3 — `intentSatisfaction` is honest about its scope, prohibitions are the judge's job

Two moves, both purely about honesty (no extra heuristics):

1. Rename / re-phrase the metric so its level vocabulary doesn't claim
   ground it doesn't measure. `complete` on a prohibition-style prompt is
   misleading; `positive-hints-satisfied` (or similar) would be accurate. Or
   keep the level and just enrich the `note` to say
   *"prompt also contained prohibitions; not checked by this metric"* when
   the prompt clearly contains a negative ("no", "don't", "avoid", "without"
   — pattern-matched in the prompt at metric time, not LLM-judged; this is
   a labelling fact, not a behavioural one).
2. The vision judge is where the actual prohibition check belongs. Its
   rubric (`intentExecution`) already grades whether the recording reflects
   what the user asked for; teach it to specifically call out prohibitions
   when present.

This doesn't fix anything in code today; it stops the metric from lying.

## Ranked fixes

1. **F1 — recon owns `durationMs` (architectural).** The seam move. Touches
   `reconnoiterer` prompt (`durationMs` as a hard constraint with the
   prompt's prohibitions echoed back), `fitPlanToBudget` demoted to
   ±X % corrector with a *surfaced miss* when out of band. Unblocks rows 5
   and 6 from the same change. Verifier: `npm run regression` shows
   gmaps trimmed-duration within ±10 % *and* youtube reconMs back under
   the goal-#5 line on the distracting variant.
2. **F2 — recon plan-size budget (architectural).** Tied to F1 — once
   `durationMs` is the constraint, "steps per second" is the natural
   parsimony lever. Adds a regression canary on `reconMs > 60 s`.
3. **F3 — metric honesty re: prohibitions (architectural, doc-level).**
   Cheap, removes a goal-#3 leak. No new heuristic logic, just stops
   over-claiming `complete`. Judge rubric tweak is a follow-up.

What I am explicitly **not** proposing, after the user's correction:

- ✗ "Make `fitPlanToBudget` loop the `scroll+dwell` append for big gaps."
  This is a site-shaped point-fix that pretends to be generic. It puts more
  content-invention load on the mechanical layer that we just identified as
  the wrong layer.
- ✗ "Detect 'no drag' / 'just observe' in the prompt and skip the padder."
  Hardcoded heuristic. Violates the "禁止硬编码" memory.
- ✗ "Hardcode `plannedSteps ≤ 20`." Same.

Next step is a design discussion on F1 (the seam move), not a code change.
