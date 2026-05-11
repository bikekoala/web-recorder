# "Prophet" Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the streaming LLM-in-the-loop recording architecture with a "prophet" architecture — a reconnaissance phase (before the recording window) builds a complete, pre-resolved, paced `Performance`; the recording window plays it back deterministically with one re-plan checkpoint as the sole recovery path.

**Architecture:** `RecordJobRunner` → `IReconnoiterer.recon()` (off-camera: observe page, resolve every target, decide per-step pacing, set `expectAfter`) → `Performance` → `PerformanceDirector.run()` (on-camera: render each step with its planned timing; if a step's `expectAfter` doesn't match reality, call the reconnoiterer again to re-plan the remaining steps). No per-action LLM calls, no click verifier, no implicit dwells during the recording. This collapses §0019/§0023/§0026-draftSequence/§0027/§0028/§0032 into one reasoning component, one recovery path, one product artifact.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Zod schemas at every boundary, Playwright + Stagehand for the browser, OpenRouter for LLM, ffmpeg (Playwright-bundled) for video trim, vitest for tests, pino for logs. Hexagonal: business logic in `src/core/`, ports in `src/ports/`, adapters in `src/adapters/`, schemas in `src/domain/`, config in `src/infra/config.ts`.

**Spec:** `docs/superpowers/specs/2026-05-11-prophet-recording-design.md` — read it before starting.

---

## File Structure

**New files:**
- `src/domain/performance.ts` — `Performance`, `PerformanceStep`, `ResolvedTarget` Zod schemas + inferred types. The primary planner output. Replaces `src/domain/plan.ts` (`DirectorBriefing`).
- `src/ports/reconnoiterer.ts` — `IReconnoiterer` port + `ReconInput`.
- `src/prompts/reconnoiterer.ts` — `reconnoitererSystemPrompt` + `buildReconUserText(input, observedElements)`.
- `src/adapters/recon/llm-reconnoiterer.ts` — `LlmReconnoiterer implements IReconnoiterer`; OpenRouter vision call → `Performance`; resolves targets via `session.resolveTarget`; `ReconError extends DomainError`.
- `src/adapters/director/performance-director.ts` — `PerformanceDirector implements IDirector`; deterministic playback + re-plan checkpoint.
- `tests/unit/domain/performance.test.ts` — schema round-trip / rejection tests.
- `tests/unit/adapters/recon/llm-reconnoiterer.test.ts` — adapter behaviour with a mocked LLM client.
- `tests/unit/adapters/director/performance-director.test.ts` — playback + re-plan unit tests (replaces `streaming-director.test.ts`).
- `tests/fakes/fake-reconnoiterer.ts` — programmable `IReconnoiterer` for tests.

**Modified files:**
- `src/infra/config.ts` — add `llmReconModel` (env `LLM_RECON_MODEL`, default `config.llmPlannerModelResolved`) and `maxReplans` (env `MAX_REPLANS`, default 3). Remove `directorClickRejectionLimit` (§0028). Remove `directorLookaheadMax`, `directorDwellFallbackMs` (streaming-only).
- `src/domain/action-log.ts` — add a `replan` entry type to the union; remove `about_blank_recovered` from `decision_failure` reasons (the re-plan subsumes it) — actually KEEP `decision_failure` for the re-plan's own failure modes, just add `replan` as a new type.
- `src/ports/director.ts` — `IDirector.run` signature changes from `(briefing: DirectorBriefing, ...)` to `(performance: Performance, ...)`. Remove `DirectorRunOpts.prefiredDecision` / `PrefiredDecision` (§0023). `DirectorReport` gains `replanCount: number`; remove `implicitDwellCount`, `expectAfterMismatchCount` (streaming-only) — actually rename `expectAfterMismatchCount` → keep it useful: it equals `replanCount` now; just drop `implicitDwellCount`.
- `src/core/record-job-runner.ts` — swap `IPlanner.brief()` → `IReconnoiterer.recon()`; swap the director call; drop `preFireDecider` param + `prefireFirstDecision` method; `RunResult` gains `performance`; `RunMetrics` gains `replanCount`; `computeIntentSatisfaction` input changes to executed-click-step descriptions.
- `src/prompts/index.ts` — export the recon prompts; remove the decider + click-verifier exports.
- `scripts/prototype-stagehand.ts` — construct `LlmReconnoiterer` + `PerformanceDirector` instead of `LlmPlanner` + `StreamingDirector` + verifier + pre-fire.
- `tests/regression/regression.test.ts` — same construction swap; update categorical asserts.
- `tests/fakes/fake-page-session.ts` — no change needed (it already implements the full `IPageSession`).
- `CLAUDE.md`, `docs/decisions.md`, `docs/architecture.md`, `docs/glossary.md` — state table + ADR §0034 + architecture notes + new term `Performance`.

**Deleted files:**
- `src/domain/plan.ts` (`DirectorBriefing`, `ClickHint`, `draftSequence`).
- `src/ports/fast-decider.ts` + `src/adapters/decider/llm-fast-decider.ts` (`IFastDecider` / `LlmFastDecider` — the recon adapter is the re-planner).
- `src/ports/click-verifier.ts` + `src/adapters/decider/llm-click-verifier.ts` + `src/prompts/click-verifier.ts` (§0027).
- `src/prompts/decider.ts` (superseded by recon prompts).
- `src/prompts/planner.ts` (superseded by recon prompts) — IF `LlmPlanner` is fully removed; otherwise keep. Decision: REMOVE — recon replaces it.
- `src/ports/planner.ts` + `src/adapters/planner/llm-planner.ts`.
- `src/adapters/director/streaming-director.ts`.
- `src/infra/pending.ts` — IF nothing else uses `track`/`Pending` after pre-fire is gone. Check usages first; the re-plan checkpoint awaits synchronously, so likely deletable. Decision: check in Task 8; delete if unused.
- `tests/unit/adapters/director/streaming-director.test.ts`, `tests/unit/adapters/decider/*` (verifier + fast-decider tests), `tests/unit/adapters/planner/*` (if any), `tests/fakes/fake-fast-decider.ts`.

---

## Task 0: Config knobs for recon + re-plan cap

**Files:**
- Modify: `src/infra/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the new config fields to the Zod schema in `src/infra/config.ts`**

In the `Schema = z.object({ ... })` block, after `llmDeciderModel`, add:

```ts
  /**
   * Reconnaissance model — used once per recording (and again per re-plan)
   * to build the Performance. Needs strong vision + planning. Defaults to
   * the resolved planner model. Override with LLM_RECON_MODEL.
   */
  llmReconModel: z.string().min(1).optional(),

  /**
   * Per-recording cap on re-plan checkpoints. After this many, the
   * PerformanceDirector stops re-planning and plays out remaining steps
   * as-is (reality checks become advisory). Test/eval infra, not a
   * behaviour threshold (goals.md #6 carve-out). Override with MAX_REPLANS.
   */
  maxReplans: z.number().int().min(0).max(10).default(3),
```

Remove `directorClickRejectionLimit`, `directorLookaheadMax`, `directorDwellFallbackMs` from the schema and from the `raw` object (they were streaming-only). Keep `directorHardBudgetMult`.

In the `raw` object, after `llmDeciderModel: process.env.LLM_DECIDER_MODEL,` add:

```ts
  llmReconModel: process.env.LLM_RECON_MODEL,
  maxReplans: process.env.MAX_REPLANS ? Number(process.env.MAX_REPLANS) : undefined,
```

Remove the corresponding `directorClickRejectionLimit` / `directorLookaheadMax` / `directorDwellFallbackMs` lines from `raw`.

In the exported `config` object, after `llmPlannerModelResolved: data.llmPlannerModel ?? data.llmModel,` add:

```ts
  llmReconModelResolved: data.llmReconModel ?? data.llmPlannerModel ?? data.llmModel,
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. (If anything still references the removed config fields, it'll fail — that's fine, those references get cleaned in later tasks. If it fails here, temporarily leave the removed fields in place and remove them in Task 8 instead — note which approach you took.)

> **Note for the implementer:** Removing `directorClickRejectionLimit` etc. WILL break `streaming-director.ts` which still imports them. To keep every commit green, do ONE of: (a) leave the removed fields in `config.ts` for now and delete them in Task 8 alongside the streaming director; or (b) do this task last. Recommended: option (a) — add the new fields now, leave the old ones, delete the old ones in Task 8. Adjust the steps above accordingly: add `llmReconModel` / `maxReplans` / `llmReconModelResolved` now; leave `directorClickRejectionLimit` / `directorLookaheadMax` / `directorDwellFallbackMs` until Task 8.

- [ ] **Step 3: Update `.env.example`** — add under the existing Director section:

```bash
# Reconnaissance / re-plan (§0034 prophet recording)
# LLM_RECON_MODEL=anthropic/claude-sonnet-4.6
# MAX_REPLANS=3
```

- [ ] **Step 4: Commit**

```bash
git add src/infra/config.ts .env.example
git commit -m "config: add llmReconModel + maxReplans for prophet recording (§0034)"
```

---

## Task 1: `Performance` domain type

**Files:**
- Create: `src/domain/performance.ts`
- Test: `tests/unit/domain/performance.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/unit/domain/performance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PerformanceSchema, PerformanceStepSchema } from '../../../src/domain/performance.js';

const validClickStep = {
  kind: 'click' as const,
  target: { selector: 'text=Sign in', bbox: { x: 10, y: 20, width: 80, height: 30 }, description: 'the sign-in link' },
  anticipationMs: 600,
  reasoning: 'user asked to sign in',
  expectAfter: { urlContains: '/login' },
};
const validScrollStep = {
  kind: 'scroll' as const, deltaPx: 600, durationMs: 1800, easing: 'inOutQuad' as const,
  dwellAfterMs: 200, reasoning: 'browse the README',
};
const validDwellStep = { kind: 'dwell' as const, durationMs: 2400, reasoning: 'reading the intro' };
const validDoneStep = { kind: 'done' as const, reasoning: 'all verbs satisfied' };

const validPerformance = {
  prompt: 'sign in then read the page',
  durationMs: 10000,
  steps: [validClickStep, validDwellStep, validScrollStep, validDoneStep],
  totalEstimatedMs: 9800,
  rationale: 'sign-in is below the fold; after it lands, browse',
};

describe('Performance schema', () => {
  it('accepts a well-formed Performance', () => {
    expect(PerformanceSchema.parse(validPerformance)).toMatchObject({ steps: expect.any(Array) });
  });
  it('accepts each step kind', () => {
    for (const s of [validClickStep, validScrollStep, validDwellStep, validDoneStep]) {
      expect(PerformanceStepSchema.parse(s)).toBeTruthy();
    }
  });
  it('rejects a click step with no target', () => {
    const bad = { kind: 'click', anticipationMs: 600, reasoning: 'x' };
    expect(() => PerformanceStepSchema.parse(bad)).toThrow();
  });
  it('rejects a scroll step with a bad easing', () => {
    const bad = { ...validScrollStep, easing: 'bouncy' };
    expect(() => PerformanceStepSchema.parse(bad)).toThrow();
  });
  it('rejects negative durations', () => {
    expect(() => PerformanceStepSchema.parse({ ...validDwellStep, durationMs: -1 })).toThrow();
  });
  it('rejects a Performance with an empty steps array', () => {
    expect(() => PerformanceSchema.parse({ ...validPerformance, steps: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- performance`
Expected: FAIL — `Cannot find module '../../../src/domain/performance.js'`.

- [ ] **Step 3: Create `src/domain/performance.ts`:**

```ts
import { z } from 'zod';

import { Bbox } from './action-log.js';

/**
 * The product of the reconnaissance phase: a complete, pre-resolved, paced
 * action sequence the PerformanceDirector plays back deterministically.
 * Replaces DirectorBriefing — see ADR §0034.
 *
 * Schema-first (CLAUDE.md hard rule #2): the recon LLM emits JSON matching
 * this exactly; LlmReconnoiterer parses + validates and throws ReconError
 * on mismatch.
 */

/** Scroll velocity profiles — same set the IPageSession.scroll() port uses. */
export const ScrollEasingSchema = z.enum(['inOutQuad', 'outQuart', 'outExpo', 'linear']);
export type ScrollEasing = z.infer<typeof ScrollEasingSchema>;

/** Named keys the `key` step may press. */
export const PerformanceKeySchema = z.enum([
  'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace',
]);
export type PerformanceKey = z.infer<typeof PerformanceKeySchema>;

/** What the playback director checks after a navigation-causing step. */
export const ExpectAfterSchema = z.object({
  urlContains: z.string().min(1).optional(),
  visibleText: z.array(z.string().min(1)).max(3).optional(),
});
export type ExpectAfter = z.infer<typeof ExpectAfterSchema>;

/** A click/type target the recon phase has already resolved to a selector + bbox. */
export const ResolvedTargetSchema = z.object({
  selector: z.string().min(1),
  bbox: Bbox,
  description: z.string().min(1),
});
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

export const PerformanceStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    target: ResolvedTargetSchema,
    anticipationMs: z.number().int().min(0).max(3000),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('scroll'),
    deltaPx: z.number().int().refine((n) => Math.abs(n) >= 50 && Math.abs(n) <= 4000, 'deltaPx magnitude must be 50..4000'),
    durationMs: z.number().int().min(200).max(4000),
    easing: ScrollEasingSchema,
    dwellAfterMs: z.number().int().min(0).max(2000),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('type'),
    target: ResolvedTargetSchema,
    text: z.string().min(1),
    preMs: z.number().int().min(0).max(2000),
    keystrokeMs: z.number().int().min(0).max(500),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('key'),
    key: PerformanceKeySchema,
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('dwell'),
    durationMs: z.number().int().min(100).max(8000),
    reasoning: z.string().min(1),
  }),
  z.object({
    kind: z.literal('back'),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('done'),
    reasoning: z.string().min(1),
  }),
]);
export type PerformanceStep = z.infer<typeof PerformanceStepSchema>;

export const PerformanceSchema = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  steps: z.array(PerformanceStepSchema).min(1),
  totalEstimatedMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
});
export type Performance = z.infer<typeof PerformanceSchema>;
```

> **Implementer note:** `Bbox` is exported from `src/domain/action-log.ts` as a Zod schema. If `discriminatedUnion` complains about `expectAfter` being optional on some members and absent on others, that's fine — discriminated unions allow members with different shapes; the discriminator is `kind`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -- performance`
Expected: PASS (6 tests).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (nothing imports `performance.ts` yet).

- [ ] **Step 6: Commit**

```bash
git add src/domain/performance.ts tests/unit/domain/performance.test.ts
git commit -m "feat(domain): Performance type — pre-resolved paced action sequence (§0034)"
```

---

## Task 2: `replan` action-log entry type

**Files:**
- Modify: `src/domain/action-log.ts`
- Test: extend `tests/unit/domain/action-log.test.ts` (if it exists) OR add a small new test file `tests/unit/domain/action-log-replan.test.ts`

- [ ] **Step 1: Write the failing test** — add to `tests/unit/domain/action-log.test.ts` (create the file if absent):

```ts
import { describe, expect, it } from 'vitest';
import { ActionLogEntrySchema } from '../../../src/domain/action-log.js';

describe('action-log replan entry (§0034)', () => {
  it('accepts a replan entry', () => {
    const entry = {
      t: 4200, type: 'replan' as const, fromStepIndex: 3,
      reason: 'expect_after_mismatch', details: 'expected urlContains "/build" but URL was ".../Recordly"',
      scrollY: 1500, viewport: { width: 1280, height: 720 },
    };
    expect(ActionLogEntrySchema.parse(entry)).toMatchObject({ type: 'replan' });
  });
  it('rejects a replan entry missing fromStepIndex', () => {
    const bad = { t: 1, type: 'replan', reason: 'x', details: 'y', scrollY: 0, viewport: { width: 1, height: 1 } };
    expect(() => ActionLogEntrySchema.parse(bad)).toThrow();
  });
});
```

> Check the actual exported name — it may be `ActionLogEntry` (the Zod union) under a different identifier. Use whatever `src/domain/action-log.ts` exports as the entry-union schema; if it only exports `ActionLog` (the whole-log schema), add `export const ActionLogEntrySchema = z.discriminatedUnion(...)` extraction or test via the whole-log schema with an `entries: [entry]` wrapper.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- action-log`
Expected: FAIL — `replan` not in the union.

- [ ] **Step 3: Add the `replan` member to the entry union in `src/domain/action-log.ts`** — next to the `decision_failure` member:

```ts
  /**
   * `replan` — the PerformanceDirector hit a step whose `expectAfter` did
   * not match reality and called the reconnoiterer to re-plan the remaining
   * steps. `fromStepIndex` is the index (in the working step list) of the
   * step that diverged. See ADR §0034.
   */
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('replan'),
    fromStepIndex: z.number().int().nonnegative(),
    reason: z.enum(['expect_after_mismatch', 'about_blank', 'target_vanished']),
    details: z.string(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
```

(Leave the existing `decision` / `decision_failure` members in place — the re-plan path may still emit `decision_failure` for the re-plan call's own LLM errors. Do NOT remove `about_blank_recovered` from the `decision_failure` reasons in this task; that cleanup is part of Task 8 when the streaming director is removed.)

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -- action-log`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/action-log.ts tests/unit/domain/action-log*.test.ts
git commit -m "feat(domain): replan action-log entry type (§0034)"
```

---

## Task 3: `IReconnoiterer` port + recon prompts

**Files:**
- Create: `src/ports/reconnoiterer.ts`
- Create: `src/prompts/reconnoiterer.ts`
- Modify: `src/prompts/index.ts` (add the new export; leave the old exports for now)

- [ ] **Step 1: Create `src/ports/reconnoiterer.ts`:**

```ts
import type { Viewport } from '../domain/action-log.js';
import type { Performance, PerformanceStep } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

/**
 * IReconnoiterer — the reasoning component of the prophet architecture.
 * Runs OFF-CAMERA (before the recording window, and again on each re-plan
 * checkpoint). Observes the page, resolves every target, decides per-step
 * pacing, sets expectAfter, and returns a complete Performance.
 *
 * Used in two places:
 *   - RecordJobRunner, once per job, before beginRecording().
 *   - PerformanceDirector, on a re-plan checkpoint — same instance, reused.
 *
 * Best-effort contract: throw on LLM/network failure or a Performance that
 * fails Zod validation. The runner surfaces a recon failure (no recording);
 * the PerformanceDirector treats a re-plan failure as "stop gracefully".
 */
export interface IReconnoiterer {
  recon(input: ReconInput, session: IPageSession): Promise<Performance>;
  /** Stable identifier for the underlying model — surfaced in logs. */
  readonly modelId: string;
}

export interface ReconInput {
  /** Current URL — the original URL on the first recon; wherever the page is on a re-plan. */
  url: string;
  /** The user's ORIGINAL natural-language intent — unchanged across re-plans. */
  prompt: string;
  /** On the first recon: the full recording budget. On a re-plan: the REMAINING budget. */
  durationMs: number;
  /** Browser viewport size. */
  viewport: Viewport;
  /** PNG screenshot of the current page, or null if it couldn't be taken. */
  screenshot: Buffer | null;
  /**
   * Re-plan context only: the (kind, reasoning) of each step already
   * executed this recording, in order — so the LLM plans the REST without
   * redoing what's done. Undefined / empty on the first recon.
   */
  priorSteps?: Array<{ kind: PerformanceStep['kind']; reasoning: string }>;
}
```

- [ ] **Step 2: Create `src/prompts/reconnoiterer.ts`** — the recon system prompt + user-text builder. Carry over the JSON-safety rules and SPA-awareness rules from the old `planner.ts` / `decider.ts`. (Read those two files before writing this — reuse their wording for the CJK-quote-escaping rules and the SPA `expectAfter` rule verbatim where applicable.)

```ts
import type { ReconInput } from '../ports/reconnoiterer.js';
import type { ObservedElement } from '../ports/page-session.js';

/**
 * Reconnoiterer prompts — used by LlmReconnoiterer.recon().
 *
 * Runs ONCE per job (and again per re-plan). Latency budget is generous
 * (it's off-camera). The LLM gets: the page screenshot, the observed
 * interactive elements, the user's intent, the duration budget, and (on a
 * re-plan) the reasoning of what's already been done. It returns a complete
 * Performance — every action with a pre-resolved target description, a
 * planned pace, and an expectAfter where the destination is predictable.
 */

export const reconnoitererSystemPrompt = `You are a RECONNAISSANCE PLANNER for browser-recording videos. You see a page, the user's goal, and a time budget. You output a complete PERFORMANCE: an ordered list of micro-actions the recorder will play back EXACTLY as written — there is NO further LLM in the loop during recording. Plan as if you were a prophet: you already know what will happen, so the recording is smooth and purposeful.

OUTPUT — strict JSON, single object, exactly this shape:
{
  "prompt": "<echo the user's intent>",
  "durationMs": <the budget you were given>,
  "steps": [ <PerformanceStep>, ... ],
  "totalEstimatedMs": <sum of your steps' durations — make it close to durationMs>,
  "rationale": "<1-3 sentences: why this plan>"
}

Each PerformanceStep is exactly one of:
  { "kind": "click",  "target": {"description": "<plain English of the element>"}, "anticipationMs": <0..3000>, "reasoning": "<short>", "expectAfter"?: {"urlContains"?: "...", "visibleText"?: ["..."]} }
  { "kind": "scroll", "deltaPx": <int, |value| 50..4000, positive = down>, "durationMs": <200..4000>, "easing": "inOutQuad"|"outQuart"|"outExpo"|"linear", "dwellAfterMs": <0..2000>, "reasoning": "<short>" }
  { "kind": "type",   "target": {"description": "<the input field>"}, "text": "<text to type>", "preMs": <0..2000>, "keystrokeMs": <0..500>, "reasoning": "<short>" }
  { "kind": "key",    "key": "Enter"|"Escape"|"Tab"|"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Backspace", "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "dwell",  "durationMs": <100..8000>, "reasoning": "<short, e.g. 'reading the README intro'>" }
  { "kind": "back",   "reasoning": "<short>", "expectAfter"?: {...} }
  { "kind": "done",   "reasoning": "<short>" }

NOTE: you give targets as {"description": "..."} only — a separate resolution step turns each description into a real selector. Make descriptions specific enough to resolve ("the simplified Chinese language link in the footer", not just "the link").

JSON SAFETY RULES — read carefully:
1. Output must be valid RFC 8259 JSON parseable by JSON.parse.
2. Use ONLY ASCII double-quote characters (") to delimit JSON strings.
3. NEVER place a double-quote character INSIDE a string value. If the user's prompt contains a quoted phrase using ASCII " " or CJK guillemets/brackets, DO NOT preserve those quotes — paraphrase into plain unquoted English in your descriptions and reasoning.
4. No markdown, no code fences, no commentary outside the JSON object.

PACING — you decide how human this looks:
- "anticipationMs" on a click: 500-800ms for a normal click (the recorder pauses there as if locating the target). Shorter (~300ms) for an obvious button; longer (~1000ms) for an ambiguous target.
- "scroll": speed = deltaPx / durationMs. ~250-350 px/s for reading scrolls, ~450 for scanning, ~800 for a fling. Big scrolls (>2500px) should be split into a fling step + a slower approach step. Always give a small "dwellAfterMs" (120-280ms) so the eye lands before the next action.
- "type": "preMs" 200-400ms (a beat before typing starts — short strings look script-injected without it). "keystrokeMs" 60-140ms.
- Insert "dwell" steps for naturalness: a 2-3s dwell after navigating to a content-rich page ("reading"), an opening 200-500ms dwell as the very first step ("absorbing the page"), a brief dwell after a search loads.
- The recording window is a FIXED duration the user paid for. "totalEstimatedMs" should be within ~15% of "durationMs". If your plan is too short, add browsing/dwell steps that fit the page. Too long — trim.

WORKFLOW PATTERNS:
- SEARCH: [click the search box, type "query", key Enter, dwell ~1.5s for results to load]. All four.
- DRILL-AND-RETURN: click into a sub-page → dwell to look around → "back" → continue. Only use "back" if the click that drilled in actually navigated (changed URL or page content).
- DISMISS-MODAL: a cookie/consent banner on screen → click accept first, before pursuing the goal.

expectAfter — when to set it:
- On a "click"/"key"/"back" that you EXPECT to navigate: set "urlContains" to a substring you expect in the URL afterward (e.g. "zh-CN" after a language switch), OR "visibleText" to 1-3 short strings you expect to see.
- If the page is a single-page app / turbo-frame / hash-routed (URL stays the same while content swaps): do NOT set "urlContains" — set "visibleText" if you're confident, otherwise OMIT expectAfter entirely. A wrong expectAfter forces a needless re-plan and wastes the budget. When in doubt, omit it.
- On "scroll"/"type"/"dwell": never set expectAfter.

WHEN THE GOAL CAN'T BE FULLY DONE:
If the page makes some verb in the user's intent impossible (the element doesn't exist, requires login, etc.), do the parts you CAN, fill the rest of the budget with natural browsing of what IS there, and say so in "rationale". Do not invent steps for elements you don't see.

Output JSON only. No markdown, no commentary outside the schema.`;

export function buildReconUserText(input: ReconInput, observed: ObservedElement[]): string {
  const observedList = observed.length === 0
    ? '(none found by the observe pass — rely on the screenshot)'
    : observed.slice(0, 40).map((e, i) => `  ${i + 1}. ${e.description}`).join('\n');
  const prior = input.priorSteps && input.priorSteps.length > 0
    ? ['', 'ALREADY DONE this recording (do NOT redo these — plan the REST):',
       ...input.priorSteps.map((s, i) => `  ${i + 1}. ${s.kind}: ${s.reasoning}`)].join('\n')
    : '';
  return [
    `User intent: ${input.prompt}`,
    `Current URL: ${input.url}`,
    `Time budget (ms): ${input.durationMs}`,
    `Viewport: ${input.viewport.width}x${input.viewport.height}`,
    '',
    'Interactive elements the observe pass found (ground truth for what exists):',
    observedList,
    prior,
    '',
    'Produce the complete Performance JSON for this. Output JSON only.',
  ].filter(Boolean).join('\n');
}
```

- [ ] **Step 2: Add the export to `src/prompts/index.ts`:**

```ts
export { reconnoitererSystemPrompt, buildReconUserText } from './reconnoiterer.js';
```

Leave the existing exports (`planner`, `decider`, `prelude`, `click-verifier`) in place for now — Task 8 removes them.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (the port + prompts are additive; nothing uses them yet).

- [ ] **Step 4: Commit**

```bash
git add src/ports/reconnoiterer.ts src/prompts/reconnoiterer.ts src/prompts/index.ts
git commit -m "feat(port): IReconnoiterer + recon prompts (§0034)"
```

---

## Task 4: `LlmReconnoiterer` adapter

**Files:**
- Create: `src/adapters/recon/llm-reconnoiterer.ts`
- Test: `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`

Pattern to follow: `src/adapters/decider/llm-click-verifier.ts` (OpenAI client via OpenRouter, `response_format: json_object`, code-fence stripping, `DomainError` subclass). The recon adapter additionally: takes a screenshot as an `image_url` content part, calls `session.observeAll()`, and post-processes the LLM's `{description}` targets into `ResolvedTarget`s via `session.resolveTarget()`.

- [ ] **Step 1: Write the failing test** in `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LlmReconnoiterer, ReconError } from '../../../../src/adapters/recon/llm-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';

// Minimal fake OpenAI-shaped client.
function fakeClient(content: string) {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  } as unknown as ConstructorParameters<typeof LlmReconnoiterer>[0]['client'];
}

const llmPerformanceJson = JSON.stringify({
  prompt: 'click sign in then browse',
  durationMs: 10000,
  steps: [
    { kind: 'dwell', durationMs: 350, reasoning: 'absorbing the page' },
    { kind: 'click', target: { description: 'the sign-in link' }, anticipationMs: 600, reasoning: 'user asked', expectAfter: { urlContains: '/login' } },
    { kind: 'dwell', durationMs: 2000, reasoning: 'reading the login form' },
    { kind: 'done', reasoning: 'done' },
  ],
  totalEstimatedMs: 2950,
  rationale: 'sign-in is in view',
});

describe('LlmReconnoiterer', () => {
  it('parses the LLM output, resolves targets, returns a validated Performance', async () => {
    const session = new FakePageSession();
    session.resolveTargetResult = { selector: 'text=Sign in', description: 'the sign-in link', bbox: { x: 10, y: 20, width: 80, height: 30 } };
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(llmPerformanceJson) });
    const perf = await recon.recon(
      { url: 'https://x.test/', prompt: 'click sign in then browse', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: Buffer.from([0x89]) },
      session,
    );
    expect(perf.steps).toHaveLength(4);
    const clickStep = perf.steps.find((s) => s.kind === 'click')!;
    expect(clickStep).toMatchObject({ kind: 'click', target: { selector: 'text=Sign in', description: 'the sign-in link' } });
    expect(recon.modelId).toBe('test/model');
  });

  it('throws ReconError on malformed JSON', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient('not json') });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('throws ReconError when the LLM output fails the schema', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(JSON.stringify({ prompt: 'p', durationMs: 1, steps: [], totalEstimatedMs: 0, rationale: 'x' })) });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('drops a click step whose target will not resolve, keeping the rest', async () => {
    const session = new FakePageSession();
    session.resolveTargetResult = null; // nothing resolves
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(llmPerformanceJson) });
    const perf = await recon.recon({ url: 'u', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    // The click is dropped; dwell + dwell + done remain.
    expect(perf.steps.some((s) => s.kind === 'click')).toBe(false);
    expect(perf.steps.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- llm-reconnoiterer`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/adapters/recon/llm-reconnoiterer.ts`:**

```ts
import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  type Performance,
  type PerformanceStep,
} from '../../domain/performance.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { buildReconUserText, reconnoitererSystemPrompt } from '../../prompts/index.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer, ReconInput } from '../../ports/reconnoiterer.js';

/**
 * LlmReconnoiterer — IReconnoiterer backed by a vision LLM via OpenRouter.
 * Default model: config.llmReconModelResolved (the resolved planner model).
 *
 * Pipeline:
 *   1. session.observeAll() — ground-truth interactive elements.
 *   2. one chat call (screenshot + intent + observed list) → raw Performance
 *      JSON where each click/type target is just {description}.
 *   3. resolve each target via session.resolveTarget(); drop steps whose
 *      target won't resolve.
 *   4. Zod-validate the final Performance; throw ReconError on any failure.
 */
export class ReconError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('RECON_FAILED', message, cause);
  }
}

interface LlmReconnoitererOpts {
  model?: string;
  client?: OpenAI;
}

/** The raw step shape the LLM emits — targets are {description} only. */
type RawStep = Omit<Extract<PerformanceStep, { kind: 'click' | 'type' }>, 'target'> & { target: { description: string } }
  | Exclude<PerformanceStep, { kind: 'click' | 'type' }>;

export class LlmReconnoiterer implements IReconnoiterer {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmReconnoiterer' });

  constructor(opts: LlmReconnoitererOpts = {}) {
    this.model = opts.model ?? config.llmReconModelResolved;
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
  }

  get modelId(): string { return this.model; }

  async recon(input: ReconInput, session: IPageSession): Promise<Performance> {
    const observed = await session.observeAll().catch(() => []);
    const userText = buildReconUserText(input, observed);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (input.screenshot && input.screenshot.length > 0) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
    }

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: reconnoitererSystemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 4000,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new ReconError('recon LLM call failed', err);
    }
    if (!raw) throw new ReconError('recon returned empty content');

    let parsedRaw: { prompt?: unknown; durationMs?: unknown; steps?: unknown; totalEstimatedMs?: unknown; rationale?: unknown };
    try {
      parsedRaw = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new ReconError(`recon JSON parse failed: ${raw.slice(0, 200)}`, err);
    }
    if (!Array.isArray(parsedRaw.steps)) throw new ReconError('recon output has no steps array');

    // Resolve targets; drop click/type steps that don't resolve.
    const resolvedSteps: PerformanceStep[] = [];
    for (const rawStep of parsedRaw.steps as RawStep[]) {
      if (rawStep.kind === 'click' || rawStep.kind === 'type') {
        const desc = (rawStep.target as { description?: string } | undefined)?.description;
        if (!desc) { this.logger.debug({ rawStep }, 'recon step missing target description — dropped'); continue; }
        const resolved = await session.resolveTarget(desc).catch(() => null);
        if (!resolved || !resolved.bbox) { this.logger.info({ desc }, 'recon target did not resolve — step dropped'); continue; }
        const target = ResolvedTargetSchema.parse({ selector: resolved.selector, bbox: resolved.bbox, description: desc });
        resolvedSteps.push({ ...(rawStep as object), target } as PerformanceStep);
      } else {
        resolvedSteps.push(rawStep as PerformanceStep);
      }
    }
    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after target resolution');
    }

    const candidate: Performance = {
      prompt: typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt,
      durationMs: input.durationMs,
      steps: resolvedSteps,
      totalEstimatedMs: typeof parsedRaw.totalEstimatedMs === 'number' ? parsedRaw.totalEstimatedMs : sumDurations(resolvedSteps),
      rationale: typeof parsedRaw.rationale === 'string' ? parsedRaw.rationale : 'no rationale provided',
    };
    const validation = PerformanceSchema.safeParse(candidate);
    if (!validation.success) {
      throw new ReconError(`recon Performance failed schema: ${validation.error.message.slice(0, 400)}`);
    }
    this.logger.info(
      { stepCount: validation.data.steps.length, totalEstimatedMs: validation.data.totalEstimatedMs, durationMs: input.durationMs },
      'recon complete',
    );
    return validation.data;
  }
}

function sumDurations(steps: PerformanceStep[]): number {
  let total = 0;
  for (const s of steps) {
    switch (s.kind) {
      case 'dwell': total += s.durationMs; break;
      case 'scroll': total += s.durationMs + s.dwellAfterMs; break;
      case 'click': total += s.anticipationMs + 400; break;   // +click+settle estimate
      case 'type': total += s.preMs + s.text.length * s.keystrokeMs; break;
      case 'key': total += 200; break;
      case 'back': total += 800; break;
      case 'done': break;
    }
  }
  return total;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return t;
}
```

> **Implementer note:** The `RawStep` type juggling is the fiddly bit. If TypeScript fights you, a pragmatic alternative: type `parsedRaw.steps` as `any[]`, branch on `rawStep.kind`, and build the resolved step object explicitly per kind (spread the raw fields, replace `target`). Keep it readable over clever. The `ResolvedTargetSchema.parse(...)` call is what guarantees the resolved target is well-formed before it goes into the Performance.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -- llm-reconnoiterer`
Expected: PASS (4 tests).

- [ ] **Step 5: Run typecheck + the full unit suite**

Run: `npm run typecheck && npm run test`
Expected: PASS (everything still green — this is additive).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/recon/llm-reconnoiterer.ts tests/unit/adapters/recon/llm-reconnoiterer.test.ts
git commit -m "feat(adapter): LlmReconnoiterer — vision LLM → resolved Performance (§0034)"
```

---

## Task 5: `PerformanceDirector` — deterministic playback (no re-plan yet)

**Files:**
- Create: `src/adapters/director/performance-director.ts`
- Create: `tests/fakes/fake-reconnoiterer.ts`
- Test: `tests/unit/adapters/director/performance-director.test.ts`
- Modify: `src/ports/director.ts` — change `IDirector.run` to accept `Performance`; update `DirectorReport`. (This breaks `StreamingDirector`'s `implements IDirector` — acceptable transient; `StreamingDirector` is removed in Task 8. To keep the build green meanwhile: in this task, ALSO comment out the `streaming-director.ts` from any barrel exports and skip its test file via `describe.skip` — or just accept that `npm run typecheck` is red until Task 8. Recommended: do Task 8 immediately after Task 7; between Task 5 and Task 8, run only the scoped test `npm run test -- performance-director`.)

Reuse from `StreamingDirector` (copy the helpers, don't reinvent): the scroll-speed-profile clamps, `safeUrl` / `safeTitle` / `safeScrollY` / `safeFocusedValue`, `viewportFrom`, the ActionEvidence capture per kind (§0026), `briefAction`, `truncate`. These are pure helpers; lift them into `performance-director.ts` (or a small shared `src/adapters/director/_helpers.ts` if you prefer — but keeping them in the one file is fine).

- [ ] **Step 1: Create `tests/fakes/fake-reconnoiterer.ts`:**

```ts
import type { Performance } from '../../src/domain/performance.js';
import type { IReconnoiterer, ReconInput } from '../../src/ports/reconnoiterer.js';
import type { IPageSession } from '../../src/ports/page-session.js';

/**
 * Programmable IReconnoiterer for unit tests. Construct with a queue of
 * Performances; each recon() call shifts one off. If the queue is empty it
 * throws (so a test that doesn't expect a re-plan fails loudly if one happens).
 */
export class FakeReconnoiterer implements IReconnoiterer {
  modelId = 'fake/recon';
  calls: ReconInput[] = [];
  private queue: Performance[];
  constructor(initial: Performance[] = []) { this.queue = [...initial]; }
  enqueue(...p: Performance[]) { this.queue.push(...p); }
  async recon(input: ReconInput, _session: IPageSession): Promise<Performance> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeReconnoiterer: no more queued Performances');
    return next;
  }
}
```

- [ ] **Step 2: Update `src/ports/director.ts`** — replace its contents with:

```ts
import type { Performance } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

/**
 * IDirector — owns the recording window. Plays back a Performance built by
 * the reconnaissance phase. See ADR §0034.
 *
 * Lifecycle: the runner calls run(performance, session) AFTER setup +
 * recon, BEFORE the deliverable starts. The Director calls
 * session.beginRecording() itself (typically immediately). run() returns
 * when a `done` step is reached, the time budget is exhausted, or an
 * unrecoverable error occurs.
 */
export interface IDirector {
  run(performance: Performance, session: IPageSession): Promise<DirectorReport>;
}

export interface DirectorReport {
  /** ms elapsed inside Director.run(). */
  totalMs: number;
  /** Number of steps actually executed (excludes ones abandoned by a re-plan). */
  stepsExecuted: number;
  /** Number of re-plan checkpoints triggered. */
  replanCount: number;
  /** Reason for ending. */
  endReason: 'done' | 'budget' | 'error';
}
```

- [ ] **Step 3: Write the failing test** in `tests/unit/adapters/director/performance-director.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PerformanceDirector } from '../../../../src/adapters/director/performance-director.js';
import { FakeReconnoiterer } from '../../../fakes/fake-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { Performance } from '../../../../src/domain/performance.js';

const target = (sel: string) => ({ selector: sel, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: sel });

const perf = (steps: Performance['steps']): Performance => ({
  prompt: 'do the thing', durationMs: 20000, steps, totalEstimatedMs: 5000, rationale: 'test',
});

describe('PerformanceDirector — deterministic playback', () => {
  it('calls beginRecording once and stops on a done step', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    const report = await director.run(perf([{ kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.filter((e) => e.kind === 'beginRecording')).toHaveLength(1);
    expect(report.endReason).toBe('done');
    expect(report.stepsExecuted).toBe(1);
  });

  it('renders a scroll step with its planned duration + dwellAfter', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'scroll', deltaPx: 400, durationMs: 1500, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 'browse' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.payload).toMatchObject({ deltaY: 400, durationMs: 1500 });
    // dwellAfter renders as a wait
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 200)).toBe(true);
  });

  it('renders a click step via clickSelector after an anticipation wait', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'click', target: target('text=Go'), anticipationMs: 500, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 500)).toBe(true);
    const clicks = session.events.filter((e) => e.kind === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload).toMatchObject({ selector: 'text=Go' });
  });

  it('renders a type step: focus, pre-pause, type with keystroke delay', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'type', target: target('input[name=q]'), text: 'hi', preMs: 250, keystrokeMs: 80, reasoning: 'enter query' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'input[name=q]')).toBe(true);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 250)).toBe(true);
    expect(session.events.some((e) => e.kind === 'type' && e.payload === 'hi')).toBe(true);
  });

  it('plays a dwell step as a wait of the planned duration', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([{ kind: 'dwell', durationMs: 1234, reasoning: 'read' }, { kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 1234)).toBe(true);
  });

  it('stops with endReason "budget" if the steps overrun durationMs * hardBudgetMult', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    // durationMs 200, hard cap ~240ms. A 1000ms dwell blows it.
    const report = await director.run(
      { prompt: 'p', durationMs: 200, steps: [{ kind: 'dwell', durationMs: 1000, reasoning: 'long' }, { kind: 'done', reasoning: 'fin' }], totalEstimatedMs: 1000, rationale: 't' },
      session,
    );
    expect(report.endReason).toBe('budget');
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npm run test -- performance-director`
Expected: FAIL — module not found.

- [ ] **Step 5: Create `src/adapters/director/performance-director.ts`** — playback only, re-plan stubbed (re-plan added in Task 6). Core shape:

```ts
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { Performance, PerformanceStep, ScrollEasing } from '../../domain/performance.js';
import type { ExpectAfter } from '../../domain/performance.js';
import type { IDirector, DirectorReport } from '../../ports/director.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer } from '../../ports/reconnoiterer.js';
import type { Viewport } from '../../domain/action-log.js';

// Scroll speed profiles for big-delta splitting (lifted from StreamingDirector).
// (For now PerformanceDirector trusts the step's durationMs/easing directly;
//  multi-stage splitting for >2500px deltas can be added — the planner is
//  instructed to pre-split, so keep playback simple here.)

interface PerformanceDirectorOpts {
  replanner: IReconnoiterer;
}

export class PerformanceDirector implements IDirector {
  private readonly replanner: IReconnoiterer;
  private readonly logger = rootLogger.child({ component: 'PerformanceDirector' });

  constructor(opts: PerformanceDirectorOpts) {
    this.replanner = opts.replanner;
  }

  async run(performance: Performance, session: IPageSession): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + performance.durationMs * config.directorHardBudgetMult;
    await session.beginRecording();

    let workingSteps: PerformanceStep[] = [...performance.steps];
    let stepsExecuted = 0;
    const replanCount = 0; // Task 6 makes this mutable.

    let i = 0;
    while (i < workingSteps.length) {
      if (Date.now() >= hardDeadlineAt) {
        this.logger.info({ stepsExecuted }, 'budget exhausted — stopping playback');
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'budget' };
      }
      const step = workingSteps[i]!;
      if (step.kind === 'done') {
        stepsExecuted += 1;
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'done' };
      }
      try {
        await this.renderStep(step, session, hardDeadlineAt);
      } catch (err) {
        this.logger.warn({ err, kind: step.kind }, 'step render failed — stopping');
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'error' };
      }
      stepsExecuted += 1;
      // Task 6: reality check + re-plan here. For now, just advance.
      i += 1;
    }
    return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'done' };
  }

  private async renderStep(step: PerformanceStep, session: IPageSession, _hardDeadlineAt: number): Promise<void> {
    switch (step.kind) {
      case 'dwell':
        await session.wait(step.durationMs);
        return;
      case 'scroll':
        await session.scroll(step.deltaPx, { durationMs: step.durationMs, easing: step.easing });
        if (step.dwellAfterMs > 0) await session.wait(step.dwellAfterMs);
        return;
      case 'click':
        if (step.anticipationMs > 0) await session.wait(step.anticipationMs);
        await session.clickSelector(step.target.selector, { description: step.target.description });
        return;
      case 'type':
        await session.clickSelector(step.target.selector, { description: step.target.description });
        if (step.preMs > 0) await session.wait(step.preMs);
        // The §0031 keystroke delay lives in session.type's config; here we
        // pass the planned values through. session.type currently reads
        // config for delays — Task 7 extends it to accept a per-call delay.
        // For now, just call session.type(text); the per-call delay wiring
        // is a follow-up within Task 7.
        await session.type(step.text);
        return;
      case 'key':
        await session.pressKey(step.key);
        return;
      case 'back':
        await session.goBack();
        return;
      case 'done':
        return;
    }
  }
}
```

> **Implementer note on `session.type` per-call delay:** the spec wants the type step to render with `preMs` + `keystrokeMs` from the step. `StagehandPageSession.type(text)` currently reads `config.typing*` internally. Two options: (a) leave `session.type(text)` as-is (it reads config defaults — close enough, the recon usually picks values near the defaults anyway), or (b) widen `IPageSession.type` to `type(text: string, opts?: { preMs?: number; keystrokeMs?: number })` and have the Stagehand impl use the opts when provided. Option (b) is cleaner and is what the spec implies; do it in Task 7 when you're already touching the runner + session wiring. For Task 5, option (a) (call `session.type(step.text)`) keeps the test simple — the `preMs` is rendered via the explicit `session.wait(step.preMs)` above, so the only thing lost is per-step keystroke speed. Note which you did.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `npm run test -- performance-director`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit** (typecheck WILL be red here because `StreamingDirector` no longer satisfies `IDirector` — that's expected; note it in the commit message)

```bash
git add src/adapters/director/performance-director.ts tests/fakes/fake-reconnoiterer.ts tests/unit/adapters/director/performance-director.test.ts src/ports/director.ts
git commit -m "feat(director): PerformanceDirector — deterministic Performance playback (§0034)

Typecheck is transiently red (StreamingDirector no longer implements the
new IDirector signature); resolved in Task 8 when StreamingDirector is
removed. Scoped test 'performance-director' is green."
```

---

## Task 6: `PerformanceDirector` re-plan checkpoint

**Files:**
- Modify: `src/adapters/director/performance-director.ts`
- Test: extend `tests/unit/adapters/director/performance-director.test.ts`

- [ ] **Step 1: Write the failing tests** — append to the test file:

```ts
import { ActionLogEntry } from '../../../../src/domain/action-log.js'; // adjust if needed

describe('PerformanceDirector — re-plan checkpoint', () => {
  it('re-plans when a step expectAfter does not match reality', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    // The re-planner returns a fresh tail: one more click then done.
    const replan = new FakeReconnoiterer([
      perf([{ kind: 'click', target: target('text=Recovered'), anticipationMs: 100, reasoning: 'try a different link' }, { kind: 'done', reasoning: 'fin' }]),
    ]);
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      // expectAfter wants /build in the URL, but the fake session's url won't contain it.
      { kind: 'click', target: target('text=build'), anticipationMs: 100, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(report.replanCount).toBe(1);
    expect(replan.calls).toHaveLength(1);
    expect(replan.calls[0]!.priorSteps?.[0]).toMatchObject({ kind: 'click' });
    // a replan action-log entry was appended
    expect(session.appendedEntries.some((e: ActionLogEntry) => e.type === 'replan')).toBe(true);
    expect(report.endReason).toBe('done'); // recovered then done
    // the "Recovered" click was executed (from the re-planned tail)
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'text=Recovered')).toBe(true);
  });

  it('does NOT re-plan when expectAfter matches', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/build/'; // satisfies urlContains '/build'
    const replan = new FakeReconnoiterer(); // empty — throws if called
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 50, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(report.replanCount).toBe(0);
    expect(replan.calls).toHaveLength(0);
  });

  it('stops re-planning after maxReplans (config default 3)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start'; // never satisfies /build
    // Every re-plan returns a step that also wants /build → would loop forever without the cap.
    const loopStep = perf([{ kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'retry', expectAfter: { urlContains: '/build' } }, { kind: 'done', reasoning: 'fin' }]);
    const replan = new FakeReconnoiterer([loopStep, loopStep, loopStep, loopStep, loopStep]);
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(report.replanCount).toBeLessThanOrEqual(3); // capped
  });

  it('stops gracefully (endReason "error") if a re-plan call throws', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    const replan = new FakeReconnoiterer(); // empty queue → recon() throws
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(report.endReason).toBe('error');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test -- performance-director`
Expected: FAIL — re-plan logic not implemented; `replanCount` stays 0, no `replan` entries.

- [ ] **Step 3: Implement the re-plan checkpoint in `performance-director.ts`.** Changes:

1. Make `replanCount` a mutable `let`.
2. After `renderStep` succeeds and `stepsExecuted += 1`, capture post-step evidence and run the reality check:

```ts
      stepsExecuted += 1;
      const executedReasonings = workingSteps.slice(0, i + 1).map((s) => ({ kind: s.kind, reasoning: s.reasoning }));

      // Reality check — only on steps that carry an expectAfter.
      const ea = stepExpectAfter(step);
      if (ea && !(await this.satisfiesExpectAfter(ea, session))) {
        if (replanCount >= config.maxReplans) {
          this.logger.warn({ replanCount }, 'maxReplans reached — playing out remaining steps without re-planning');
          i += 1;
          continue;
        }
        replanCount += 1;
        const currentUrl = await safeUrl(session);
        const screenshot = await session.screenshot().catch(() => null);
        const remainingMs = Math.max(1000, hardDeadlineAt - Date.now());
        this.logger.info({ fromStepIndex: i, expected: ea, replanCount }, 'expectAfter mismatch — re-planning');
        this.appendReplanEntry(session, i, 'expect_after_mismatch', `expected ${JSON.stringify(ea)}; URL was ${currentUrl}`);
        let newPerf;
        try {
          newPerf = await this.replanner.recon(
            { url: currentUrl, prompt: performance.prompt, durationMs: remainingMs, viewport: viewportFrom(session), screenshot, priorSteps: executedReasonings },
            session,
          );
        } catch (err) {
          this.logger.warn({ err }, 're-plan failed — stopping');
          return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'error' };
        }
        // Replace the tail: keep executed steps [0..i], append the new plan.
        workingSteps = [...workingSteps.slice(0, i + 1), ...newPerf.steps];
        i += 1;
        continue;
      }
      i += 1;
```

3. Add the helpers (lift `safeUrl`, `safeTitle`, `viewportFrom` from `streaming-director.ts`):

```ts
function stepExpectAfter(step: PerformanceStep): ExpectAfter | null {
  return (step.kind === 'click' || step.kind === 'key' || step.kind === 'back') ? (step.expectAfter ?? null) : null;
}

// inside the class:
  private async satisfiesExpectAfter(ea: ExpectAfter, session: IPageSession): Promise<boolean> {
    if (ea.urlContains) {
      const url = await safeUrl(session);
      if (!url.includes(ea.urlContains)) return false;
    }
    if (ea.visibleText && ea.visibleText.length > 0) {
      // Reuse a cheap on-page text probe. If IPageSession lacks one, use
      // quickFindOnPage as a proxy (it returns non-null if the text exists).
      for (const txt of ea.visibleText) {
        const found = await session.quickFindOnPage(txt).catch(() => null);
        if (!found) return false;
      }
    }
    // about:blank is never a satisfying state for a navigation expectAfter.
    const url = await safeUrl(session);
    if (url === 'about:blank') return false;
    return true;
  }

  private appendReplanEntry(session: IPageSession, fromStepIndex: number, reason: 'expect_after_mismatch' | 'about_blank' | 'target_vanished', details: string): void {
    try {
      session.appendEntry({
        t: session.nowMs(), type: 'replan', fromStepIndex, reason, details: details.slice(0, 500),
        scrollY: 0, viewport: viewportFrom(session),
      });
    } catch (err) { this.logger.debug({ err }, 'appendReplanEntry failed'); }
  }

async function safeUrl(session: IPageSession): Promise<string> { try { return await session.currentUrl(); } catch { return ''; } }
function viewportFrom(session: IPageSession): Viewport {
  const v = (session as unknown as { viewport?: Viewport }).viewport;
  return v ?? { width: 1280, height: 720 };
}
```

> **Implementer note:** `FakePageSession` already has `quickFindOnPage` (returns `quickFindOnPageResult`, default null) and `currentUrl()` (returns `this.url`) and `appendEntry` (pushes to `appendedEntries`). Set `session.quickFindOnPageResult` in tests that exercise `visibleText`. For the `urlContains` tests, set `session.url`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm run test -- performance-director`
Expected: PASS (6 playback + 4 re-plan = 10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/director/performance-director.ts tests/unit/adapters/director/performance-director.test.ts
git commit -m "feat(director): re-plan checkpoint — the one recovery path (§0034)"
```

---

## Task 7: Wire `RecordJobRunner` to the prophet pipeline

**Files:**
- Modify: `src/core/record-job-runner.ts`
- Modify: `src/ports/page-session.ts` + `src/adapters/agent/stagehand-session.ts` — widen `type(text, opts?)` (the optional per-call delay; option (b) from Task 5's note). Also widen `FakePageSession.type`.
- Test: `tests/unit/core/record-job-runner.test.ts` — `computeIntentSatisfaction` still works; its input source changes.

- [ ] **Step 1: Widen `IPageSession.type`** in `src/ports/page-session.ts`:

```ts
  /**
   * Type into the currently focused element. `opts.preMs` (pause before the
   * first keystroke) and `opts.keystrokeMs` (inter-keystroke delay) override
   * the config defaults when provided. Caller must focus the field first.
   * Logged as `type`.
   */
  type(text: string, opts?: { preMs?: number; keystrokeMs?: number }): Promise<void>;
```

In `src/adapters/agent/stagehand-session.ts`, change `async type(text: string)` to `async type(text: string, opts: { preMs?: number; keystrokeMs?: number } = {})` and use `opts.preMs ?? randInRange(config.typingPreMinMs, config.typingPreMaxMs)` and `opts.keystrokeMs ?? randInRange(config.typingKeystrokeMinMs, config.typingKeystrokeMaxMs)`.

In `tests/fakes/fake-page-session.ts`, change `async type(text: string)` to `async type(text: string, _opts?: { preMs?: number; keystrokeMs?: number })` (body unchanged).

In `src/adapters/director/performance-director.ts` `renderStep` `case 'type'`: replace `await session.type(step.text);` with `await session.type(step.text, { preMs: 0, keystrokeMs: step.keystrokeMs });` (preMs is 0 here because we already did `session.wait(step.preMs)` explicitly above — keep it that way so the wait shows in the action log as a discrete entry).

- [ ] **Step 2: Rewrite `RecordJobRunner.run` to use recon + PerformanceDirector.** Key changes in `src/core/record-job-runner.ts`:

- Constructor: replace `planner: IPlanner` with `reconnoiterer: IReconnoiterer`; replace `director: IDirector` (same port, new impl) — keep the param; remove `preFireDecider`. Keep `blockerPrelude` optional.
- Remove the `prefireFirstDecision` method and `enrichHintsForState` helper (briefing-hint specific).
- In `run()`: after setup, call `const performance = await this.reconnoiterer.recon({ url: req.url, prompt: req.prompt, durationMs: req.durationMs, viewport: this.viewportFromSession(), screenshot }, this.session);` instead of `planner.brief(...)`.
- Run `BlockerPrelude` (kept) — but it currently takes a `DirectorBriefing`; change `BlockerPrelude.run(session, briefing)` to `BlockerPrelude.run(session)` (it only used `briefing.hints` for context which is now gone — check; if it genuinely needs hints, pass `performance.steps.filter(s => s.kind === 'click').map(s => s.target.description)` as a `string[]` and adjust `BlockerPrelude`'s signature). Pragmatic: change `BlockerPrelude.run(session: IPageSession, hints?: string[])`.
- Replace the director call: `const directorReport = await this.director.run(performance, this.session);`
- `RunResult` gains `performance: Performance`. `RunMetrics` gains `replanCount: number` (from `directorReport.replanCount`), drops `resolvedClicks`/`fallbackClicks`/`stableTimeouts` (streaming-era) — or keep them as 0 for backward compat with anything reading them; recommended: drop, and update callers.
- `computeIntentSatisfaction`: change the first arg from `briefing.hints.map(h => h.description)` to `performance.steps.filter((s): s is Extract<PerformanceStep, {kind:'click'}> => s.kind === 'click').map(s => s.target.description)`. The function body (and the §0033 bipartite matching) is unchanged.
- Update the `RunMetrics` doc comment block accordingly.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: STILL RED — `StreamingDirector`, `LlmFastDecider`, `LlmClickVerifier`, `LlmPlanner`, the old prompts, the scripts, the regression test still reference removed/changed things. That's Task 8. Run the scoped tests instead:

Run: `npm run test -- record-job-runner performance-director llm-reconnoiterer performance`
Expected: PASS.

- [ ] **Step 4: Commit** (note the transient red typecheck)

```bash
git add src/core/record-job-runner.ts src/ports/page-session.ts src/adapters/agent/stagehand-session.ts tests/fakes/fake-page-session.ts src/adapters/director/performance-director.ts tests/unit/core/record-job-runner.test.ts
git commit -m "feat(core): RecordJobRunner uses recon + PerformanceDirector (§0034)

Typecheck transiently red until Task 8 removes the streaming-era code that
still references the old APIs. Scoped tests green."
```

---

## Task 8: Remove the streaming-era code

**Files:**
- Delete: `src/adapters/director/streaming-director.ts`, `tests/unit/adapters/director/streaming-director.test.ts`
- Delete: `src/ports/fast-decider.ts`, `src/adapters/decider/llm-fast-decider.ts`, `tests/fakes/fake-fast-decider.ts`, `tests/unit/adapters/decider/llm-fast-decider.test.ts` (if it exists)
- Delete: `src/ports/click-verifier.ts`, `src/adapters/decider/llm-click-verifier.ts`, `src/prompts/click-verifier.ts`, `tests/unit/adapters/decider/llm-click-verifier.test.ts`
- Delete: `src/prompts/decider.ts`, `src/prompts/planner.ts`
- Delete: `src/ports/planner.ts`, `src/adapters/planner/llm-planner.ts`, `tests/unit/adapters/planner/*` (if any)
- Delete: `src/domain/plan.ts`
- Maybe delete: `src/infra/pending.ts` (check usages first — `grep -rn "from.*pending" src tests`); delete only if unused
- Modify: `src/prompts/index.ts` — remove the `planner`/`decider`/`click-verifier` exports (keep `prelude` and `reconnoiterer`)
- Modify: `src/infra/config.ts` — remove `directorClickRejectionLimit`, `directorLookaheadMax`, `directorDwellFallbackMs` (schema + raw) if you left them in during Task 0
- Modify: `src/domain/action-log.ts` — remove `about_blank_recovered` from the `decision_failure` reasons enum (the `replan` entry's `reason: 'about_blank'` covers it now); ALSO consider whether the `decision` entry type is still used — the re-plan path doesn't emit `decision`, only `replan`; if nothing emits `decision`, you may remove it too, but it's harmless to keep — recommended: keep `decision`/`decision_failure` (the BlockerPrelude still emits `decision_failure`), just drop the `about_blank_recovered` reason
- Modify: `src/core/blocker-prelude.ts` — adjust the signature per Task 7 step 2 (`run(session, hints?: string[])` instead of `run(session, briefing)`)
- Modify: `CLAUDE.md` — remove `IDirector + StreamingDirector`, `IFastDecider + LlmFastDecider`, `IClickVerifier`, retry-cap rows; the `IPlanner + LlmPlanner` row; add `IReconnoiterer + LlmReconnoiterer` and `IDirector + PerformanceDirector` and `Performance domain type` rows; update the action-vocabulary note; update the unit-test count
- Modify: `docs/architecture.md` — update the ports/adapters list
- Modify: `docs/glossary.md` — add `Performance`, `reconnaissance`, `re-plan checkpoint`; remove `DirectorBriefing`, `draftSequence`, `FastDecider`, `click verifier` if present

- [ ] **Step 1: Delete the files** listed above. Run `grep -rn "streaming-director\|StreamingDirector\|IFastDecider\|LlmFastDecider\|LlmClickVerifier\|IClickVerifier\|DirectorBriefing\|draftSequence\|LlmPlanner\|IPlanner\b\|fast-decider\|click-verifier\|prompts/decider\|prompts/planner\|domain/plan" src tests scripts` and fix every remaining reference (mostly: the scripts and the regression test, handled in Task 10; and the prompts/index.ts; and any stragglers).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS now (or only the scripts/regression-test references remain — fix those here too if `tsc` includes them; if `tsc` config excludes `scripts/`, they're handled in Task 10).

- [ ] **Step 3: Run the full unit suite**

Run: `npm run test`
Expected: PASS — all remaining unit tests (performance, action-log, llm-reconnoiterer, performance-director, record-job-runner, plus whatever schema/util tests survive). The streaming-director / verifier / fast-decider tests are gone.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove streaming-era code superseded by prophet recording (§0034)

Deletes StreamingDirector, IFastDecider/LlmFastDecider, IClickVerifier/
LlmClickVerifier, LlmPlanner/IPlanner, DirectorBriefing, the decider/
planner/click-verifier prompts, and their tests. Drops the streaming-only
config knobs. typecheck + unit suite green."
```

---

## Task 9: Update scripts + regression test

**Files:**
- Modify: `scripts/prototype-stagehand.ts`
- Modify: `tests/regression/regression.test.ts`

- [ ] **Step 1: Rewrite `scripts/prototype-stagehand.ts`'s wiring.** Replace the planner/director/verifier/pre-fire construction with:

```ts
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
// ... keep StagehandPageSession, RecordJobRunner, BlockerPrelude, config, logger, buildRunDir imports

  const session = new StagehandPageSession({ outputDir, headless: false, viewport: config.viewport, verbose: 1 });
  const reconnoiterer = new LlmReconnoiterer();
  const director = new PerformanceDirector({ replanner: reconnoiterer });   // same instance reused for re-plans
  const blockerPrelude = new BlockerPrelude(); // adjust constructor if it took a decider — it took `{ decider }`; now it can take nothing or keep a decider for its dismissal loop. If BlockerPrelude still needs an LLM for its probe→dismiss loop, give it `new LlmReconnoiterer()` is WRONG (different shape). Decision: leave BlockerPrelude's internals as-is for now (it has its own decider); if that decider was LlmFastDecider (deleted), BlockerPrelude needs its own small LLM client — out of scope for this plan. Pragmatic: if BlockerPrelude depended on LlmFastDecider, SKIP constructing BlockerPrelude in the prototype/regression (pass null) and note it as follow-up.
  const runner = new RecordJobRunner(session, reconnoiterer, director, blockerPrelude /* or null */);
```

> **Implementer note — BlockerPrelude:** check `src/core/blocker-prelude.ts`'s constructor. If it takes `{ decider: IFastDecider }` and `IFastDecider` is being deleted, you have a real coupling. Cheapest resolution within this plan: give BlockerPrelude its own minimal LLM call (it only needs a yes/no "is there a blocker, what do I click" loop — a tiny prompt). OR: pass `null` for blockerPrelude in the runner (the runner already handles `blockerPrelude: null`) and file a follow-up task "give BlockerPrelude an LLM client independent of the deleted FastDecider". Recommended: pass `null` + follow-up — keeps this plan's scope contained. The prophet recon already sees the page including any blockers, and the recon prompt instructs "dismiss the cookie banner first" — so a missing BlockerPrelude is less critical than it was.

- [ ] **Step 2: Update `tests/regression/regression.test.ts`** — same construction swap. Update the categorical asserts to:

```ts
        expect(result.videoPath, 'video path produced').toBeTruthy();
        expect(result.metrics.trimmedVideoMs, 'trimmed video has non-zero duration').toBeGreaterThan(0);
        expect(result.metrics.intentSatisfaction.level, 'intentSatisfaction.level was computed')
          .toMatch(/^(complete|partial|unmet|unknown)$/);
        expect(typeof result.metrics.replanCount, 'replanCount is a number').toBe('number');
        expect(result.directorReport.endReason, 'Director reached an endReason')
          .toMatch(/^(done|budget|error)$/);
```

Remove the `blockerPrelude?.endReason` assert if BlockerPrelude is now null. Keep the diagnostic `console.log` block (it's the report) — add `performance step count` and `replanCount` to it.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (scripts now compile against the new APIs).

- [ ] **Step 4: Commit**

```bash
git add scripts/prototype-stagehand.ts tests/regression/regression.test.ts
git commit -m "chore: rewire prototype + regression to recon + PerformanceDirector (§0034)"
```

---

## Task 10: Integration run + acceptance + docs

**Files:**
- Modify: `CLAUDE.md`, `docs/decisions.md` (ADR §0034), `docs/architecture.md`, `docs/glossary.md`, `docs/naturalness-catalog.md` (note C4 "opening hold" is now a planned `dwell` step, not a hard-coded Director wait)

- [ ] **Step 1: Run the prototype on the Recordly scenario**

Run: `npm run prototype:stagehand` (defaults to the GitHub Recordly README, "click 简中, slow scroll, 10s" — set `PROTOTYPE_DURATION_MS=10000` if needed). Requires `OPENROUTER_API_KEY` in `.env`.
Expected: a recording produced; `metrics.replanCount` logged; the trimmed video opens. Inspect the video — it should have NO static-frame stretch > ~1s that isn't a planned `dwell`.

- [ ] **Step 2: Run the §0030 judge on the produced recording**

Run: `npm run judge -- <the recording.webm path from step 1> "<the prompt>" --duration-ms 10000`
Expected: a `judgment.json` written; the `pacing` dimension is `pass` or `partial` (not `fail`); the verdict is at worst `probably_synthetic`. (Per goals.md #6 this is an eyeball check, not a hard gate — but it's the acceptance signal that the architecture paid off.)

If `pacing: fail` with "dead air" evidence, or `replanCount > 1` on this scenario: the recon isn't producing a tight enough plan. Iterate on the recon prompt (pacing rules, dwell insertion) before declaring done — this is the bet the whole architecture rests on (spec "Open design risks" #1).

- [ ] **Step 3: Run the regression suite**

Run: `npm run regression`
Expected: 6/6 pass (categorical asserts). Eyeball the 6 videos + run the judge on each (`npm run judge`); compare to the §0031 batch (`docs/findings/2026-05-11-judge-second-batch.md`) — dead air should be visibly reduced.

- [ ] **Step 4: Run the full unit suite + typecheck one more time**

Run: `npm run typecheck && npm run test`
Expected: all green.

- [ ] **Step 5: Update the docs.**
- `CLAUDE.md`: in the state table, remove the `IPlanner + LlmPlanner`, `IDirector + StreamingDirector`, `IFastDecider + LlmFastDecider`, `IClickVerifier`, retry-cap, `draftSequence` rows; add `IReconnoiterer + LlmReconnoiterer (recon → Performance, reused as re-planner)`, `IDirector + PerformanceDirector (deterministic Performance playback + re-plan checkpoint)`, `Performance domain type (pre-resolved paced action sequence)`; update the unit-test count; update the "Measured performance" block with a fresh run from step 1.
- `docs/decisions.md`: add ADR §0034 "Prophet recording — deep reconnaissance → deterministic paced playback" — context (the §0030 judge findings, the patch sprawl, the user's "prophet" framing), the choice (recon builds a Performance, PerformanceDirector plays it back, one re-plan checkpoint), what it preserves/removes (the lists from the spec), the open risk (recon quality is the bet; `replanCount` is the canary), and the validation result from steps 1-3.
- `docs/architecture.md`: update the ports list (`IReconnoiterer`, `IDirector`, `IPageSession`, `IRecordingJudge`; remove `IPlanner`, `IFastDecider`, `IClickVerifier`).
- `docs/glossary.md`: add `Performance`, `reconnaissance`, `re-plan checkpoint`, `ResolvedTarget`; remove `DirectorBriefing`, `draftSequence`, `FastDecider`.
- `docs/naturalness-catalog.md`: C4 (opening hold) — note it's now a planned `dwell` step the reconnoiterer emits as the first step, not a Director-side wait; A6 (inter-scroll micro-pause) — note it's now the `dwellAfterMs` on each `scroll` step in the Performance.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/decisions.md docs/architecture.md docs/glossary.md docs/naturalness-catalog.md
git commit -m "docs: prophet recording — ADR §0034 + state table + glossary (§0034)"
```

- [ ] **Step 7: Final review** — dispatch a code reviewer (or read the diff yourself) over the whole change set: does the codebase actually got *simpler* (one reasoning component, one recovery path, one product artifact)? Are there orphaned imports / dead exports? Is `IReconnoiterer` used the same way in the runner and the director (same instance, reused)? Is the `replan` entry written on every re-plan? Fix anything found, commit, done.

---

## Self-Review (filled in by the plan author)

**1. Spec coverage:**
- `Performance` domain type → Task 1 ✓
- `IReconnoiterer` port + `ReconInput` (incl. `priorSteps`) → Task 3 ✓
- `LlmReconnoiterer` adapter (observe → LLM → resolve targets → validate; drop unresolvable; `ReconError`) → Task 4 ✓
- `PerformanceDirector` playback (reuses §0017/§0018/§0031 primitives via `session.*`) → Task 5 ✓
- Re-plan checkpoint + `maxReplans` + the one-recovery-path semantics (subsumes §0027/§0028/§0032) → Task 6 ✓
- `RecordJobRunner` swap; drop pre-fire; `RunResult.performance`; `replanCount`; `computeIntentSatisfaction` input change (§0033 logic preserved) → Task 7 ✓
- `replan` action-log entry → Task 2 ✓
- Config: `llmReconModel` / `maxReplans` add, streaming knobs remove → Task 0 + Task 8 ✓
- Removals (IClickVerifier, IFastDecider/LlmFastDecider, directorClickRejectionLimit, about:blank branch, pre-fire, DirectorBriefing/draftSequence, decider/planner/click-verifier prompts, StreamingDirector, LlmPlanner/IPlanner) → Task 8 ✓
- Scripts + regression rewire + categorical asserts → Task 9 ✓
- Acceptance (Recordly run, judge `pacing` ≠ fail, `replanCount` ≤ 1) → Task 10 step 2 ✓
- Docs (CLAUDE.md, ADR §0034, architecture, glossary, naturalness-catalog) → Task 10 step 5 ✓
- Preserved: rendering primitives, recording lifecycle, ffmpeg trim, BlockerPrelude (modulo the FastDecider coupling — flagged as a contained follow-up), ActionEvidence, opening hold (→ planned dwell), §0031 (→ planner defaults / per-step), §0030 judge, intentSatisfaction + §0033 → covered across Tasks 5/7/9/10 ✓
- **Gap noted:** `BlockerPrelude`'s internal `IFastDecider` coupling. Resolution in Task 9's implementer note: pass `null` for blockerPrelude + file a follow-up, OR give BlockerPrelude its own small LLM client. The plan does not fully resolve this — it's explicitly deferred. Acceptable: the recon prompt already handles on-page blockers, so a null BlockerPrelude is a tolerable interim.

**2. Placeholder scan:** No "TBD"/"implement later". The "implementer note" callouts give concrete options, not vague directives. The one genuine open item (BlockerPrelude) is explicitly scoped as a deferred follow-up with a stated interim.

**3. Type consistency:** `Performance` / `PerformanceStep` / `ResolvedTarget` / `ScrollEasing` / `ExpectAfter` / `PerformanceKey` — same names across Tasks 1, 4, 5, 6. `IReconnoiterer.recon(input, session)` / `ReconInput` — same in Tasks 3, 4, 6, 7. `DirectorReport { totalMs, stepsExecuted, replanCount, endReason }` — same in Tasks 5, 6, 7, 9. `IDirector.run(performance, session)` — same in Tasks 5, 7, 9. `replan` entry `{ t, type, fromStepIndex, reason, details, scrollY, viewport }` — same in Tasks 2, 6. Config `llmReconModelResolved` / `maxReplans` — same in Tasks 0, 4, 6. ✓
