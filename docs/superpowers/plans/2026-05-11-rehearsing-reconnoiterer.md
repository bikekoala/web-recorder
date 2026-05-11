# Rehearsing Reconnoiterer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LlmReconnoiterer.recon()` walk its draft `Performance` against the live page off-camera — observing real outcomes, rewriting each action step's `expectAfter` to the *observed* state, reconverging (capped) where the draft diverges, resetting the page — so the on-camera playback rarely diverges.

**Architecture:** A new adapter-internal pure-ish function `rehearse()` (`src/adapters/recon/rehearsal.ts`) walks the draft (instant scrolls, skipped dwells, real clicks/types/keys/backs) and returns `{ steps, trace }`. `LlmReconnoiterer.recon()` orchestrates `plan → resolve targets → rehearse() → goto(startUrl)+stable → assemble+validate`. `IReconnoiterer`/`IDirector`/`IPageSession` port signatures are unchanged. Gated by `config.reconRehearse` (default on).

**Tech Stack:** TypeScript strict ESM (NodeNext — relative imports use `.js`), Zod schemas in `src/domain/`, Vitest, OpenRouter (OpenAI-compatible) for LLM, pino for logs. Hexagonal: `src/core/` imports only `src/ports/`/`src/domain/`/`src/infra/`; adapters may use libs/`config`/`logger`.

**Spec:** `docs/superpowers/specs/2026-05-11-rehearsing-reconnoiterer-design.md` — read it first.

**Branch:** work happens on `rehearsing-reconnoiterer` (already created, off `main` at `86d5ab0`; the spec is committed there as `0d1a3c8`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/domain/performance.ts` | add `RehearsalTraceSchema`/`RehearsalTrace`; add optional `rehearsal` field to `PerformanceSchema` | Modify |
| `src/infra/config.ts` | add `reconRehearse` / `reconRehearsalBudgetMs` / `reconReconvergeMax` knobs | Modify |
| `.env.example` | document the three new env vars | Modify |
| `tests/fakes/fake-page-session.ts` | add a `clickSelectorImpl` test hook so tests can simulate post-click page changes/failures | Modify |
| `src/adapters/recon/rehearsal.ts` | the `rehearse()` walk function + its `RehearsalOpts`/`ReconvergeContext` types + a `rewriteExpectAfter` helper | Create |
| `tests/unit/adapters/recon/rehearsal.test.ts` | unit tests for `rehearse()` | Create |
| `src/prompts/reconnoiterer.ts` | add `buildReconvergeUserText()` | Modify |
| `src/prompts/index.ts` | export `buildReconvergeUserText` | Modify |
| `src/adapters/recon/llm-reconnoiterer.ts` | factor out `resolveSteps()`; wire `rehearse()` + reset; assemble `Performance.rehearsal` | Modify |
| `tests/unit/adapters/recon/llm-reconnoiterer.test.ts` | extend for the rehearse orchestration + the `reconRehearse=false` skip | Modify |
| `src/core/record-job-runner.ts` | surface `rehearsal` in `RunMetrics` | Modify |
| `tests/unit/core/record-job-runner.test.ts` | assert `RunMetrics.rehearsal` is populated | Modify |
| `CLAUDE.md`, `docs/decisions.md`, `docs/findings/2026-05-11-prophet-first-integration.md`, `docs/glossary.md` | doc updates | Modify (Task 8) |

---

## Task 1: `RehearsalTrace` + `Performance.rehearsal` schema

**Files:**
- Modify: `src/domain/performance.ts`
- Test: `tests/unit/domain/performance.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `tests/unit/domain/performance.test.ts`:

```ts
import { PerformanceSchema, RehearsalTraceSchema } from '../../../src/domain/performance.js';

describe('RehearsalTrace + Performance.rehearsal', () => {
  it('RehearsalTraceSchema accepts a well-formed trace', () => {
    const t = { walkedSteps: 5, divergences: 1, reconverges: 1, truncated: false, timedOut: false };
    expect(RehearsalTraceSchema.parse(t)).toEqual(t);
  });

  it('Performance.rehearsal is optional — absent is valid', () => {
    const perf = {
      prompt: 'x', durationMs: 10000, totalEstimatedMs: 9000, rationale: 'r',
      steps: [{ kind: 'dwell', durationMs: 300, reasoning: 'open' }],
    };
    const parsed = PerformanceSchema.parse(perf);
    expect(parsed.rehearsal).toBeUndefined();
  });

  it('Performance.rehearsal round-trips when present', () => {
    const perf = {
      prompt: 'x', durationMs: 10000, totalEstimatedMs: 9000, rationale: 'r',
      steps: [{ kind: 'dwell', durationMs: 300, reasoning: 'open' }],
      rehearsal: { walkedSteps: 3, divergences: 0, reconverges: 0, truncated: false, timedOut: false },
    };
    expect(PerformanceSchema.parse(perf).rehearsal).toEqual(perf.rehearsal);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`RehearsalTraceSchema` not exported).

Run: `npm run test -- performance`
Expected: FAIL (import error / `rehearsal` stripped).

- [ ] **Step 3: Implement.** In `src/domain/performance.ts`, after `PerformanceStep` (before `PerformanceSchema`), add:

```ts
/**
 * Health summary of the off-camera rehearsal walk (see ADR §0034 / the
 * rehearsing-reconnoiterer spec). The operator canary: high `divergences` /
 * `truncated: true` means the LLM's first-draft planning is weak for that site.
 */
export const RehearsalTraceSchema = z.object({
  walkedSteps: z.number().int().nonnegative(),
  divergences: z.number().int().nonnegative(),
  reconverges: z.number().int().nonnegative(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
export type RehearsalTrace = z.infer<typeof RehearsalTraceSchema>;
```

Then add to `PerformanceSchema` (after `rationale`):

```ts
  /** Present iff the recon ran a rehearsal walk (config.reconRehearse). */
  rehearsal: RehearsalTraceSchema.optional(),
```

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- performance`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit.**

```bash
git add src/domain/performance.ts tests/unit/domain/performance.test.ts
git commit -m "feat(domain): RehearsalTrace + optional Performance.rehearsal (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: config knobs for the rehearsal

**Files:**
- Modify: `src/infra/config.ts`
- Modify: `.env.example`
- Test: `tests/unit/infra/config.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `tests/unit/infra/config.test.ts` (it already uses `vi.resetModules()` + `vi.stubEnv` + dynamic re-import — follow that pattern):

```ts
describe('rehearsal config knobs', () => {
  it('reconRehearse defaults to true', async () => {
    vi.resetModules();
    const { config } = await import('../../../src/infra/config.js');
    expect(config.reconRehearse).toBe(true);
  });
  it('RECON_REHEARSE=false disables it', async () => {
    vi.resetModules();
    vi.stubEnv('RECON_REHEARSE', 'false');
    const { config } = await import('../../../src/infra/config.js');
    expect(config.reconRehearse).toBe(false);
    vi.unstubAllEnvs();
  });
  it('reconRehearsalBudgetMs / reconReconvergeMax have sensible defaults', async () => {
    vi.resetModules();
    const { config } = await import('../../../src/infra/config.js');
    expect(config.reconRehearsalBudgetMs).toBe(30000);
    expect(config.reconReconvergeMax).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`config.reconRehearse` is `undefined`).

Run: `npm run test -- config`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/infra/config.ts`, in the Zod schema near `maxReplans` / `replanMinRemainingMs`, add (match the file's existing boolean-from-env pattern — `BROWSER_RETURN_FOCUS` uses `z.enum(['true','false','1','0']).transform(v => v==='true'||v==='1').default('true')`; reuse that form):

```ts
  // Rehearsing reconnoiterer (Task #21): the recon walks its draft against the
  // live page off-camera before recording, verifying targets and rewriting
  // expectAfter to observed state. `reconRehearse` is the master switch (off ⇒
  // recon falls back to plan-and-resolve, no walk). `reconRehearsalBudgetMs`
  // caps the whole walk's wall-clock; `reconReconvergeMax` caps the LLM
  // reconverge calls during a walk. Both overruns ⇒ truncate the walk + a
  // graceful tail. See the rehearsing-reconnoiterer spec.
  reconRehearse: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('true'),
  reconRehearsalBudgetMs: z.coerce.number().int().min(0).default(30000),
  reconReconvergeMax: z.coerce.number().int().min(0).max(10).default(2),
```

And in the `raw` env-parsing layer (where the file maps `process.env.* → raw object` — match how `replanMinRemainingMs` / `maxReplans` are wired there, including the `|| undefined` empty-string guard the file uses for the bool):

```ts
  reconRehearse: process.env.RECON_REHEARSE || undefined,
  reconRehearsalBudgetMs: process.env.RECON_REHEARSAL_BUDGET_MS,
  reconReconvergeMax: process.env.RECON_RECONVERGE_MAX,
```

(If `config.ts` is structured so the schema parses `process.env` directly without a separate `raw` layer, adapt — keep the parsing in `config.ts`.)

In `.env.example`, in the "Reconnaissance / re-plan (§0034 prophet recording)" block, add:

```
# Rehearsing reconnoiterer (Task #21) — recon walks its draft off-camera
# before recording, verifies targets, rewrites expectAfter to observed state,
# reconverges (capped) on divergence. Master switch + budgets:
# RECON_REHEARSE=true
# RECON_REHEARSAL_BUDGET_MS=30000   # wall-clock cap on the whole walk
# RECON_RECONVERGE_MAX=2            # cap on reconverge LLM calls per walk
```

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- config`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit.**

```bash
git add src/infra/config.ts .env.example tests/unit/infra/config.test.ts
git commit -m "config: reconRehearse + reconRehearsalBudgetMs + reconReconvergeMax (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `FakePageSession` — a `clickSelectorImpl` hook

So rehearsal tests can simulate "after this click the page navigated" / "this click did nothing" / "this click threw".

**Files:**
- Modify: `tests/fakes/fake-page-session.ts`

- [ ] **Step 1: Implement directly** (this is test infrastructure — no separate test for the fake). In `tests/fakes/fake-page-session.ts`, near `clickByDescriptionImpl`, add:

```ts
  /**
   * Optional test hook — if set, called by `clickSelector` AFTER recording the
   * event. Use it to simulate the click's effect (e.g. mutate `this.url` /
   * `this.observeResults` / `this.pageDiagnosticImpl` to model a navigation),
   * or to throw (e.g. `() => { throw new ElementNotFoundError('gone'); }`) to
   * model a click that failed.
   */
  clickSelectorImpl: ((selector: string, opts?: { description?: string }) => Promise<void> | void) | null = null;
```

And change `clickSelector` to:

```ts
  async clickSelector(selector: string, opts?: { description?: string }) {
    this.record('click', { selector, description: opts?.description });
    if (this.clickSelectorImpl) {
      await this.clickSelectorImpl(selector, opts);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
```

- [ ] **Step 2: Verify nothing broke.**

Run: `npm run test`
Expected: PASS (all existing tests — the new field is opt-in, `clickSelectorImpl` defaults to `null` so `clickSelector` behaves exactly as before).

- [ ] **Step 3: Commit.**

```bash
git add tests/fakes/fake-page-session.ts
git commit -m "test(fakes): FakePageSession clickSelectorImpl hook for rehearsal tests (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `rehearse()` — the off-camera walk

**Files:**
- Create: `src/adapters/recon/rehearsal.ts`
- Test: `tests/unit/adapters/recon/rehearsal.test.ts`

### The algorithm (reference — implemented across the steps below)

```
rehearse({ draftSteps, session, intent, reconverge, rehearsalBudgetMs, reconvergeMax, logger }):
  deadlineAt = Date.now() + rehearsalBudgetMs
  steps = [...draftSteps]              // mutable working copy
  walked = []                          // verified output steps
  divergences = 0; reconverges = 0; truncated = false; timedOut = false
  i = 0
  while i < steps.length:
    if Date.now() >= deadlineAt: timedOut = true; truncated = true; break
    step = steps[i]
    if step.kind === 'done': walked.push(step); i++; continue
    if step.kind === 'dwell': walked.push(step); i++; continue          // skip the wait, keep the step
    if step.kind === 'scroll':
      await session.scroll(step.deltaPx, { durationMs: 1 })             // instant
      walked.push(step); i++; continue                                  // keep original durationMs/easing/dwellAfterMs
    // step is click | type | key | back  — an "acting" step
    urlBefore = await safeCurrentUrl(session)
    sigBefore = await observeSignature(session)
    let threw = false
    try {
      await renderActingStepInstant(step, session)                      // click→clickSelector; type→clickSelector+type; key→pressKey; back→goBack
    } catch (err) { threw = true; logger.debug({ err, kind: step.kind }, 'rehearsal acting step threw') }
    urlAfter = await safeCurrentUrl(session)
    diag = await session.pageDiagnostic().catch(() => null)
    const eaBefore = stepExpectAfter(step)
    const eaSatisfied = eaBefore ? await expectAfterSatisfied(eaBefore, urlAfter, session) : true
    const aboutBlank = urlAfter === 'about:blank'
    const sigAfter = await observeSignature(session)
    const unchanged = (step.kind === 'click' || step.kind === 'type') && !threw && urlBefore === urlAfter && sigBefore === sigAfter
    const diverged = threw || aboutBlank || !eaSatisfied || unchanged
    if (!diverged):
      walked.push(rewriteExpectAfter(step, urlBefore, urlAfter, eaBefore, diag))
      i++; continue
    // diverged
    divergences++
    logger.info({ i, kind: step.kind, threw, aboutBlank, unchanged, eaSatisfied }, 'rehearsal divergence')
    if (reconverges < reconvergeMax && Date.now() < deadlineAt):
      let newSteps
      try {
        newSteps = await reconverge({ session, divergedAtIndex: i, divergedStep: step, intent, observedUrl: urlAfter })
      } catch (err) { logger.warn({ err }, 'reconverge failed'); newSteps = null }
      if (newSteps && newSteps.length > 0):
        reconverges++
        steps = [...steps.slice(0, i + 1), ...newSteps]   // keep up to & incl. the diverged step? NO — see note
        // actually: drop the diverged step too (it didn't work). Keep walked[] as-is (it has the prior verified steps).
        steps = [...newSteps]                              // restart the working list from the reconverged steps
        i = 0
        continue
      // reconverge produced nothing usable → fall through to truncate
    // truncate
    truncated = true
    break
  // after the loop:
  if truncated:
    walked.push(...gracefulTail())                         // [scroll(320px,1500ms,inOutQuad,0), dwell(700ms), done]
  else if walked has no 'done' step:
    walked.push({ kind: 'done', reasoning: 'rehearsal walk completed; nothing left to do' })
  await session.goto(startUrl=intentUrl).catch(...)        // CALLER does the reset, not rehearse — see Task 6. So rehearse does NOT reset.
  return { steps: walked, trace: { walkedSteps: walked.length, divergences, reconverges, truncated, timedOut } }
```

**Important corrections to the sketch above (the real spec):**
- `rehearse()` does **NOT** reset the page (`goto`) — the caller (`LlmReconnoiterer.recon()`, Task 6) does that after `rehearse()` returns. Keeps `rehearse()` focused on "walk + produce verified steps".
- On reconverge: **the diverged step is dropped** (it didn't do what we thought). `walked[]` already holds the verified prefix (steps before the diverged one). We replace the *entire remaining working list* with the reconverged steps: `steps = [...newSteps]; i = 0;` and keep walking. (The reconverged steps already have resolved targets — that's the caller's job in the `reconverge` callback.)
- A reconverged step list may itself diverge → counts against the same `divergences` / `reconverges` caps. When `reconvergeMax` is hit, the next divergence ⇒ truncate.
- `gracefulTail()` = `[{kind:'scroll', deltaPx:320, durationMs:1500, easing:'inOutQuad', dwellAfterMs:0, reasoning:'rehearsal truncated: gentle closing scroll'}, {kind:'dwell', durationMs:700, reasoning:'rehearsal truncated: brief settle'}, {kind:'done', reasoning:'rehearsal truncated — playing out gracefully'}]`. (Match `PerformanceStepSchema` exactly — `scroll` has `deltaPx`/`durationMs`/`easing`/`dwellAfterMs`/`reasoning`; `dwell` has `durationMs`/`reasoning`; `done` has `reasoning`. No `brief` field on any variant.)
- If `walked` ends up empty (every step diverged immediately) → `walked = gracefulTail()` and `truncated = true`. Never return zero steps (the caller's `PerformanceSchema` requires `steps.min(1)`).
- `expectAfterSatisfied(ea, urlAfter, session)`: if `ea.urlContains` and `!urlAfter.includes(ea.urlContains)` → false; for each `t` in `ea.visibleText` if `await session.quickFindOnPage(t).catch(()=>null)` is falsy → false; else true. (Same logic PerformanceDirector uses — keep it in step.)
- `observeSignature(session)`: `const els = await session.observeAll().catch(() => []); return els.length + ':' + els.map(e => e.selector).join('|');` — cheap structural fingerprint for the "page unchanged" check.
- `safeCurrentUrl(session)`: `try { return await session.currentUrl(); } catch { return ''; }`.
- `stepExpectAfter(step)`: returns `step.expectAfter ?? null` for `click`/`key`/`back`, else `null`.
- `renderActingStepInstant(step, session)`: `click` → `await session.clickSelector(step.target.selector, { description: step.target.description })`; `type` → `await session.clickSelector(step.target.selector, { description: step.target.description }); await session.type(step.text, { preMs: 0, keystrokeMs: 0 })`; `key` → `await session.pressKey(step.key)`; `back` → `await session.goBack()`.
- `rewriteExpectAfter(step, urlBefore, urlAfter, eaBefore, diag)`: only `click`/`key`/`back` carry `expectAfter` — for those, build `next: ExpectAfter = {}`; if `urlAfter && urlAfter !== urlBefore && urlAfter !== 'about:blank'` set `next.urlContains = pathOf(urlAfter)` where `pathOf` = `new URL(urlAfter).pathname` (fallback to `urlAfter` if `new URL` throws); collect `visibleText` candidates = the entries of `eaBefore?.visibleText ?? []` that `quickFindOnPage` confirmed present *plus* `diag?.visibleHeadings?.[0]` if any — dedupe, take up to 2; if non-empty set `next.visibleText`. If `next` has at least one key, return `{ ...step, expectAfter: next }`; else if `step` already had an `expectAfter` that was satisfied, keep it; else return `step` unchanged. For `type`/`scroll`/`dwell`/`done` return `step` unchanged. (Since `rewriteExpectAfter` calls `quickFindOnPage`, make it `async`.)

### Types in `src/adapters/recon/rehearsal.ts`

```ts
import { type PerformanceStep, type RehearsalTrace } from '../../domain/performance.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { Logger } from 'pino';   // (or whatever pino's logger type alias is used elsewhere — check src/infra/logger.ts; if it exports a type, use that)

export interface ReconvergeContext {
  session: IPageSession;
  divergedAtIndex: number;
  divergedStep: PerformanceStep;
  intent: string;
  observedUrl: string;
}

export interface RehearsalOpts {
  draftSteps: PerformanceStep[];
  session: IPageSession;
  intent: string;
  reconverge: (ctx: ReconvergeContext) => Promise<PerformanceStep[]>;
  rehearsalBudgetMs: number;
  reconvergeMax: number;
  logger: Logger;          // pino child logger
}

export async function rehearse(opts: RehearsalOpts): Promise<{ steps: PerformanceStep[]; trace: RehearsalTrace }> { /* ... */ }
```

(If `src/infra/logger.ts` doesn't export a clean logger type, type `logger` as `ReturnType<typeof rootLogger.child>` imported from there, or `pino.Logger`. Don't `any` it.)

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/adapters/recon/rehearsal.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { rehearse, type ReconvergeContext } from '../../../../src/adapters/recon/rehearsal.js';
import type { PerformanceStep } from '../../../../src/domain/performance.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';

const log = pino({ level: 'silent' });
const NEVER_RECONVERGE = async (_ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
  throw new Error('reconverge should not have been called');
};

function clickStep(desc: string, expectAfter?: { urlContains?: string; visibleText?: string[] }): PerformanceStep {
  return { kind: 'click', target: { selector: `sel:${desc}`, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: desc }, anticipationMs: 200, reasoning: `click ${desc}`, ...(expectAfter ? { expectAfter } : {}) };
}
const dwell = (ms: number): PerformanceStep => ({ kind: 'dwell', durationMs: ms, reasoning: 'd' });
const scroll = (px: number): PerformanceStep => ({ kind: 'scroll', deltaPx: px, durationMs: 2000, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 's' });
const done: PerformanceStep = { kind: 'done', reasoning: 'fin' };

it('no divergence: walks all steps, rewrites click expectAfter to observed state, keeps scroll/dwell params', async () => {
  const session = new FakePageSession();
  session.url = 'https://test.example/';
  session.observeResults = [{ selector: 'a#x', description: 'x' }];
  // a successful click navigates + changes the page:
  session.clickSelectorImpl = () => {
    session.url = 'https://test.example/zh';
    session.observeResults = [{ selector: 'a#y', description: 'y' }];
    session.pageDiagnosticImpl = () => ({ url: session.url, title: 'ZH', interactiveElementCount: 5, visibleHeadings: ['Heading ZH'], blockerSignals: [] });
  };
  const draft: PerformanceStep[] = [dwell(300), scroll(800), clickStep('the link', { urlContains: '/wrong', visibleText: ['gone'] }), dwell(400), done];
  const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
  expect(trace).toMatchObject({ divergences: 0, reconverges: 0, truncated: false, timedOut: false });
  // dwell and scroll kept verbatim:
  expect(steps[0]).toEqual(dwell(300));
  expect(steps[1]).toEqual(scroll(800));
  // click expectAfter rewritten to OBSERVED state (path + the page's heading), not the LLM's bogus values:
  const click = steps[2] as Extract<PerformanceStep, { kind: 'click' }>;
  expect(click.expectAfter?.urlContains).toBe('/zh');
  expect(click.expectAfter?.visibleText).toContain('Heading ZH');
  expect(click.expectAfter?.visibleText).not.toContain('gone');
  // a 'done' is present at the end:
  expect(steps[steps.length - 1].kind).toBe('done');
});

it('dead click (page unchanged after click) → divergence → reconverge → working list replaced', async () => {
  const session = new FakePageSession();
  session.url = 'https://test.example/';
  session.observeResults = [{ selector: 'a#x', description: 'x' }];
  // clickSelectorImpl unset ⇒ the click changes nothing ⇒ "unchanged" ⇒ divergence
  const reconverged: PerformanceStep[] = [clickStep('the REAL link'), done];
  let reconvergeCalls = 0;
  const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
    reconvergeCalls++;
    expect(ctx.divergedStep.kind).toBe('click');
    // on the reconverged path, make THIS click succeed so it doesn't diverge again:
    session.clickSelectorImpl = () => { session.url = 'https://test.example/real'; session.observeResults = [{ selector: 'a#z', description: 'z' }]; };
    return reconverged;
  };
  const draft: PerformanceStep[] = [clickStep('the link'), dwell(400), done];
  const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
  expect(reconvergeCalls).toBe(1);
  expect(trace).toMatchObject({ divergences: 1, reconverges: 1, truncated: false, timedOut: false });
  // the diverged 'the link' click is NOT in the output; 'the REAL link' is:
  expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the link')).toBe(false);
  expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the REAL link')).toBe(true);
});

it('reconverge cap hit → truncate at the divergence + graceful tail', async () => {
  const session = new FakePageSession();
  session.observeResults = [{ selector: 'a#x', description: 'x' }];
  // every click is dead ⇒ every reconverged click also dead ⇒ caps blow ⇒ truncate
  const reconverge = async (_ctx: ReconvergeContext): Promise<PerformanceStep[]> => [clickStep('still dead'), done];
  const draft: PerformanceStep[] = [clickStep('a'), done];
  const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 1, logger: log });
  expect(trace.truncated).toBe(true);
  expect(trace.reconverges).toBe(1);
  // graceful tail present: a scroll, a short dwell, a done — in that order at the end
  const tail = steps.slice(-3);
  expect(tail.map((s) => s.kind)).toEqual(['scroll', 'dwell', 'done']);
});

it('wall-clock budget exceeded → truncate (timedOut)', async () => {
  const session = new FakePageSession();
  session.observeResults = [{ selector: 'a#x', description: 'x' }];
  // many steps + a 0ms budget ⇒ loop bails on the first iteration
  const draft: PerformanceStep[] = [scroll(100), scroll(100), scroll(100), done];
  const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 0, reconvergeMax: 2, logger: log });
  expect(trace.timedOut).toBe(true);
  expect(trace.truncated).toBe(true);
  expect(steps[steps.length - 1].kind).toBe('done');
});

it('never returns zero steps', async () => {
  const session = new FakePageSession();
  session.observeResults = [{ selector: 'a#x', description: 'x' }];
  const reconverge = async (): Promise<PerformanceStep[]> => [];   // reconverger gives nothing
  const draft: PerformanceStep[] = [clickStep('a')];   // dead click, reconverge yields nothing ⇒ truncate
  const { steps } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
  expect(steps.length).toBeGreaterThan(0);
  expect(steps[steps.length - 1].kind).toBe('done');
});
```

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist).

Run: `npm run test -- rehearsal`
Expected: FAIL (cannot find `../../../../src/adapters/recon/rehearsal.js`).

- [ ] **Step 3: Implement `src/adapters/recon/rehearsal.ts`** per the algorithm above. Key points to get right:
  - The "page unchanged" check (`urlBefore === urlAfter && sigBefore === sigAfter` for click/type, not threw). This is what catches the §0034 dead-click failure.
  - `dwell` steps are kept in the output verbatim but NOT waited on during the walk.
  - `scroll` steps are kept verbatim; the walk does `session.scroll(deltaPx, { durationMs: 1 })` (instant) — do NOT pass the original `durationMs`.
  - On reconverge: drop the diverged step, set `steps = [...newSteps]`, `i = 0`, continue. (`walked[]` already has the verified prefix.)
  - After the loop: if `truncated`, append the graceful tail (scroll+dwell+done). Else if no `done` in `walked`, append one. If `walked` is empty, `walked = gracefulTail()` (and the trace's `truncated` should be `true` in that case — set it).
  - `rewriteExpectAfter` is async (it calls `quickFindOnPage`). Don't forget to `await` it where called.
  - All `session.*` reads (`currentUrl`, `observeAll`, `pageDiagnostic`, `quickFindOnPage`, `screenshot`) wrapped so a throw doesn't crash the walk — use `.catch(() => <fallback>)`. A throw from an *acting* step (`clickSelector` etc.) is caught and turned into `threw = true` (a divergence), NOT propagated. A truly unexpected throw outside those (shouldn't happen given the `.catch`es) — let it propagate; the caller turns it into `ReconError`.
  - Use the `logger` for `info` on each divergence and `debug` on caught acting-step throws. No `console.log`.

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- rehearsal`
Expected: PASS (all 5). Then `npm run typecheck` — clean. Then `npm run test` — full suite green.

- [ ] **Step 5: Commit.**

```bash
git add src/adapters/recon/rehearsal.ts tests/unit/adapters/recon/rehearsal.test.ts
git commit -m "feat(recon): rehearse() — off-camera walk that verifies the draft & rewrites expectAfter (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `buildReconvergeUserText` prompt

**Files:**
- Modify: `src/prompts/reconnoiterer.ts`
- Modify: `src/prompts/index.ts`
- Test: `tests/unit/prompts/reconnoiterer.test.ts` (create if it doesn't exist; otherwise add to it)

- [ ] **Step 1: Write the failing test.** In `tests/unit/prompts/reconnoiterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildReconvergeUserText } from '../../../src/prompts/index.js';
import type { PerformanceStep } from '../../../src/domain/performance.js';

it('buildReconvergeUserText mentions the intent, the diverged step, and asks for remaining steps JSON', () => {
  const divergedStep: PerformanceStep = { kind: 'click', target: { selector: 's', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'the 简体中文 link' }, anticipationMs: 200, reasoning: 'switch language' };
  const observed = [{ selector: 'a#real', description: 'Simplified Chinese' }];
  const text = buildReconvergeUserText({ intent: 'click 简体中文, slow scroll', divergedStep, observedUrl: 'https://example.com/x', observed });
  expect(text).toContain('click 简体中文, slow scroll');     // the intent
  expect(text).toContain('the 简体中文 link');                // the diverged target description
  expect(text).toContain('https://example.com/x');           // the observed URL
  expect(text).toContain('Simplified Chinese');              // an observed element
  expect(text.toLowerCase()).toContain('steps');             // asks for steps
});
```

- [ ] **Step 2: Run — expect FAIL** (not exported).

Run: `npm run test -- reconnoiterer`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/prompts/reconnoiterer.ts`, add (alongside `buildReconUserText`):

```ts
/**
 * User message for a *reconverge* call during the off-camera rehearsal walk
 * (Task #21). A draft step did not do what the planner expected; we hand the
 * LLM the current page state and ask for the REST of the plan from here. The
 * system prompt is the same `reconnoitererSystemPrompt` (it already specifies
 * the Performance JSON shape); we only need the remaining `steps` array back.
 */
export function buildReconvergeUserText(args: {
  intent: string;
  divergedStep: PerformanceStep;
  observedUrl: string;
  observed: ReadonlyArray<{ selector: string; description: string }>;
}): string {
  const { intent, divergedStep, observedUrl, observed } = args;
  const stepDesc =
    divergedStep.kind === 'click' || divergedStep.kind === 'type'
      ? `${divergedStep.kind} "${divergedStep.target.description}"`
      : divergedStep.kind === 'key'
        ? `key ${divergedStep.key}`
        : divergedStep.kind;
  const list = observed.slice(0, 40).map((e, n) => `${n + 1}. ${e.description} — selector: ${e.selector}`).join('\n');
  return [
    `RE-PLAN (mid-rehearsal).`,
    `Original task: ${intent}`,
    `The planned step \`${stepDesc}\` (reasoning: "${divergedStep.reasoning}") did NOT produce the expected result — the page either did not change, did not navigate as expected, or went blank.`,
    `Current page URL: ${observedUrl}`,
    `Interactive elements visible on the current page:`,
    list || '(none observed)',
    ``,
    `Give me the REMAINING plan from HERE — a JSON object \`{ "steps": [ ... ] }\` whose \`steps\` follow the same schema as a full Performance's steps (kinds: click/scroll/type/key/dwell/back/done; click/type targets are just {"description": "..."} — they'll be resolved later). Do NOT repeat the failed step. End with a \`done\` step. Keep it tight and paced for the time that's left.`,
  ].join('\n');
}
```

(Make sure `PerformanceStep` is imported at the top of `reconnoiterer.ts` — `import type { PerformanceStep } from '../domain/performance.js';`.)

In `src/prompts/index.ts`, add to the reconnoiterer export line:

```ts
export { reconnoitererSystemPrompt, buildReconUserText, buildReconvergeUserText } from './reconnoiterer.js';
```

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- reconnoiterer`
Expected: PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit.**

```bash
git add src/prompts/reconnoiterer.ts src/prompts/index.ts tests/unit/prompts/reconnoiterer.test.ts
git commit -m "feat(prompts): buildReconvergeUserText for mid-rehearsal re-plan (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: wire `rehearse()` into `LlmReconnoiterer.recon()`

**Files:**
- Modify: `src/adapters/recon/llm-reconnoiterer.ts`
- Test: `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`

- [ ] **Step 1: Write the failing tests.** Add to `tests/unit/adapters/recon/llm-reconnoiterer.test.ts` (it already mocks the OpenAI client and a fake `IPageSession` — follow the existing pattern; you may need a fake that supports `clickSelector` outcomes via `FakePageSession`'s new `clickSelectorImpl`):

```ts
it('runs the rehearsal walk by default and resets the page afterwards', async () => {
  // Arrange: a fake OpenAI client that returns a 2-step plan (a click + done),
  // a FakePageSession where the click succeeds (navigates), reconRehearse on (default).
  // ...build `recon = new LlmReconnoiterer({ client: fakeClient, model: 'm' })`...
  const session = new FakePageSession();
  session.url = 'https://site.test/';
  session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
  session.clickSelectorImpl = () => { session.url = 'https://site.test/next'; };
  const perf = await recon.recon({ url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
  // rehearsal trace present:
  expect(perf.rehearsal).toBeDefined();
  expect(perf.rehearsal!.walkedSteps).toBeGreaterThan(0);
  // reset happened: a goto back to the start URL + a stability wait, AFTER the walk's clicks
  const gotoEvents = session.events.filter((e) => e.kind === 'goto');
  expect(gotoEvents[gotoEvents.length - 1]!.payload).toBe('https://site.test/');
  expect(session.events.some((e) => e.kind === 'stable')).toBe(true);
});

it('reconRehearse=false skips the walk — no rehearsal field, no extra clicks/goto', async () => {
  vi.stubEnv('RECON_REHEARSE', 'false');
  // re-import config + LlmReconnoiterer so the env takes effect (vi.resetModules + dynamic import),
  // OR construct LlmReconnoiterer with an explicit opt if it accepts one — pick whichever the file supports.
  // ...build recon + a FakePageSession + a fake client returning a 1-step [done] plan...
  const session = new FakePageSession();
  session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
  const perf = await recon.recon({ url: 'https://site.test/', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
  expect(perf.rehearsal).toBeUndefined();
  expect(session.events.some((e) => e.kind === 'click')).toBe(false);
  vi.unstubAllEnvs();
});
```

(If the existing test file already has a clean harness for building `LlmReconnoiterer` + a fake `IPageSession`, reuse it; the above is the *intent* of the new cases — adapt names to match. If `config.reconRehearse` can't be toggled per-test without `vi.resetModules()`, do the resetModules+dynamic-import dance for the second test, the way `config.test.ts` does.)

- [ ] **Step 2: Run — expect FAIL.**

Run: `npm run test -- llm-reconnoiterer`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/adapters/recon/llm-reconnoiterer.ts`:

  1. **Factor out `resolveSteps()`** — pull the loop in `recon()` that turns `rawSteps: Array<Record<string,unknown>>` into resolved `PerformanceStep[]` (resolve click/type targets via `session.resolveTarget`, drop unresolvable, `ResolvedTargetSchema.parse`) into a private method `private async resolveSteps(rawSteps: Array<Record<string, unknown>>, session: IPageSession): Promise<PerformanceStep[]>` and call it from `recon()` where the inline loop used to be. (No behavior change — just extraction, so the reconverge path can reuse it.)

  2. **Add the rehearsal step.** After `resolvedSteps` is computed and before assembling `candidate`, add:

```ts
import { rehearse, type ReconvergeContext } from './rehearsal.js';
import { buildReconvergeUserText } from '../../prompts/index.js';
// ... and `config` is already imported

// inside recon(), after resolvedSteps non-empty check:
let finalSteps = resolvedSteps;
let rehearsalTrace: import('../../domain/performance.js').RehearsalTrace | undefined;
if (config.reconRehearse) {
  const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
    const observed = await ctx.session.observeAll().catch(() => []);
    const screenshot = await ctx.session.screenshot().catch(() => null);
    const userText = buildReconvergeUserText({ intent: ctx.intent, divergedStep: ctx.divergedStep, observedUrl: ctx.observedUrl, observed });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (screenshot && screenshot.length > 0) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } });
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'system', content: reconnoitererSystemPrompt }, { role: 'user', content }],
        response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 3000,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) { this.logger.warn({ err }, 'reconverge LLM call failed'); return []; }
    if (!raw) return [];
    let parsed: { steps?: unknown };
    try { parsed = JSON.parse(stripCodeFence(raw)); } catch { this.logger.warn('reconverge JSON parse failed'); return []; }
    if (!Array.isArray(parsed.steps)) return [];
    return this.resolveSteps(parsed.steps as Array<Record<string, unknown>>, ctx.session);
  };
  try {
    const result = await rehearse({
      draftSteps: resolvedSteps,
      session,
      intent: candidate?.prompt ?? input.prompt,   // i.e. the prompt string we'll put on the Performance
      reconverge,
      rehearsalBudgetMs: config.reconRehearsalBudgetMs,
      reconvergeMax: config.reconReconvergeMax,
      logger: this.logger,
    });
    finalSteps = result.steps;
    rehearsalTrace = result.trace;
  } catch (err) {
    throw new ReconError('rehearsal walk failed', err);
  }
  // reset the page so the on-camera run reproduces the start state
  try {
    await session.goto(input.url);
    await session.waitForVisualStability();
  } catch (err) {
    this.logger.warn({ err }, 'page reset after rehearsal failed — on-camera run may diverge (the director re-plan/graceful-degradation is the backstop)');
  }
}
```

  3. **Assemble `candidate` from `finalSteps`** (not `resolvedSteps`), and add `rehearsal: rehearsalTrace` to it:

```ts
const candidate: Performance = {
  prompt: typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt,
  durationMs: input.durationMs,
  steps: finalSteps,
  totalEstimatedMs: typeof parsedRaw.totalEstimatedMs === 'number' ? parsedRaw.totalEstimatedMs : sumDurations(finalSteps),
  rationale: typeof parsedRaw.rationale === 'string' ? parsedRaw.rationale : 'no rationale provided',
  ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
};
```

  (Note: the sketch references `candidate?.prompt` for the rehearsal `intent` before `candidate` exists — that's wrong. Just compute the prompt string once: `const promptStr = typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt;` before the rehearsal block, pass `intent: promptStr` to `rehearse()`, and reuse `promptStr` when building `candidate`. Fix the ordering accordingly.)

  4. Update the doc-comment block at the top of the class to mention the rehearsal step in the pipeline.

  5. Make sure `resolveSteps()` doesn't throw on an empty result here — the *initial* recon still throws `ReconError('recon produced zero usable steps...')` if `resolvedSteps.length === 0` (keep that check before the rehearsal block). But the `reconverge` callback returning `[]` is fine (the walker handles it → truncate).

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- llm-reconnoiterer rehearsal performance config`
Expected: PASS. Then `npm run typecheck` — clean. Then `npm run test` — full suite green.

- [ ] **Step 5: Commit.**

```bash
git add src/adapters/recon/llm-reconnoiterer.ts tests/unit/adapters/recon/llm-reconnoiterer.test.ts
git commit -m "feat(recon): LlmReconnoiterer runs the rehearsal walk + page reset (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: surface `rehearsal` in `RunMetrics`

**Files:**
- Modify: `src/core/record-job-runner.ts`
- Test: `tests/unit/core/record-job-runner.test.ts`

- [ ] **Step 1: Write the failing test.** In the existing `RecordJobRunner — prophet wiring` test block in `tests/unit/core/record-job-runner.test.ts`, have the `FakeReconnoiterer`'s queued `Performance` include a `rehearsal` trace, then assert it surfaces:

```ts
// when building the queued Performance for the wiring test, add:
rehearsal: { walkedSteps: 4, divergences: 1, reconverges: 1, truncated: false, timedOut: false },
// then after `result = await runner.run(...)`:
expect(result.metrics.rehearsal).toEqual({ walkedSteps: 4, divergences: 1, reconverges: 1, truncated: false, timedOut: false });
```

Also: an existing case (or a new tiny one) where the queued `Performance` has no `rehearsal` field ⇒ `result.metrics.rehearsal` is `null`.

- [ ] **Step 2: Run — expect FAIL** (`metrics.rehearsal` is `undefined`/missing).

Run: `npm run test -- record-job-runner`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/core/record-job-runner.ts`:
  - Import `RehearsalTrace`: `import { ..., type RehearsalTrace } from '../domain/performance.js';` (the file already imports `Performance`/`PerformanceStep` from there).
  - Add to the `RunMetrics` interface: `/** Off-camera rehearsal health (null if recon ran without a rehearsal walk). */ rehearsal: RehearsalTrace | null;`
  - In `run()`, where `metrics` is assembled, add: `rehearsal: performance.rehearsal ?? null,`
  - Update the `RunMetrics` doc-comment block to mention it.

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test -- record-job-runner`
Expected: PASS. Then `npm run typecheck` — clean. Then `npm run test` — full suite green.

- [ ] **Step 5: Commit.**

```bash
git add src/core/record-job-runner.ts tests/unit/core/record-job-runner.test.ts
git commit -m "feat(core): RunMetrics.rehearsal surfaces the off-camera walk trace (Task #21)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: integration run + acceptance + docs

**Files:**
- Modify: `CLAUDE.md`, `docs/decisions.md`, `docs/findings/2026-05-11-prophet-first-integration.md`, `docs/glossary.md`

> This task is done **hands-on by the controller** (it needs `OPENROUTER_API_KEY` + a real browser). The implementer subagent should do the doc edits in Steps 5–6 only once the controller reports the integration numbers.

- [ ] **Step 1: Full unit suite + typecheck.**

Run: `npm run typecheck && npm run test`
Expected: all green.

- [ ] **Step 2: Integration run on the canonical scenario.**

Run: `npm run prototype:stagehand` (GitHub Recordly README, "click 简体中文, slow scroll", 10 s; needs `OPENROUTER_API_KEY` in `.env`).
Expected: a recording produced; the log shows a `rehearsal` block in `RunMetrics` (`divergences`, `reconverges`, `truncated`). Hopefully `intentSatisfaction: complete` (the 简体中文 target now verified, or reconverged to the right one), `replanCount: 0`, `endReason: done`. Note `reconMs` (will be larger — the walk is part of it now) and the rehearsal trace.

- [ ] **Step 3: §0030 judge on the produced recording.**

Run: `npm run judge -- <recording.webm path> "click 简体中文, slow scroll" --duration-ms 10000`
Expected: `pacing` ≠ `fail`; verdict at worst `probably_synthetic`. (Eyeball check, not a hard gate.) If the recon still resolves the wrong 简体中文 target *and* reconverge doesn't fix it, iterate on the recon prompt + the reconverge prompt before declaring done — that's the bet.

- [ ] **Step 4: Regression suite (optional but recommended).**

Run: `npm run regression`
Expected: categorical asserts pass (timeouts already bumped to `RECON_BUDGET_MS + durationMs*2 + 30_000`; the rehearsal walk adds wall-clock — if a case now times out, bump `RECON_BUDGET_MS` and note it). Eyeball a couple of videos.

- [ ] **Step 5: Doc updates.**
  - `CLAUDE.md`: in the `Current state` table add `IReconnoiterer — rehearsing recon (walks the draft off-camera, verifies targets, rewrites expectAfter, reconverges) (§0034 / Task #21)` ✅; refresh the "Measured performance" block with the numbers from Step 2 (note `reconMs` now includes the walk; note `rehearsal: { divergences, reconverges, truncated }`); update the unit-test count.
  - `docs/decisions.md` §0034: append a short "Update — rehearsing recon (Task #21)" subsection: the recon now rehearses its draft off-camera (graduated walk: instant scrolls, skipped dwells, real acting steps), rewrites each acting step's `expectAfter` to the observed state, reconverges (capped, `reconReconvergeMax`) on divergence and truncates+graceful-tails on cap/timeout (`reconRehearsalBudgetMs`); gated by `reconRehearse` (default on); `Performance.rehearsal` / `RunMetrics.rehearsal` is the canary; cite the spec + the integration result.
  - `docs/findings/2026-05-11-prophet-first-integration.md`: append a "Update — after the rehearsing recon (Task #21)" section with the before/after (the §0034 "B fix" run vs. this run) — verdict, `intentSatisfaction`, `replanCount`, the rehearsal trace, judge dimensions.
  - `docs/glossary.md`: add `rehearsal walk` / `reconverge`; note `Reconnaissance` now includes a rehearsal phase.

- [ ] **Step 6: Final review + finish the branch.**
  - Dispatch a final code reviewer over `main..rehearsing-reconnoiterer`.
  - Address any blocking findings.
  - `npm run typecheck && npm run test` — green.
  - Use `superpowers:finishing-a-development-branch` (the user's pattern this project has been "merge back to main locally").

---

## Self-review

**Spec coverage:**
- "graduated walk (instant scrolls, skipped dwells, real acting steps)" → Task 4 (`rehearse()`) ✓
- "rewrite expectAfter to observed state" → Task 4 (`rewriteExpectAfter`) ✓
- "divergence detection: expectAfter unsatisfied / about:blank / page-unchanged / clickSelector threw" → Task 4 ✓
- "reconverge (capped) → splice; cap/timeout → truncate + graceful tail; never zero steps" → Task 4 ✓
- "page reset (`goto(startUrl)` + stability) — done by the caller, not `rehearse()`" → Task 6 ✓
- "config: `reconRehearse` (default on) / `reconRehearsalBudgetMs` / `reconReconvergeMax`" → Task 2 ✓
- "`Performance.rehearsal` schema field" → Task 1 ✓; "`RunMetrics.rehearsal`" → Task 7 ✓
- "reconverge prompt" → Task 5 ✓
- "`IReconnoiterer` port unchanged" → confirmed (Task 6 only changes `recon()`'s body) ✓
- "no action-log change" → confirmed (the walk is pre-`beginRecording()`) ✓
- "`reconRehearse=false` ⇒ today's behaviour, no `rehearsal` field" → Task 6 ✓
- "tests: walker (no-div / dead-click→reconverge / cap→truncate / timeout / never-zero), LlmReconnoiterer orchestration + skip, schema round-trip, integration" → Tasks 1,4,6,8 ✓
- "out of scope: scroll-looks-linear" → noted, not in any task ✓

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — the `rehearse()` algorithm is given in full; the one place that defers detail ("`scroll(deltaPx,{durationMs:1})` vs a 0-safe helper path") is a deliberate either-fine implementation choice, called out as such.

**Type consistency:** `RehearsalTrace` (Task 1) is used identically in Tasks 4/6/7. `ReconvergeContext` / `RehearsalOpts` (Task 4) match their use in Task 6. `rehearse()` returns `{ steps, trace }` everywhere. `buildReconvergeUserText` signature (Task 5) matches its call in Task 6. `PerformanceStep` filler/tail objects match `PerformanceStepSchema` (checked against `src/domain/performance.ts`: `scroll` = `{kind,deltaPx,durationMs,easing,dwellAfterMs,reasoning}`, `dwell` = `{kind,durationMs,reasoning}`, `done` = `{kind,reasoning}` — no `brief`).

**Known wrinkle flagged for the implementer:** the Task 6 code sketch has a deliberate ordering bug (`candidate?.prompt` referenced before `candidate` exists) — the step text calls this out and tells the implementer to hoist a `promptStr` variable. Don't let a subagent copy the sketch verbatim without that fix.
