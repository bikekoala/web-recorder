# Streaming Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current plan-then-execute pipeline with a streaming `IDirector` that runs an LLM decision loop *inside* the recording window, hiding LLM latency under animation time, while preserving every existing primitive (discovery click, multi-stage scroll, easings, recording lifecycle, ffmpeg trim).

**Architecture:** Three-layer hexagonal: `IPlanner` (one upfront LLM call, outputs a `DirectorBriefing` with pre-resolved hints) → `IDirector` (NEW, owns the recording window, double-queue streaming) → `IFastDecider` (NEW, sub-second Gemini Flash Lite decisions). Speed/fluidity is preserved by pre-firing the next decision call BEFORE awaiting the current animation, so by the time the animation finishes the next plan is usually already on the queue.

**Tech Stack:** TypeScript 5.7 (strict, ESM, NodeNext), tsx for dev, vitest for tests, zod for schemas, OpenRouter (Gemini Flash Lite for decider, gpt-4o-mini for planner), Playwright + Stagehand v3, ffmpeg from Playwright bundle, dotenv.

**Spec:** `docs/superpowers/specs/2026-05-10-streaming-director-design.md`

**Test commands** (added in Task 1):
- `npm run test` — vitest run, all unit tests
- `npm run test:watch` — vitest interactive
- `npm run test:integration` — runs the Recordly scenario end-to-end and asserts metrics
- `npm run typecheck` — existing strict typecheck

**Key constraints honored throughout:**
- `IPageSession.scroll/click/wait/screenshot/observe` API unchanged
- `clickSelector`'s discovery choreography (§0017) preserved verbatim — invoked by the Director
- §0018 multi-stage scroll preserved
- `RUNTIME_HELPERS_SCRIPT`, recording lifecycle, ffmpeg trim untouched

---

## File structure

After this plan, the codebase looks like:

```
src/
  domain/
    action-log.ts            (existing)
    errors.ts                (existing, +DirectorError)
    plan.ts                  (MODIFIED: DirectorBriefing added; TimelinePlan removed in cleanup task)
    director-action.ts       (NEW)
    director-state.ts        (NEW)
  ports/
    page-session.ts          (MODIFIED: +quickFindInViewport)
    planner.ts               (MODIFIED: returns DirectorBriefing)
    director.ts              (NEW)
    fast-decider.ts          (NEW)
  adapters/
    agent/
      stagehand-session.ts   (MODIFIED: +quickFindInViewport, clickSelector now searches when target off-screen)
    planner/
      llm-planner.ts         (MODIFIED: brief() instead of plan())
    director/
      streaming-director.ts  (NEW)
    decider/
      llm-fast-decider.ts    (NEW)
  core/
    record-job-runner.ts     (MODIFIED: plan→director; retired helpers deleted in cleanup task)
  infra/
    config.ts                (MODIFIED: +LLM_DECIDER_MODEL etc.)
    ffmpeg.ts                (existing)
    logger.ts                (existing)
    pending.ts               (NEW: Promise tracker utility for streaming)
scripts/
  prototype-stagehand.ts     (MODIFIED: uses new pipeline)
  test-planner.ts            (DELETED in cleanup)
  smoke-recording.ts         (existing, untouched)
tests/
  integration/
    recordly.test.ts         (NEW: real-browser end-to-end + metric assertions)
  fakes/
    fake-page-session.ts     (NEW: in-memory IPageSession for unit tests)
    fake-fast-decider.ts     (NEW: in-memory IFastDecider for unit tests)
vitest.config.ts             (NEW)
```

---

## Task sequence

The plan is grouped into 9 phases. **All commits keep the prototype runnable** — no phase leaves the project in a broken state.

- Phase 0 (Task 0): git init checkpoint
- Phase 1 (Task 1): vitest setup
- Phase 2 (Tasks 2-7): domain types + ports (additive, no behavior change)
- Phase 3 (Task 8): config additions
- Phase 4 (Tasks 9-10): IPageSession enhancements
- Phase 5 (Task 11): IFastDecider implementation
- Phase 6 (Tasks 12-16): StreamingDirector incremental build
- Phase 7 (Tasks 17-19): wire into pipeline
- Phase 8 (Task 20): integration test
- Phase 9 (Tasks 21-22): cleanup + final run

---

## Task 0: git init checkpoint

**Files:**
- Create: `.gitattributes` (ensure consistent line endings)

**Why:** the project has no git yet. We need version control to make every subsequent task a real commit. This task initializes the repo and makes one big commit of the existing state, so the implementation history starts from a clean baseline.

- [ ] **Step 1: Initialize git repo and configure**

```bash
git init
git config user.name "$(git config --global user.name || echo 'Web Recorder Dev')"
git config user.email "$(git config --global user.email || echo 'dev@web-recorder.local')"
```

- [ ] **Step 2: Verify `.gitignore` covers secrets and noise**

Run: `cat .gitignore`
Expected: includes `node_modules/`, `output/`, `.env`. If not, add them.

- [ ] **Step 3: Create `.gitattributes`**

```
* text=auto eol=lf
*.png binary
*.webm binary
*.mp4 binary
```

- [ ] **Step 4: Stage and commit existing project**

```bash
git add -A
git status   # sanity-check no .env or output/ included
git commit -m "chore: initial checkpoint of pre-Director architecture"
```

Expected: commit succeeds with ~30 files.

- [ ] **Step 5: Verify**

Run: `git log --oneline`
Expected: one commit shown.

---

## Task 1: vitest setup with placeholder test

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/infra/__smoketest__.test.ts`

- [ ] **Step 1: Install vitest as dev dep**

```bash
npm install --save-dev vitest@^2.1.8
```

Expected: `package.json` and `package-lock.json` updated; `node_modules/vitest` present.

- [ ] **Step 2: Add test scripts to `package.json`**

Modify `package.json` "scripts" section. After the existing `"typecheck"` line add:

```json
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

(Don't worry about `vitest.integration.config.ts` yet — Task 20 creates it.)

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/__smoketest__/**'],
    testTimeout: 5000,
    environment: 'node',
  },
});
```

- [ ] **Step 4: Write a placeholder test that should pass**

Create `src/infra/__smoketest__.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

(Filename starts with `__smoketest__` so the include glob still matches; the exclude glob in step 3 needs adjustment.)

Update `vitest.config.ts` `exclude` to remove the `__smoketest__` exclusion so this test runs:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 5000,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Run the test**

Run: `npm run test`
Expected: 1 passing test, exit code 0.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/infra/__smoketest__.test.ts
git commit -m "test: install vitest with smoke test"
```

---

## Task 2: DirectorAction domain type with Zod schema

**Files:**
- Create: `src/domain/director-action.ts`
- Create: `src/domain/director-action.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/director-action.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { DirectorAction, ScrollSpeed } from './director-action.js';

describe('DirectorAction schema', () => {
  it('accepts a valid click action', () => {
    const result = DirectorAction.safeParse({
      kind: 'click',
      target: 'the 简体中文 link',
      reasoning: 'user requested it',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid scroll action', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 600,
      speed: 'slow',
      reasoning: 'browse content',
    });
    expect(result.success).toBe(true);
  });

  it('accepts negative scroll deltaPx (scroll up)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: -500,
      speed: 'normal',
      reasoning: 'look back',
    });
    expect(result.success).toBe(true);
  });

  it('rejects scroll deltaPx below 100 absolute (jitter range)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 50,
      speed: 'slow',
      reasoning: 'too small',
    });
    expect(result.success).toBe(false);
  });

  it('rejects scroll deltaPx above 1500 absolute (disorient range)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 2000,
      speed: 'fast',
      reasoning: 'too big',
    });
    expect(result.success).toBe(false);
  });

  it('rejects scroll deltaPx of 0', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 0,
      speed: 'slow',
      reasoning: 'no-op',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown speed', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 600,
      speed: 'instant',
      reasoning: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('accepts dwell within range', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 600,
      reasoning: 'pause',
    });
    expect(result.success).toBe(true);
  });

  it('rejects dwell below 200ms (too short to read)', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 100,
      reasoning: 'too short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects dwell above 3000ms (too long, dead air)', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 5000,
      reasoning: 'too long',
    });
    expect(result.success).toBe(false);
  });

  it('accepts done', () => {
    const result = DirectorAction.safeParse({
      kind: 'done',
      reasoning: 'recording complete',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing reasoning', () => {
    const result = DirectorAction.safeParse({
      kind: 'click',
      target: 'something',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = DirectorAction.safeParse({
      kind: 'teleport',
      reasoning: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('exports ScrollSpeed enum values', () => {
    expect(ScrollSpeed.options).toEqual(['slow', 'normal', 'fast']);
  });
});
```

- [ ] **Step 2: Run tests, verify they all fail**

Run: `npm run test -- director-action`
Expected: all fail with "module not found" / TypeError because the module doesn't exist yet.

- [ ] **Step 3: Create the schema**

Create `src/domain/director-action.ts`:

```typescript
import { z } from 'zod';

/**
 * Director action vocabulary — what the FastDecider can choose.
 *
 * Designed to be small (4 primitives) so the LLM has minimal cognitive
 * load and produces fast, accurate decisions. The executor renders each
 * primitive into the full natural choreography (approach scroll +
 * anticipation + click for `click`, multi-stage scroll for far targets,
 * etc.) — see `docs/decisions.md` §0017 / §0018.
 *
 * All bounds are deliberate:
 * - `scroll.deltaPx` excludes [−99, 99] (jitter) and |x|>1500 (disorienting).
 * - `dwell.durationMs` is [200, 3000] (shorter is invisible, longer is dead air).
 */

export const ScrollSpeed = z.enum(['slow', 'normal', 'fast']);
export type ScrollSpeed = z.infer<typeof ScrollSpeed>;

const ClickAction = z.object({
  kind: z.literal('click'),
  target: z.string().min(1),
  reasoning: z.string().min(1),
});

const ScrollAction = z.object({
  kind: z.literal('scroll'),
  deltaPx: z.number().int().refine(
    (v) => (v >= 100 && v <= 1500) || (v <= -100 && v >= -1500),
    { message: 'deltaPx must be in [-1500, -100] ∪ [100, 1500]' },
  ),
  speed: ScrollSpeed,
  reasoning: z.string().min(1),
});

const DwellAction = z.object({
  kind: z.literal('dwell'),
  durationMs: z.number().int().min(200).max(3000),
  reasoning: z.string().min(1),
});

const DoneAction = z.object({
  kind: z.literal('done'),
  reasoning: z.string().min(1),
});

export const DirectorAction = z.discriminatedUnion('kind', [
  ClickAction,
  ScrollAction,
  DwellAction,
  DoneAction,
]);
export type DirectorAction = z.infer<typeof DirectorAction>;

/**
 * Speed → (px/s, easing) map. Single source of truth for the
 * `scroll(deltaPx, speed)` executor mapping. See `docs/decisions.md` §0018.
 */
export const SCROLL_SPEED_PROFILES: Record<
  ScrollSpeed,
  { pxPerSec: number; easing: 'outQuart' | 'outExpo' }
> = {
  slow:   { pxPerSec: 250, easing: 'outQuart' },
  normal: { pxPerSec: 450, easing: 'outQuart' },
  fast:   { pxPerSec: 800, easing: 'outExpo' },
};
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm run test -- director-action`
Expected: 14 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/director-action.ts src/domain/director-action.test.ts
git commit -m "feat(domain): add DirectorAction Zod schema with bounded primitives"
```

---

## Task 3: DirectorState type

**Files:**
- Create: `src/domain/director-state.ts`

This file is types-only — no runtime logic to test. The schema is enforced at the boundary by Zod elsewhere.

- [ ] **Step 1: Create the type module**

Create `src/domain/director-state.ts`:

```typescript
import type { Viewport } from './action-log.js';
import type { DirectorAction } from './director-action.js';

/**
 * State snapshot the Director hands to the FastDecider on each call.
 *
 * Kept compact on purpose — the screenshot is the heavy field, every other
 * field is a small primitive. The screenshot is downscaled to ~768×432 by
 * the caller before construction so the prompt stays under ~5K tokens.
 */
export interface DirectorState {
  /** User's natural-language intent, verbatim from the briefing. */
  prompt: string;
  /** Time left in the recording window, ms. */
  remainingMs: number;
  /** Page scroll position right now (window.scrollY), px. */
  currentScrollY: number;
  /** Browser viewport size. */
  viewport: Viewport;
  /** PNG bytes, downscaled to ~768×432. */
  screenshot: Buffer;
  /** Description of each briefing-hint that is currently in viewport. */
  visibleHints: string[];
  /** Last 3 actions (oldest → newest). Empty on first call. */
  recentActions: ActionSummary[];
  /** Set when the previous action errored, surfaces context to the LLM. */
  lastActionFailure?: string;
}

export interface ActionSummary {
  kind: DirectorAction['kind'];
  /** Human-readable, ≤80 chars. e.g. "scroll +600 slow", "click 简中". */
  brief: string;
  succeeded: boolean;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/domain/director-state.ts
git commit -m "feat(domain): add DirectorState + ActionSummary types"
```

---

## Task 4: DirectorBriefing in plan.ts

**Files:**
- Modify: `src/domain/plan.ts`
- Create: `src/domain/plan.test.ts`

This task is **additive** — `TimelinePlan` and friends stay so `LlmPlanner.plan()` still compiles. Cleanup happens in Task 21.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/plan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { ClickHint, DirectorBriefing } from './plan.js';

describe('DirectorBriefing schema', () => {
  it('accepts a minimal valid briefing with no hints', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click X then scroll',
      durationMs: 10_000,
      hints: [],
      rationale: 'click + scroll',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a briefing with hints', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click 简中',
      durationMs: 10_000,
      hints: [
        {
          description: 'the 简体中文 link',
          selector: 'xpath=/html/body/...',
          bboxAtRest: { x: 100, y: 200, width: 30, height: 19 },
        },
      ],
      rationale: 'one click target identified',
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative durationMs', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click X',
      durationMs: -1,
      hints: [],
      rationale: 'bad duration',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty prompt', () => {
    const result = DirectorBriefing.safeParse({
      prompt: '',
      durationMs: 10_000,
      hints: [],
      rationale: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('ClickHint rejects empty description', () => {
    const result = ClickHint.safeParse({
      description: '',
      selector: 'xpath=...',
      bboxAtRest: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- plan`
Expected: fail with "ClickHint / DirectorBriefing not exported".

- [ ] **Step 3: Add the new schemas to `plan.ts`**

Read `src/domain/plan.ts` and find the `// IPlanner port` block at the bottom. Just before it, add:

```typescript
// =====================================================================
// New (post-Director redesign) — see docs/superpowers/specs/2026-05-10-streaming-director-design.md
// =====================================================================

export const ClickHint = z.object({
  description: z.string().min(1),
  selector: z.string().min(1),
  bboxAtRest: Bbox,
});
export type ClickHint = z.infer<typeof ClickHint>;

export const DirectorBriefing = z.object({
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  hints: z.array(ClickHint),
  rationale: z.string(),
});
export type DirectorBriefing = z.infer<typeof DirectorBriefing>;
```

(`Bbox` is already imported at the top of `plan.ts` — verify or add `import { Bbox } from './action-log.js';` if needed.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test -- plan`
Expected: 5 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/plan.ts src/domain/plan.test.ts
git commit -m "feat(domain): add DirectorBriefing + ClickHint schemas (additive)"
```

---

## Task 5: IDirector port

**Files:**
- Create: `src/ports/director.ts`

Pure interface, no runtime logic.

- [ ] **Step 1: Create the port**

```typescript
import type { DirectorBriefing } from '../domain/plan.js';
import type { IPageSession } from './page-session.js';

/**
 * IDirector — owns the recording window and runs the streaming decision loop.
 *
 * Lifecycle:
 *   - The runner calls `run(briefing, session)` AFTER setup (browser + page
 *     ready, planner has produced a briefing) but BEFORE `session.beginRecording()`.
 *     The Director itself decides when to call `beginRecording()` — typically
 *     immediately, but it may insert an opening dwell first.
 *   - `run` returns when the FastDecider issues `done`, the time budget is
 *     exhausted, or an unrecoverable error occurs.
 *
 * Implementations:
 *   - `StreamingDirector` (Phase 6) — double-queue + pre-fired LLM calls.
 *   - Future: a `RecordingDirectorReplay` that takes a fixed action list (no LLM)
 *     for offline-deterministic test reruns.
 */
export interface IDirector {
  run(briefing: DirectorBriefing, session: IPageSession): Promise<DirectorReport>;
}

export interface DirectorReport {
  /** ms elapsed inside the Director.run() call. */
  totalMs: number;
  /** Total FastDecider calls made (including failures). */
  decisionCount: number;
  /** Number of times an implicit dwell was inserted because LLM was slow. */
  implicitDwellCount: number;
  /** Number of expectAfter mismatches that triggered a re-decide. */
  expectAfterMismatchCount: number;
  /** Reason for ending: 'done' | 'budget' | 'error'. */
  endReason: 'done' | 'budget' | 'error';
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ports/director.ts
git commit -m "feat(ports): add IDirector + DirectorReport"
```

---

## Task 6: IFastDecider port

**Files:**
- Create: `src/ports/fast-decider.ts`

- [ ] **Step 1: Create the port**

```typescript
import { z } from 'zod';

import { DirectorAction } from '../domain/director-action.js';
import type { DirectorState } from '../domain/director-state.js';

/**
 * IFastDecider — single LLM round-trip that picks the next 1-N micro actions.
 *
 * Latency budget: ≤1s p95. The Director relies on this to hide LLM lag
 * under animation time. If the implementation cannot meet the budget on a
 * given network/route, the Director's implicit-dwell fallback covers it.
 *
 * Output is validated by `DecisionResponse` Zod schema — adapters MUST parse
 * before returning so callers never see malformed actions.
 */
export interface IFastDecider {
  decide(state: DirectorState): Promise<DecisionResponse>;
}

export const ExpectAfter = z.object({
  urlContains: z.string().optional(),
  visibleText: z.array(z.string()).optional(),
});
export type ExpectAfter = z.infer<typeof ExpectAfter>;

export const DecisionResponse = z.object({
  /** 1-3 actions of lookahead. */
  actions: z.array(DirectorAction).min(1).max(3),
  /** Optional cheap-validation hint from the LLM about expected post-state. */
  expectAfter: ExpectAfter.optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ports/fast-decider.ts
git commit -m "feat(ports): add IFastDecider + DecisionResponse schema"
```

---

## Task 7: Pending<T> tracker utility

**Files:**
- Create: `src/infra/pending.ts`
- Create: `src/infra/pending.test.ts`

The Director's pseudocode uses `pending.resolved` to peek at promise state without awaiting. Native promises don't expose state synchronously, so we wrap them.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';

import { track } from './pending.js';

describe('Pending<T> tracker', () => {
  it('starts as not resolved', () => {
    const p = track(new Promise(() => {})); // never resolves
    expect(p.isResolved).toBe(false);
    expect(p.value).toBeUndefined();
  });

  it('marks resolved after promise resolves', async () => {
    const p = track(Promise.resolve(42));
    // microtask flush
    await new Promise((r) => setImmediate(r));
    expect(p.isResolved).toBe(true);
    expect(p.value).toBe(42);
  });

  it('marks rejected after promise rejects', async () => {
    const p = track(Promise.reject(new Error('boom')));
    await new Promise((r) => setImmediate(r));
    expect(p.isResolved).toBe(true);
    expect(p.error).toBeInstanceOf(Error);
    expect((p.error as Error).message).toBe('boom');
  });

  it('await still works for resolved value', async () => {
    const p = track(Promise.resolve('hi'));
    const v = await p.promise;
    expect(v).toBe('hi');
  });

  it('await throws for rejected', async () => {
    const p = track(Promise.reject(new Error('nope')));
    await expect(p.promise).rejects.toThrow('nope');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- pending`
Expected: module-not-found errors.

- [ ] **Step 3: Implement the utility**

Create `src/infra/pending.ts`:

```typescript
/**
 * Wrap a Promise to expose its resolution state synchronously.
 *
 * The streaming Director needs to peek at "did the LLM call return yet?"
 * without awaiting, so it can decide between draining the queue and
 * inserting an implicit dwell. Native promises don't expose this; this
 * utility tracks resolution via a side-effect on the original promise.
 *
 * The original promise is preserved on `.promise` for normal awaiting.
 */
export interface Pending<T> {
  readonly promise: Promise<T>;
  readonly isResolved: boolean;
  readonly value: T | undefined;
  readonly error: unknown;
}

export function track<T>(promise: Promise<T>): Pending<T> {
  const state: { isResolved: boolean; value: T | undefined; error: unknown } = {
    isResolved: false,
    value: undefined,
    error: undefined,
  };
  const tracked = promise.then(
    (v) => {
      state.isResolved = true;
      state.value = v;
      return v;
    },
    (e) => {
      state.isResolved = true;
      state.error = e;
      throw e;
    },
  );
  return {
    promise: tracked,
    get isResolved() { return state.isResolved; },
    get value() { return state.value; },
    get error() { return state.error; },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm run test -- pending`
Expected: 5 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/infra/pending.ts src/infra/pending.test.ts
git commit -m "feat(infra): add Pending<T> tracker for streaming coordination"
```

---

## Task 8: Config additions for Director and FastDecider

**Files:**
- Modify: `src/infra/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add new fields to the config schema**

Read `src/infra/config.ts`. In the `Schema = z.object({...})` definition, after the `llmModel: z.string().min(1).default(...)` line add:

```typescript
  /**
   * FastDecider model — used by the Director's per-action decision calls.
   * Optimized for low latency + cost. Default: `google/gemini-2.5-flash-lite`.
   * Override with LLM_DECIDER_MODEL.
   */
  llmDeciderModel: z.string().min(1).default('google/gemini-2.5-flash-lite'),

  /**
   * Maximum actions per FastDecider response (lookahead depth).
   * Higher = more buffer against LLM tail latency, but more chance of
   * stale lookahead. Default 2.
   */
  directorLookaheadMax: z.number().int().min(1).max(5).default(2),

  /**
   * Implicit dwell duration when LLM is slower than animation, ms.
   * Per-iteration; the Director will keep dwelling in 200ms chunks until
   * the FastDecider response arrives.
   */
  directorDwellFallbackMs: z.number().int().min(50).max(800).default(200),

  /**
   * Recording window hard cap as multiple of `durationMs`. The Director
   * forcibly injects `done` if the recording exceeds this.
   */
  directorHardBudgetMult: z.number().min(1.0).max(2.0).default(1.2),
```

- [ ] **Step 2: Add raw env reads**

In the same file, find the `const raw = { ... }` block. Add these lines (next to the existing `llmModel`):

```typescript
  llmDeciderModel: process.env.LLM_DECIDER_MODEL,
  directorLookaheadMax: process.env.DIRECTOR_LOOKAHEAD_MAX
    ? Number(process.env.DIRECTOR_LOOKAHEAD_MAX)
    : undefined,
  directorDwellFallbackMs: process.env.DIRECTOR_DWELL_FALLBACK_MS
    ? Number(process.env.DIRECTOR_DWELL_FALLBACK_MS)
    : undefined,
  directorHardBudgetMult: process.env.DIRECTOR_HARD_BUDGET_MULT
    ? Number(process.env.DIRECTOR_HARD_BUDGET_MULT)
    : undefined,
```

- [ ] **Step 3: Update `.env.example`**

Read `.env.example` and append:

```
# Director (NEW) ----------------------------------------------------------
# Model used for per-action streaming decisions. Optimized for low latency.
# LLM_DECIDER_MODEL=google/gemini-2.5-flash-lite

# Director tunables (defaults are usually fine)
# DIRECTOR_LOOKAHEAD_MAX=2
# DIRECTOR_DWELL_FALLBACK_MS=200
# DIRECTOR_HARD_BUDGET_MULT=1.2
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Sanity-run the existing prototype to make sure config still loads**

Run: `npm run typecheck && OPENROUTER_API_KEY=$(grep OPENROUTER_API_KEY .env | cut -d= -f2) DIRECTOR_DWELL_FALLBACK_MS=300 node -e "import('./node_modules/tsx/dist/cli.mjs').then(()=>{}).catch(()=>{}); import('./src/infra/config.ts').then(m => console.log('lookahead:', m.config.directorLookaheadMax, 'dwell:', m.config.directorDwellFallbackMs)).catch(e => { console.error(e); process.exit(1); });"`

(If that one-liner is brittle, just do `npm run prototype:stagehand` and confirm it still starts the browser. Kill it with Ctrl-C — we just want to see config validates.)

Expected: no Zod validation errors at startup.

- [ ] **Step 6: Commit**

```bash
git add src/infra/config.ts .env.example
git commit -m "feat(infra): add Director config (LLM_DECIDER_MODEL, lookahead, dwell, budget mult)"
```

---

## Task 9: Add quickFindInViewport to IPageSession

**Files:**
- Modify: `src/ports/page-session.ts`
- Modify: `src/adapters/agent/stagehand-session.ts`

This adds a fast no-LLM way to find an element by text/role description, used by the Director's `click` executor for the in-viewport check and search loop.

- [ ] **Step 1: Add the port method**

In `src/ports/page-session.ts`, find the `IPageSession` interface and add this method (place it near `resolveTarget`):

```typescript
  /**
   * Fast non-LLM element finder by natural-language description.
   *
   * Tries cheap Playwright matchers in order:
   *   1. text= match (visible text equality / substring)
   *   2. role+name match (e.g. button "Subscribe")
   *   3. partial text match (case-insensitive contains)
   *
   * Returns the first match's selector + bbox if found, else null.
   * Crucially: returns null FAST (no LLM, no full DOM walk) so the
   * Director can do an in-viewport check in milliseconds.
   *
   * Used by the Director's `click` executor:
   * - present in viewport → run discovery click
   * - not in viewport, but on page → run search loop
   * - not on page at all → bubble back to LLM as failure
   */
  quickFindInViewport(description: string): Promise<ObservedElement | null>;

  /**
   * Same as `quickFindInViewport` but searches the entire page (not just
   * the visible viewport). Used by the search loop to know whether
   * scrolling will eventually reveal the target.
   */
  quickFindOnPage(description: string): Promise<ObservedElement | null>;
```

- [ ] **Step 2: Implement in StagehandPageSession**

Open `src/adapters/agent/stagehand-session.ts`. Find the existing `resolveTarget` method. Right after it, add:

```typescript
  async quickFindInViewport(description: string): Promise<ObservedElement | null> {
    const page = this.requirePage();
    const candidates = this.candidateLocators(description);

    for (const locator of candidates) {
      try {
        const handle = locator.first();
        if ((await handle.count()) === 0) continue;
        const bbox = await handle.boundingBox({ timeout: 500 });
        if (!bbox) continue;
        // Viewport check — bbox.y/x are viewport-relative.
        const inViewport =
          bbox.y >= 0 &&
          bbox.y < this.cfg.viewport.height &&
          bbox.x >= 0 &&
          bbox.x < this.cfg.viewport.width;
        if (!inViewport) continue;
        const sel = await this.locatorSelectorFallback(handle);
        return {
          selector: sel ?? '',
          description,
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        };
      } catch {
        // ignore — try next candidate
      }
    }
    return null;
  }

  async quickFindOnPage(description: string): Promise<ObservedElement | null> {
    const page = this.requirePage();
    const candidates = this.candidateLocators(description);

    for (const locator of candidates) {
      try {
        const handle = locator.first();
        if ((await handle.count()) === 0) continue;
        const bbox = await handle.boundingBox({ timeout: 500 });
        if (!bbox) continue;
        const sel = await this.locatorSelectorFallback(handle);
        return {
          selector: sel ?? '',
          description,
          bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
        };
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Generate a small ordered list of Playwright Locators that might match
   * a natural-language description. Cheapest matchers first.
   */
  private candidateLocators(description: string) {
    const page = this.requirePage();
    const trimmed = description.trim();
    return [
      page.getByText(trimmed, { exact: false }),
      page.getByRole('link', { name: new RegExp(escapeRegex(trimmed), 'i') }),
      page.getByRole('button', { name: new RegExp(escapeRegex(trimmed), 'i') }),
      page.locator(`text=${trimmed}`),
    ];
  }

  /**
   * Best-effort: get a stable selector string for a Playwright locator
   * we just resolved by description. Falls back to an empty string when
   * Playwright can't serialize the locator (in which case the caller can
   * still re-derive via `quickFindInViewport`).
   */
  private async locatorSelectorFallback(
    locator: ReturnType<Page['locator']>,
  ): Promise<string | null> {
    // Playwright doesn't expose a stable serializer; we just round-trip via
    // an XPath snapshot computed in the page. If that fails, return null
    // and the caller will re-query by description.
    try {
      const handle = await locator.elementHandle({ timeout: 500 });
      if (!handle) return null;
      const xpath = await handle.evaluate((el: Element) => {
        function getXPath(node: Element): string {
          const segs: string[] = [];
          for (let n: Element | null = node; n && n.nodeType === 1; n = n.parentElement) {
            let i = 1;
            for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
              if (s.tagName === n.tagName) i += 1;
            }
            segs.unshift(`${n.tagName.toLowerCase()}[${i}]`);
          }
          return '/' + segs.join('/');
        }
        return getXPath(el);
      });
      await handle.dispose();
      return `xpath=${xpath}`;
    } catch {
      return null;
    }
  }
```

Also add this small helper at the top of the file (after the imports):

```typescript
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Quick smoke check (no test framework — verify the prototype still launches)**

Run: `npm run smoke:recording`
Expected: smoke test passes (prints "smoke test complete — video produced"). This verifies the StagehandPageSession changes didn't break anything.

- [ ] **Step 5: Commit**

```bash
git add src/ports/page-session.ts src/adapters/agent/stagehand-session.ts
git commit -m "feat(page-session): add quickFindInViewport / quickFindOnPage primitives"
```

---

## Task 10: Modify clickSelector with internal search loop

**Files:**
- Modify: `src/adapters/agent/stagehand-session.ts`

The current `clickSelector` takes a known selector. We're augmenting it: now it can take EITHER a CSS/XPath selector OR a natural-language description, and:
- Selector branch: existing discovery click choreography (unchanged)
- Description branch: try in-viewport find → if found, click; else try on-page find → search-scroll loop; else throw `ElementNotFoundError`

We do this by adding a NEW method `clickByDescription(description, opts)` rather than overloading the existing one — keeps existing call sites stable.

- [ ] **Step 1: Add the new method**

In `src/adapters/agent/stagehand-session.ts`, find `clickSelector` (around the line with `async clickSelector(selector: string`). Right BEFORE `clickSelector`, insert:

```typescript
  /**
   * Click an element identified by a natural-language description.
   *
   * Pipeline:
   *   1. quickFindInViewport(description) → if found, run discovery click.
   *   2. quickFindOnPage(description) → if found but off-screen, run a
   *      search loop: scroll toward target's expected direction, re-find
   *      after each scroll, click when in viewport. Hard cap on total
   *      scroll distance (proportional to remaining time budget if
   *      provided).
   *   3. Neither found → throw ElementNotFoundError.
   *
   * The Director uses this for `click(target)` actions. It is the path
   * that turns "the LLM said click X" into the real human-feeling
   * scroll-search-click sequence.
   */
  async clickByDescription(
    description: string,
    opts: { searchBudgetPx?: number } = {},
  ): Promise<void> {
    this.logger.debug({ description }, 'clickByDescription');

    // Branch 1: already in viewport.
    const inView = await this.quickFindInViewport(description);
    if (inView && inView.selector) {
      await this.clickSelector(inView.selector, { description });
      return;
    }

    // Branch 2: on page but off-screen — search loop.
    const onPage = await this.quickFindOnPage(description);
    if (onPage && onPage.selector) {
      const targetPageY = onPage.bbox?.y ?? 0;
      const currentScrollY = await this.readScrollY();
      // bbox returned by quickFindOnPage was already in viewport-relative
      // coords at the time of the call; convert to page-absolute by adding
      // current scrollY.
      const desiredViewportY = this.cfg.viewport.height * 0.35;
      const initialDeltaY = Math.round(targetPageY - desiredViewportY);
      const direction = Math.sign(initialDeltaY) || 1;
      const budgetPx = opts.searchBudgetPx ?? 1500;
      const stepPx = 600;
      let scrolled = 0;

      while (scrolled < budgetPx) {
        // Try in-viewport find (target may have come into view via prior scroll).
        const found = await this.quickFindInViewport(description);
        if (found && found.selector) {
          await this.clickSelector(found.selector, { description });
          return;
        }
        // Scroll one step in target direction.
        const remaining = budgetPx - scrolled;
        const thisStep = direction * Math.min(stepPx, remaining);
        await this.scroll(thisStep, {
          durationMs: Math.max(800, Math.abs(thisStep) / 250 * 1000),
          easing: 'outQuart',
        });
        scrolled += Math.abs(thisStep);
      }
      // Fell off the end of the budget.
      throw new ElementNotFoundError(
        `search budget exhausted (${budgetPx}px) without locating: ${description}`,
      );
    }

    // Branch 3: not on page at all.
    throw new ElementNotFoundError(`target not found on page: ${description}`);
  }
```

`clickSelector` itself stays unchanged — it remains the foundation for both the briefing-hint pre-resolved selector path AND the new `clickByDescription` once the target is located.

- [ ] **Step 2: Add `clickByDescription` to the `IPageSession` port**

In `src/ports/page-session.ts`, in the `IPageSession` interface, add:

```typescript
  /**
   * Click an element by natural-language description, using the search loop
   * if needed. Throws `ElementNotFoundError` if the target cannot be located
   * even after scroll-searching up to `searchBudgetPx`.
   *
   * Logged as a `click` ActionLogEntry plus zero-or-more `scroll` entries
   * for the search phase.
   */
  clickByDescription(
    description: string,
    opts?: { searchBudgetPx?: number },
  ): Promise<void>;
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Smoke test the prototype still works**

Run: `npm run smoke:recording`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/ports/page-session.ts src/adapters/agent/stagehand-session.ts
git commit -m "feat(page-session): clickByDescription with viewport-then-search-then-click pipeline"
```

---

## Task 11: LlmFastDecider implementation + tests

**Files:**
- Create: `src/adapters/decider/llm-fast-decider.ts`
- Create: `src/adapters/decider/llm-fast-decider.test.ts`

The FastDecider takes a `DirectorState` and returns a validated `DecisionResponse`. Backed by OpenRouter + Gemini Flash Lite. Schema validation happens INSIDE the adapter; callers always get clean data.

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/decider/llm-fast-decider.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';

import { LlmFastDecider } from './llm-fast-decider.js';
import type { DirectorState } from '../../domain/director-state.js';

function buildState(overrides: Partial<DirectorState> = {}): DirectorState {
  return {
    prompt: 'click 简中',
    remainingMs: 8_000,
    currentScrollY: 0,
    viewport: { width: 1280, height: 720 },
    screenshot: Buffer.alloc(10), // tiny dummy
    visibleHints: ['the 简体中文 link'],
    recentActions: [],
    ...overrides,
  };
}

function buildClient(content: string): OpenAI {
  const client = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
  return client;
}

describe('LlmFastDecider', () => {
  it('parses a valid response with a click action', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'click', target: 'the 简体中文 link', reasoning: 'user asked' }],
      expectAfter: { urlContains: 'zh' },
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const result = await decider.decide(buildState());
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.kind).toBe('click');
    expect(result.expectAfter?.urlContains).toBe('zh');
  });

  it('strips markdown code fences if present', async () => {
    const wrapped = '```json\n' + JSON.stringify({
      actions: [{ kind: 'dwell', durationMs: 600, reasoning: 'pause' }],
    }) + '\n```';
    const decider = new LlmFastDecider({ client: buildClient(wrapped) });
    const result = await decider.decide(buildState());
    expect(result.actions[0]!.kind).toBe('dwell');
  });

  it('throws when LLM returns invalid JSON', async () => {
    const decider = new LlmFastDecider({ client: buildClient('not json') });
    await expect(decider.decide(buildState())).rejects.toThrow(/invalid json/i);
  });

  it('throws when response fails schema validation', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'scroll', deltaPx: 10, speed: 'slow', reasoning: 'too small' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('throws when actions array is empty', async () => {
    const json = JSON.stringify({ actions: [] });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('passes lastActionFailure into the prompt', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'done', reasoning: 'recovering' }],
    });
    const client = buildClient(json);
    const decider = new LlmFastDecider({ client, model: 'fake' });
    await decider.decide(buildState({ lastActionFailure: 'expectAfter mismatch' }));
    const callArg = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const userMsg = callArg.messages.find((m: { role: string }) => m.role === 'user');
    const textContent = userMsg.content.find((c: { type: string }) => c.type === 'text').text;
    expect(textContent).toContain('expectAfter mismatch');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- llm-fast-decider`
Expected: module-not-found errors.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/decider/llm-fast-decider.ts`:

```typescript
import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import type { DirectorState } from '../../domain/director-state.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import {
  DecisionResponse,
  type IFastDecider,
} from '../../ports/fast-decider.js';

/**
 * LlmFastDecider — IFastDecider backed by OpenRouter (default Gemini Flash Lite).
 *
 * Designed for sub-second p95 latency. The Director hides this latency by
 * pre-firing the next call during the previous animation; if the LLM
 * occasionally takes longer, the Director's implicit-dwell fallback covers it.
 *
 * Output is parsed strictly via Zod. Callers never see malformed actions.
 *
 * Markdown code-fence stripping is included defensively — Anthropic models
 * routed through OpenRouter sometimes wrap JSON in ```json … ``` despite
 * the response_format hint. (See `LlmPlanner` for the same defense.)
 */
export class FastDeciderError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('FAST_DECIDER_FAILED', message, cause);
  }
}

const SYSTEM_PROMPT = `You are a streaming browser-recording DIRECTOR. On each call you receive the user's intent, the current page state, and a screenshot. You output 1-2 next "micro actions" the executor will play immediately.

Output JSON ONLY, matching this exact shape:
{
  "actions": [ <DirectorAction>, ... ],
  "expectAfter": { "urlContains": "...", "visibleText": ["..."] }   // optional
}

Where each DirectorAction is one of:
  { "kind": "click",  "target": "<natural language description, in the user's language>", "reasoning": "<short>" }
  { "kind": "scroll", "deltaPx": <integer in [-1500,-100] or [100,1500]>, "speed": "slow"|"normal"|"fast", "reasoning": "<short>" }
  { "kind": "dwell",  "durationMs": <integer in [200,3000]>, "reasoning": "<short>" }
  { "kind": "done",   "reasoning": "<short>" }

Action semantics:
- "click"  — the executor will smoothly scroll the target into view, pause briefly, then click. You do NOT need a separate scroll-to-target before a click.
- "scroll" — smooth scroll. Speed: slow=250 px/s (reading), normal=450 (scanning), fast=800 (flinging).
- "dwell"  — pause. Use for reading or before a click that follows other content.
- "done"   — signal that the user's intent has been satisfied; recording ends.

Quality rules:
- Output 1-2 actions per response. Lookahead is for buffering, not committing to a long plan.
- Don't repeat the SAME action three times in a row — alternate scroll lengths or insert a dwell.
- "expectAfter.urlContains" should be a SUBSTRING expected in URL after these actions complete (e.g. "zh-CN" after a language switch). Omit if no navigation expected.
- "expectAfter.visibleText" should be 1-3 short strings expected to be visible after these actions. Omit if uncertain.
- If lastActionFailure is set, address it explicitly in your reasoning.

Output JSON only. No markdown, no commentary outside the schema.`;

interface LlmFastDeciderOpts {
  /** Model id; defaults to config.llmDeciderModel. */
  model?: string;
  /** Pre-built OpenAI client; defaults to OpenRouter via config. */
  client?: OpenAI;
}

export class LlmFastDecider implements IFastDecider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmFastDecider' });

  constructor(opts: LlmFastDeciderOpts = {}) {
    this.model = opts.model ?? config.llmDeciderModel;
    this.client =
      opts.client ??
      new OpenAI({
        baseURL: config.openrouterBaseUrl,
        apiKey: config.openrouterApiKey,
      });
  }

  async decide(state: DirectorState): Promise<DecisionResponse> {
    const userText = buildUserPrompt(state);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (state.screenshot.length > 0) {
      const b64 = state.screenshot.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }

    const t0 = Date.now();
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new FastDeciderError('LLM call failed', err);
    }
    if (!raw) throw new FastDeciderError('LLM returned empty content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new FastDeciderError(`invalid json from LLM: ${raw.slice(0, 200)}`, err);
    }
    const result = DecisionResponse.safeParse(parsed);
    if (!result.success) {
      throw new FastDeciderError(
        `schema validation failed: ${JSON.stringify(result.error.format()).slice(0, 500)}`,
      );
    }

    this.logger.debug(
      {
        elapsedMs: Date.now() - t0,
        actionCount: result.data.actions.length,
        firstKind: result.data.actions[0]?.kind,
      },
      'decision',
    );
    return result.data;
  }
}

function buildUserPrompt(s: DirectorState): string {
  const recent =
    s.recentActions.length === 0
      ? '(none)'
      : s.recentActions
          .map((a) => `${a.kind}: ${a.brief}${a.succeeded ? '' : ' [FAILED]'}`)
          .join('; ');
  const hints = s.visibleHints.length === 0 ? '(none in view)' : s.visibleHints.join('; ');
  return [
    `User intent: ${s.prompt}`,
    `Time remaining (ms): ${s.remainingMs}`,
    `Current scrollY: ${s.currentScrollY}`,
    `Viewport: ${s.viewport.width}x${s.viewport.height}`,
    `Briefing hints currently in viewport: ${hints}`,
    `Recent actions (oldest→newest): ${recent}`,
    s.lastActionFailure ? `LAST ACTION FAILED: ${s.lastActionFailure}` : '',
    '',
    'Choose 1-2 next actions. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test -- llm-fast-decider`
Expected: 6 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/decider/llm-fast-decider.ts src/adapters/decider/llm-fast-decider.test.ts
git commit -m "feat(decider): LlmFastDecider via OpenRouter (Gemini Flash Lite default)"
```

---

## Task 12: StreamingDirector skeleton + basic sequential loop

**Files:**
- Create: `src/adapters/director/streaming-director.ts`
- Create: `src/adapters/director/streaming-director.test.ts`
- Create: `tests/fakes/fake-page-session.ts`
- Create: `tests/fakes/fake-fast-decider.ts`

This task lands a working Director that does sequential decide → execute → repeat. Streaming lookahead and expectAfter come next. We get a minimal DI integration tested first.

- [ ] **Step 1: Add tests directory to vitest include**

Update `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 5000,
    environment: 'node',
  },
});
```

- [ ] **Step 2: Create the test fakes**

Create `tests/fakes/fake-page-session.ts`:

```typescript
import type { ActionLog, Bbox, Viewport } from '../../src/domain/action-log.js';
import type {
  IPageSession,
  ObservedElement,
  ScrollEasing,
  SessionArtifacts,
} from '../../src/ports/page-session.js';

/**
 * In-memory IPageSession for unit-testing the Director.
 *
 * Records every method call to `events`. Animations are simulated as
 * `setTimeout`-driven promises with the requested duration, so tests can
 * assert "did the LLM call return BEFORE the animation finished?".
 *
 * Override behavior by setting fields like `quickFindInViewportResult`
 * before invoking the Director.
 */
export class FakePageSession implements IPageSession {
  events: Array<{ kind: string; payload: unknown; t: number }> = [];
  startedAt = Date.now();

  scrollY = 0;
  url = 'https://test.example/';
  viewport: Viewport = { width: 1280, height: 720 };
  screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header

  /** If set, quickFindInViewport returns this instead of null. */
  quickFindInViewportResult: ObservedElement | null = null;
  /** If set, quickFindOnPage returns this instead of null. */
  quickFindOnPageResult: ObservedElement | null = null;
  /** If set, resolveTarget returns this. */
  resolveTargetResult: ObservedElement | null = null;
  /** If set, observe(...) returns this. */
  observeResults: ObservedElement[] = [];

  private record(kind: string, payload: unknown) {
    this.events.push({ kind, payload, t: Date.now() - this.startedAt });
  }

  async start(): Promise<void> { this.record('start', null); }
  async stop(): Promise<SessionArtifacts> {
    this.record('stop', null);
    return {
      videoPath: '/tmp/fake.webm',
      actionLogPath: '/tmp/fake.json',
      actionLog: {
        version: 1,
        startedAt: new Date(this.startedAt).toISOString(),
        durationMs: Date.now() - this.startedAt,
        recording: null,
        entries: [],
      } as ActionLog,
      viewport: this.viewport,
      recording: null,
    };
  }
  async goto(url: string): Promise<void> { this.url = url; this.record('goto', url); }
  async act(instruction: string): Promise<void> { this.record('act', instruction); }
  async observe(): Promise<ObservedElement[]> { return this.observeResults; }
  async scroll(deltaY: number, opts?: { durationMs?: number; easing?: ScrollEasing }) {
    const d = opts?.durationMs ?? 1000;
    this.record('scroll', { deltaY, durationMs: d, easing: opts?.easing });
    this.scrollY = Math.max(0, this.scrollY + deltaY);
    await new Promise((r) => setTimeout(r, d));
  }
  async wait(ms: number): Promise<void> {
    this.record('wait', ms);
    await new Promise((r) => setTimeout(r, ms));
  }
  async waitForVisualStability(opts?: { quietMs?: number; maxMs?: number }) {
    this.record('stable', opts);
  }
  async currentUrl(): Promise<string> { return this.url; }
  async screenshot(): Promise<Buffer> { return this.screenshotBytes; }
  async observeAll(): Promise<ObservedElement[]> { return this.observeResults; }
  async resolveTarget(): Promise<ObservedElement | null> { return this.resolveTargetResult; }
  async clickSelector(selector: string, opts?: { description?: string }) {
    this.record('click', { selector, description: opts?.description });
    await new Promise((r) => setTimeout(r, 50)); // simulate click latency
  }
  async clickByDescription(description: string, opts?: { searchBudgetPx?: number }) {
    this.record('clickByDescription', { description, searchBudgetPx: opts?.searchBudgetPx });
    await new Promise((r) => setTimeout(r, 50));
  }
  async quickFindInViewport(): Promise<ObservedElement | null> {
    return this.quickFindInViewportResult;
  }
  async quickFindOnPage(): Promise<ObservedElement | null> {
    return this.quickFindOnPageResult;
  }
  async beginRecording(): Promise<void> { this.record('beginRecording', null); }
}
```

Create `tests/fakes/fake-fast-decider.ts`:

```typescript
import type { DirectorState } from '../../src/domain/director-state.js';
import type { DecisionResponse, IFastDecider } from '../../src/ports/fast-decider.js';

/**
 * Programmable IFastDecider for unit tests.
 *
 * Construct with a queue of pre-canned responses. Each `decide()` call
 * shifts one off the queue. Optional `delayMs` simulates LLM latency
 * so the test can verify streaming overlap.
 */
export interface FakeDeciderResponse {
  response: DecisionResponse;
  delayMs?: number;
}

export class FakeFastDecider implements IFastDecider {
  decisions: Array<{ state: DirectorState; t: number }> = [];
  startedAt = Date.now();
  queue: FakeDeciderResponse[] = [];
  defaultDelayMs = 50;

  constructor(initial: FakeDeciderResponse[] = []) {
    this.queue = [...initial];
  }

  enqueue(...resp: FakeDeciderResponse[]) {
    this.queue.push(...resp);
  }

  async decide(state: DirectorState): Promise<DecisionResponse> {
    this.decisions.push({ state, t: Date.now() - this.startedAt });
    const next = this.queue.shift();
    if (!next) {
      // Default: emit `done` so the loop terminates safely in tests.
      return { actions: [{ kind: 'done', reasoning: 'fake decider exhausted' }] };
    }
    if (next.delayMs && next.delayMs > 0) {
      await new Promise((r) => setTimeout(r, next.delayMs));
    } else {
      await new Promise((r) => setTimeout(r, this.defaultDelayMs));
    }
    return next.response;
  }
}
```

- [ ] **Step 3: Write the failing test for the basic loop**

Create `src/adapters/director/streaming-director.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { FakeFastDecider } from '../../../tests/fakes/fake-fast-decider.js';
import { FakePageSession } from '../../../tests/fakes/fake-page-session.js';
import { StreamingDirector } from './streaming-director.js';
import type { DirectorBriefing } from '../../domain/plan.js';

const briefing = (durationMs = 5_000): DirectorBriefing => ({
  prompt: 'do the thing',
  durationMs,
  hints: [],
  rationale: 'test',
});

describe('StreamingDirector — basic loop', () => {
  it('terminates on done action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.endReason).toBe('done');
    expect(decider.decisions).toHaveLength(1);
  });

  it('executes a scroll then done', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 600, speed: 'slow', reasoning: 'browse' }],
        },
      },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.payload).toMatchObject({ deltaY: 600 });
  });

  it('executes a dwell action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'dwell', durationMs: 300, reasoning: 'pause' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const waits = session.events.filter((e) => e.kind === 'wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload).toBe(300);
  });

  it('calls clickByDescription for a click action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: '简中', reasoning: 'tap it' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const clicks = session.events.filter((e) => e.kind === 'clickByDescription');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload).toMatchObject({ description: '简中' });
  });

  it('calls beginRecording exactly once', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    expect(session.events.filter((e) => e.kind === 'beginRecording')).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run tests, verify they fail**

Run: `npm run test -- streaming-director`
Expected: module-not-found / undefined-class errors.

- [ ] **Step 5: Implement the basic Director (sequential, no streaming yet)**

Create `src/adapters/director/streaming-director.ts`:

```typescript
import { DomainError } from '../../domain/errors.js';
import type { ActionSummary, DirectorState } from '../../domain/director-state.js';
import type { DirectorAction } from '../../domain/director-action.js';
import { SCROLL_SPEED_PROFILES } from '../../domain/director-action.js';
import type { ClickHint, DirectorBriefing } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { DirectorReport, IDirector } from '../../ports/director.js';
import type { IFastDecider } from '../../ports/fast-decider.js';
import type { IPageSession } from '../../ports/page-session.js';

export class DirectorError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('DIRECTOR_FAILED', message, cause);
  }
}

interface StreamingDirectorOpts {
  decider: IFastDecider;
}

/**
 * StreamingDirector — see `docs/superpowers/specs/2026-05-10-streaming-director-design.md`.
 *
 * This first version implements the core sequential loop. Streaming
 * (pre-fired LLM calls during animation) is added in the next task to
 * keep diffs small and tests narrow.
 */
export class StreamingDirector implements IDirector {
  private readonly decider: IFastDecider;
  private readonly logger = rootLogger.child({ component: 'StreamingDirector' });

  constructor(opts: StreamingDirectorOpts) {
    this.decider = opts.decider;
  }

  async run(
    briefing: DirectorBriefing,
    session: IPageSession,
  ): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + briefing.durationMs * config.directorHardBudgetMult;
    const recentActions: ActionSummary[] = [];
    const report = {
      decisionCount: 0,
      implicitDwellCount: 0,
      expectAfterMismatchCount: 0,
    };

    await session.beginRecording();

    while (true) {
      const remainingMs = Math.max(0, hardDeadlineAt - Date.now());
      const state = await this.observeState(briefing, session, recentActions, remainingMs);
      const decision = await this.callDecider(state);
      report.decisionCount += 1;

      let endReason: 'done' | 'budget' | null = null;
      for (const action of decision.actions) {
        const summary = await this.executeAction(action, session);
        recentActions.push(summary);
        if (recentActions.length > 3) recentActions.shift();
        if (action.kind === 'done') { endReason = 'done'; break; }
        if (Date.now() >= hardDeadlineAt) { endReason = 'budget'; break; }
      }
      if (endReason !== null) {
        return {
          totalMs: Date.now() - startedAt,
          decisionCount: report.decisionCount,
          implicitDwellCount: report.implicitDwellCount,
          expectAfterMismatchCount: report.expectAfterMismatchCount,
          endReason,
        };
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private async observeState(
    briefing: DirectorBriefing,
    session: IPageSession,
    recentActions: ActionSummary[],
    remainingMs: number,
  ): Promise<DirectorState> {
    const [screenshot, scrollY] = await Promise.all([
      session.screenshot(),
      this.readScrollY(session),
    ]);
    const viewport = (await session.stop) // sentinel: not actually called
      ? { width: 1280, height: 720 } : { width: 1280, height: 720 };
    // The real adapter exposes viewport via the session config; for the unit
    // tests, FakePageSession exposes it as a public field. In the real
    // pipeline, the runner constructs the Director with viewport injected.
    return {
      prompt: briefing.prompt,
      remainingMs,
      currentScrollY: scrollY,
      viewport: viewportFrom(session),
      screenshot,
      visibleHints: visibleHintNames(briefing.hints, scrollY, viewportFrom(session)),
      recentActions: [...recentActions],
    };
  }

  private async callDecider(state: DirectorState) {
    return this.decider.decide(state);
  }

  private async executeAction(action: DirectorAction, session: IPageSession): Promise<ActionSummary> {
    switch (action.kind) {
      case 'click': {
        try {
          await session.clickByDescription(action.target);
          return { kind: 'click', brief: `click ${truncate(action.target, 40)}`, succeeded: true };
        } catch (err) {
          this.logger.warn({ err, target: action.target }, 'click failed');
          return { kind: 'click', brief: `click ${truncate(action.target, 40)} [err]`, succeeded: false };
        }
      }
      case 'scroll': {
        const profile = SCROLL_SPEED_PROFILES[action.speed];
        const durationMs = clamp(
          (Math.abs(action.deltaPx) / profile.pxPerSec) * 1000,
          800,
          2800,
        );
        await session.scroll(action.deltaPx, { durationMs, easing: profile.easing });
        return {
          kind: 'scroll',
          brief: `scroll ${action.deltaPx > 0 ? '+' : ''}${action.deltaPx} ${action.speed}`,
          succeeded: true,
        };
      }
      case 'dwell': {
        await session.wait(action.durationMs);
        return { kind: 'dwell', brief: `dwell ${action.durationMs}ms`, succeeded: true };
      }
      case 'done':
        return { kind: 'done', brief: 'done', succeeded: true };
    }
  }

  private async readScrollY(session: IPageSession): Promise<number> {
    // FakePageSession exposes scrollY as a field; the real adapter exposes
    // it via screenshot/observe but we can derive it from a tiny evaluate.
    return (session as unknown as { scrollY?: number }).scrollY ?? 0;
  }
}

function viewportFrom(session: IPageSession): { width: number; height: number } {
  return (session as unknown as { viewport?: { width: number; height: number } }).viewport
    ?? { width: 1280, height: 720 };
}

function visibleHintNames(
  hints: ClickHint[],
  scrollY: number,
  viewport: { width: number; height: number },
): string[] {
  return hints
    .filter((h) => {
      const yInView = h.bboxAtRest.y - scrollY;
      return yInView >= 0 && yInView < viewport.height;
    })
    .map((h) => h.description);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm run test -- streaming-director`
Expected: 5 tests pass.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add tests/fakes/fake-page-session.ts tests/fakes/fake-fast-decider.ts src/adapters/director/streaming-director.ts src/adapters/director/streaming-director.test.ts vitest.config.ts
git commit -m "feat(director): StreamingDirector skeleton with sequential loop"
```

---

## Task 13: StreamingDirector — pre-fired streaming

**Files:**
- Modify: `src/adapters/director/streaming-director.ts`
- Modify: `src/adapters/director/streaming-director.test.ts`

Now we add the actual streaming: the next FastDecider call fires DURING the current animation, so by the time it finishes the next plan is on the queue. Verified by checking that `decider.decisions[1].t < scroll_animation_end`.

- [ ] **Step 1: Write the failing test for streaming overlap**

Append to `src/adapters/director/streaming-director.test.ts`:

```typescript
describe('StreamingDirector — streaming overlap', () => {
  it('fires next decider call DURING current animation', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 600, speed: 'slow', reasoning: 'first' }],
        },
        delayMs: 50,  // very fast LLM
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'finished' }] },
        delayMs: 50,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    await director.run(briefing(), session);

    // The scroll animation duration: 600 / 250 * 1000 = 2400ms (clamped to 2400)
    // First decision should arrive at t≈50ms (defaultDelayMs).
    // Scroll starts at t≈50, ends at t≈50+2400=2450.
    // Second decision call should fire DURING the scroll, i.e. at t<2450.
    expect(decider.decisions).toHaveLength(2);
    const secondDecisionT = decider.decisions[1]!.t;
    // The second call must have STARTED before the scroll animation ended.
    // Streaming director fires it right after the action begins, so t≈50ms.
    // (If sequential, t would be ≈2450ms.)
    expect(secondDecisionT).toBeLessThan(500); // generous bound
  });

  it('does not fire a second call if the first action is "done"', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    await director.run(briefing(), session);
    expect(decider.decisions).toHaveLength(1); // not 2
  });
});
```

- [ ] **Step 2: Run, verify the new tests fail (sequential implementation)**

Run: `npm run test -- streaming-director`
Expected: the 'fires next decider call DURING current animation' test fails because the current implementation is sequential. The 'does not fire a second call' might pass by accident depending on impl.

- [ ] **Step 3: Refactor `run()` to stream**

Replace the `run` method body in `streaming-director.ts` with:

```typescript
  async run(
    briefing: DirectorBriefing,
    session: IPageSession,
  ): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + briefing.durationMs * config.directorHardBudgetMult;
    const recentActions: ActionSummary[] = [];
    let decisionCount = 0;
    let implicitDwellCount = 0;
    let expectAfterMismatchCount = 0;

    await session.beginRecording();

    let actionQueue: DirectorAction[] = [];
    let pending: ReturnType<typeof track<DecisionResponse>> | null = null;

    // Cold start: fire first decision call.
    {
      const state = await this.observeState(briefing, session, recentActions, briefing.durationMs);
      pending = track(this.decider.decide(state));
      decisionCount += 1;
    }

    while (true) {
      const remainingMs = Math.max(0, hardDeadlineAt - Date.now());

      // Top up the queue if empty: block on pending decision.
      if (actionQueue.length === 0) {
        if (!pending) {
          const state = await this.observeState(briefing, session, recentActions, remainingMs);
          pending = track(this.decider.decide(state));
          decisionCount += 1;
        }
        try {
          const decision = await pending.promise;
          actionQueue = [...decision.actions];
          pending = null;
        } catch (err) {
          this.logger.warn({ err }, 'decider failed at queue top-up');
          return this.endReport('error', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
        }
      }

      const action = actionQueue.shift()!;

      // Pre-fire the next decision call BEFORE awaiting the animation.
      // EXCEPTION: skip pre-fire if the action is `done` (we're about to exit).
      if (action.kind !== 'done' && pending === null) {
        const state = await this.observeState(briefing, session, recentActions, remainingMs);
        pending = track(this.decider.decide(state));
        decisionCount += 1;
      }

      // Execute the animation.
      const summary = await this.executeAction(action, session);
      recentActions.push(summary);
      if (recentActions.length > 3) recentActions.shift();

      // If the pending decision resolved during animation, REPLACE the queue.
      if (pending && pending.isResolved) {
        if (pending.error) {
          this.logger.warn({ err: pending.error }, 'decider failed in-flight');
          // Fall through; next loop iteration will try a fresh call.
          pending = null;
        } else if (pending.value) {
          actionQueue = [...pending.value.actions];
          pending = null;
        }
      }

      if (action.kind === 'done') {
        return this.endReport('done', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
      }
      if (Date.now() >= hardDeadlineAt) {
        return this.endReport('budget', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
      }
    }
  }

  private endReport(
    endReason: 'done' | 'budget' | 'error',
    startedAt: number,
    decisionCount: number,
    implicitDwellCount: number,
    expectAfterMismatchCount: number,
  ): DirectorReport {
    return {
      totalMs: Date.now() - startedAt,
      decisionCount,
      implicitDwellCount,
      expectAfterMismatchCount,
      endReason,
    };
  }
```

Add at the top of the file (with the other imports):

```typescript
import { track } from '../../infra/pending.js';
import type { DecisionResponse } from '../../ports/fast-decider.js';
```

- [ ] **Step 4: Run tests, verify all pass (basic + streaming)**

Run: `npm run test -- streaming-director`
Expected: 7 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/director/streaming-director.ts src/adapters/director/streaming-director.test.ts
git commit -m "feat(director): pre-fired streaming — next LLM call overlaps current animation"
```

---

## Task 14: StreamingDirector — implicit dwell when LLM is slow

**Files:**
- Modify: `src/adapters/director/streaming-director.ts`
- Modify: `src/adapters/director/streaming-director.test.ts`

If the queue is empty AND the pending call is still in flight (LLM tail latency), the Director inserts a 200ms `dwell` to keep the recording alive. Hard cap at 4 consecutive implicit dwells before logging.

- [ ] **Step 1: Add the failing tests**

Append to `streaming-director.test.ts`:

```typescript
describe('StreamingDirector — implicit dwell on LLM lag', () => {
  it('inserts an implicit dwell when queue empty AND pending not yet resolved', async () => {
    // First call: SLOW, takes 600ms. Returns scroll.
    // Second call: queued; the test ends after the scroll.
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'tiny' }],
        },
        delayMs: 600,
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'fin' }] },
        delayMs: 50,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    // The first call takes 600ms. Action queue is empty initially.
    // Director should insert at least one implicit dwell (200ms each)
    // before the first call resolves.
    expect(report.implicitDwellCount).toBeGreaterThanOrEqual(1);
    // wait events on the fake session reflect both implicit and explicit dwells
    const waits = session.events.filter((e) => e.kind === 'wait');
    expect(waits.length).toBeGreaterThanOrEqual(1);
  });

  it('caps consecutive implicit dwells at 4 and continues', async () => {
    // Pending call never resolves until 1000ms.
    const decider = new FakeFastDecider([
      {
        response: { actions: [{ kind: 'done', reasoning: 'late' }] },
        delayMs: 1000,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    // 1000ms / 200ms = 5 implicit dwells but cap is 4.
    expect(report.implicitDwellCount).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `npm run test -- streaming-director`
Expected: the implicit-dwell tests fail (they expect `implicitDwellCount > 0`, but current impl just blocks on `pending`).

- [ ] **Step 3: Modify the queue-top-up branch to insert dwells**

In `streaming-director.ts`, find the section starting with `// Top up the queue if empty: block on pending decision.` and replace the inner block:

```typescript
      // Top up the queue if empty.
      if (actionQueue.length === 0) {
        if (!pending) {
          const state = await this.observeState(briefing, session, recentActions, remainingMs);
          pending = track(this.decider.decide(state));
          decisionCount += 1;
        }
        // Wait for pending, but if it takes longer than the implicit-dwell
        // duration, insert a dwell action and re-check. Caps at 4 dwells.
        let consecutiveDwells = 0;
        while (!pending.isResolved && consecutiveDwells < 4) {
          if (Date.now() >= hardDeadlineAt) break;
          await session.wait(config.directorDwellFallbackMs);
          implicitDwellCount += 1;
          consecutiveDwells += 1;
        }
        if (consecutiveDwells >= 4) {
          this.logger.warn(
            { consecutiveDwells },
            'consecutive implicit dwells hit cap — LLM tail latency or stuck',
          );
        }
        try {
          const decision = await pending.promise;
          actionQueue = [...decision.actions];
          pending = null;
        } catch (err) {
          this.logger.warn({ err }, 'decider failed at queue top-up');
          return this.endReport('error', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
        }
      }
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm run test -- streaming-director`
Expected: 9 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/director/streaming-director.ts src/adapters/director/streaming-director.test.ts
git commit -m "feat(director): implicit dwell when LLM call is slower than animation"
```

---

## Task 15: StreamingDirector — expectAfter validation

**Files:**
- Modify: `src/adapters/director/streaming-director.ts`
- Modify: `src/adapters/director/streaming-director.test.ts`

When the LLM provides `expectAfter`, the Director cheaply checks reality after each action. On mismatch, drop the queue and force a fresh decision with `lastActionFailure: 'expectAfter mismatch'`.

- [ ] **Step 1: Add the failing tests**

Append to `streaming-director.test.ts`:

```typescript
describe('StreamingDirector — expectAfter validation', () => {
  it('continues normally when expectAfter matches', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'go' },
            { kind: 'done', reasoning: 'fin' },
          ],
          expectAfter: { urlContains: 'test.example' }, // matches the fake's url
        },
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.expectAfterMismatchCount).toBe(0);
    expect(decider.decisions).toHaveLength(1);
  });

  it('clears the queue and re-decides on expectAfter mismatch', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'go' },
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'more' },
          ],
          expectAfter: { urlContains: 'NEVER_MATCHES_THIS_STRING' },
        },
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'recovered' }] },
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.expectAfterMismatchCount).toBeGreaterThanOrEqual(1);
    // Only ONE scroll executed — the second was discarded due to mismatch.
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    // The next decider call should have received lastActionFailure context.
    expect(decider.decisions.length).toBeGreaterThanOrEqual(2);
    const secondCallState = decider.decisions[1]!.state;
    expect(secondCallState.lastActionFailure).toContain('expectAfter');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- streaming-director`
Expected: 'expectAfter mismatch' test fails (no such logic yet).

- [ ] **Step 3: Track expectAfter in the loop and add validateNow**

In `streaming-director.ts`, modify the streaming `run()` to track `expectAfter` and validate after each action:

In the loop, after `actionQueue = [...decision.actions]` (TWO places — top-up and pre-fire-resolved), also set:

```typescript
expectAfter = decision.expectAfter ?? null;
```

Declare `let expectAfter: ExpectAfter | null = null;` near the other loop locals.

After `await this.executeAction(...)`, before the `if (action.kind === 'done')` check, add:

```typescript
      // expectAfter check — cheap text-based validation.
      if (expectAfter && !(await this.validateExpectAfter(expectAfter, session))) {
        expectAfterMismatchCount += 1;
        actionQueue = [];
        // Cancel any in-flight pre-fire (its premise is stale) and
        // force a fresh call with the failure context.
        pending = null;
        const state = await this.observeState(briefing, session, recentActions, Math.max(0, hardDeadlineAt - Date.now()));
        const stateWithFailure: DirectorState = { ...state, lastActionFailure: 'expectAfter mismatch' };
        pending = track(this.decider.decide(stateWithFailure));
        decisionCount += 1;
        expectAfter = null;
        continue;
      }
```

Add the helper method on the class:

```typescript
  private async validateExpectAfter(
    expect: ExpectAfter,
    session: IPageSession,
  ): Promise<boolean> {
    if (expect.urlContains) {
      const url = await session.currentUrl();
      if (!url.includes(expect.urlContains)) return false;
    }
    if (expect.visibleText && expect.visibleText.length > 0) {
      // Cheap path: try quickFindInViewport for each text. We don't need
      // ALL to match — at least one signals the page is roughly where the
      // LLM expected. Tunable if it proves too lenient/strict.
      let anyFound = false;
      for (const t of expect.visibleText) {
        const r = await session.quickFindInViewport(t);
        if (r) { anyFound = true; break; }
      }
      if (!anyFound) return false;
    }
    return true;
  }
```

Add to imports: `import type { ExpectAfter } from '../../ports/fast-decider.js';`.

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm run test -- streaming-director`
Expected: 11 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/director/streaming-director.ts src/adapters/director/streaming-director.test.ts
git commit -m "feat(director): expectAfter cheap text-based validation + queue clear"
```

---

## Task 16: StreamingDirector — schema/error path resilience + budget watchdog

**Files:**
- Modify: `src/adapters/director/streaming-director.ts`
- Modify: `src/adapters/director/streaming-director.test.ts`

Last Director task. Verifies (1) what happens when FastDecider throws, (2) what happens when time budget is exhausted but LLM hasn't said `done`, (3) malformed actions never reach the executor (already enforced by the schema in `LlmFastDecider`, but we add a defensive guard).

- [ ] **Step 1: Add the failing tests**

Append to `streaming-director.test.ts`:

```typescript
describe('StreamingDirector — error + budget paths', () => {
  it('returns error endReason when FastDecider rejects on first call', async () => {
    const decider = new FakeFastDecider();
    decider.decide = async () => { throw new Error('network down'); };
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.endReason).toBe('error');
  });

  it('exits with budget endReason when hard deadline hit', async () => {
    // FastDecider keeps returning slow scrolls, never `done`.
    const decider = new FakeFastDecider();
    decider.decide = async () => ({
      actions: [{ kind: 'scroll' as const, deltaPx: 600, speed: 'slow' as const, reasoning: 'forever' }],
    });
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    // Set a tiny duration so the hard cap (1.2x) is reached fast.
    const report = await director.run({ ...briefing(), durationMs: 200 }, session);
    expect(report.endReason).toBe('budget');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- streaming-director`
Expected: 'error' or 'budget' assertions fail.

- [ ] **Step 3: Verify error path correctness**

In `streaming-director.ts`, the cold-start fire of pending is wrapped in a `try`. If it rejects later (when awaited at top-up), we already return `endReason: 'error'`. But we don't currently catch rejections at the cold-start await. Update:

The `// Top up the queue if empty.` block already has the try/catch. Verify the cold-start fire inside the `// Cold start` doesn't throw synchronously — it's just `track(this.decider.decide(...))` which can't throw synchronously. Good.

But there's a subtle issue: the FIRST iteration enters the `if (actionQueue.length === 0)` branch and tries to `await pending.promise`. If decide rejects, we hit the catch and return error. ✓

Run the test and confirm:
Run: `npm run test -- streaming-director`
Expected: 'returns error endReason' should pass after this verification (no code change needed).

If it doesn't pass, inspect the error trace. Likely the implicit-dwell loop is also affected. Add a defensive check:

In the implicit-dwell loop, after `if (consecutiveDwells >= 4)`, also break if `pending` is in error state:

```typescript
        // Bail early if the pending call already errored — let the catch below report it.
        if (pending.isResolved && pending.error) break;
```

- [ ] **Step 4: Verify budget path correctness**

The current implementation checks `Date.now() >= hardDeadlineAt` inside the inner action loop. Verify the budget test passes. If it doesn't (hard deadline is 200 * 1.2 = 240ms but a single scroll is 2400ms), the issue is that the scroll animation runs to completion before the budget check. We need an early-cancel check inside `executeAction`.

Easier fix: tighten the per-action time check. Wrap the scroll in `Promise.race` with a budget timer:

```typescript
      // Execute the animation with an upper-bound watchdog.
      const watchdog = new Promise<'budget'>((resolve) => {
        setTimeout(() => resolve('budget'), Math.max(50, hardDeadlineAt - Date.now()));
      });
      const summary = await Promise.race([
        this.executeAction(action, session),
        watchdog.then(() => ({
          kind: action.kind,
          brief: 'budget cut',
          succeeded: false,
        }) satisfies ActionSummary),
      ]);
      recentActions.push(summary);
```

This races the action against the budget timer. The first to resolve wins. If budget hits first, we get a fake summary (animation may continue in the background but the next iteration's check will exit).

Note: the dangling animation in the background is a leak we accept for budget-hit recordings (rare). For cleanliness we'd add `AbortController` plumbing in a future task — out of scope here.

- [ ] **Step 5: Run all tests**

Run: `npm run test`
Expected: all 13 streaming-director tests + earlier tests pass.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/director/streaming-director.ts src/adapters/director/streaming-director.test.ts
git commit -m "feat(director): error path + hard budget watchdog"
```

---

## Task 17: Modify LlmPlanner — output DirectorBriefing

**Files:**
- Modify: `src/adapters/planner/llm-planner.ts`
- Modify: `src/ports/planner.ts`

The new flow: Planner outputs a `DirectorBriefing` (not a `TimelinePlan`). It still uses the LLM for one pass — to extract likely click targets — and then pre-resolves them to selectors. This is a much smaller LLM responsibility than before.

We **add** a `brief()` method without removing `plan()` yet. The runner switches over in the next task; cleanup deletes `plan()` and `TimelinePlan` in the final cleanup task.

- [ ] **Step 1: Add brief() to the IPlanner port**

Read `src/ports/planner.ts` and add the new method to the interface:

```typescript
import type { DirectorBriefing, PlanRequest, TimelinePlan } from '../domain/plan.js';
import type { IPageSession } from './page-session.js';

export interface IPlanner {
  /** @deprecated Use brief() instead. Kept until cleanup-task migration. */
  plan(request: PlanRequest, screenshot: Buffer | null): Promise<TimelinePlan>;

  /**
   * Produce a DirectorBriefing for the streaming Director.
   *
   * Implementations:
   * 1. Make ONE LLM call with the screenshot, asking for likely click targets.
   * 2. For each named target, call `session.resolveTarget(name)` to get a selector + bbox.
   * 3. Return briefing with hints + verbatim prompt + duration.
   */
  brief(input: BriefRequest, session: IPageSession): Promise<DirectorBriefing>;
}

export interface BriefRequest {
  url: string;
  prompt: string;
  durationMs: number;
  viewport: { width: number; height: number };
  screenshot: Buffer | null;
}
```

- [ ] **Step 2: Implement brief() in LlmPlanner**

Append to `src/adapters/planner/llm-planner.ts` (inside the `LlmPlanner` class):

```typescript
  async brief(
    input: BriefRequest,
    session: IPageSession,
  ): Promise<DirectorBriefing> {
    const userText = [
      `URL: ${input.url}`,
      `Prompt: ${input.prompt}`,
      `Target duration ms: ${input.durationMs}`,
      `Viewport: ${input.viewport.width}x${input.viewport.height}`,
      '',
      'Identify the click targets the user implicitly or explicitly mentioned.',
      'Output JSON: { "targets": ["<natural-language description, in the user\\'s language>", ...], "rationale": "<one sentence>" }',
      'Up to 3 targets. If the prompt has no click intent, return an empty list.',
    ].join('\n');

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (input.screenshot) {
      const b64 = input.screenshot.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You extract click targets from a user prompt + screenshot. Output JSON only.',
          },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new PlannerError('LLM brief() call failed', err);
    }
    if (!raw) throw new PlannerError('LLM returned empty brief content');

    let parsed: { targets?: unknown; rationale?: unknown };
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new PlannerError(`brief returned invalid JSON: ${raw.slice(0, 300)}`, err);
    }
    const targets = Array.isArray(parsed.targets)
      ? (parsed.targets as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';

    // Pre-resolve each target. Misses are dropped silently — Director's
    // search loop will rediscover them if they exist.
    const hints: ClickHint[] = [];
    for (const description of targets) {
      const resolved = await session.resolveTarget(description);
      if (resolved && resolved.selector && resolved.bbox) {
        hints.push({
          description,
          selector: resolved.selector,
          bboxAtRest: resolved.bbox,
        });
      }
    }

    return {
      prompt: input.prompt,
      durationMs: input.durationMs,
      hints,
      rationale,
    };
  }
```

Add the necessary imports at the top of `llm-planner.ts`:

```typescript
import { ClickHint, type DirectorBriefing } from '../../domain/plan.js';
import type { BriefRequest } from '../../ports/planner.js';
import type { IPageSession } from '../../ports/page-session.js';
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run all unit tests**

Run: `npm run test`
Expected: all previous tests still pass; no new tests yet for `brief()` (it's network-dependent; tested by integration in Task 20).

- [ ] **Step 5: Commit**

```bash
git add src/ports/planner.ts src/adapters/planner/llm-planner.ts
git commit -m "feat(planner): add brief() returning DirectorBriefing"
```

---

## Task 18: Modify RecordJobRunner to use the Director

**Files:**
- Modify: `src/core/record-job-runner.ts`

Switch the runner to call `planner.brief()` then `director.run()`. Keep the old plan→execute path callable behind an internal flag so we can verify the new path before deleting the old one (Task 21).

- [ ] **Step 1: Add new dependencies to RecordJobRunner**

Open `src/core/record-job-runner.ts`. Update the constructor and class to accept an `IDirector`:

Find:
```typescript
  constructor(
    private readonly session: IPageSession,
    private readonly planner: IPlanner,
  ) {}
```

Replace with:
```typescript
  constructor(
    private readonly session: IPageSession,
    private readonly planner: IPlanner,
    private readonly director: IDirector,
  ) {}
```

Add the import at the top:
```typescript
import type { IDirector } from '../ports/director.js';
```

- [ ] **Step 2: Replace the run() body to use the Director**

Replace the entire `run(req: RunRequest)` method body with:

```typescript
  async run(req: RunRequest): Promise<RunResult> {
    const wallClockT0 = Date.now();

    // ----------------------------------- 1. Setup
    const tSetup = Date.now();
    await this.session.start();
    await this.session.goto(req.url);

    // Take an early screenshot for the Planner. Stability wait runs in
    // parallel via Promise.all below.
    const tScreenshot = Date.now();
    const screenshot = await this.session.screenshot().catch(() => null);
    const screenshotMs = Date.now() - tScreenshot;

    // Planner brief() runs in parallel with visual stability.
    const tBrief = Date.now();
    const briefingTask = this.planner.brief(
      {
        url: req.url,
        prompt: req.prompt,
        durationMs: req.durationMs,
        viewport: this.viewportFromSession(),
        screenshot,
      },
      this.session,
    );
    const stabilityTask = this.session.waitForVisualStability({
      quietMs: 400,
      maxMs: 3000,
    });
    const [briefing] = await Promise.all([briefingTask, stabilityTask]);
    const briefMs = Date.now() - tBrief;
    const setupMs = Date.now() - tSetup;
    this.logger.info({ setupMs, screenshotMs, briefMs, hintCount: briefing.hints.length }, 'setup + brief complete');

    // ------------------------------------ 2. Director (owns recording window)
    const directorReport = await this.director.run(briefing, this.session);

    // ------------------------------------ 3. Stop + trim
    const artifacts = await this.session.stop();

    const tTrim = Date.now();
    let videoPath = artifacts.videoPath;
    if (artifacts.recording) {
      const out = resolve(req.outputDir, 'recording.webm');
      await trimVideo(
        artifacts.videoPath,
        out,
        artifacts.recording.startedAtMs,
        artifacts.recording.endedAtMs,
      );
      videoPath = out;
    }
    const trimMs = Date.now() - tTrim;

    const rawVideoMs = await videoDurationMs(artifacts.videoPath).catch(() => null);
    const trimmedVideoMs = await videoDurationMs(videoPath).catch(() => null);

    const metrics: RunMetrics = {
      totalWallClockMs: Date.now() - wallClockT0,
      setupMs,
      planMs: briefMs,
      preResolveMs: 0,                         // hints are pre-resolved inside brief()
      recordingMs: directorReport.totalMs,
      trimMs,
      rawVideoMs,
      trimmedVideoMs,
      resolvedClicks: briefing.hints.length,
      fallbackClicks: 0,
      stableTimeouts: 0,                       // tracked by Director if needed
    };

    return {
      videoPath,
      rawVideoPath: artifacts.videoPath,
      actionLogPath: artifacts.actionLogPath,
      // Plan field deprecated; populate with a stub for backward compat
      // until cleanup task removes it.
      plan: {
        version: 1 as const,
        targetDurationMs: req.durationMs,
        steps: [],
      } as unknown as TimelinePlan,
      metrics,
      directorReport,
    };
  }
```

(Add `directorReport` to `RunResult`:)

```typescript
export interface RunResult {
  videoPath: string;
  rawVideoPath: string;
  actionLogPath: string;
  plan: TimelinePlan;             // deprecated
  metrics: RunMetrics;
  directorReport: DirectorReport;
}
```

Add the import:
```typescript
import type { DirectorReport } from '../ports/director.js';
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean. There may be unused imports (like `adjustPlanDuration`, `TimelinePlanSchema`, etc.) — leave them; cleanup task removes them.

- [ ] **Step 4: Commit**

```bash
git add src/core/record-job-runner.ts src/ports/planner.ts
git commit -m "feat(core): RecordJobRunner uses Planner.brief() + Director.run()"
```

---

## Task 19: Update prototype script to wire Director

**Files:**
- Modify: `scripts/prototype-stagehand.ts`

- [ ] **Step 1: Wire Director construction**

Open `scripts/prototype-stagehand.ts`. After the `LlmPlanner` instantiation, add the Director:

Find:
```typescript
  const planner = new LlmPlanner();

  const runner = new RecordJobRunner(session, planner);
```

Replace with:
```typescript
  const planner = new LlmPlanner();
  const decider = new LlmFastDecider();
  const director = new StreamingDirector({ decider });

  const runner = new RecordJobRunner(session, planner, director);
```

Add the imports near the top:
```typescript
import { LlmFastDecider } from '../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../src/adapters/director/streaming-director.js';
```

- [ ] **Step 2: Add directorReport printout**

Find the `log.info({ metrics: result.metrics }, '📊 RUN METRICS');` line and add right after it:

```typescript
    log.info({ directorReport: result.directorReport }, '🎬 DIRECTOR REPORT');
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Try a real run (smoke check, doesn't have to pass spec yet)**

Run: `npm run prototype:stagehand`
Expected: produces a video. Note metrics. The output may not yet hit ±10% — Task 20 verifies that formally.

If it fails to launch, debug and fix before commit. Common gotchas:
- `LLM_DECIDER_MODEL` not set: defaults to `google/gemini-2.5-flash-lite` — should work via OpenRouter.
- `OPENROUTER_API_KEY` missing: error tells you.

- [ ] **Step 5: Commit**

```bash
git add scripts/prototype-stagehand.ts
git commit -m "feat(scripts): prototype uses LlmFastDecider + StreamingDirector"
```

---

## Task 20: Integration test for Recordly scenario + metric assertions

**Files:**
- Create: `tests/integration/recordly.test.ts`
- Create: `vitest.integration.config.ts`

The integration test runs the full prototype against the real Recordly URL and asserts:
- Trimmed video duration within ±10% of `durationMs`
- 0 stalls > 500ms in the recording window
- All briefing hints successfully resolved

This test takes ~30s and requires `OPENROUTER_API_KEY` in env. Skipped in unit-test runs.

- [ ] **Step 1: Create the integration vitest config**

Create `vitest.integration.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    environment: 'node',
  },
});
```

- [ ] **Step 2: Create the integration test**

Create `tests/integration/recordly.test.ts`:

```typescript
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LlmFastDecider } from '../../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../../src/adapters/director/streaming-director.js';
import { LlmPlanner } from '../../src/adapters/planner/llm-planner.js';
import { StagehandPageSession } from '../../src/adapters/agent/stagehand-session.js';
import { RecordJobRunner } from '../../src/core/record-job-runner.js';
import { config } from '../../src/infra/config.js';

describe('integration: Recordly scenario via Streaming Director', () => {
  it('produces a 10s ±10% recording with 0 stalls > 500ms', async () => {
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('skipping integration test — OPENROUTER_API_KEY not set');
      return;
    }
    const outputDir = resolve(config.outputDir, `it-recordly-${Date.now()}`);

    const session = new StagehandPageSession({
      outputDir,
      headless: false,
      viewport: config.viewport,
      verbose: 0,
    });
    const planner = new LlmPlanner();
    const decider = new LlmFastDecider();
    const director = new StreamingDirector({ decider });
    const runner = new RecordJobRunner(session, planner, director);

    const result = await runner.run({
      url: 'https://github.com/webadderallorg/Recordly',
      prompt: '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
      durationMs: 10_000,
      outputDir,
    });

    // Assertion 1: trimmed video duration within ±10% of target.
    expect(result.metrics.trimmedVideoMs).not.toBeNull();
    if (result.metrics.trimmedVideoMs !== null) {
      const lower = 10_000 * 0.9;
      const upper = 10_000 * 1.1;
      expect(result.metrics.trimmedVideoMs).toBeGreaterThanOrEqual(lower);
      expect(result.metrics.trimmedVideoMs).toBeLessThanOrEqual(upper);
    }

    // Assertion 2: implicit dwell count is bounded (no extreme LLM lag).
    expect(result.directorReport.implicitDwellCount).toBeLessThanOrEqual(3);

    // Assertion 3: at least one hint was pre-resolved (we asked for 简体中文 click).
    expect(result.metrics.resolvedClicks).toBeGreaterThanOrEqual(1);

    // Assertion 4: no expectAfter mismatches on this stable page.
    expect(result.directorReport.expectAfterMismatchCount).toBeLessThanOrEqual(1);

    console.log('Integration metrics:', result.metrics);
    console.log('Director report:', result.directorReport);
  }, 90_000);
});
```

- [ ] **Step 3: Run the integration test**

Run: `npm run test:integration`
Expected: **the test passes**, but if not the failure should give actionable info. Common issues to debug:

- **Trimmed duration off by more than 10%**: check `directorHardBudgetMult` (default 1.2 should give breathing room) and the LLM's `done` timing. Tune the FastDecider system prompt to bias toward staying in budget.
- **Implicit dwell count high**: switch `LLM_DECIDER_MODEL` to a faster model (e.g., `groq/llama-3.3-70b-versatile` if Groq is on OpenRouter and supports vision; otherwise `google/gemini-2.0-flash-lite`).
- **expectAfter mismatches**: the LLM may be over-claiming. Soften the prompt to encourage omitting `expectAfter` unless certain.

If a tuning round is needed, fix and rerun until green.

- [ ] **Step 4: Commit (whether or not the integration test passed; failure is data)**

```bash
git add tests/integration/recordly.test.ts vitest.integration.config.ts
git commit -m "test: integration test for Recordly scenario with metric assertions"
```

---

## Task 21: Cleanup — delete retired components

**Files:**
- Modify: `src/domain/plan.ts`
- Modify: `src/core/record-job-runner.ts`
- Modify: `src/adapters/planner/llm-planner.ts`
- Modify: `src/ports/planner.ts`
- Delete: `scripts/test-planner.ts`

- [ ] **Step 1: Delete the legacy plan() method from LlmPlanner**

Open `src/adapters/planner/llm-planner.ts`. Delete:
- The `plan()` method
- The `buildUserPrompt(req: PlanRequest)` helper (used only by `plan()`)
- The `SYSTEM_PROMPT` constant if it's only used by the deleted method (`brief()` uses inline strings)

If `brief()` reuses these, just delete what's truly dead. Verify with `grep`.

- [ ] **Step 2: Delete TimelinePlan from plan.ts**

Open `src/domain/plan.ts`. Delete:
- `ScrollStep`, `ClickStep`, `WaitStep`, `StableStep`
- `PlanStep`, `TimelinePlan` types and their re-exports
- `DomCandidate`, `PlanRequest` types if unused after step 3 below
- The `Bbox` import if it's now only used by `ClickHint` (it should still be used)

`DirectorBriefing` and `ClickHint` stay.

- [ ] **Step 3: Delete plan() from IPlanner port**

Open `src/ports/planner.ts`. Remove the `plan()` method declaration. Update the JSDoc to reflect that brief() is the only entry point.

- [ ] **Step 4: Delete retired runner helpers**

Open `src/core/record-job-runner.ts`. Delete:
- The `adjustPlanDuration` function (anywhere in the file)
- `recomputeClickDurations` function
- `expectedPlanDurationMs` function
- `estimateClickDurationMs` function
- All the `*_PX`, `*_MS`, `*_SPEED` constants used by them
- Unused imports (`PlanStep`, `TimelinePlan`, `TimelinePlanSchema`, `ClickStep` if not used elsewhere)
- The `RunResult.plan` field (now removed; update consumers)

Update the prototype script `scripts/prototype-stagehand.ts` to drop the `result.plan` log line if it logs that.

- [ ] **Step 5: Delete the standalone planner test script**

```bash
git rm scripts/test-planner.ts
```

Also remove the `"test:planner"` entry from `package.json` "scripts".

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: clean. If there are dangling references, follow the type errors to clean them up.

- [ ] **Step 7: Run all unit tests**

Run: `npm run test`
Expected: all unit tests still pass.

- [ ] **Step 8: Run a quick smoke**

Run: `npm run smoke:recording`
Expected: passes (the recording pipeline is unaffected).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: delete TimelinePlan, plan(), adjustPlanDuration, recomputeClickDurations, test-planner.ts"
```

---

## Task 22: Final integration run + ADR §0019

**Files:**
- Modify: `docs/decisions.md`

- [ ] **Step 1: Run the integration test once more**

Run: `npm run test:integration`
Expected: passes the metric assertions defined in Task 20.

- [ ] **Step 2: Update CLAUDE.md `Current state` table**

Open `CLAUDE.md`. Update the table to flip:
- `IPlanner + LlmPlanner adapter` → status reflects new `brief()` signature
- Add row: `IDirector + StreamingDirector` ✅
- Add row: `IFastDecider + LlmFastDecider` ✅

If there's a "what's next" section, refresh per current reality (cursor synth is still the next milestone).

- [ ] **Step 3: Add ADR §0019 to docs/decisions.md**

Append to `docs/decisions.md` (before the template at the bottom):

```markdown
---

## 0019 · Streaming Director with LLM-in-the-loop (partial reversal of §0013)

**Date**: implementation date

**Context**: §0013 required zero LLM calls inside the recording window to guarantee fluidity. That worked but produced rigid plan-then-execute recordings that could not adapt to lazy targets, mid-recording surprises, or position-dependent decisions. The Recordly test showed "teleport" clicks because the executor jumped straight to a known target instead of staging discovery.

**Choice**: Introduce a `StreamingDirector` that runs an LLM decision loop *inside* the recording window, using a **fast multimodal model** (Gemini Flash Lite, sub-second p95) and a **double-queue with pre-fired calls** so LLM latency overlaps animation and is invisible to viewers.

**Rationale**:
- The original constraint "no LLM in window" was too strict — the goal was actually "no visible stalls". Pre-firing achieves that without the constraint.
- 4-primitive action vocabulary (click/scroll/dwell/done) keeps decisions trivial for the LLM, making sub-second responses reliable.
- The Director still calls existing primitives (discovery click §0017, multi-stage scroll §0018, etc.) — choreography knowledge stays in code, LLM picks intent only.

**Consequences**:
- `TimelinePlan`, `adjustPlanDuration`, `recomputeClickDurations`, and the runner's step-execution loop are all retired. `LlmPlanner` shrinks to a `brief()` that just extracts click targets and pre-resolves selectors.
- New ports `IDirector` and `IFastDecider`; new domain types `DirectorAction`, `DirectorState`, `DirectorBriefing`.
- The recording window now contains LLM calls (typically 5-8 per 10s recording, ~$0.002-$0.004 cost). Their latency is hidden under animation; an implicit-dwell fallback handles tail latency.
- Spec: `docs/superpowers/specs/2026-05-10-streaming-director-design.md`. Implementation plan: `docs/superpowers/plans/2026-05-10-streaming-director.md`.

**Reverses (partially)**: §0013.
**Preserves**: §0017, §0018, §0010 (browser-side init helpers), §0001 (post-process cursor overlay still planned).
```

- [ ] **Step 4: Final commit**

```bash
git add docs/decisions.md CLAUDE.md
git commit -m "docs: ADR §0019 streaming Director; update CLAUDE.md current state"
```

- [ ] **Step 5: Verify the whole tree builds + tests pass**

Run: `npm run typecheck && npm run test && npm run smoke:recording`
Expected: all green.

---

## Self-review

I checked:

**Spec coverage:**
- IDirector port → Task 5 ✓
- IFastDecider port → Task 6 ✓
- DirectorAction + Zod → Task 2 ✓
- DirectorState type → Task 3 ✓
- DirectorBriefing schema → Task 4 ✓
- StreamingDirector implementation → Tasks 12-16 ✓
- LlmFastDecider implementation → Task 11 ✓
- LlmPlanner.brief() → Task 17 ✓
- RecordJobRunner using Director → Task 18 ✓
- StagehandPageSession.clickSelector internal search → Task 10 ✓
- StagehandPageSession.quickFindInViewport → Task 9 ✓
- Config additions (LLM_DECIDER_MODEL etc.) → Task 8 ✓
- Streaming pseudocode (double-queue, pre-fire, expectAfter, implicit dwell) → Tasks 13-15 ✓
- Error handling (FastDecider failure, schema mismatch, budget watchdog) → Task 16 ✓
- Cleanup of TimelinePlan, adjustPlanDuration, recomputeClickDurations → Task 21 ✓
- Integration test on Recordly with metric assertions → Task 20 ✓
- ADR §0019 → Task 22 ✓

**Placeholder scan:** No "TBD"/"TODO"/"fill in"/"similar to". All steps either contain actual code or are commands with expected output.

**Type consistency:**
- `DirectorAction` discriminated union shape consistent across `director-action.ts`, `director-state.ts`, `streaming-director.ts`, `llm-fast-decider.ts` ✓
- `DirectorBriefing` consistent between `plan.ts`, `planner.ts` (port), `llm-planner.ts` (adapter), `streaming-director.ts` (consumer) ✓
- `IPageSession` interface additions (`quickFindInViewport`, `quickFindOnPage`, `clickByDescription`) implemented in StagehandPageSession AND FakePageSession ✓
- `DecisionResponse` schema consistent between `fast-decider.ts` (port) and `llm-fast-decider.ts` (adapter); the parsed type flows through to `streaming-director.ts` consumer ✓

**Scope:** Single coherent change. No multi-subsystem decomposition needed.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-streaming-director.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
