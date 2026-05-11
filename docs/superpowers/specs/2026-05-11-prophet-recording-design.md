# "Prophet" Recording — Design Spec

> **Sub-project 1 of the "intelligent system" direction (Direction A).** Sub-project 2 — cursor synth + composer — is a separate spec/plan cycle that follows this one. This document covers ONLY the recording-architecture change.

**Status:** approved design, awaiting implementation-plan write-up.
**Date:** 2026-05-11
**Supersedes:** parts of §0019 (streaming director), §0023 (cold-start pre-fire), §0026 (`draftSequence`), §0027 (click verifier), §0028 (retry cap), §0032 (about:blank recovery) — see "What this preserves / removes" below for the exact list.

---

## Context — why this change

The §0030 video judge, run twice against the regression suite, consistently flags the recordings as `robotic` / `probably_synthetic`. Every "robotic" verdict traces to ONE cause: **multi-second dead air** — frozen frames while an LLM-in-the-loop decision or a §0027 verifier call is in flight, rendered as static frames by the Director's implicit-dwell mechanism. On a 15s gmaps recording, one §0027 verifier call took 5 seconds — a third of the budget. The §0029/§0031 rendering polish (opening hold, slower typing, scroll-tail) is real but invisible next to a 12s frozen middle.

The user's framing: they want "一个智能的系统" — and the specific pain is that the **recording still looks like a machine**. They earlier articulated the fix unprompted: *"准备好了表示先收集到所有的信息,执行的时候精准无误的就做了,像一位先知一样"* — collect all information first, then execute precisely, like a prophet.

Independently, the codebase has accumulated a patch sprawl: §0027 click verifier, §0028 retry cap, §0029 opening hold, §0031 anti-idle + back-semantics prompt rules, §0032 about:blank recovery, §0033 bipartite metric. Each is a reaction to a specific failure mode. The Director has become a rules engine with LLM calls bolted in; intelligence is fragmented across planner / decider / verifier, and the orchestration glue is hard-coded.

**The intended outcome:** move all reasoning to a reconnaissance phase *before* the recording window. Recon produces a complete, pre-resolved, paced `Performance`. The recording window plays it back deterministically — no LLM, no verifier, no implicit dwells. The patch sprawl collapses into a single re-plan checkpoint. Dead air is eliminated structurally (not papered over). The "intelligence" concentrates in the recon prompt and the richness of what recon observes, not in scattered hard-coded branches.

This serves goals.md non-negotiables: #1 (looks human — no frozen screens), #2 (fluid, no visible stalls — the only "dwells" are *planned*, not LLM tail latency), #3 (intent satisfied or transparently not — unresolvable targets surface in `intentSatisfaction`), #6 (AI-first, not magic-numbers — pacing is decided by the recon LLM per step; the §0031 fixed values become defaults it may override).

---

## Architecture

```
RecordJobRunner
  1. setup (NOT recorded)        browser launch · goto(url) · waitForVisualStability
  2. RECON (NOT recorded)        IReconnoiterer.recon({ url, prompt, durationMs, viewport, screenshot }, session)
                                   → Performance { steps[], totalEstimatedMs, rationale }
                                 - screenshot + session.observeAll()
                                 - LLM call(s): build the step list, decide per-step pacing, set expectAfter
                                 - session.resolveTarget() for every click/type step → selector + bbox
                                 - drop unresolvable targets (LLM re-plans without them)
                                 - sanity: totalEstimatedMs ≈ durationMs (pad with browsing/dwell or trim)
  3. BlockerPrelude (NOT recorded, OPTIONAL)
                                 - probe → dismiss cookie/consent/etc. KEPT.
                                 - the §0023 "pre-fire decision 1" sub-feature is REMOVED (no cold start to hide)
  4. PLAYBACK (RECORDED)         PerformanceDirector.run(performance, session)
                                 - beginRecording()
                                 - for each step: render with its planned timing → capture evidence
                                   → reality check (expectAfter) → on divergence: re-plan remaining steps
                                 - done step → stop · budget exhausted → stop
  5. stop + trim (NOT recorded)  session.stop() · ffmpeg trim
  6. judge gate (OPTIONAL)       §0030 LlmVisionJudge — warn if robotic; not a hard gate (goals.md #6)
```

---

## Components

### `Performance` — new domain type (`src/domain/performance.ts`)

Zod-validated. Replaces `DirectorBriefing` as the primary planner output.

```ts
export type ResolvedTarget = {
  /** Stable Playwright selector, pre-resolved by recon. */
  selector: string;
  /** Bounding box at the moment recon resolved it (viewport-relative). */
  bbox: Bbox;
  /** Natural-language description, for logs + the reality-check diagnostics. */
  description: string;
};

export type PerformanceStep =
  | { kind: 'click';  target: ResolvedTarget;  anticipationMs: number;  reasoning: string;
      expectAfter?: { urlContains?: string; visibleText?: string[] } }
  | { kind: 'scroll'; deltaPx: number;  durationMs: number;  easing: ScrollEasing;
      dwellAfterMs: number;  reasoning: string }
  | { kind: 'type';   target: ResolvedTarget;  text: string;  preMs: number;  keystrokeMs: number;
      reasoning: string }
  | { kind: 'key';    key: 'Enter'|'Escape'|'Tab'|'ArrowDown'|'ArrowUp'|'ArrowLeft'|'ArrowRight'|'Backspace';
      reasoning: string;  expectAfter?: { urlContains?: string; visibleText?: string[] } }
  | { kind: 'dwell';  durationMs: number;  reasoning: string }   // "reading the README intro" — first-class
  | { kind: 'back';   reasoning: string;  expectAfter?: { urlContains?: string; visibleText?: string[] } }
  | { kind: 'done';   reasoning: string };

export interface Performance {
  prompt: string;
  durationMs: number;            // user-requested target
  steps: PerformanceStep[];
  totalEstimatedMs: number;      // sum of step durations; should be ≈ durationMs
  rationale: string;             // one-paragraph "why this plan"
}
```

Differences from `DirectorBriefing`:
- **Targets pre-resolved** (`selector` + `bbox`), not natural-language descriptions resolved at runtime.
- **Timing is per-step** — `anticipationMs`, `durationMs`, `dwellAfterMs`, `preMs`, `keystrokeMs`. The recon LLM decides pacing; the §0029/§0031 values become the defaults it picks from (and may override per step).
- **`dwell` is a first-class step** — the recon inserts these for naturalness ("dwell 2.4s, simulating reading the README intro"), not just to hide latency.
- **`expectAfter` on navigation-causing steps** — the reality check the playback director runs.
- No `hints` array, no `draftSequence` — the `steps` list IS the complete sequence.

### `IReconnoiterer` — new port (`src/ports/reconnoiterer.ts`)

```ts
export interface IReconnoiterer {
  recon(input: ReconInput, session: IPageSession): Promise<Performance>;
  /** Stable identifier for the underlying model. */
  readonly modelId: string;
}

export interface ReconInput {
  url: string;            // current URL (== original on first recon; wherever the page is on a re-plan)
  prompt: string;         // the user's ORIGINAL intent — unchanged across re-plans
  durationMs: number;     // on first recon: the full budget. on a re-plan: the REMAINING budget.
  viewport: Viewport;
  screenshot: Buffer | null;
  /**
   * Re-plan context only. On a re-plan, the reasoning strings of the steps
   * already executed this recording, in order — so the LLM plans the REST
   * without redoing what's done. Undefined / empty on the first recon.
   */
  priorSteps?: Array<{ kind: PerformanceStep['kind']; reasoning: string }>;
}
```

Adapter: `LlmReconnoiterer` (`src/adapters/recon/llm-reconnoiterer.ts`). Strong vision model (Sonnet 4.6 / Gemini Pro — reuses `config.llmPlannerModelResolved` by default; new `LLM_RECON_MODEL` override). Procedure:

1. Take the screenshot; call `session.observeAll()` for candidate interactive elements (ground truth for what exists).
2. LLM call(s): given page + intent + duration budget + observed elements, produce the `Performance` — which elements to click in what order, pacing per step, where to insert reading dwells, what `expectAfter` to assert. (One call usually; a second if the first plan needs revision after resolution fails.)
3. For each `click`/`type` step: `session.resolveTarget(description)` → `ResolvedTarget`. This is the §0017 pre-resolve mechanism, moved into recon and made **mandatory** (was best-effort).
4. If a target won't resolve → tell the LLM, it re-plans without it. If the intent fundamentally needs it, the Performance is shorter and `intentSatisfaction` will later report `partial`/`unmet` transparently.
5. Sanity-check `totalEstimatedMs` ≈ `durationMs` (within ~±15%). Too short → LLM adds browsing/dwell steps. Too long → LLM trims.

**Destination verification — light, not exhaustive.** For `click` steps where the resolved element has a readable `href`, recon writes the predicted destination into `expectAfter.urlContains`. For JS-heavy clicks (turbo-frame, SPA, hash routing), recon does NOT predict a URL — it may set `expectAfter.visibleText` if confident, otherwise leaves `expectAfter` unset (the playback's reality check then treats "no expectAfter" as "any change is fine"). Recon does **not** click-to-verify during the recon pass (too expensive, mutates page state). The re-plan checkpoint is the backstop for wrong predictions.

`ReconError extends DomainError` — thrown on LLM/network failure or a Performance that fails Zod validation. The runner surfaces it (no recording produced), same as today's planner-fail behavior.

### `PerformanceDirector` — refactor of `StreamingDirector` (`src/adapters/director/performance-director.ts`)

```ts
export class PerformanceDirector implements IDirector {
  constructor(opts: { replanner: IReconnoiterer });   // the SAME recon adapter, reused for re-plans
  run(performance: Performance, session: IPageSession): Promise<DirectorReport>;
}
```

Loop:
1. `session.beginRecording()`.
2. For each `step` in `performance.steps` (a mutable working copy — re-plan replaces the tail):
   a. **Render the step** with its planned timing:
      - `click` → discovery click choreography (§0017): scroll target into view, hold `anticipationMs`, click `target.selector`.
      - `scroll` → multi-stage scroll for big deltas (§0018), driven by `durationMs`/`easing`; then `dwellAfterMs` pause.
      - `type` → focus `target.selector`, pause `preMs`, `keyboard.type(text, { delay: keystrokeMs })` (§0031).
      - `key` → `keyboard.press(key)`.
      - `dwell` → `session.wait(durationMs)`.
      - `back` → `page.goBack()`.
      - `done` → stop.
   b. **Capture evidence** (§0026 `ActionEvidence` — URL/title/scrollY/focusedValue before & after).
   c. **Reality check**: if the step has `expectAfter` and the post-step evidence doesn't satisfy it → **re-plan checkpoint** (the ONE recovery path):
      - Pause. Call `replanner.recon({ url: <current>, prompt: <original prompt, unchanged>, durationMs: <remaining budget>, viewport, screenshot: <fresh>, priorSteps: <reasoning of every step executed so far> }, session)`.
      - Replace the remaining steps with the new Performance's steps. Continue from the first new step.
      - Log a `replan` action-log entry (reason="expectAfter mismatch", which step diverged, what was expected vs. observed).
      - This generically subsumes §0027 (click-failed), §0028 (retry-cap), §0032 (about:blank — `back`'s `expectAfter` won't match `about:blank`, triggers a re-plan that re-navigates).
   d. **Budget guard**: if elapsed ≥ `durationMs × hardBudgetMult` (config, default 1.2) → stop.
3. On `done` → stop. `DirectorReport.endReason ∈ {done, budget, error}`.

**Re-plan loop guard**: at most `config.maxReplans` (new knob, default 3) re-plans per recording. After the cap, no more re-plans — play out remaining steps as-is (their reality checks become advisory, not actionable) or stop if there's nothing sensible left. Prevents a divergent page from causing endless re-plan stalls. The cap is test/eval infra, not a behavior threshold — goals.md #6 carve-out.

No pre-fire, no verifier, no implicit dwells. The only stalls are: (1) planned `dwell` steps (intentional, natural), (2) a re-plan checkpoint in flight (~3-5s, page sitting; bounded by `maxReplans`; cursor synth in sub-project 2 covers it — and the playback director MAY render a small natural dwell during a re-plan as a forward hook).

### `RecordJobRunner` changes (`src/core/record-job-runner.ts`)

- `this.planner.brief(...)` → `this.reconnoiterer.recon(...)`.
- `this.director.run(briefing, ...)` → `this.director.run(performance, session)` (the `IDirector` port stays; the implementation is `PerformanceDirector`).
- Drop the `preFireDecider` constructor param and the `prefireFirstDecision` method (§0023). `BlockerPrelude` is kept (still constructed/run for pre-recording dismissal); only its pre-fire-decision-1 coupling is removed.
- `RunResult` gains `performance: Performance` and `metrics` gains `replanCount: number`.
- `computeIntentSatisfaction` is unchanged in spirit (§0033 bipartite) but its input changes: instead of `briefing.hints` it gets the descriptions of the Performance's `click` steps that actually executed (i.e. weren't abandoned by a re-plan that dropped them). The §0030 judge remains the authoritative cross-check.

### Action-log additions (`src/domain/action-log.ts`)

- New entry type `replan` (or extend `decision_failure` with reason `replanned`): `{ t, type: 'replan', fromStepIndex, reason, details, scrollY, viewport }`.
- The existing `decision` / `decision_failure` entry types stay (the re-plan uses them) but the per-action `decision` entries from the old streaming loop no longer appear (there's no per-action LLM call).

---

## Data flow

```
(url, prompt, durationMs)
  → setup: browser + goto + waitForVisualStability
  → recon: screenshot + observeAll → LLM → Performance
            (targets resolved to selector+bbox, pacing planned, expectAfter set where predictable)
  → [BlockerPrelude: dismiss cookie/consent if present — NOT recorded]
  → beginRecording()
  → playback: working steps = [...performance.steps]
              for each step:
                render(step, step.timing)        // reuses §0017/§0018/§0031 primitives
                evidence = captureEvidence()       // §0026
                if step.expectAfter && !satisfied(step.expectAfter, evidence):
                  newPerf = replanner.recon(currentState, remainingIntent, remainingBudget)
                  workingSteps = [...executedSoFar, ...newPerf.steps]   // replace tail
                  log('replan', ...)
                  if replanCount > maxReplans: stop re-planning (advisory only)
                if elapsed >= durationMs * hardBudgetMult: stop
                if step.kind == 'done': stop
  → stop → trim
  → judge gate (optional): §0030 video judge
  → RunResult { videoPath, rawVideoPath, actionLogPath, performance, metrics: {..., replanCount, intentSatisfaction}, directorReport }
```

---

## Error handling

| Failure | Behavior |
|---|---|
| Recon LLM/network error, or Performance fails Zod validation | Throw `ReconError`. No recording produced. (Same as today's planner-fail.) |
| A click/type target won't resolve during recon | LLM re-plans without it. If intent needs it → Performance is shorter → `intentSatisfaction` reports `partial`/`unmet` transparently. |
| Reality check (`expectAfter`) fails during playback | Re-plan checkpoint (the one recovery path). |
| Re-plan itself fails (LLM error) | Playback stops gracefully; trim to what happened; `intentSatisfaction` reports what got done; `directorReport.endReason = 'error'`. |
| `maxReplans` cap hit | Stop re-planning. Remaining steps play out (reality checks advisory). Prevents endless re-plan stalls. |
| Budget exhausted (`elapsed ≥ durationMs × hardBudgetMult`) | Stop. `endReason = 'budget'`. (Same as today.) |
| BlockerPrelude fails | Logged, non-fatal — recording proceeds (same as today). |

All recoverable failures → action-log entries (`replan`, `step_skipped`). The action log stays the source of truth.

---

## Testing

**Unit (vitest, `tests/unit/`):**
- `Performance` Zod schema: round-trip valid payloads; reject malformed (missing `target` on a `click`, bad `easing` enum, negative durations).
- `PerformanceDirector` with a `FakeReconnoiterer` (the re-planner) + `FakePageSession`:
  - plays back all steps in order; renders each with its planned timing (assert `session.events` shape).
  - reality-check pass → no re-plan.
  - reality-check fail → exactly one re-plan; remaining steps replaced with the fake re-planner's output.
  - `maxReplans` cap respected (N+1th divergence → no more re-plans).
  - budget exhausted mid-playback → stops, `endReason = 'budget'`.
  - `done` step → stops.
  - re-plan LLM error → graceful stop, `endReason = 'error'`.
  - ~8-10 cases.
- `LlmReconnoiterer` with a mocked LLM client:
  - parses a valid Performance JSON, resolves each target via the fake session's `resolveTarget`.
  - target won't resolve → re-plan-without-it path (one extra LLM call, the second plan validated).
  - LLM returns malformed JSON / schema-invalid Performance → `ReconError`.
  - `totalEstimatedMs` way off `durationMs` → the prompt asks for revision (assert the second call happens).

**Regression (vitest, real browser + LLM, `tests/regression/`):** the existing 3 cases × 2 prompts. Categorical asserts ONLY (goals.md #6):
- recording produced (`videoPath` truthy).
- `metrics.trimmedVideoMs > 0`.
- `metrics.intentSatisfaction.level` ∈ {complete, partial, unmet, unknown}.
- `metrics.replanCount` is a finite number ≥ 0 (we LOG it; humans interpret).
- `directorReport.endReason` ∈ {done, budget, error}.
- NO assert on re-plan counts, step counts, durations, or timing.

**Judge gate (manual / eval):** after the regression run, run the §0030 `npm run judge` on each recording. Eyeball: did dead air drop vs the §0031 batch? Did `pacing` move from `fail` toward `partial`/`pass`? Not a hard assert.

**Acceptance criterion:** a Recordly run (`PROTOTYPE_URL=…/Recordly`, the "click 简中, slow scroll, 10s" scenario) where:
- the trimmed video has no static-frame stretch > ~1s that isn't a *planned* `dwell` step;
- the §0030 judge's `pacing` dimension is `pass` or `partial` (not `fail`);
- `replanCount ≤ 1` (the bet that recon is good enough — if this is routinely violated, the architecture isn't paying off and we revisit).

---

## What this preserves / removes

**Preserves:**
- Rendering primitives: §0010 init-script browser-side helpers, §0017 discovery click choreography, §0018 multi-stage scroll, the §0031 typing (pre-pause + keystroke delay) and scroll-tail — now driven by `Performance` step timing rather than fixed speed profiles, but the *code* is reused.
- Recording lifecycle (`beginRecording` / `stop` / `RecordingWindow`) + ffmpeg trim.
- `BlockerPrelude` — pre-recording blocker dismissal. Only the §0023 pre-fire-decision-1 coupling is removed.
- §0026 `ActionEvidence` — the playback's reality check consumes it.
- §0029 opening hold — folded into the first `Performance` step's timing (recon emits an opening `dwell` or a delayed first action).
- §0030 `IRecordingJudge` + `LlmVisionJudge` — becomes the post-hoc out-the-door gate.
- `intentSatisfaction` metric + §0033 1-to-1 bipartite matching — input changes to "executed Performance click steps", logic unchanged.
- `IPageSession` port (all of it — `resolveTarget`, `observeAll`, `clickSelector`, `scroll`, `type`, `pressKey`, `goBack`, `historyDepth`, evidence probes, `appendEntry`, etc.).
- `IDirector` port shape (`run(...) → DirectorReport`); the implementation swaps `StreamingDirector` → `PerformanceDirector`.

**Removes:**
- `IClickVerifier` + `LlmClickVerifier` (§0027) — recon verifies destinations upfront (lightly); divergence is caught by the re-plan checkpoint.
- The recording-loop `IFastDecider` + `LlmFastDecider` (§0019) — the recon adapter IS the re-planner; there is no per-action LLM call during the recording window. (The `IFastDecider` port file and `LlmFastDecider` adapter may be deleted, or `LlmFastDecider` repurposed/renamed if useful; the decider *prompts* in `src/prompts/decider.ts` are superseded by the recon prompts.)
- `config.directorClickRejectionLimit` (§0028) — no per-target retry concept; a click that doesn't achieve its `expectAfter` triggers a re-plan, full stop.
- The about:blank-recovery branch (§0032) in the Director — generalized: `back`'s `expectAfter` won't match `about:blank`, which triggers a re-plan that re-navigates. (`IPageSession.historyDepth()` stays — recon uses it to avoid planning a `back` from a depth-1 history in the first place.)
- The §0023 cold-start pre-fire (`RecordJobRunner.prefireFirstDecision`, the `preFireDecider` param) — no cold start to hide; the Performance is fully built before `beginRecording`.
- `DirectorBriefing` + `DirectorBriefing.draftSequence` (§0026) — superseded by `Performance`. (`src/domain/plan.ts` is rewritten or replaced by `src/domain/performance.ts`.)
- The per-action `decision` action-log entries from the streaming loop — replaced by zero-or-few `replan` entries.

**Net:** the codebase gets *simpler*. One reasoning component (recon, reused as re-planner). One recovery path (re-plan checkpoint). One product artifact (`Performance`). The "intelligence" is concentrated in the recon prompt + the richness of what recon observes — not scattered across a decider, a verifier, and N hand-coded Director branches.

---

## Open design risks (carried into implementation)

1. **Recon quality is the whole bet.** If recon's plans are frequently wrong → frequent re-plans → back to streaming-with-stalls. Mitigation: recon does a thorough `observeAll` pass; the regression run measures `replanCount`; the acceptance criterion includes `replanCount ≤ 1` on the canonical scenario. If the bet fails in practice, we revisit (possibly toward Direction C — collapsed-reasoning streaming).
2. **LLM-decided pacing might be worse than fixed defaults.** Mitigation: §0031/§0029 values are the defaults the recon picks from; it can override but doesn't have to. If recon's pacing is consistently off, lock it to defaults.
3. **`expectAfter` on JS-heavy sites is inherently fuzzy** (§0026 showed this). The recon prompt must carry the SPA-awareness rule (URL stable + content/title shift = success; don't set `urlContains` on SPA routes). Reused from the §0026 decider prompt.
4. **A re-plan checkpoint is itself a short stall** (~3-5s, page sitting). The bet is they're rare (`maxReplans = 3`, acceptance ≤ 1). Forward hook: cursor synth (sub-project 2) covers it; the playback director MAY render a small natural dwell during a re-plan.
5. **N=1-per-case judging is noisy.** When evaluating whether this helped, run the regression + judge 2-3× and compare modal verdicts, not a single batch (per the §0030 second-batch findings).

---

## Out of scope (deferred to sub-project 2 or later)

- Cursor synth + composer (`ICursorSynthesizer`, `IComposer`) — separate spec/plan cycle.
- Click-to-verify during recon (clicking each navigation target to confirm its destination, then `back()`). Possible future enrichment if re-plan frequency proves too high.
- A per-site reconnaissance cache (skip re-recon for the same URL across runs).
- HTTP API.
