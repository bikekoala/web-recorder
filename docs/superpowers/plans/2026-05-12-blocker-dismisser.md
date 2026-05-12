# Off-camera Blocker Dismisser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an off-camera "blocker dismisser" — a small probe→detect→click→re-probe loop that clears cookie/consent banners and X-to-close modals *before* the recon plans and *before* the recording window opens, so they don't swallow every click.

**Architecture:** New `IBlockerDismisser` port + `LlmBlockerDismisser` adapter (its own gpt-4o-mini OpenAI client), owned by `LlmReconnoiterer`. It runs at the top of `recon()` (before `observeAll`/screenshot — so recon sees a clean page) and again inside the rehearsal walk's page-reset (after `goto(input.url)`, before `waitForVisualStability` — the walk reloads the page, which brings the overlay back, and the on-camera Director must see a clean page too). The report rides on `Performance.blockerDismissal` (like `rehearsal`) and surfaces in `RunMetrics`. Gated by `config.blockerDismiss` (default on); `BLOCKER_DISMISS=false` ⇒ no dismisser is constructed, behaviour as today.

**Tech Stack:** TypeScript (strict, ESM/NodeNext — relative imports end `.js`), Zod schemas (`src/domain/`), `openai` SDK pointed at OpenRouter, `pino` logging via `src/infra/logger.ts`, vitest. Hexagonal: business logic in `core/` depends only on `ports/`; concrete tech (OpenRouter, Stagehand) lives in `adapters/`.

**Spec:** `docs/superpowers/specs/2026-05-12-blocker-dismisser-design.md`

**Branch:** `main` (this session has been committing directly to `main`; no worktree).

---

### Task 1: `BlockerDismissalReport` schema + `Performance.blockerDismissal`

Schema-first (Hard Rule 2): the report crosses a boundary (recon → runner via the `Performance`), so it's a Zod schema in `src/domain/`. Mirrors the existing `RehearsalTraceSchema`.

**Files:**
- Modify: `src/domain/performance.ts`
- Test: `tests/unit/domain/performance.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/domain/performance.test.ts` (a `describe('blockerDismissal', ...)` block):

```ts
import { describe, expect, it } from 'vitest';
import { PerformanceSchema, BlockerDismissalReportSchema } from '../../../src/domain/performance.js';

describe('BlockerDismissalReportSchema', () => {
  it('round-trips a report', () => {
    const r = { rounds: 2, dismissed: ['Accept all cookies', 'Close newsletter modal'], stillBlocked: false };
    expect(BlockerDismissalReportSchema.parse(r)).toEqual(r);
  });
  it('rejects a negative round count', () => {
    expect(() => BlockerDismissalReportSchema.parse({ rounds: -1, dismissed: [], stillBlocked: true })).toThrow();
  });
});

describe('PerformanceSchema.blockerDismissal', () => {
  const base = {
    prompt: 'p', durationMs: 1000,
    steps: [{ kind: 'done', reasoning: 'x' }],
    totalEstimatedMs: 0, rationale: 'r',
  };
  it('is valid when absent', () => {
    expect(PerformanceSchema.parse(base).blockerDismissal).toBeUndefined();
  });
  it('round-trips when present', () => {
    const p = { ...base, blockerDismissal: { rounds: 1, dismissed: ['Accept all'], stillBlocked: false } };
    expect(PerformanceSchema.parse(p).blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all'], stillBlocked: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/domain/performance.test.ts`
Expected: FAIL — `BlockerDismissalReportSchema` is not exported.

- [ ] **Step 3: Implement**

In `src/domain/performance.ts`, near `RehearsalTraceSchema` (search for `export const RehearsalTraceSchema`), add:

```ts
/**
 * Outcome of the off-camera blocker dismisser (Task #20). Lives on the
 * Performance like RehearsalTrace — it's metadata about how the page was
 * prepared, surfaced in RunMetrics as an operator canary.
 */
export const BlockerDismissalReportSchema = z.object({
  /** detect→click iterations that ran (0 = the page was already clean). */
  rounds: z.number().int().nonnegative(),
  /** descriptions of the elements we clicked, in order. */
  dismissed: z.array(z.string()),
  /** a blocker still seemed present when we stopped (cap hit / error / undismissable). */
  stillBlocked: z.boolean(),
});
export type BlockerDismissalReport = z.infer<typeof BlockerDismissalReportSchema>;
```

Then in `PerformanceSchema` (search for `rehearsal: RehearsalTraceSchema.optional()`), add a sibling field right after it:

```ts
  blockerDismissal: BlockerDismissalReportSchema.optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/domain/performance.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/domain/performance.ts tests/unit/domain/performance.test.ts
git commit -m "feat(domain): BlockerDismissalReport schema + Performance.blockerDismissal (Task #20)"
```

---

### Task 2: `IBlockerDismisser` port

A 1-method interface. No behaviour ⇒ no unit test; just create the file and typecheck.

**Files:**
- Create: `src/ports/blocker-dismisser.ts`

- [ ] **Step 1: Create the file**

`src/ports/blocker-dismisser.ts`:

```ts
import type { BlockerDismissalReport } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

export type { BlockerDismissalReport };

/**
 * Off-camera blocker dismisser (Task #20 / spec 2026-05-12). Clears
 * dismissable overlays — cookie/consent banners, X-to-close modals — from a
 * page before the Performance is planned / played. NOT region/age gates,
 * NOT paywalls. Best-effort: `dismiss()` never throws; on any failure it
 * returns a report with `stillBlocked: true` and the caller proceeds (the
 * §0034 on-camera gated re-plan + graceful degradation are the backstop).
 */
export interface IBlockerDismisser {
  dismiss(session: IPageSession): Promise<BlockerDismissalReport>;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/ports/blocker-dismisser.ts
git commit -m "feat(ports): IBlockerDismisser port (Task #20)"
```

---

### Task 3: config knobs

`blockerDismiss`, `blockerDismissMaxRounds`, `blockerDismissMaxMs`, `llmBlockerModel` (+ resolved). Mirrors the existing `reconRehearse` / `reconRehearsalBudgetMs` / `reconReconvergeMax` pattern.

**Files:**
- Modify: `src/infra/config.ts`
- Test: `tests/unit/infra/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/infra/config.test.ts`, inside (or next to) the existing `describe('rehearsal config knobs', ...)` — use the same `loadConfig` helper already in that file:

```ts
describe('blocker-dismiss config knobs', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('blockerDismiss defaults to true', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS: undefined });
    expect(config.blockerDismiss).toBe(true);
  });
  it('BLOCKER_DISMISS=false disables it', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS: 'false' });
    expect(config.blockerDismiss).toBe(false);
  });
  it('blockerDismissMaxRounds / blockerDismissMaxMs have sensible defaults', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS_MAX_ROUNDS: undefined, BLOCKER_DISMISS_MAX_MS: undefined });
    expect(config.blockerDismissMaxRounds).toBe(3);
    expect(config.blockerDismissMaxMs).toBe(10000);
  });
  it('llmBlockerModelResolved falls back to llmModel', async () => {
    const config = await loadConfig({ LLM_BLOCKER_MODEL: undefined, LLM_MODEL: 'test/mini' });
    expect(config.llmBlockerModelResolved).toBe('test/mini');
  });
  it('llmBlockerModelResolved honours LLM_BLOCKER_MODEL', async () => {
    const config = await loadConfig({ LLM_BLOCKER_MODEL: 'foo/vision' });
    expect(config.llmBlockerModelResolved).toBe('foo/vision');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/infra/config.test.ts`
Expected: FAIL — `config.blockerDismiss` etc. are `undefined`.

- [ ] **Step 3: Implement**

In `src/infra/config.ts`, in the Zod schema near `reconReconvergeMax` (search for `reconReconvergeMax: z.coerce.number()`), add:

```ts
  /**
   * Off-camera blocker dismisser (Task #20). `blockerDismiss` is the master
   * switch (off ⇒ recon constructs no dismisser, behaviour as before).
   * `blockerDismissMaxRounds` caps the detect→click iterations;
   * `blockerDismissMaxMs` caps the whole dismiss() call's wall-clock.
   */
  blockerDismiss: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('true'),
  blockerDismissMaxRounds: z.coerce.number().int().min(0).default(3),
  blockerDismissMaxMs: z.coerce.number().int().min(0).default(10000),

  /**
   * Model for the blocker dismisser's detect call. Needs vision (it's shown a
   * screenshot) but the task is simple (yes/no + pick an element) — a fast
   * cheap model. Defaults to `llmModel` (openai/gpt-4o-mini). Override with
   * LLM_BLOCKER_MODEL. (Model names live in config — goals.md #6.)
   */
  llmBlockerModel: z.string().min(1).optional(),
```

In the `raw` object (search for `reconReconvergeMax: process.env.RECON_RECONVERGE_MAX`), add after it:

```ts
  blockerDismiss: process.env.BLOCKER_DISMISS || undefined,
  blockerDismissMaxRounds: process.env.BLOCKER_DISMISS_MAX_ROUNDS,
  blockerDismissMaxMs: process.env.BLOCKER_DISMISS_MAX_MS,
  llmBlockerModel: process.env.LLM_BLOCKER_MODEL,
```

In the exported `config` object (search for `llmReconModelResolved: data.llmReconModel ?? data.llmPlannerModel ?? data.llmModel`), add a sibling line:

```ts
  llmBlockerModelResolved: data.llmBlockerModel ?? data.llmModel,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/infra/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `.env.example` + commit**

In `.env.example`, after the `RECON_RECONVERGE_MAX=...` line (search for `RECON_RECONVERGE_MAX`), add:

```
# Off-camera blocker dismisser (Task #20) — clears cookie/consent banners and
# X-to-close modals before recon plans / before recording opens.
# BLOCKER_DISMISS=true
# BLOCKER_DISMISS_MAX_ROUNDS=3      # cap on detect->click iterations
# BLOCKER_DISMISS_MAX_MS=10000      # wall-clock cap on the whole dismiss() call
# LLM_BLOCKER_MODEL=                # defaults to LLM_MODEL (gpt-4o-mini); vision-capable
```

```bash
npm run typecheck
git add src/infra/config.ts tests/unit/infra/config.test.ts .env.example
git commit -m "feat(config): blocker-dismiss knobs + llmBlockerModelResolved (Task #20)"
```

---

### Task 4: the dismisser prompt

A system prompt + a user-text builder, in `src/prompts/` like every other prompt.

**Files:**
- Create: `src/prompts/blocker-dismisser.ts`
- Modify: `src/prompts/index.ts`
- Test: `tests/unit/prompts/blocker-dismisser.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/prompts/blocker-dismisser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from '../../../src/prompts/index.js';

describe('blockerDismisserSystemPrompt', () => {
  it('names the dismissable kinds, the preference order, and demands JSON only', () => {
    const lower = blockerDismisserSystemPrompt.toLowerCase();
    expect(lower).toContain('consent');
    expect(lower).toContain('accept all');
    expect(lower).toContain('paywall');           // explicitly NOT dismissable
    expect(lower).toContain('blocker');           // the output key
    expect(lower).toContain('json');              // JSON-only rule
  });
});

describe('buildBlockerDismissUserText', () => {
  it('lists the observed elements and asks for the JSON decision', () => {
    const text = buildBlockerDismissUserText([
      { selector: '#a', description: 'Accept all cookies button' },
      { selector: '#b', description: 'Reject all button' },
    ]);
    expect(text).toContain('Accept all cookies button');
    expect(text.toLowerCase()).toContain('json');
  });
  it('handles an empty observed list', () => {
    expect(buildBlockerDismissUserText([])).toContain('(none found)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/prompts/blocker-dismisser.test.ts`
Expected: FAIL — module/exports don't exist.

- [ ] **Step 3: Implement**

`src/prompts/blocker-dismisser.ts`:

```ts
/**
 * Blocker-dismisser prompts — used by LlmBlockerDismisser.dismiss().
 *
 * Off-camera, before recon. The model is shown the page screenshot + the
 * observed interactive elements (a heuristic already flagged a possible
 * blocker) and decides whether a dismissable overlay covers the content and,
 * if so, which element clears it. Strict JSON out — gpt-4o-mini honours
 * response_format: json_object, so no heavy prose-extraction needed.
 */

export const blockerDismisserSystemPrompt = `You decide whether a web page is blocked by a DISMISSABLE overlay and, if so, which element clears it.

You see a screenshot of a page and a list of its interactive elements. A heuristic already flagged a possible blocker — confirm it and pinpoint the dismiss control.

DISMISSABLE (return "blocker": true) = a cookie/consent banner, a newsletter-signup modal, or an app-install / "open in app" interstitial covering the page's main content.
NOT DISMISSABLE (return "blocker": false) = a paywall, a login/signup wall you must authenticate through, a region or age gate (a real choice we won't make), or — nothing is actually blocking the content.

If dismissable, name the element that clears it by its visible text / role / position. PREFER, in this order:
  1. "Accept all" / "Allow all" / "Got it" / "OK" / "I agree"  (one click, done)
  2. a close button / "X" / "No thanks" / "Skip" / "Maybe later"
  3. "Manage" / "Customize" / "Settings"  — AVOID; that opens a sub-panel, not a dismiss
Never pick "Reject all" / "Decline" unless it is the ONLY way to clear the overlay.

OUTPUT — strict JSON, a single object, exactly this shape and nothing else:
{ "blocker": <true|false>, "dismissTargetDescription": "<element description; omit when blocker is false>", "rationale": "<one short sentence>" }
ASCII double-quotes only. No markdown, no code fences, no prose before or after. Your entire response is that JSON object.`;

export function buildBlockerDismissUserText(
  observed: ReadonlyArray<{ selector: string; description: string }>,
): string {
  const list = observed.slice(0, 50).map((e, i) => `  ${i + 1}. ${e.description}`).join('\n');
  return [
    'Interactive elements on the page right now:',
    list || '  (none found)',
    '',
    'Is a dismissable overlay covering the page? If so, which element clears it? Output the JSON decision only.',
  ].join('\n');
}
```

In `src/prompts/index.ts`, add an export line next to the others:

```ts
export { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from './blocker-dismisser.js';
```

And add a bullet to the "One file per LLM role:" comment block in that file:

```
 * - `blocker-dismisser.ts` — the off-camera detect call that picks the
 *   element clearing a cookie/consent banner or X-to-close modal. Task #20.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/prompts/blocker-dismisser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/prompts/blocker-dismisser.ts src/prompts/index.ts tests/unit/prompts/blocker-dismisser.test.ts
git commit -m "feat(prompts): blocker-dismisser system prompt + user text (Task #20)"
```

---

### Task 5: `LlmBlockerDismisser` adapter

The component. `FakePageSession` already has everything we need to test it: `pageDiagnosticResults` (a queue — each `pageDiagnostic()` call shifts one off; empty ⇒ a default with `blockerSignals: []`), `resolveTargetResult`, `observeResults`, `screenshotBytes`, `clickSelectorImpl`/`clickAtImpl` hooks. The LLM client is faked with the same shape as the recon tests use.

**Files:**
- Create: `src/adapters/blocker/llm-blocker-dismisser.ts`
- Test: `tests/unit/adapters/blocker/llm-blocker-dismisser.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/adapters/blocker/llm-blocker-dismisser.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { LlmBlockerDismisser } from '../../../../src/adapters/blocker/llm-blocker-dismisser.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { PageDiagnostic } from '../../../../src/ports/page-session.js';

const diag = (blockerSignals: string[]): PageDiagnostic => ({
  url: 'https://x.test/', title: '', interactiveElementCount: 10, visibleHeadings: [], blockerSignals,
});

// Fake OpenAI-shaped client returning contents[n] on the n-th call (clamps to the last).
function sequencedClient(...contents: string[]) {
  const create = vi.fn(async () => {
    const idx = Math.min(create.mock.calls.length - 1, contents.length - 1);
    return { choices: [{ message: { content: contents[Math.max(0, idx)] } }] };
  });
  return { client: { chat: { completions: { create } } } as unknown as ConstructorParameters<typeof LlmBlockerDismisser>[0]['client'], create };
}
function throwingClient() {
  const create = vi.fn(async () => { throw new Error('LLM down'); });
  return { client: { chat: { completions: { create } } } as unknown as ConstructorParameters<typeof LlmBlockerDismisser>[0]['client'], create };
}

describe('LlmBlockerDismisser', () => {
  it('clean page (no blockerSignals) → 0 rounds, 0 LLM calls', async () => {
    const session = new FakePageSession(); // empty pageDiagnosticResults ⇒ default diag with blockerSignals: []
    const { client, create } = sequencedClient('{"blocker":false}');
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 0, dismissed: [], stillBlocked: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('one consent banner → detect → click → re-probe clean → rounds 1', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog']), diag([])]; // initial probe sees it; re-probe clean
    session.resolveTargetResult = { selector: '#accept', description: 'Accept all cookies', bbox: { x: 100, y: 600, width: 120, height: 40 } };
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all cookies' }));
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });
  });

  it('banner then modal → 2 rounds, two dismissed', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog']), diag(['auth_modal']), diag([])];
    session.resolveTargetResult = { selector: '#x', description: 'a dismiss control', bbox: { x: 10, y: 10, width: 20, height: 20 } };
    const { client } = sequencedClient(
      JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all cookies' }),
      JSON.stringify({ blocker: true, dismissTargetDescription: 'Close the modal' }),
    );
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r.rounds).toBe(2);
    expect(r.dismissed).toEqual(['Accept all cookies', 'Close the modal']);
    expect(r.stillBlocked).toBe(false);
  });

  it('round cap: every re-probe still flags a blocker → rounds capped, stillBlocked', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => diag(['consent_dialog']); // always non-empty
    session.resolveTargetResult = { selector: '#x', description: 'dismiss', bbox: { x: 10, y: 10, width: 20, height: 20 } };
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'dismiss' }));
    const d = new LlmBlockerDismisser({ client, model: 'm', maxRounds: 2, maxMs: 60_000 });
    const r = await d.dismiss(session);
    expect(r.rounds).toBe(2);
    expect(r.stillBlocked).toBe(true);
  });

  it('LLM says blocker:false → 1 round (one detect), nothing clicked', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    const { client } = sequencedClient('{"blocker":false}');
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: [], stillBlocked: false });
  });

  it('resolveTarget returns null → 1 round, stillBlocked, no click', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    session.resolveTargetResult = null;
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all' }));
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: [], stillBlocked: true });
  });

  it('LLM throws → caught, stillBlocked, never throws', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    const { client } = throwingClient();
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r.stillBlocked).toBe(true);
    expect(r.dismissed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/adapters/blocker/llm-blocker-dismisser.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`src/adapters/blocker/llm-blocker-dismisser.ts`:

```ts
import OpenAI from 'openai';

import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from '../../prompts/index.js';
import type { IBlockerDismisser, BlockerDismissalReport } from '../../ports/blocker-dismisser.js';
import type { IPageSession, ObservedElement } from '../../ports/page-session.js';

interface LlmBlockerDismisserOpts {
  client?: OpenAI;
  model?: string;
  maxRounds?: number;
  maxMs?: number;
}

interface DismissDecision { blocker: boolean; dismissTargetDescription?: string }

export class LlmBlockerDismisser implements IBlockerDismisser {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxRounds: number;
  private readonly maxMs: number;
  private readonly logger = rootLogger.child({ component: 'LlmBlockerDismisser' });

  constructor(opts: LlmBlockerDismisserOpts = {}) {
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
    this.model = opts.model ?? config.llmBlockerModelResolved;
    this.maxRounds = opts.maxRounds ?? config.blockerDismissMaxRounds;
    this.maxMs = opts.maxMs ?? config.blockerDismissMaxMs;
  }

  async dismiss(session: IPageSession): Promise<BlockerDismissalReport> {
    const deadlineAt = Date.now() + this.maxMs;
    const dismissed: string[] = [];
    let rounds = 0;

    const blocked = async (): Promise<boolean> => {
      const diag = await session.pageDiagnostic().catch(() => null);
      return !!diag && diag.blockerSignals.length > 0;
    };

    if (!(await blocked())) {
      return { rounds: 0, dismissed: [], stillBlocked: false };
    }

    while (rounds < this.maxRounds && Date.now() < deadlineAt) {
      rounds++;
      const shot = await session.screenshot().catch(() => null);
      const observed = await session.observeAll().catch((): ObservedElement[] => []);

      let decision: DismissDecision | null;
      try {
        decision = await this.detect(shot, observed);
      } catch (err) {
        this.logger.warn({ err }, 'blocker detect call failed');
        return { rounds, dismissed, stillBlocked: true };
      }
      if (!decision) {
        this.logger.warn('blocker detect response unparseable');
        return { rounds, dismissed, stillBlocked: true };
      }
      if (!decision.blocker || !decision.dismissTargetDescription) {
        // Page is clear, or the model declined (paywall/login wall). Done.
        return { rounds, dismissed, stillBlocked: false };
      }

      const target = await session.resolveTarget(decision.dismissTargetDescription).catch(() => null);
      if (!target || !target.bbox) {
        this.logger.warn({ desc: decision.dismissTargetDescription }, 'blocker dismiss target did not resolve — stopping');
        return { rounds, dismissed, stillBlocked: true };
      }
      try {
        await this.clickTarget(target.selector, target.bbox, decision.dismissTargetDescription, session);
      } catch (err) {
        this.logger.warn({ err, desc: decision.dismissTargetDescription }, 'blocker dismiss click failed — stopping');
        return { rounds, dismissed, stillBlocked: true };
      }
      dismissed.push(decision.dismissTargetDescription);
      await session.waitForVisualStability().catch(() => {});

      if (!(await blocked())) {
        this.logger.info({ rounds, dismissed }, 'blockers dismissed');
        return { rounds, dismissed, stillBlocked: false };
      }
      // else: another overlay surfaced — loop.
    }
    this.logger.warn({ rounds, dismissed }, 'blocker dismiss capped with a blocker still present');
    return { rounds, dismissed, stillBlocked: true };
  }

  private async detect(
    screenshot: Buffer | null,
    observed: ObservedElement[],
  ): Promise<DismissDecision | null> {
    const userText = buildBlockerDismissUserText(observed.map((e) => ({ selector: e.selector, description: e.description })));
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (screenshot && screenshot.length > 0) {
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } });
    }
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: blockerDismisserSystemPrompt },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 300,
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    return parseDismissDecision(raw);
  }

  /** Coord-click if the bbox is in the viewport (robust to stale deep XPaths); else clickSelector. */
  private async clickTarget(
    selector: string,
    bbox: { x: number; y: number; width: number; height: number },
    description: string,
    session: IPageSession,
  ): Promise<void> {
    const vp = session.viewport;
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2; // dismiss controls are virtually always at scrollY 0
    if (cx >= 0 && cx < vp.width && cy >= 0 && cy < vp.height) {
      try { await session.clickAt(cx, cy, { description }); return; } catch { /* fall through */ }
    }
    await session.clickSelector(selector, { description });
  }
}

function parseDismissDecision(raw: string): DismissDecision | null {
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const obj = tryParse(raw) ?? tryParse(stripped);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.blocker !== 'boolean') return null;
  return {
    blocker: o.blocker,
    dismissTargetDescription: typeof o.dismissTargetDescription === 'string' && o.dismissTargetDescription.trim() ? o.dismissTargetDescription : undefined,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/adapters/blocker/llm-blocker-dismisser.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/adapters/blocker/llm-blocker-dismisser.ts tests/unit/adapters/blocker/llm-blocker-dismisser.test.ts
git commit -m "feat(adapters): LlmBlockerDismisser — off-camera probe->detect->click->re-probe loop (Task #20)"
```

---

### Task 6: wire the dismisser into `LlmReconnoiterer`

`recon()` calls `dismiss()` first thing (the page is already at `input.url` — `RecordJobRunner` does `session.goto(req.url)` before `recon`), threads the report onto the returned `Performance.blockerDismissal`, and the rehearsal walk's page-reset calls `dismiss()` again (fire-and-forget) after `goto(input.url)`.

**Files:**
- Modify: `src/adapters/recon/llm-reconnoiterer.ts`
- Test: `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`:

```ts
import type { IBlockerDismisser, BlockerDismissalReport } from '../../../../src/ports/blocker-dismisser.js';
import type { IPageSession } from '../../../../src/ports/page-session.js';

// Spy IBlockerDismisser: records each dismiss() call's call-order vs the session's observeAll.
class SpyDismisser implements IBlockerDismisser {
  calls = 0;
  report: BlockerDismissalReport = { rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false };
  async dismiss(_session: IPageSession): Promise<BlockerDismissalReport> { this.calls++; return this.report; }
}

describe('LlmReconnoiterer + blockerDismisser', () => {
  // goPlanJson is already defined in this file (a one-click "go" plan).
  it('calls dismiss() and surfaces the report on Performance.blockerDismissal', async () => {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext; session.clickSelectorImpl = goNext;
    const dismisser = new SpyDismisser();
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goPlanJson), blockerDismisser: dismisser });
    const perf = await recon.recon(
      { url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(dismisser.calls).toBeGreaterThanOrEqual(1);            // at least the recon-start call (walk-reset adds one more)
    expect(perf.blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });
  });

  it('without a dismisser, Performance.blockerDismissal is undefined', async () => {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext; session.clickSelectorImpl = goNext;
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goPlanJson) });
    const perf = await recon.recon(
      { url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(perf.blockerDismissal).toBeUndefined();
  });

  it('a dismiss() that throws does not fail recon — report is stillBlocked', async () => {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext; session.clickSelectorImpl = goNext;
    const throwing: IBlockerDismisser = { dismiss: async () => { throw new Error('boom'); } };
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goPlanJson), blockerDismisser: throwing });
    const perf = await recon.recon(
      { url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(perf.blockerDismissal).toEqual({ rounds: 0, dismissed: [], stillBlocked: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/adapters/recon/llm-reconnoiterer.test.ts`
Expected: FAIL — `LlmReconnoitererOpts` has no `blockerDismisser`; `Performance.blockerDismissal` is never set.

- [ ] **Step 3: Implement**

In `src/adapters/recon/llm-reconnoiterer.ts`:

(a) import the port type — add to the imports near `import type { IReconnoiterer, ReconInput } from '../../ports/reconnoiterer.js';`:

```ts
import type { IBlockerDismisser, BlockerDismissalReport } from '../../ports/blocker-dismisser.js';
```

(b) extend the opts interface + ctor:

```ts
interface LlmReconnoitererOpts {
  model?: string;
  client?: OpenAI;
  blockerDismisser?: IBlockerDismisser;
}
```

Add a private field and assign it in the constructor (next to `this.model = ...`):

```ts
  private readonly blockerDismisser: IBlockerDismisser | null;
  // in the ctor:
  this.blockerDismisser = opts.blockerDismisser ?? null;
```

(c) a private helper that runs the dismisser and never throws:

```ts
  /** Run the off-camera blocker dismisser (if configured); never throws. */
  private async dismissBlockers(session: IPageSession): Promise<BlockerDismissalReport | null> {
    if (!this.blockerDismisser) return null;
    try {
      return await this.blockerDismisser.dismiss(session);
    } catch (err) {
      this.logger.warn({ err }, 'blocker dismisser threw — proceeding without it');
      return { rounds: 0, dismissed: [], stillBlocked: true };
    }
  }
```

(d) at the very top of `recon()` (before `const observed = await session.observeAll()...`):

```ts
    // Off-camera: clear cookie/consent banners / X-to-close modals before we
    // observe + plan, so the Performance is built against the real page.
    const blockerDismissal = await this.dismissBlockers(session);
```

(e) inside the rehearsal-walk reset (search for `await session.goto(input.url);` then `await session.waitForVisualStability();` inside the `if (config.reconRehearse) { ... }` block) — re-dismiss after the reload, since the walk reloaded the page and the overlay can be back. Change:

```ts
      try {
        await session.goto(input.url);
        await this.dismissBlockers(session);
        await session.waitForVisualStability();
      } catch (err) {
```

(f) put the report on the candidate `Performance` (search for `...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),`) — add a sibling:

```ts
      ...(blockerDismissal ? { blockerDismissal } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/adapters/recon/llm-reconnoiterer.test.ts`
Expected: PASS (the new 3 + all existing).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/adapters/recon/llm-reconnoiterer.ts tests/unit/adapters/recon/llm-reconnoiterer.test.ts
git commit -m "feat(recon): LlmReconnoiterer runs the blocker dismisser before observe + on walk-reset (Task #20)"
```

---

### Task 7: surface `blockerDismissal` in `RunMetrics`

A passthrough — the `Performance` already carries it (Task 1 + 6); the runner just reads it, exactly like `rehearsal`.

**Files:**
- Modify: `src/core/record-job-runner.ts`
- Test: `tests/unit/core/record-job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/core/record-job-runner.test.ts`, in the existing test that builds a `Performance` with a `rehearsal` field (search for `rehearsal: { walkedSteps: 4`), add a `blockerDismissal` to that same performance object and a matching assertion. Concretely — on the `const performance: Performance = { ... }` literal add:

```ts
      blockerDismissal: { rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false },
```

and after the `expect(result.metrics.rehearsal).toEqual(...)` line add:

```ts
    expect(result.metrics.blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });
```

Also, in a test that uses a `Performance` *without* a `blockerDismissal` (e.g. the one with `perf([{ kind: 'done', ... }])`), add:

```ts
    expect(result.metrics.blockerDismissal).toBeNull();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/core/record-job-runner.test.ts`
Expected: FAIL — `result.metrics.blockerDismissal` is `undefined` (the field doesn't exist).

- [ ] **Step 3: Implement**

In `src/core/record-job-runner.ts`:

(a) import the type — change `import type { Performance, PerformanceStep, RehearsalTrace } from '../domain/performance.js';` to also bring `BlockerDismissalReport`:

```ts
import type { BlockerDismissalReport, Performance, PerformanceStep, RehearsalTrace } from '../domain/performance.js';
```

(b) add to `RunMetrics`, right after the `rehearsal: RehearsalTrace | null;` field:

```ts
  /**
   * Off-camera blocker dismisser outcome (Task #20), or `null` if recon ran
   * without one (`config.blockerDismiss === false`). `rounds > 0` means a
   * cookie/consent banner or X-to-close modal was cleared before recording;
   * `stillBlocked: true` means one slipped past — the deliverable may show it.
   */
  blockerDismissal: BlockerDismissalReport | null;
```

(c) where the metrics object is built (search for `rehearsal: performance.rehearsal ?? null,`), add a sibling line:

```ts
      blockerDismissal: performance.blockerDismissal ?? null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/core/record-job-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Full test run + commit**

```bash
npm run typecheck
npm run test
git add src/core/record-job-runner.ts tests/unit/core/record-job-runner.test.ts
git commit -m "feat(core): RunMetrics.blockerDismissal — off-camera blocker-dismisser canary (Task #20)"
```

---

### Task 8: wire `LlmBlockerDismisser` into the prototype script + regression suite

The two entry points that build a real `LlmReconnoiterer` must now also build a `LlmBlockerDismisser` (when `config.blockerDismiss`) and pass it in.

**Files:**
- Modify: `scripts/prototype-stagehand.ts`
- Modify: `tests/regression/regression.test.ts`

- [ ] **Step 1: prototype-stagehand.ts**

Add an import near the other adapter imports:

```ts
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { config } from '../src/infra/config.js';   // if not already imported
```

Change the reconnoiterer construction (search for `const reconnoiterer = new LlmReconnoiterer();`):

```ts
  const blockerDismisser = config.blockerDismiss ? new LlmBlockerDismisser() : undefined;
  const reconnoiterer = new LlmReconnoiterer({ blockerDismisser });
```

(`LlmReconnoiterer` / `LlmBlockerDismisser` build their own OpenRouter clients from `config` when not given one — same as before.)

- [ ] **Step 2: regression.test.ts**

Search for where it constructs `new LlmReconnoiterer(...)`. Mirror the prototype change:

```ts
const blockerDismisser = config.blockerDismiss ? new LlmBlockerDismisser() : undefined;
const reconnoiterer = new LlmReconnoiterer({ blockerDismisser });
```

Add the import: `import { LlmBlockerDismisser } from '../../src/adapters/blocker/llm-blocker-dismisser.js';` (`config` is already imported in that file). Bump the per-test timeout helper note (the comment about recon's wall-clock) to mention "+ a possible ~1-3s blocker-dismiss detect call" — no number change needed (already has slack), just keep the comment honest.

- [ ] **Step 3: Typecheck + full test run**

```bash
npm run typecheck
npm run test
```
Expected: all green (the prototype/regression files aren't run by `npm run test`, but typecheck covers them).

- [ ] **Step 4: Commit**

```bash
git add scripts/prototype-stagehand.ts tests/regression/regression.test.ts
git commit -m "chore: wire LlmBlockerDismisser into the prototype script + regression suite (Task #20)"
```

---

### Task 9: integration runs + docs + finish

**Files:**
- Modify: `CLAUDE.md`, `docs/decisions.md`, `docs/glossary.md`, `docs/naturalness-catalog.md`, `docs/findings/2026-05-11-robustness-sweep-1.md`

- [ ] **Step 1: Integration — the Guardian case (the one that failed in sweep #1)**

```bash
PROTOTYPE_URL="https://www.theguardian.com" PROTOTYPE_PROMPT="浏览一下首页头条，点击第一条新闻打开它，然后慢慢往下读" PROTOTYPE_DURATION_MS=18000 PROTOTYPE_HEADLESS=true npm run prototype:stagehand 2>&1 | tail -50
```
Expected: `metrics.blockerDismissal.rounds >= 1` with a consent dismissal; `intentSatisfaction.level` no longer `unknown` (a real headline click in the final Performance). Note the actual numbers. Then judge it:
```bash
npm run judge -- <printed recording.webm path> "浏览首页头条，点击第一条新闻，慢慢往下读" --duration-ms 18000 2>&1 | tail -25
```

- [ ] **Step 2: Integration — the canonical Recordly case (no regression)**

```bash
npm run prototype:stagehand 2>&1 | tail -45
```
Expected: `metrics.blockerDismissal.rounds: 0` (no overlay on the GitHub README), `intentSatisfaction: complete`, `rehearsal` clean. Judge if anything looks off (the canonical was `LOOKS_HUMAN` before this task).

- [ ] **Step 3: Update docs**

- `CLAUDE.md`: add a "Current state" row — `Off-camera blocker dismisser — clears cookie/consent banners + X-to-close modals before recon plans & before recording (`BLOCKER_DISMISS`, default on; Task #20 / spec 2026-05-12) | ✅`. If the measured-perf block changes (it shouldn't on Recordly — `blockerDismissal: rounds 0`), update it; otherwise add a one-line note that the Guardian-class cookie-wall case now resolves.
- `docs/decisions.md`: add a short ADR (`## NNNN · Off-camera blocker dismisser (Task #20 — BlockerPrelude reborn)`) — context (§0034 deleted BlockerPrelude; the recon-prompt stopgap failed on Guardian in sweep #1), the choice (new `IBlockerDismisser` port + `LlmBlockerDismisser`, owned by `LlmReconnoiterer`, runs before observe + on walk-reset, gpt-4o-mini, capped 3 rounds / 10s, never fatal, `RunMetrics.blockerDismissal`), what it preserves (`reconRehearse=false`/`blockerDismiss=false` ⇒ as today; the recon prompt's DISMISS-MODAL rule stays as a mid-recording backstop), and the validation numbers from Steps 1-2.
- `docs/glossary.md`: add a "Blocker dismisser" entry (one paragraph, like the "Rehearsal walk" entry).
- `docs/naturalness-catalog.md`: flip the blocker-dismissal row(s) — search for `consent` / `blocker` / `BlockerPrelude` and update the status/notes to point at the new `LlmBlockerDismisser` (Task #20).
- `docs/findings/2026-05-11-robustness-sweep-1.md`: in the "Next" section, mark "Task #20" done with the Guardian re-run result.

- [ ] **Step 4: Final review + finish the branch**

```bash
npm run typecheck && npm run test
git add CLAUDE.md docs/decisions.md docs/glossary.md docs/naturalness-catalog.md docs/findings/2026-05-11-robustness-sweep-1.md
git commit -m "docs: off-camera blocker dismisser landed — Guardian-class cookie wall resolves (Task #20)"
```
Then a final code-review pass over the whole Task #20 diff (`git diff <first-task-1-commit>^..HEAD`), then `superpowers:finishing-a-development-branch` (we're on `main`, so the "merge locally" option is a no-op — it's mainly the test-verify + cleanup gate).
