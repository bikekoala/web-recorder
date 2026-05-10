# Streaming Director — Design Spec

**Status**: design approved, ready for implementation planning
**Date**: 2026-05-10
**Replaces**: parts of `docs/decisions.md` §0013 (plan-then-execute as the only model). Existing primitives (§0017 discovery click, §0018 multi-stage scroll, §0010 addInitScript helpers) are preserved verbatim.

## Problem statement

The current pipeline produces functionally correct recordings but **does not look human**. Specifically:

1. The recording starts on a static page state and the first action (often a click) executes immediately. From the viewer's perspective the page "teleports" to the next state with no apparent search, hesitation, or browsing.
2. The plan-then-execute architecture is a one-shot decision tree: one LLM call up front, deterministic playback after. This cannot adapt to:
   - Lazy-loaded targets (not in DOM at plan time)
   - Position-dependent decisions ("scroll a bit, see if I find it, scroll more")
   - Mid-recording surprises (cookie banners, content shifts, slow loads)
3. The plan format encodes pixel-level steps, which means choreography intent ("find and click X") is buried in a sequence of `scroll`/`click`/`wait` instructions. The system has no first-class concept of "exploring" or "searching".

The user's stated mental model is *"plan → operate → record" is a coupled cycle that may iterate*, with the system behaving like *"a prophet who already knows where things are but stages discovery so the journey looks natural"*.

## Goals

The redesign must satisfy all of:

1. **Looks human**: viewer cannot tell from the trimmed video that an LLM is in the loop. No teleports, no obvious thinking pauses, no robot-pace uniformity.
2. **Adapts at runtime**: handles lazy targets, content shifts, search-when-needed without a re-plan from scratch.
3. **Speed/fluidity preserved**: trimmed video duration matches user request within ±10%; recording window has 0 stalls longer than 500ms.
4. **Cheap**: <$0.01 per recording in LLM cost.
5. **Reuses tuned primitives**: §0017 discovery click, §0018 multi-stage scroll, smooth-scroll easings, opening hold, anticipation pauses — all kept and called by the new layer.

## Non-goals

- Cursor visualization (planned as a separate Tier-1 milestone, see `docs/naturalness-catalog.md` Group B).
- Text selection, typing, drag-and-drop (catalog Groups E, F — out of scope for V1).
- Hover state firing in CSS (requires Architecture A from §0001 — explicit deferral).
- MP4 output (still WebM via Playwright bundled ffmpeg).

## Architecture overview

Three layers replace the current "planner → fixed plan → executor" linear flow:

```
[1] IPlanner (slimmed)
    one LLM call, output a Briefing (intent summary + pre-resolved click hints)
                           ↓
[2] IDirector (NEW)
    owns the recording window
    runs a streaming inner loop driven by IFastDecider
                           ↓
[3] IFastDecider (NEW)              IPageSession (existing)
    Gemini Flash Lite                scroll / click (with internal
    < 1s per call                    search) / wait / screenshot
    structured action output
```

### Why this shape

- **Planner stays one-shot** because expensive multimodal reasoning ("understand the prompt, identify likely targets, pre-resolve their selectors") is best done before the recording window opens. We pay this cost in setup time, which is trimmed from the final video.
- **Director is the only component aware of the recording window**. It owns time budget, action sequencing, error recovery, and termination. RecordJobRunner becomes a thin orchestrator.
- **FastDecider is a separate port from Planner** because the model and prompt requirements differ:
  - Planner: high-quality multimodal, output structure that lasts the whole recording. Latency tolerance: ~3-5s.
  - FastDecider: small/cheap multimodal, output a 1-3 step lookahead. Latency tolerance: <1s. Gemini Flash Lite is the canonical choice; could swap to Groq-hosted models without changing the Director.

### How streaming hides LLM latency

A naive agent loop (one LLM call per action, sequential) costs roughly `actions × per_call_latency` of visible "thinking pause". For a 10s video with 5 actions and 600ms-per-call, that is 3 seconds — 30% of the recording dedicated to stalls.

The Streaming Director eliminates almost all visible stalls via a **double-queue with pre-fired calls**:

```
                      ┌─────────────────────────┐
   FastDecider call ──┤ pendingDecision Promise │
                      └─────────────────────────┘
                                 │ resolves
                                 ▼
                      ┌─────────────────────────┐
                      │  actionQueue (FIFO)     │
                      └─────────────────────────┘
                                 │ dequeue
                                 ▼
                      ┌─────────────────────────┐
                      │ executor runs animation │
                      └─────────────────────────┘
```

Time-flow of one iteration:

```
t=0       Director fires first FastDecider call
t=600ms   Decider returns [scroll(...), click(...)] → queue
t=600ms   Action 1 (scroll) starts executing (1500ms animation)
t=600ms   ALSO: Director fires next FastDecider call in parallel
t=2100ms  Animation 1 finishes
t=≈1800ms Decider's second call already returned (hidden under animation)
t=2100ms  Action 2 (click) starts immediately, no perceived stall
…
```

As long as `animation_duration > decider_latency` for the typical action, no LLM lag is ever visible. Empirically:

- Average click choreography: ~1.5-2.5s (scroll-to-position + anticipation + click)
- Average scroll: 1-2.2s
- Average dwell: 0.3-1s
- Gemini Flash Lite p50: ~600ms, p95: ~1.5s

Animations are mostly longer than LLM latency. Visible stalls happen only on consecutive short actions or LLM tail latency.

## Action vocabulary (the LLM's "keyboard")

The FastDecider chooses from exactly four primitives. Smaller vocabulary = faster decisions, fewer errors, easier prompt engineering. New primitives (`select_text`, `hover`, `type`) are deferred until a real use case demands them.

```typescript
type DirectorAction =
  | { kind: 'click';  target: string;     reasoning: string }
  | { kind: 'scroll'; deltaPx: number;    speed: 'slow' | 'normal' | 'fast'; reasoning: string }
  | { kind: 'dwell';  durationMs: number; reasoning: string }
  | { kind: 'done';                       reasoning: string };
```

### `click(target, reasoning)`

Natural-language target description. Executor renders this as a multi-stage operation:

1. **Locate**: try Playwright text/role match for the target description. Cheap (milliseconds, no LLM).
2. **Three branches**:
   - Target visible in current viewport → discovery click (§0017): scroll-to-35% + anticipation + click.
   - Target on page but off-screen → **internal search**: scroll forward by ~600px, re-locate, repeat. Budget = `min(1500px, remainingTimeMs / 3 ÷ avgPxPerSec)`.
   - Target not on page anywhere → return error to FastDecider in next decision context as `lastActionFailure: 'target not found'`.
3. **Click**: Playwright native click on resolved selector.

The internal search makes lazy-loaded targets first-class. Targets that materialize only after scrolling are found naturally without the LLM having to reason about it explicitly.

### `scroll(deltaPx, speed, reasoning)`

Bounded freeform scroll. Speed maps to a px-per-second target plus easing curve:

| `speed` | px/s | easing | use case |
|---|---|---|---|
| `slow`   | 250 | outQuart | reading content carefully |
| `normal` | 450 | outQuart | browsing/scanning |
| `fast`   | 800 | outExpo  | flinging to a known position |

`deltaPx` constrained to `[-1500, -100] ∪ [100, 1500]` to prevent jitter (sub-100px) and disorienting jumps (>1500px). Out-of-range requests are rejected and fed back to the LLM. `durationMs` is computed by the executor as `|deltaPx| / speed × 1000`, clamped per band to ranges that already work in §0018.

### `dwell(durationMs, reasoning)`

Pause. Range `[200, 3000]` ms. When cursor visualization arrives (Tier-1 milestone), dwells with `durationMs > 800` may add micro-drift to avoid a "frozen" look.

### `done(reasoning)`

Signals the Director that the recording's intent has been satisfied. Director enters cleanup. If the time budget has not yet been used, the trim point is at this `done` call; the remaining time is not recorded.

## Briefing schema (Planner output → Director input)

```typescript
type DirectorBriefing = {
  prompt: string;            // user's natural-language request, verbatim
  durationMs: number;        // target recording duration
  hints: ClickHint[];        // pre-resolved likely click targets
  rationale: string;         // planner's brief description of intent (debug only)
};

type ClickHint = {
  description: string;       // "the 简体中文 link"
  selector: string;          // resolved at planner time
  bboxAtRest: Bbox;          // bbox when page is at scrollY=0
};
```

The Planner's job is now lighter:
1. Take a screenshot of the loaded page.
2. Issue one LLM call asking: "what targets in this prompt are likely click candidates?"
3. For each named target, attempt `session.resolveTarget()` to pre-resolve the selector.
4. Output the briefing.

This removes `TimelinePlan`, `adjustPlanDuration`, and `recomputeClickDurations` from the runner — the Director handles those concerns dynamically.

## Director state (input to FastDecider)

Each FastDecider call receives a compact state snapshot:

```typescript
type DirectorState = {
  prompt: string;
  remainingMs: number;             // recording window time left
  currentScrollY: number;
  viewport: Viewport;
  screenshot: Buffer;              // 768×432 (downscaled from 1280×720)
  visibleHints: string[];          // which briefing hints are currently in viewport
  recentActions: ActionSummary[];  // last 3 actions for context
  lastActionFailure?: string;      // populated when previous action errored
};

type ActionSummary = {
  kind: DirectorAction['kind'];
  brief: string;                   // human-readable, ≤80 chars
  succeeded: boolean;
};
```

The screenshot is intentionally downscaled to ~330KB per frame, keeping the input under 5K tokens for Gemini Flash Lite. Visible hints are a cheap pre-computed list (`bboxAtRest.y - currentScrollY ∈ [0, viewport.height]`) — the LLM does not need to figure out from the image alone.

## FastDecider response

```typescript
type DecisionResponse = {
  actions: DirectorAction[];       // 1-3 actions for lookahead
  expectAfter?: {                  // optional; lets Director cheaply verify
    urlContains?: string;
    visibleText?: string[];
  };
};
```

The `expectAfter` field lets the Director catch cases where reality diverges from the LLM's mental model. The check is **strictly text-based**: compare current URL fragment + visible page text against expectations. No vision diff (too slow). On mismatch, the Director clears the action queue and fires a fresh FastDecider call with `lastActionFailure: 'expectAfter mismatch'`.

This is the only mechanism that interrupts streaming. It triggers <10% of the time on well-behaved pages. The cost is one extra LLM call when it fires, paid for by reduced wasted execution on stale plans.

## Streaming coordination

```
director.run(briefing, session):
  pending = fastDecider.decide(initialState())  # first call: cold
  expectAfter = null
  actionQueue = []

  while running:
    # Top up the queue if empty — block on pending call.
    # Most iterations skip this: queue is non-empty from prior pre-fire.
    if actionQueue.empty:
      decision = await pending
      actionQueue.push(...decision.actions)  # 1-2 actions of lookahead
      expectAfter = decision.expectAfter
      pending = null

    action = actionQueue.shift()

    # Pre-fire BEFORE awaiting animation. Crucially, the result of `pending`
    # REPLACES the queue if it differs from current — keeps decisions fresh
    # while still buffering against LLM tail latency.
    if pending is null:
      pending = fastDecider.decide(observe())

    startAnimation(action)            # non-blocking; animation runs to completion
    await animation.complete()        # most of the time, `pending` resolves here

    # Drain pending if it resolved during animation.
    if pending.resolved:
      decision = pending.value
      actionQueue = decision.actions  # REPLACE queued actions with fresh plan
      expectAfter = decision.expectAfter
      pending = null

    # Cheap text-based check: did reality match LLM's prediction?
    if expectAfter and not validateNow(expectAfter):
      actionQueue.clear()
      pending = fastDecider.decide(observe(), withFailure='expectAfter mismatch')
      expectAfter = null
      continue

    if action.kind == 'done' or remainingMs <= 0:
      break

  cancel(pending)  # if still running, drop result
```

### When LLM is slower than animation

If `actionQueue.empty AND pending.notResolved`, the Director enters an **implicit dwell**:

- Insert a `dwell(200ms)` action (animated, looks like natural rhythm)
- Re-check after 200ms; if still pending, dwell again
- Hard cap: 4 consecutive implicit dwells → log warning and continue when call resolves

Single implicit dwells are indistinguishable from intentional pauses. Multiple in a row are a smell that surfaces in metrics.

### Decision frequency

One FastDecider call per executed action. The pseudocode pre-fires during animation and the result replaces the queue when it lands. This is simpler than rules-based gating and more robust to LLM tail latency: fewer calls means less buffer when the LLM is slow.

- Lookahead = 1-2 actions per call (small enough to stay fresh)
- ~5-8 calls per 10-second recording (one per action)
- Direct cost: 5-8 × ~$0.0004 (Gemini Flash Lite) ≈ **$0.002-$0.004 per recording**
- The `expectAfter` mismatch path adds 1-2 extra calls when it fires; rare on stable pages

## Component map

```
src/
  domain/
    director-action.ts   (NEW)    DirectorAction Zod schema, action validators
    director-state.ts    (NEW)    DirectorState type for FastDecider input
    plan.ts              (MODIFY) DirectorBriefing replaces TimelinePlan
  ports/
    director.ts          (NEW)    IDirector { run(briefing, session): DirectorReport }
    fast-decider.ts      (NEW)    IFastDecider { decide(state): DecisionResponse }
    page-session.ts      (MODIFY) add quickFindInViewport(text) for fast search
  adapters/
    director/
      streaming-director.ts (NEW) StreamingDirector — double-queue + expectAfter
    decider/
      llm-fast-decider.ts   (NEW) Gemini Flash Lite via OpenRouter
    agent/
      stagehand-session.ts  (MODIFY) clickSelector grows internal search loop
    planner/
      llm-planner.ts        (MODIFY) outputs DirectorBriefing
  core/
    record-job-runner.ts    (MODIFY) plan→director replaces plan→execute
```

### Code preserved verbatim

| Component | Preserved | Reason |
|---|---|---|
| `IPageSession.scroll/click/wait/screenshot` | yes | the executor primitives the Director calls |
| `clickSelector` choreography (approach + anticipation + click) | yes | reused inside `click` — the Director just decides "click X", not "how to click" |
| Multi-stage scroll for far targets (§0018) | yes | reused for `click` internal search and `scroll(deltaPx, speed)` |
| Easing curves (`inOutQuad/outQuart/outExpo/linear`) | yes | reused via speed→easing mapping |
| `addInitScript` runtime helpers (smoothScrollTo, waitVisuallyStable) | yes | unchanged |
| `RUNTIME_HELPERS_SCRIPT` browser-side bridge | yes | unchanged |
| `recordingWindow` markers + ffmpeg trim | yes | the Director calls `beginRecording()` at exactly the same point |
| `BROWSER_CHANNEL` env, `OPENROUTER_API_KEY` env, dotenv config | yes | configuration surface unchanged |

### Code retired

| Component | Action |
|---|---|
| `TimelinePlan` Zod schema | delete after migration |
| `adjustPlanDuration` | delete (Director self-regulates time budget) |
| `recomputeClickDurations` | delete (no fixed plan to align) |
| `LlmPlanner.plan()` returning `TimelinePlan` | replace with `brief()` returning `DirectorBriefing` |
| `RecordJobRunner` step-execution loop | replace with `director.run(briefing, session)` |

## Error handling

| Failure mode | Director response |
|---|---|
| FastDecider call >2s | implicit dwell loop, log if >4s |
| FastDecider returns invalid JSON or schema mismatch | retry once, then degrade to `dwell(800) + done` |
| `click` internal search exhausts budget | error fed back via `lastActionFailure`, LLM re-strategizes |
| `expectAfter` mismatch | clear queue, fresh decision with mismatch context |
| Recording window time elapsed but LLM not yet `done` | watchdog injects `done`, Director exits gracefully |
| Browser context dies mid-recording | `session.stop()` in finally, surface partial artifacts |
| Decider model unreachable (network) | retry with exponential backoff up to 2s, else fail the job |

All `DirectorAction` validation happens in domain layer (Zod). Adapter never accepts an action that hasn't passed schema validation.

## Configuration

New env vars (added to `src/infra/config.ts`):

- `LLM_DECIDER_MODEL` — default `google/gemini-2.5-flash-lite`. Identifies the FastDecider model.
- `DIRECTOR_LOOKAHEAD_MAX` — default `3`. Cap on actions per FastDecider call.
- `DIRECTOR_DWELL_FALLBACK_MS` — default `200`. Implicit-dwell duration.
- `DIRECTOR_HARD_BUDGET_MULT` — default `1.2`. Recording window hard cap as multiple of `durationMs`.

Existing env vars (`LLM_MODEL`, `OPENROUTER_API_KEY`, `BROWSER_CHANNEL`, etc.) are unchanged. `LLM_MODEL` continues to drive the Planner; the Decider has its own.

## Testing strategy

### Unit tests (deterministic, fast)

- `director-action.test.ts` — Zod schema accepts valid actions, rejects:
  - `scroll` with `deltaPx` out of `[-1500, -100] ∪ [100, 1500]`
  - `dwell` with `durationMs` out of `[200, 3000]`
  - missing `kind`, missing `reasoning`, unknown discriminant
- `streaming-director.test.ts` — uses mock `IFastDecider` and mock `IPageSession`:
  - LLM slower than animation → implicit dwell inserted
  - 4 consecutive implicit dwells → warning emitted
  - `expectAfter` mismatch → action queue cleared, re-decide invoked
  - Time budget exhaustion → forced `done`, exits cleanly
  - LLM returns invalid action → retry once, then degrade
  - LLM returns 0 actions → forced `done`

### Integration tests (real browser, optional LLM)

- `prototype-director.test.ts` — runs the existing Recordly scenario with the new Director. Asserts:
  - trimmed-video duration within ±10% of `durationMs`
  - 0 stalls > 500ms in the recording window
  - all `click` hints from the briefing successfully resolved
  - 0 `expectAfter` mismatches on a clean run

### Smoke (manual)

- A "no LLM" smoke that bypasses FastDecider with a hand-rolled action stream, validating the executor primitives still work end-to-end. Already exists as `npm run smoke:recording` — adapt to call the Director with a stub IFastDecider.

## Naturalness catalog impact

This redesign flips status on multiple rows in `docs/naturalness-catalog.md`:

- **A5** (reading-pace exploration scrolls) → ✅ Director chooses `scroll(speed='slow')` for content browsing
- **A10** (variable scroll length within phase) → ✅ Director chooses different `deltaPx` per call
- **C4** (opening hold) → ✅ Director's first action can be `dwell` if Planner hints suggest it
- **C5** (reading pauses after navigation) → ✅ Director observes new page, naturally inserts dwell
- **C6** (inter-action variability) → ✅ Each FastDecider call has temperature, no two runs identical
- **C7** (decision pauses for ambiguous targets) → ✅ falls out of FastDecider's `dwell` choices

Tier-1 cursor work (B1-B3) and `H` post-process polish remain out of scope.

## Migration plan summary

1. Add new domain types and ports (no behavior change yet).
2. Implement `LlmFastDecider` adapter (testable in isolation against fixtures).
3. Implement `StreamingDirector` adapter (testable with mock decider/session).
4. Modify `LlmPlanner` to output `DirectorBriefing` instead of `TimelinePlan`.
5. Modify `RecordJobRunner` to invoke the Director.
6. Delete retired components.
7. Run integration test on Recordly scenario; tune until ±10% duration met.

The detailed implementation plan is the next deliverable (writing-plans skill).

## Risks and open items

- **Risk**: Gemini Flash Lite quality on Chinese-language prompts. Mitigation: prompt the FastDecider in English with Chinese targets passed through verbatim. The action's `target` field is just a string handed back to executor for matching.
- **Risk**: lookahead actions become stale faster than expected on highly dynamic pages. Mitigation: `expectAfter` mismatch handling already covers it; if it fires too often, drop lookahead from 3 to 2 and re-measure.
- **Open**: how the cursor synth (Tier-1 next milestone) consumes the new action log. The action log schema doesn't change, so existing entries (`scroll`, `click`, `wait`, `visual_stable`, `recording_start`) are still produced by the Director-orchestrated executor. Synth integration is independent.

## Decisions referenced

- §0001 Architecture B (post-process cursor overlay) — preserved
- §0006 Stagehand v3 + Playwright recordVideo via cdpUrl — preserved
- §0010 addInitScript pattern — preserved
- §0013 Plan-then-Execute (one LLM before, zero during) — **partially superseded**: the Director adds streaming LLM calls during the recording window, but their latency is hidden under animation, preserving the spirit of the original constraint
- §0017 Discovery click choreography — preserved as the executor of `click`
- §0018 Multi-stage long-distance scroll — preserved as the executor of `scroll`

A new ADR §0019 documenting the streaming Director will be added at implementation time.
