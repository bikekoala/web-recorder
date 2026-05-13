# Plan–duration fit (F1) — design

**Date:** 2026-05-13
**Status:** approved, implementing.
**Context:** [`docs/findings/2026-05-13-plan-duration-fit.md`](../../findings/2026-05-13-plan-duration-fit.md)
identified one architectural seam: recon (A) proposes a plan whose length is
"whatever the LLM judged natural for the intent"; `fitPlanToBudget` (B)
mechanically scales/pads to reach `durationMs`; Director (C, §0039) soft-aligns
each dwell by at most ±2 s at playback time.

The 7-run regression + canonical eval (post §0037+§0039) showed:

- **Row 6 — gmaps "search NY, JUST observe — no canvas drag" (15 s):** trimmed
  to 6.6 s (−56 %, blows goal #2). A's natural plan is ~3 s; B's pad appends
  one mechanical `scroll + dwell` (~5 s reach); C tops out at +2 s. **B is
  being asked to invent natural content — the wrong layer for the job.**
- **Row 5 — youtube distracting variant (25 s):** `reconMs` 61.8 s, 24 steps
  (blows goal #5). A has no parsimony budget; B compresses to time but doesn't
  reject excessive step count.

**Decision (the seam move):** make `durationMs` a **first-class constraint in
A** (the recon LLM), so the layer that has the prompt + the page tree + the
sense of "what natural filler looks like" also owns the duration target. Demote
B from a content-inventor to a ±X % corrector that **surfaces** any out-of-band
miss to `RunMetrics` (goal #3 transparency). No retries, no hardcoded
prohibition detection, no step-count cap — those are F2 / out of scope.

Goals.md derivations that pin this design (not open):

| Goal | Pinned by |
|---|---|
| #2 trimmed ±10 % | end-to-end target; A+B+C combined |
| #3 transparent | any B miss must be a structured `RunMetrics` field, never silent |
| #5 <60 s, <$0.01 | no retry LLM call as default path |
| #6 AI-first | A identifies prohibitions itself; we do not regex the prompt |

## Components

### 1 — Recon prompt contract change (A owns duration + parsimony + prohibitions)

`src/prompts/reconnoiterer.ts` — add a new section to `reconnoitererSystemPrompt`
(separate from the existing PACING / PRIORITY sections) that elevates
`durationMs` to a hard constraint and pushes natural-filler responsibility onto
the LLM. The user's prompt + `durationMs` are already passed in
`buildReconUserText`; this is purely the system prompt.

Text (final wording during implementation may polish, but the substance must
include all four bullets):

```
DURATION & SCOPE (hard constraint):
- Your plan's totalEstimatedMs MUST land within ±10% of the durationMs you are
  given. Estimate using the same model the runner uses:
    each non-`done` step: +pacingStepOverheadMs (default 280 ms)
    click:                +anticipationMs + pacingSettleEstMs (default 1500 ms)
    key / back:           +pacingSettleEstMs
    dwell:                +durationMs
    scroll:               +durationMs + dwellAfterMs
    type:                 +preMs + text.length × keystrokeMs
- If the user's prompt forbids an action (any expression — "only", "just",
  "no X", "don't", "without", 中英文随意 — you judge), your plan MUST NOT
  contain that action, and your filler exploration MUST respect the
  prohibition. We do NOT regex the prompt; this is your call.
- If the explicit intent doesn't fill durationMs, do NOT pad with mechanical
  generic scroll/dwell. Add steps a real person would naturally do on THIS
  page given THIS prompt: read a result card, scan top chips, glance at the
  sidebar, scroll to a specific content section worth dwelling on. Each
  filler step must be groundable in the ariaSnapshot — the rehearsal walk
  will verify; if your filler can't be found at walk time it will be dropped.
- If the prompt's prohibitions make any natural filler violate them (e.g.
  "just glance" + durationMs=60s), say so in `rationale`. This is a
  prompt-level irreconcilability — the runner will mark the run as
  underfilled and that is fine; it is not your failure.
```

`buildReconvergeUserText` — add one line: "*remaining durationMs budget is
~Xms; same ±10 % discipline applies to the rest of the plan*." We compute X
as `durationMs - elapsedDeclaredMs` at reconverge time (already trackable in
`rehearsal.ts`).

### 2 — `fitPlanToBudget` demotion (B becomes a ±20 % corrector + surface)

`src/adapters/recon/llm-reconnoiterer.ts` — `fitPlanToBudget(steps, durationMs)`
returns a struct, not just `steps`:

```ts
export interface PlanDurationFit {
  estimatedMs: number;            // sumDurations(steps) BEFORE any B adjustment
  targetMs: number;               // durationMs
  ratio: number;                  // estimatedMs / targetMs
  status: 'ok' | 'compressed-hard' | 'underfilled';
}

export function fitPlanToBudget(
  steps: PerformanceStep[],
  durationMs: number,
): { steps: PerformanceStep[]; fit: PlanDurationFit };
```

Logic:

```
estimated = sumDurations(steps)
ratio = estimated / durationMs
TOL = config.planDurationFitToleranceRatio   // default 0.20

if |ratio - 1| <= TOL:
  // close enough — apply the existing scale-down compress only when slightly
  // over (so C's ±2 s can still land it inside ±10 %). Never pad.
  if estimated > durationMs:
    steps = compressScale(steps, durationMs)   // EXISTING logic, kept
  return { steps, fit: { ..., status: 'ok' } }

if ratio > 1 + TOL:
  // A over-planned by more than tolerance. Compress (best-effort) and flag.
  steps = compressScale(steps, durationMs)
  return { steps, fit: { ..., status: 'compressed-hard' } }

if ratio < 1 - TOL:
  // A under-planned by more than tolerance. DO NOT pad. Record as-is, surface.
  return { steps, fit: { ..., status: 'underfilled' } }
```

Removals:
- The current `else if estimatedMs < durationMs * 0.9` branch that appends
  `[scroll, dwell]` is **deleted**. B never invents steps.
- The current return type `PerformanceStep[]` changes to the struct above;
  call sites in `recon()` updated to thread `fit` through.

Kept:
- `compressScale` (the existing per-step scaler: scroll dur floor 200, dwell
  floor 100, click anticipation floor 0, type preMs floor 0). Used for both
  the "slightly over" inside-tolerance case and the `compressed-hard` case.

### 3 — `Performance` carries `planDurationFit`

`src/domain/performance.ts` — `PerformanceSchema` gains:

```ts
planDurationFit: z.object({
  estimatedMs: z.number().int().nonnegative(),
  targetMs: z.number().int().nonnegative(),
  ratio: z.number(),
  status: z.enum(['ok', 'compressed-hard', 'underfilled']),
}).optional()
```

`recon()` sets it from `fitPlanToBudget`'s return. Optional only because
existing test fixtures don't have it; new runs always populate it.

### 4 — `RunMetrics` surfaces it

`src/core/record-job-runner.ts` — `RunMetrics` gains:

```ts
planDurationFit?: {
  estimatedMs: number;
  targetMs: number;
  ratio: number;
  status: 'ok' | 'compressed-hard' | 'underfilled';
}
```

Copied verbatim from `performance.planDurationFit` at run end. Logged on
every run (structured); `status: 'ok'` is the silent default in the human-
readable summary, the other two statuses get a one-line note.

### 5 — Config knob

`src/infra/config.ts`:

```ts
planDurationFitToleranceRatio: z.coerce.number().min(0).max(1).default(0.20)
```

Env: `PLAN_DURATION_FIT_TOLERANCE_RATIO`. In `.env.example` with a comment.

Lives in the same "pure pacing params" carve-out as `pacingSettleEstMs`,
`directorDwellStretchMaxMs`, etc. (CLAUDE.md hard rule #6).

### 6 — `scripts/self-eval.ts` canary

The eval script today hard-fails on the bright-line specs (trimmed ±10 %,
wall-clock <60 s, disk <100 MB) and CONCERNS on quality. Add:

- `planDurationFit.status !== 'ok'` → **CONCERNS** (not hard-fail).
  Rationale: trimmed ±10 % already hard-fails when it actually matters;
  `compressed-hard` may still trim to ±10 %; `underfilled` definitely won't,
  and the trimmed-duration line will hard-fail anyway. The status field is
  the *diagnostic* the operator wants alongside the duration fail, not a
  second hard line.

Regression (`tests/regression/regression.test.ts`) keeps its categorical-only
assertions — `planDurationFit` is recorded to per-case logs for review but
does not gate test pass/fail. Regression is the "did the pipeline survive on
3 sites × 2 prompts" check; eval is the "did the canonical case stay healthy"
check.

## What this is explicitly NOT

- ✗ Recon retry on `underfilled` (F1 forbids; would blow goal #5)
- ✗ Step-count cap (F2; separate pass)
- ✗ Regex/pattern matching prohibitions in our code (goal #6; A's job)
- ✗ Director changes (C stays §0039)
- ✗ rehearsal walk changes (still validates filler step groundability via
  existing divergence/reconverge — no new mechanism)
- ✗ Metric rename / `intentSatisfaction` honesty (F3; separate pass)

## Verification

After implementation, expect on `npm run eval` + `npm run regression`:

| Run | Pre-F1 status | Post-F1 expectation |
|---|---|---|
| Canonical Recordly (10 s) | `+0%`, complete, LOOKS_HUMAN | `+0%`, `planDurationFit.status: 'ok'` |
| gmaps "JUST observe" (15 s) | trimmed 6.6 s (−56 %), `complete` (overcredit) | A fills naturally → trimmed in ±10 %, status `ok`. **OR** A is honest that 15 s is too long for "just observe" → status `underfilled` + rationale explains it; the run is then a goal-#3 transparent miss rather than a goal-#2 silent miss. **Either is acceptable** — both are honest. The current silent −56 % is not. |
| youtube distracting (25 s) | reconMs 61.8 s, 24 steps | F1 doesn't directly fix this — that's F2. `planDurationFit` here is already `ok`. Expect no regression. |

Failure mode to watch: A interprets "natural filler" as "many micro-dwells
between scrolls" → step count goes up → walk cost goes up → `reconMs` regresses.
Mitigation: the prompt explicitly says "a real person would naturally do" with
concrete examples (read a card, scan chips), not "fill with many micro-pauses".
If still observed, that's the signal F2 (parsimony budget) is needed sooner.

## Files touched (change-volume estimate)

| File | Change |
|---|---|
| `src/prompts/reconnoiterer.ts` | new DURATION & SCOPE section in system prompt; reconverge user-text adds remaining-budget line |
| `src/adapters/recon/llm-reconnoiterer.ts` | `fitPlanToBudget` returns struct; pad branch deleted; reconverge threads remaining budget; `recon()` writes `planDurationFit` onto `Performance` |
| `src/domain/performance.ts` | `PerformanceSchema.planDurationFit` optional field |
| `src/core/record-job-runner.ts` | `RunMetrics.planDurationFit` mirrored from `Performance`; structured log line |
| `src/infra/config.ts` | `planDurationFitToleranceRatio: 0.20` + env wiring |
| `scripts/self-eval.ts` | CONCERNS on `status !== 'ok'` |
| `tests/unit/adapters/recon/llm-reconnoiterer.test.ts` | `fitPlanToBudget` pad-branch tests deleted; status tests added (ok / compressed-hard / underfilled) |
| `tests/unit/domain/performance.test.ts` (or recon-draft adjacent) | `planDurationFit` schema test |
| `tests/unit/infra/config.test.ts` | `planDurationFitToleranceRatio` default + env override |
| `tests/unit/prompts/reconnoiterer.test.ts` | new system-prompt section asserted |
| `.env.example` | `PLAN_DURATION_FIT_TOLERANCE_RATIO=0.20` with comment |
| `docs/decisions.md` | new ADR §0040 |
| `CLAUDE.md` | state table row + Measured-performance note |

Estimated change: ~150 src lines + ~100 test lines. One PR-sized commit, or
split into "schema + config" → "fitPlanToBudget rewrite" → "prompt + log" if
the diff gets unwieldy.
