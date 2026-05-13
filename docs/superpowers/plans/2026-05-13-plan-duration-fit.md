# F1（Plan–Duration Fit）实施计划

> **给执行 Agent：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务执行本计划。步骤使用 checkbox（`- [ ]`）语法跟踪进度。

**目标：** 把 `durationMs` 从"提示"升格为 recon LLM（A）的一级硬约束；把 `fitPlanToBudget`（B）从"造内容"降格为 ±20% 校正器——超出窗口时通过结构化的 `RunMetrics.planDurationFit` 字段透明上报。

**架构：** 三个改动，按安全顺序排列。(1) Schema + config 新增——纯添加，不改行为。(2) `fitPlanToBudget` 签名改为返回 `{ steps, fit }`，**删掉**"远低于预算时机械补 scroll+dwell"那条分支。(3) Prompt 改动——A 的 system prompt 新增 DURATION & SCOPE 段落，A 自己拥有时长目标 + 自然填充责任 + 禁止项识别；reconverge user-text 加上"剩余预算"提示。Director（§0039）不动。

**技术栈：** TypeScript（strict ESM，NodeNext——相对导入以 `.js` 结尾）、Zod schema（CLAUDE.md 硬规则 #2）、vitest。只动现有文件，`src/` 下不新增文件。

**Spec：** [`docs/superpowers/specs/2026-05-13-plan-duration-fit-design.md`](../specs/2026-05-13-plan-duration-fit-design.md)。**先看 spec 再看本计划**——本计划是 spec 的落地版。

---

## 文件结构（已锁定）

| 文件 | 职责 | 变更类型 |
|---|---|---|
| `src/infra/config.ts` | 新增 `planDurationFitToleranceRatio` + env | 新增 |
| `src/domain/performance.ts` | `PerformanceSchema.planDurationFit`（可选） | 新增 |
| `src/adapters/recon/llm-reconnoiterer.ts` | `fitPlanToBudget` 返回 `{steps, fit}`；pad 分支删除；`recon()` 写 `planDurationFit` | 修改 |
| `src/core/record-job-runner.ts` | `RunMetrics.planDurationFit` 从 `performance.planDurationFit` 镜像；多一行结构化日志 | 修改 |
| `src/prompts/reconnoiterer.ts` | system prompt 新增 DURATION & SCOPE 段；reconverge user-text 新增剩余预算行 | 修改 |
| `scripts/self-eval.ts` | 新增 CONCERNS 行：`planDurationFit.status !== 'ok'` | 修改 |
| `.env.example` | `PLAN_DURATION_FIT_TOLERANCE_RATIO` 及注释 | 新增 |
| `tests/unit/infra/config.test.ts` | 默认值 + env 覆盖测试 | 加测试 |
| `tests/unit/domain/performance.test.ts` | `planDurationFit` schema 测试 | 加测试 |
| `tests/unit/adapters/recon/llm-reconnoiterer.test.ts` | 重写 `fitPlanToBudget` 测试块；删 pad 测试 | 重写 |
| `tests/unit/prompts/reconnoiterer.test.ts` | DURATION & SCOPE 段 + reconverge 剩余预算行断言 | 加测试 |
| `docs/decisions.md` | 新增 ADR §0040 | 新增 |
| `CLAUDE.md` | 状态表 + Measured-performance 备注 | 编辑 |

预估改动：~150 行 src + ~120 行 test。

**Commit 风格：** 每个 task 结束必须 commit（TDD：red → green → commit）。本项目用的 co-author 尾签是：

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**始终用 `git commit -F -` + heredoc 传 commit message**——fish shell 的反引号替换会把 `-m "..."` 内联 message 搞坏。

---

## Task 1：Config 新增 `planDurationFitToleranceRatio`

**文件：**
- 修改：`src/infra/config.ts`（Schema 块约 192–207 行附近；raw 块约 300 行）
- 修改：`tests/unit/infra/config.test.ts`
- 修改：`.env.example`

- [ ] **Step 1：写失败测试**

打开 `tests/unit/infra/config.test.ts`，找到 §0037 加进去的 "pacing config knobs" describe 块（用 `pacingSettleEstMs` 搜）。在里面（或同级新建 describe，按文件风格来）加：

```ts
  it('planDurationFitToleranceRatio defaults to 0.20', async () => {
    delete process.env.PLAN_DURATION_FIT_TOLERANCE_RATIO;
    const { config } = await loadFreshConfig();
    expect(config.planDurationFitToleranceRatio).toBeCloseTo(0.20);
  });

  it('planDurationFitToleranceRatio respects PLAN_DURATION_FIT_TOLERANCE_RATIO env', async () => {
    process.env.PLAN_DURATION_FIT_TOLERANCE_RATIO = '0.10';
    const { config } = await loadFreshConfig();
    expect(config.planDurationFitToleranceRatio).toBeCloseTo(0.10);
  });
```

`loadFreshConfig` 是文件里已有的 helper（`vi.resetModules()` 后重新 import）。如果文件里看不到，**复制文件里其他测试用的现成 pattern**——不要自己造新 helper。

- [ ] **Step 2：跑测试确认 FAIL**

```bash
npx vitest run tests/unit/infra/config.test.ts -t 'planDurationFitToleranceRatio'
```

预期：FAIL——config 对象上 `planDurationFitToleranceRatio` 是 `undefined`（属性不存在）。

- [ ] **Step 3：加 schema 字段**

`src/infra/config.ts` 里，找到现有的 `directorDwellMinMs` / `directorDwellStretchMaxMs` 对（约 162–163 行）。新的 knob 紧挨在 `pacingStepOverheadMs` 之后（约 192 行）添加——和其他 pacing carve-out 放一起：

```ts
  /**
   * `fitPlanToBudget`'s silent-correction window. When the LLM's plan is more
   * than this ratio off the target durationMs, fitPlanToBudget no longer
   * silently scales — it surfaces a structured `planDurationFit.status` of
   * `compressed-hard` (over) or `underfilled` (under) onto the Performance,
   * which `RunMetrics.planDurationFit` mirrors and the eval canary flags.
   *
   * Within the window, the existing scale-down compress still runs when the
   * plan is slightly over budget; mechanical scroll+dwell padding when under
   * was removed in F1 (only the recon LLM owns content invention now). Pure
   * pacing tolerance, goals.md #6 carve-out. Default 0.20 = ±20 %, deliberately
   * looser than the recon LLM's own ±10 % discipline so the surface mostly
   * fires only on systemic LLM mis-sizing, not on routine variance. Override
   * with PLAN_DURATION_FIT_TOLERANCE_RATIO.
   */
  planDurationFitToleranceRatio: z.coerce.number().min(0).max(1).default(0.20),
```

- [ ] **Step 4：把 env 接到 `raw` 对象**

在 `raw` 对象里（约 300 行，紧跟 `pacingStepOverheadMs: process.env.PACING_STEP_OVERHEAD_MS,` 后）：

```ts
  planDurationFitToleranceRatio: process.env.PLAN_DURATION_FIT_TOLERANCE_RATIO,
```

- [ ] **Step 5：更新 `.env.example`**

追加（和其他 pacing carve-out 放一组）：

```
# fitPlanToBudget's silent-correction window. Outside ±this ratio,
# planDurationFit.status becomes `compressed-hard` (over) or `underfilled`
# (under) and is surfaced in RunMetrics. Default 0.20 (±20%). See ADR §0040.
# PLAN_DURATION_FIT_TOLERANCE_RATIO=0.20
```

- [ ] **Step 6：跑测试确认 PASS + typecheck**

```bash
npx vitest run tests/unit/infra/config.test.ts -t 'planDurationFitToleranceRatio'
npm run typecheck
```

预期：都 PASS。

- [ ] **Step 7：Commit**

```bash
git add src/infra/config.ts tests/unit/infra/config.test.ts .env.example
git commit -F - <<'EOF'
feat(config): planDurationFitToleranceRatio knob (F1)

New ±X% tolerance for fitPlanToBudget's silent-correction window. Default
0.20 (±20%), env PLAN_DURATION_FIT_TOLERANCE_RATIO. F1 piece — used by the
upcoming fitPlanToBudget signature change to gate when a plan miss becomes
a surfaced `planDurationFit.status` vs a silent compress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2：Domain — `PerformanceSchema.planDurationFit`

**文件：**
- 修改：`src/domain/performance.ts:144-165`
- 修改：`tests/unit/domain/performance.test.ts`（若不存在，新建；不要把 schema 测试塞进 `recon-draft.test.ts`——`grep -rn 'PerformanceSchema' tests/unit/domain/` 先确认）

- [ ] **Step 1：写失败测试**

找到现有的 `performance.test.ts`；若不存在则新建 `tests/unit/domain/performance.test.ts`，内容：

```ts
import { describe, expect, it } from 'vitest';
import { PerformanceSchema } from '../../../src/domain/performance.js';

describe('PerformanceSchema.planDurationFit', () => {
  const basePerf = {
    prompt: 'click X',
    durationMs: 10000,
    steps: [{ kind: 'dwell' as const, durationMs: 1000, reasoning: 'r' }],
    totalEstimatedMs: 1280,
    rationale: 'r',
  };

  it('accepts a Performance with planDurationFit { ok }', () => {
    const out = PerformanceSchema.parse({
      ...basePerf,
      planDurationFit: { estimatedMs: 1280, targetMs: 10000, ratio: 0.128, status: 'ok' },
    });
    expect(out.planDurationFit?.status).toBe('ok');
  });

  it('accepts each of `ok` / `compressed-hard` / `underfilled` status values', () => {
    for (const status of ['ok', 'compressed-hard', 'underfilled'] as const) {
      expect(() => PerformanceSchema.parse({
        ...basePerf,
        planDurationFit: { estimatedMs: 1, targetMs: 1, ratio: 1, status },
      })).not.toThrow();
    }
  });

  it('rejects an unknown status', () => {
    expect(() => PerformanceSchema.parse({
      ...basePerf,
      planDurationFit: { estimatedMs: 1, targetMs: 1, ratio: 1, status: 'padded' as unknown as 'ok' },
    })).toThrow();
  });

  it('omitting planDurationFit is fine (optional)', () => {
    expect(() => PerformanceSchema.parse(basePerf)).not.toThrow();
  });
});
```

- [ ] **Step 2：跑测试确认 FAIL**

```bash
npx vitest run tests/unit/domain/performance.test.ts -t 'planDurationFit'
```

预期：FAIL——Zod 报 `Unrecognized key(s) in object: 'planDurationFit'`（schema 没这个字段）。

- [ ] **Step 3：加 schema 字段**

`src/domain/performance.ts` 里，定位到 144 行的 `PerformanceSchema` 与 164 行的 `unresolvedTargets`。在 `unresolvedTargets` 之后（仍在 `z.object({...})` 内）添加 `planDurationFit`：

```ts
  /**
   * Outcome of `fitPlanToBudget` (the F1 ±X% corrector — see ADR §0040). The
   * structured transparency channel that replaces the old silent
   * scroll+dwell pad: `compressed-hard` means the LLM over-planned by more
   * than the tolerance and B compressed (best-effort) to land it; `underfilled`
   * means the LLM under-planned by more than the tolerance and B refused to
   * invent filler — the recording will run short, surfaced here so
   * `intentSatisfaction` / the eval canary can flag it instead of pretending
   * the duration was hit. `ok` covers both "within tolerance" and the
   * still-OK light-compress case. Mirrored verbatim into `RunMetrics`.
   */
  planDurationFit: z.object({
    estimatedMs: z.number().int().nonnegative(),
    targetMs: z.number().int().nonnegative(),
    ratio: z.number(),
    status: z.enum(['ok', 'compressed-hard', 'underfilled']),
  }).optional(),
```

- [ ] **Step 4：跑测试确认 PASS + typecheck**

```bash
npx vitest run tests/unit/domain/performance.test.ts -t 'planDurationFit'
npm run typecheck
```

预期：都 PASS。

- [ ] **Step 5：Commit**

```bash
git add src/domain/performance.ts tests/unit/domain/performance.test.ts
git commit -F - <<'EOF'
feat(domain): PerformanceSchema.planDurationFit (optional) — F1

Structured transparency channel for fitPlanToBudget's outcome:
`ok` / `compressed-hard` / `underfilled`. RunMetrics mirrors it in
the next task. Schema-first per Hard Rule #2; optional so existing
test fixtures still parse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3：把 `fitPlanToBudget` 降级为 ±X% 校正器 + 透明上报

整个改动的核心。函数返回 struct，**删掉**远低于预算的机械补丁分支，超出窗口打 status。compress 分支保留。

**文件：**
- 修改：`src/adapters/recon/llm-reconnoiterer.ts:438-524`（`fitPlanToBudget`）
- 修改：`src/adapters/recon/llm-reconnoiterer.ts:217`（`recon()` 里的调用点）
- 修改：`src/adapters/recon/llm-reconnoiterer.ts:239-248`（`candidate: Performance` 对象——设置 `planDurationFit`）
- 修改：`tests/unit/adapters/recon/llm-reconnoiterer.test.ts:303-372`（重写 `fitPlanToBudget` describe 块）

### Step 1：重写 `fitPlanToBudget` 测试（red）

打开 `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`，**整段替换**现有的 `describe('fitPlanToBudget — keep the recording the length the user paid for', () => { ... })` 块（303–372 行）为：

```ts
describe('fitPlanToBudget — ±20% corrector + structured status (F1)', () => {
  // Mirror the reconnoiterer's own estimate. Same defaults as before.
  const estimateMs = (steps: PerformanceStep[]): number => {
    let t = 0;
    for (const s of steps) {
      if (s.kind !== 'done') t += 280;
      switch (s.kind) {
        case 'dwell': t += s.durationMs; break;
        case 'scroll': t += s.durationMs + s.dwellAfterMs; break;
        case 'click': t += s.anticipationMs + 1500; break;
        case 'type': t += s.preMs + s.text.length * s.keystrokeMs; break;
        case 'key': t += 1500; break;
        case 'back': t += 1500; break;
        case 'done': break;
      }
    }
    return t;
  };

  // ── status: 'ok' — within the tolerance window ───────────────────────────
  it('passes a plan that already fits straight through, status ok', () => {
    const steps: PerformanceStep[] = [
      { kind: 'dwell', durationMs: 400, reasoning: 'absorb' },
      { kind: 'scroll', deltaPx: 600, durationMs: 1800, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 'read' },
      { kind: 'dwell', durationMs: 2000, reasoning: 'linger' },
      { kind: 'done', reasoning: 'fin' },
    ];
    const out = fitPlanToBudget(steps, estimateMs(steps));
    expect(out.steps).toBe(steps); // same reference — no work needed
    expect(out.fit.status).toBe('ok');
    expect(out.fit.targetMs).toBe(estimateMs(steps));
    expect(out.fit.estimatedMs).toBe(estimateMs(steps));
    expect(out.fit.ratio).toBeCloseTo(1);
  });

  it('slightly-over (still inside +20%) compresses + still reports ok', () => {
    // estimate ≈ 1400(overhead) + 500 + (800+1500) + 3400 + 3400 + 3000 ≈ 14 s
    // Budget 12 s → ratio ≈ 1.17, inside ±20% → still 'ok' but compressed.
    const steps: PerformanceStep[] = [
      { kind: 'dwell', durationMs: 500, reasoning: 'absorb' },
      { kind: 'click', target: { selector: 'a', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'a' }, anticipationMs: 800, reasoning: 'tap', expectAfter: { urlContains: '/x' } },
      { kind: 'scroll', deltaPx: 700, durationMs: 3000, easing: 'outQuart', dwellAfterMs: 400, reasoning: 'read' },
      { kind: 'scroll', deltaPx: 700, durationMs: 3000, easing: 'inOutQuad', dwellAfterMs: 400, reasoning: 'read' },
      { kind: 'dwell', durationMs: 3000, reasoning: 'linger' },
      { kind: 'done', reasoning: 'fin' },
    ];
    const out = fitPlanToBudget(steps, 12000);
    expect(out.fit.status).toBe('ok');
    expect(out.steps.map((s) => s.kind)).toEqual(steps.map((s) => s.kind)); // every step kept
    expect(estimateMs(out.steps)).toBeLessThan(12500);
    expect(estimateMs(out.steps)).toBeGreaterThan(10500); // not over-compressed
  });

  // ── status: 'compressed-hard' — ratio > 1 + TOL ───────────────────────────
  it('far-over (ratio > 1.20) compresses and reports compressed-hard', () => {
    // Same ~14 s plan against a 10 s budget → ratio 1.40 → compressed-hard
    const steps: PerformanceStep[] = [
      { kind: 'dwell', durationMs: 500, reasoning: 'absorb' },
      { kind: 'click', target: { selector: 'a', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'a' }, anticipationMs: 800, reasoning: 'tap', expectAfter: { urlContains: '/x' } },
      { kind: 'scroll', deltaPx: 700, durationMs: 3000, easing: 'outQuart', dwellAfterMs: 400, reasoning: 'read' },
      { kind: 'scroll', deltaPx: 700, durationMs: 3000, easing: 'inOutQuad', dwellAfterMs: 400, reasoning: 'read' },
      { kind: 'dwell', durationMs: 3000, reasoning: 'linger' },
      { kind: 'done', reasoning: 'fin' },
    ];
    const out = fitPlanToBudget(steps, 10000);
    expect(out.fit.status).toBe('compressed-hard');
    expect(out.fit.ratio).toBeGreaterThan(1.20);
    expect(out.steps.map((s) => s.kind)).toEqual(steps.map((s) => s.kind)); // no step added
    expect((out.steps[2] as { easing: string }).easing).toBe('outQuart'); // easing preserved
    expect(estimateMs(out.steps)).toBeLessThan(11000); // compressed to ~budget
    expect(estimateMs(out.steps)).toBeGreaterThan(8500);
  });

  // ── status: 'underfilled' — ratio < 1 - TOL, NO PAD ───────────────────────
  it('far-under (ratio < 0.80) is returned as-is — no mechanical pad — and reports underfilled', () => {
    // Plan estimate ~2.6 s; budget 10 s; ratio 0.26 → underfilled. PAD BRANCH
    // REMOVED in F1: the returned `steps` must equal the input verbatim (no
    // appended scroll/dwell). A's job to fill the time naturally; B refuses.
    const steps: PerformanceStep[] = [
      { kind: 'dwell', durationMs: 400, reasoning: 'absorb' },
      { kind: 'dwell', durationMs: 1500, reasoning: 'read' },
      { kind: 'done', reasoning: 'fin' },
    ];
    const out = fitPlanToBudget(steps, 10000);
    expect(out.steps).toBe(steps); // same array reference — B added nothing
    expect(out.fit.status).toBe('underfilled');
    expect(out.fit.ratio).toBeLessThan(0.80);
    expect(out.fit.targetMs).toBe(10000);
  });

  it('inside-tolerance under-plan (ratio in [0.80, 1.00)) is ok, untouched', () => {
    // Plan estimate ~8.4 s; budget 10 s; ratio 0.84 → inside tolerance → ok, untouched.
    const steps: PerformanceStep[] = [
      { kind: 'dwell', durationMs: 400, reasoning: 'absorb' },
      { kind: 'scroll', deltaPx: 600, durationMs: 1800, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 'read' },
      { kind: 'dwell', durationMs: 4000, reasoning: 'linger' },
      { kind: 'scroll', deltaPx: 400, durationMs: 1200, easing: 'inOutQuad', dwellAfterMs: 100, reasoning: 'continue' },
      { kind: 'done', reasoning: 'fin' },
    ];
    const out = fitPlanToBudget(steps, 10000);
    expect(out.fit.status).toBe('ok');
    expect(out.steps).toBe(steps); // untouched (under-tol, no compress, no pad)
  });
});
```

（pad 分支测试整段删除——那个行为没了。）

### Step 2：跑测试确认 FAIL（red）

```bash
npx vitest run tests/unit/adapters/recon/llm-reconnoiterer.test.ts -t 'F1'
```

预期：FAIL——`out.fit` 是 undefined（现在 `fitPlanToBudget` 只返回 `steps`）。

### Step 3：重写 `fitPlanToBudget`

`src/adapters/recon/llm-reconnoiterer.ts` 里，整段替换现有 `fitPlanToBudget` 函数（438–524 行的 JSDoc + 函数体）为：

```ts
/**
 * F1 corrector: the ±X% silent-correction window for the LLM's plan duration.
 *
 * Reconnaissance LLMs mis-size the playback window — typically over-pack
 * ("a 10 s budget back as 13–14 s"), occasionally under-pack. F1 makes
 * `durationMs` a first-class constraint **in the recon prompt itself** (A
 * owns natural filler — only A has the prompt + page + prohibition context
 * for "what a real person would do in the spare time"). This function (B)
 * is no longer a content-inventor; it is a deterministic ±X% corrector that
 * SURFACES out-of-band misses to `RunMetrics.planDurationFit` instead of
 * silently papering over them. The well-under-budget mechanical scroll+dwell
 * pad branch that used to live here was **removed in F1** — see ADR §0040 +
 * docs/superpowers/specs/2026-05-13-plan-duration-fit-design.md.
 *
 * Behavior, where TOL = config.planDurationFitToleranceRatio (default 0.20):
 *   ratio = estimated / durationMs
 *   |ratio - 1| <= TOL  → status 'ok'; if estimated > durationMs, run the
 *                         per-step compress (kept) to land it inside ±10%;
 *                         otherwise return steps as-is (B does not pad).
 *   ratio > 1 + TOL     → status 'compressed-hard'; run the per-step compress
 *                         (best-effort). Surface for the canary.
 *   ratio < 1 - TOL     → status 'underfilled'; return steps as-is. B never
 *                         invents filler — that is A's job. Surface for the
 *                         canary; the trimmed-duration line will hard-fail.
 *
 * "Fit the recording into the duration the user paid for" is mechanical, not a
 * behaviour threshold — goals.md #6 carve-out (pacing carve-out).
 */
export function fitPlanToBudget(
  steps: PerformanceStep[],
  durationMs: number,
): { steps: PerformanceStep[]; fit: PlanDurationFit } {
  let fixedMs = 0;       // costs we can't shrink: post-action settle waits + typing speed + per-step overhead
  let controllableMs = 0; // scroll/dwell/anticipation/preMs — the slack we can compress
  for (const s of steps) {
    if (s.kind !== 'done') fixedMs += config.pacingStepOverheadMs;
    switch (s.kind) {
      case 'dwell': controllableMs += s.durationMs; break;
      case 'scroll': controllableMs += s.durationMs + s.dwellAfterMs; break;
      case 'click': controllableMs += s.anticipationMs; fixedMs += config.pacingSettleEstMs; break;
      case 'type': controllableMs += s.preMs; fixedMs += s.text.length * s.keystrokeMs; break;
      case 'key': fixedMs += config.pacingSettleEstMs; break;
      case 'back': fixedMs += config.pacingSettleEstMs; break;
      case 'done': break;
    }
  }
  const estimatedMs = fixedMs + controllableMs;
  const ratio = durationMs > 0 ? estimatedMs / durationMs : 1;
  const TOL = config.planDurationFitToleranceRatio;

  // Compress helper — the existing per-step scale-down, lifted verbatim so
  // both the inside-tolerance "slightly over" case and the out-of-tolerance
  // 'compressed-hard' case share it.
  const compressIfPossible = (): PerformanceStep[] => {
    if (estimatedMs > durationMs && controllableMs > 0 && durationMs > fixedMs) {
      const scale = (durationMs - fixedMs) / controllableMs;
      if (scale < 1) {
        return steps.map((s): PerformanceStep => {
          switch (s.kind) {
            case 'dwell':
              return { ...s, durationMs: Math.max(100, Math.round(s.durationMs * scale)) };
            case 'scroll':
              return {
                ...s,
                durationMs: Math.max(200, Math.round(s.durationMs * scale)),
                dwellAfterMs: Math.max(0, Math.round(s.dwellAfterMs * scale)),
              };
            case 'click':
              return { ...s, anticipationMs: Math.max(0, Math.round(s.anticipationMs * scale)) };
            case 'type':
              return { ...s, preMs: Math.max(0, Math.round(s.preMs * scale)) };
            default:
              return s;
          }
        });
      }
    }
    return steps;
  };

  // Out-of-tolerance over: compress (best-effort) + surface as compressed-hard.
  if (ratio > 1 + TOL) {
    return { steps: compressIfPossible(), fit: { estimatedMs, targetMs: durationMs, ratio, status: 'compressed-hard' } };
  }

  // Out-of-tolerance under: surface as underfilled. F1 explicitly forbids B
  // from inventing filler — A owns natural filler (durationMs is now a
  // first-class constraint in the recon prompt). Return steps untouched.
  if (ratio < 1 - TOL) {
    return { steps, fit: { estimatedMs, targetMs: durationMs, ratio, status: 'underfilled' } };
  }

  // Inside tolerance: still allow a light compress when the plan is slightly
  // over (so C's ±2 s soft-align can land it inside ±10%); never pad.
  return { steps: compressIfPossible(), fit: { estimatedMs, targetMs: durationMs, ratio, status: 'ok' } };
}
```

### Step 4：加 `PlanDurationFit` 类型

紧挨着 `fitPlanToBudget` 上方（或 `sumDurations` 附近），添加：

```ts
/**
 * Structured outcome of {@link fitPlanToBudget} — copied verbatim onto
 * `Performance.planDurationFit` and mirrored into `RunMetrics.planDurationFit`.
 * See ADR §0040.
 */
export interface PlanDurationFit {
  estimatedMs: number;
  targetMs: number;
  ratio: number;
  status: 'ok' | 'compressed-hard' | 'underfilled';
}
```

### Step 5：更新 `recon()` 里的调用点

`src/adapters/recon/llm-reconnoiterer.ts` 第 217 行：

```ts
    finalSteps = fitPlanToBudget(finalSteps, input.durationMs);
```

替换为：

```ts
    const fitOutcome = fitPlanToBudget(finalSteps, input.durationMs);
    finalSteps = fitOutcome.steps;
```

接着把 `candidate: Performance` 对象的构造（239–248 行）改为带上 `planDurationFit`：

```ts
    const candidate: Performance = {
      prompt: draft.prompt,
      durationMs: input.durationMs,
      steps: finalSteps,
      totalEstimatedMs: sumDurations(finalSteps),
      rationale: draft.rationale,
      ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
      ...(blockerDismissal ? { blockerDismissal } : {}),
      ...(unresolvedTargets.length > 0 ? { unresolvedTargets } : {}),
      planDurationFit: fitOutcome.fit,
    };
```

（`planDurationFit` 现在每次都填——不走条件 spread。schema 留 optional 只是给旧 fixture 兜底。）

同时把 256 行的 `this.logger.info` 调用也带上 fit status：

```ts
    this.logger.info(
      {
        stepCount: validation.data.steps.length,
        totalEstimatedMs: validation.data.totalEstimatedMs,
        durationMs: input.durationMs,
        rehearsal: rehearsalTrace,
        unresolvedTargets: unresolvedTargets.length || undefined,
        planDurationFit: fitOutcome.fit,
      },
      'recon complete',
    );
```

### Step 6：跑测试 + typecheck

```bash
npx vitest run tests/unit/adapters/recon/llm-reconnoiterer.test.ts
npm run typecheck
```

预期：PASS（新的 F1 fitPlanToBudget describe + 所有未改的测试）。如果 `llm-reconnoiterer.test.ts` 里 F1 块**之外**的测试现在挂了，是因为某些测试本来直接拿 `fitPlanToBudget(...)` 的返回当 steps 数组用——把那些调用点改成 `fitPlanToBudget(...).steps` 即可。在文件里搜 `fitPlanToBudget(` 一一确认。

### Step 7：跑完整单测

```bash
npm test -- --run
```

预期：所有 suite 通过。如果 `tests/unit/domain/` 或 `tests/unit/core/` 里某些测试挂了，多半是 `Performance` 形状变敏感（多了个新可选字段）——用 `.toMatchObject` 绕开 `planDurationFit`，或在 fixture 里把它带上。**不要**用 `as unknown` 强转——修 fixture。

### Step 8：Commit

```bash
git add src/adapters/recon/llm-reconnoiterer.ts tests/unit/adapters/recon/llm-reconnoiterer.test.ts
git commit -F - <<'EOF'
feat(recon): fitPlanToBudget demoted to ±X% corrector + surface (F1)

`fitPlanToBudget` returns `{ steps, fit: PlanDurationFit }` now. The
well-under-budget mechanical scroll+dwell pad branch is REMOVED — A
(the recon LLM) now owns natural filler via the F1 prompt change in
the next task; B no longer invents content.

Behavior:
- |ratio - 1| <= TOL (default 0.20): status 'ok'; light compress kept
  for the slightly-over case so §0039 can land ±10%.
- ratio > 1 + TOL: status 'compressed-hard'; compress best-effort.
- ratio < 1 - TOL: status 'underfilled'; steps untouched. Surfaced
  so the trimmed-duration line catches it instead of B papering over.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4：`RunMetrics` 暴露 `planDurationFit`

**文件：**
- 修改：`src/core/record-job-runner.ts:64-113`（`RunMetrics`）、`:212-226`（metrics 对象构造）
- 修改：`tests/unit/core/record-job-runner.test.ts`（找现有的 metrics 形状测试）

- [ ] **Step 1：写失败测试**

找到 `record-job-runner.test.ts` 里现有的 `RunMetrics` 形状断言测试（在文件里搜 `intentSatisfaction:` 或 `RunMetrics`）。在那个 describe 里（或同级新建 `describe('RunMetrics — F1 planDurationFit', …)`）加一条：

```ts
  it('RunMetrics.planDurationFit mirrors Performance.planDurationFit verbatim', async () => {
    // The runner's contract for F1: copy `performance.planDurationFit` onto
    // RunMetrics so operators don't have to dig into the Performance object.
    // Use whatever harness/fake the file already uses to drive a run; this
    // file's existing tests show the pattern.
    //
    // Drive a run where the reconnoiterer returns a Performance with
    // planDurationFit: { estimatedMs: 8500, targetMs: 10000, ratio: 0.85, status: 'ok' }.
    // After runner.run(), expect:
    //   metrics.planDurationFit?.estimatedMs === 8500
    //   metrics.planDurationFit?.targetMs   === 10000
    //   metrics.planDurationFit?.ratio      === 0.85
    //   metrics.planDurationFit?.status     === 'ok'
  });
```

然后把这条骨架按文件里已有的 harness 翻译成实测代码。如果文件里用的是 `FakeReconnoiterer` + `nextPerformance` 字段，就把 `nextPerformance.planDurationFit` 设成测试 struct。**沿用现有 pattern**——不要造新 harness。

- [ ] **Step 2：跑测试确认 FAIL**

```bash
npx vitest run tests/unit/core/record-job-runner.test.ts -t 'planDurationFit'
```

预期：FAIL——`metrics.planDurationFit` 是 undefined（字段没加）。

- [ ] **Step 3：给 `RunMetrics` 加字段**

`src/core/record-job-runner.ts` 第 112 行 `unresolvedTargets: string[];` 之后（仍在 `interface RunMetrics` 内）：

```ts
  /**
   * Outcome of `fitPlanToBudget` (F1, ADR §0040) — mirrored verbatim from
   * `performance.planDurationFit`. `status: 'compressed-hard'` means A
   * over-planned beyond tolerance and B compressed it; `'underfilled'` means
   * A under-planned beyond tolerance and B refused to invent filler (the
   * recording will run short — `trimmedVideoMs` vs `durationMs` will show
   * it, but this field tells you *why* without inspecting steps). `'ok'` for
   * within-tolerance (silent compress allowed for the slightly-over case).
   * Optional only because adapters with very old fixtures may omit it.
   */
  planDurationFit?: {
    estimatedMs: number;
    targetMs: number;
    ratio: number;
    status: 'ok' | 'compressed-hard' | 'underfilled';
  };
```

- [ ] **Step 4：在 metrics 对象里镜像**

`src/core/record-job-runner.ts:212-226` 的 `metrics` 对象里，紧跟 `unresolvedTargets,` 后加一行：

```ts
    const metrics: RunMetrics = {
      totalWallClockMs: Date.now() - wallClockT0,
      setupMs,
      reconMs,
      recordingMs: directorReport.totalMs,
      trimMs,
      rawVideoMs,
      trimmedVideoMs,
      plannedSteps: performance.steps.length,
      replanCount: directorReport.replanCount,
      intentSatisfaction,
      rehearsal: performance.rehearsal ?? null,
      blockerDismissal: performance.blockerDismissal ?? null,
      unresolvedTargets,
      ...(performance.planDurationFit ? { planDurationFit: performance.planDurationFit } : {}),
    };
```

（条件 spread——`exactOptionalPropertyTypes` 要求。）

- [ ] **Step 5：非 `ok` status 多打一行结构化日志**

同一文件，在现有的 `if (intentSatisfaction.level === 'unmet' || …)` 块（约 228 行）**之前**加：

```ts
    if (performance.planDurationFit && performance.planDurationFit.status !== 'ok') {
      this.logger.warn(
        { planDurationFit: performance.planDurationFit },
        `plan/duration fit out of tolerance (${performance.planDurationFit.status}) — the recording may not land in ±10% (goals.md #2)`,
      );
    }
```

- [ ] **Step 6：跑测试 + typecheck**

```bash
npx vitest run tests/unit/core/record-job-runner.test.ts -t 'planDurationFit'
npm run typecheck
```

预期：PASS。

- [ ] **Step 7：Commit**

```bash
git add src/core/record-job-runner.ts tests/unit/core/record-job-runner.test.ts
git commit -F - <<'EOF'
feat(metrics): RunMetrics.planDurationFit mirrors Performance — F1

Mirrors the new planDurationFit field from Performance into RunMetrics so
operators read it at the same level as intentSatisfaction / rehearsal /
blockerDismissal. Logs a warn-level line when status !== 'ok' so a miss
shows up in logs even if no one inspects the metrics object.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5：Recon system prompt — DURATION & SCOPE 段

A 的契约改动。实质内容直接照 spec 抄；后续 prompt 打磨另起 commit，**不**算这个 task 的事。

**文件：**
- 修改：`src/prompts/reconnoiterer.ts:17-84`（`reconnoitererSystemPrompt`）
- 修改：`tests/unit/prompts/reconnoiterer.test.ts`

- [ ] **Step 1：写失败测试**

在 `tests/unit/prompts/reconnoiterer.test.ts` 里加：

```ts
import { describe, expect, it } from 'vitest';
import { reconnoitererSystemPrompt, buildReconvergeUserText } from '../../../src/prompts/reconnoiterer.js';

describe('reconnoitererSystemPrompt — F1 DURATION & SCOPE section', () => {
  it('contains a DURATION & SCOPE section that names durationMs as a hard constraint', () => {
    expect(reconnoitererSystemPrompt).toContain('DURATION & SCOPE');
    expect(reconnoitererSystemPrompt).toMatch(/hard constraint/i);
    expect(reconnoitererSystemPrompt).toMatch(/totalEstimatedMs.*within.*10%/i);
  });

  it('tells the LLM to identify prohibitions itself (we do not regex the prompt)', () => {
    // The whole point of F1 is no hardcoded prohibition detection. A's job.
    expect(reconnoitererSystemPrompt).toMatch(/prohib|forbid/i);
    expect(reconnoitererSystemPrompt).toMatch(/your call|you judge|你判断/i);
  });

  it('forbids mechanical generic scroll/dwell filler when under budget', () => {
    expect(reconnoitererSystemPrompt).toMatch(/(do not|don't).*(mechanical|generic).*(scroll|filler|pad)/i);
  });

  it('says irreconcilable prompt/duration mismatch goes into `rationale` (not a failure)', () => {
    expect(reconnoitererSystemPrompt).toMatch(/rationale/i);
    expect(reconnoitererSystemPrompt).toMatch(/underfilled/i);
  });
});

describe('buildReconvergeUserText — F1 remaining-budget hint', () => {
  it('mentions the remaining durationMs budget when given one', () => {
    const text = buildReconvergeUserText({
      intent: 'click X',
      divergedStep: { kind: 'dwell', durationMs: 500, reasoning: 'r' },
      observedUrl: 'https://example.com',
      snapshot: '- link "X" [ref=e1]',
      remainingDurationMs: 6500,
    });
    expect(text).toMatch(/remaining.*6500|6500.*remaining/i);
  });

  it('omits the remaining-budget hint when not provided', () => {
    const text = buildReconvergeUserText({
      intent: 'click X',
      divergedStep: { kind: 'dwell', durationMs: 500, reasoning: 'r' },
      observedUrl: 'https://example.com',
      snapshot: '- link "X" [ref=e1]',
    });
    expect(text).not.toMatch(/remaining.*durationMs/i);
  });
});
```

- [ ] **Step 2：跑测试确认 FAIL**

```bash
npx vitest run tests/unit/prompts/reconnoiterer.test.ts -t 'F1'
```

预期：FAIL——DURATION & SCOPE 段不存在；`buildReconvergeUserText` 不接受 `remainingDurationMs`。

- [ ] **Step 3：往 system prompt 里插 DURATION & SCOPE 段**

`src/prompts/reconnoiterer.ts` 里，在 `reconnoitererSystemPrompt` 末尾附近找到 `expectAfter — when to set it:` 这行（约第 76 行）。**紧挨它前面**（即 `WORKFLOW PATTERNS:` 块与 `expectAfter — when to set it:` 之间）插入：

```
DURATION & SCOPE (hard constraint — supersedes the soft ~15% mention in PACING):
- Your plan's totalEstimatedMs MUST land within ±10% of the durationMs you are given. Estimate using the same model the runner uses:
    each non-\`done\` step: +~280ms (per-step overhead the Director can't avoid)
    click:                +anticipationMs + ~1500ms (anticipation pause + the post-action page-settle wait)
    key / back:           +~1500ms (post-action page-settle wait)
    dwell:                +durationMs
    scroll:               +durationMs + dwellAfterMs
    type:                 +preMs + text.length × keystrokeMs
- If the user's prompt forbids an action (any expression — "only", "just", "no X", "don't", "without", 中英任何 — your call), your plan MUST NOT contain that action, and any filler exploration MUST respect the prohibition. We do not pattern-match the prompt for you; identifying prohibitions is your job.
- If the explicit intent does not fill durationMs, do NOT pad with mechanical generic scroll+dwell. Add steps a real person would naturally do on THIS page given THIS prompt: read a result card, scan top chips, glance at the sidebar, scroll to a specific content section worth dwelling on. Each filler step must be groundable in the accessibility tree — the rehearsal walk will verify; ungroundable filler will be dropped.
- If the prompt's prohibitions make any natural filler violate them (e.g. "just glance" + durationMs=60s is irreconcilable), say so in \`rationale\`. The runner will mark the run as underfilled — that is a transparent goal-#3 outcome, not your failure.

```

（这段插进的是一个 template literal——保持整个 system prompt 是单一 template literal，把这几行**直接**拼进字符串。**不要**改成字符串拼接。）

插完之后，**删掉** PACING 里现在已经被取代的最后一条 bullet（约第 69 行）：

```
- The recording window is a FIXED duration the user paid for. "totalEstimatedMs" should be within ~15% of "durationMs". If your plan is too short, add browsing/dwell steps that fit the page. Too long — trim.
```

新的 DURATION & SCOPE 段取代了它（更严：±10%；并把"自然填充"的责任显式给了 LLM）。

- [ ] **Step 4：`buildReconvergeUserText` 加 `remainingDurationMs?: number`**

找到现有的 `buildReconvergeUserText`（约第 114 行）。改签名：

```ts
export function buildReconvergeUserText(args: {
  intent: string;
  divergedStep: PerformanceStep;
  observedUrl: string;
  snapshot: string;
  remainingDurationMs?: number;
}): string {
  const { intent, divergedStep, observedUrl, snapshot, remainingDurationMs } = args;
```

并在返回的数组（`[ … ].join('\n')` 块）里，紧跟 `Current page URL: ${observedUrl}` 那行后面，**仅当 `remainingDurationMs` 被传入时**追加一行：

```ts
    `Current page URL: ${observedUrl}`,
    ...(remainingDurationMs !== undefined ? [`Remaining durationMs budget: ~${remainingDurationMs}ms — keep the rest of the plan within ±10% of this.`] : []),
    ``,
```

- [ ] **Step 5：跑 prompt 测试 + typecheck**

```bash
npx vitest run tests/unit/prompts/reconnoiterer.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **Step 6：从 reconverge 回调把 `remainingDurationMs` 接出来**（让它真的传给 LLM）

`src/adapters/recon/llm-reconnoiterer.ts` 里找到 `recon()` 内的 `reconverge` 闭包（约 128 行）。闭包参数已经有 `ctx: ReconvergeContext`——先读 `src/adapters/recon/rehearsal.ts`，看 `interface ReconvergeContext` 顶部都有什么字段。rehearsal 走的 walk 在内部会跟踪一个"已声明走过的时间"（类似 `walkedMs`、`elapsedDeclaredMs` 之类）；如果 `ctx` 上已经有这个字段，直接用：

```ts
const remainingDurationMs = Math.max(0, input.durationMs - (ctx.walkedDeclaredMs ?? 0));
```

然后透传：

```ts
const userText = buildReconvergeUserText({
  intent: ctx.intent,
  divergedStep: ctx.divergedStep,
  observedUrl: ctx.observedUrl,
  snapshot,
  remainingDurationMs,
});
```

**如果 `ReconvergeContext` 现在没有"已走过的声明时间"字段：** 做最小安全改动——读 `rehearsal.ts`，找到那个累加 declared time 的循环变量（应该是 `let declaredAcc = 0; ... declaredAcc += declaredMs(step);` 之类，跟 Director 的 `declaredMs` 同形状），把它加到 `ReconvergeContext` 接口上作为新字段 `walkedDeclaredMs: number`，并在 callsite 里塞进去。这是对 `rehearsal.ts` + 其 TS 接口的小幅追加改动。**不要**新加 accounting 逻辑——只把 `rehearsal.ts` 已经算过的那个值暴露出来。

如果 rehearsal 里今天根本没在跟踪这个值——**停下来问**，先别擅自加新的 tracker。（spec 里的说法是"already trackable"——实施者要先验证。）

- [ ] **Step 7：重跑单测 + typecheck**

```bash
npm test -- --run
npm run typecheck
```

预期：PASS。

- [ ] **Step 8：Commit**

```bash
git add src/prompts/reconnoiterer.ts src/adapters/recon/llm-reconnoiterer.ts tests/unit/prompts/reconnoiterer.test.ts
# 若 Step 6 改了 ReconvergeContext，加上 src/adapters/recon/rehearsal.ts
git commit -F - <<'EOF'
feat(recon): DURATION & SCOPE prompt + remaining-budget reconverge hint (F1)

A (the recon LLM) now owns durationMs as a hard constraint with ±10%
discipline; identifies prohibitions in the user prompt itself (no regex
on our side); fills under-budget plans with natural exploration tied to
the page rather than mechanical scroll+dwell. Reconverge user-text gets a
`Remaining durationMs budget: ~Xms` line so the LLM keeps the rest of the
plan to scale.

The old PACING bullet "totalEstimatedMs should be within ~15% of
durationMs" is removed — DURATION & SCOPE supersedes it (tighter target,
explicit filler discipline).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6：`npm run eval` — 非 `ok` planDurationFit 多一条 CONCERNS 行

**文件：**
- 修改：`scripts/self-eval.ts:51-114`（`assess`）

新增一条小行——无单测（eval 脚本目前没单测）。

- [ ] **Step 1：往 `assess` 加一条 row**

`scripts/self-eval.ts` 里，找到现有的 `intentSatisfaction` row（约第 75 行）。紧跟它之后加：

```ts
  // plan/duration fit — surfaced by the F1 corrector (ADR §0040). CONCERNS
  // not hard-fail: the trimmed-duration line is already the hard goal-#2 gate,
  // and a `compressed-hard` plan may still trim into ±10% via the Director's
  // soft-align. This field tells the operator *why* a duration miss happened.
  const fit = m.planDurationFit;
  if (fit) {
    const ok = fit.status === 'ok';
    rows.push({
      status: ok ? 'ok' : 'warn',
      label: 'planDurationFit',
      value: `${fit.status} — ratio ${fit.ratio.toFixed(2)} (est ${fmtMs(fit.estimatedMs)} / target ${fmtMs(fit.targetMs)})`,
      note: ok ? undefined :
        fit.status === 'underfilled'
          ? "the recon LLM's plan is shorter than durationMs by more than the tolerance — A did not (or could not) fill the time naturally; the recording will run short. Check the rationale: A may have flagged a prompt/duration irreconcilability (goal #3 transparent miss), or A may simply have under-planned (recon-quality miss)."
          : "the recon LLM over-planned beyond the tolerance and B compressed best-effort; pacing may be tighter than natural. If the trimmed-duration line is OK this is just a diagnostic.",
    });
  }
```

- [ ] **Step 2：跑脚本现有的检查（typecheck）**

```bash
npm run typecheck
```

预期：PASS。

- [ ] **Step 3：Commit**

```bash
git add scripts/self-eval.ts
git commit -F - <<'EOF'
feat(eval): self-eval CONCERNS row for planDurationFit (F1)

When fitPlanToBudget's status is `compressed-hard` or `underfilled`,
self-eval prints a ⚠ row with the ratio and a note explaining what
happened. Not a hard-fail — the trimmed-duration ±10% line is the
goal-#2 gate; this is the diagnostic alongside it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7：ADR §0040 + CLAUDE.md

**文件：**
- 修改：`docs/decisions.md`（在末尾追加新的 §0040）
- 修改：`CLAUDE.md`（状态表新增行 + Measured-performance 备注）

- [ ] **Step 1：先看最近的 ADR 风格**

```bash
grep -n '^## §00[0-9][0-9]' docs/decisions.md | tail -5
```

读最近 2–3 条 ADR，照抄标题/结构 pattern。

- [ ] **Step 2：追加 ADR §0040**

往 `docs/decisions.md` 末尾追加：

```markdown
## §0040 — F1: plan/duration fit (`durationMs` is a first-class constraint in A; B becomes a ±X% surface)

Date: 2026-05-13.

### Context

7-run review (1 eval + 6 regression) post §0037+§0039 showed `fitPlanToBudget`
(B) was being asked to invent natural content when the recon LLM (A)
under-planned (gmaps "JUST observe" 15 s → trimmed 6.6 s, −56 %, B's
mechanical scroll+dwell pad clearly inadequate), and was standing aside when
A over-planned with too many steps (youtube distracting 25 s → 24 steps,
reconMs 61.8 s blowing goal #5). Same architectural seam, two failure
directions: A had no hard contract on durationMs + no parsimony incentive,
B was carrying semantic load it shouldn't carry. See
docs/findings/2026-05-13-plan-duration-fit.md and
docs/superpowers/specs/2026-05-13-plan-duration-fit-design.md.

### Decision

Make `durationMs` a **first-class constraint in A** (the recon system prompt
gains a DURATION & SCOPE section: ±10 % discipline; A identifies prohibitions
in the user prompt itself — no regex on our side; A fills under-budget plans
with natural exploration tied to the page, not mechanical filler).

Demote B (`fitPlanToBudget`) to a **±X % corrector** (default 20 %, config
`planDurationFitToleranceRatio`). The well-under-budget mechanical-pad branch
is deleted. Out-of-band cases are surfaced as a structured
`Performance.planDurationFit.status` (`ok` / `compressed-hard` / `underfilled`)
which `RunMetrics.planDurationFit` mirrors and `npm run eval` flags as CONCERNS.

C (PerformanceDirector §0039 soft-align ±2 s) is untouched.

### Consequences

- A's plan is the only place "what natural filler looks like for THIS prompt
  on THIS page" lives — goals.md #6 (AI-first).
- B becomes deterministic and small: scale-down compress + status surface.
  No content invention.
- A run that genuinely can't fit (e.g. "just glance" + 60 s) becomes a
  goal-#3 transparent `underfilled` rather than a silent duration miss.
- No new LLM calls — goal #5 preserved (no retry).
- F2 (recon plan-size budget, "steps/sec") and F3 (intentSatisfaction
  honesty re: prohibitions) remain open, tracked separately.
```

- [ ] **Step 3：更新 CLAUDE.md 状态表**

打开 `CLAUDE.md`，找到含 "§0037" / "duration fidelity" 的那行（在状态表里、临近 "Measured performance" 段）。按现有行的风格添加 F1 的一行。例：

```markdown
| Plan/duration fit — `durationMs` is a first-class constraint in the recon prompt (±10 % discipline, prohibitions identified by A itself, natural filler is A's responsibility) and `fitPlanToBudget` is a ±20 % corrector surfacing out-of-band misses as `RunMetrics.planDurationFit.status` (`ok` / `compressed-hard` / `underfilled`); mechanical scroll+dwell padding removed (§0040 / F1) | ✅ |
```

并在 "Measured performance" 段里、"Director soft-aligns" 那句附近补一句：新的透明通道是 `planDurationFit`（goals.md #3 / #6）。

- [ ] **Step 4：Typecheck（sanity，行为不变）**

```bash
npm run typecheck && npm test -- --run
```

预期：PASS。

- [ ] **Step 5：Commit**

```bash
git add docs/decisions.md CLAUDE.md
git commit -F - <<'EOF'
docs(adr): §0040 F1 plan/duration fit; CLAUDE.md state table

ADR for F1 (A owns durationMs + prohibitions + natural filler; B becomes
a ±X% corrector + surface). CLAUDE.md state-table row and a note in
Measured performance pointing to RunMetrics.planDurationFit as the new
transparency channel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8：验证 — `npm run eval` + `npm run regression`

**唯一**会接真实 LLM + 真实浏览器的一步。前面全部绿才跑。

- [ ] **Step 1：`npm test` 干净**

```bash
npm test -- --run
npm run typecheck
```

预期：绿。

- [ ] **Step 2：跑 canonical eval**

```bash
npm run eval
```

预期：
- `planDurationFit` 行打印 `status: ok`（canonical Recordly 10s 在 F1 之前就是 +0% / `LOOKS_HUMAN`；A 应该产出落在 ±10% 内的 plan）。
- `trimmed-video duration` 行仍在 ±10% 内。
- 总评：`PASS`（或仅有本来就是 CONCERNS 的项打出 `CONCERNS`——`recon LLM $` 是已知 warn，待换模型）。

如果 canonical case 的 `planDurationFit.status` 是 `compressed-hard` 或 `underfilled`，F1 的 prompt 改没扎住——排查之前不要宣布完成。canonical 是 LLM 最容易的路；这条都打不进 ±10%，prompt 还得更硬。

- [ ] **Step 3：跑 regression（3 sites × 2 prompts）**

```bash
npm run regression
```

预期（按 case）：
- 6 个 case 的 categorical 断言全过（F1 不改断言，只改 metrics 对象的内容）。
- 检查每个 case 日志里的 `planDurationFit`：
  - canonical-shaped 的（GitHub multi-step、YouTube creator）应该是 `ok`。
  - **gmaps "JUST observe"** 是 F1 的验收 case：要么 `ok`（A 自然填满了 15s——结果卡片、chips、侧边栏），要么 `underfilled`（A 诚实地说 prompt 对 15s 太短，`rationale` 里会说）。**两种 F1 之后都可接受。** F1 干掉的是之前那个**静默 −56%**。如果反而是 `compressed-hard` 或者**静默过填**——说明 prompt 没真的发挥作用，先确认 `reconnoitererSystemPrompt` 字符串里确实含 "DURATION & SCOPE"。
  - **youtube distracting**：F1 不直接修 24 步过填那个问题（那是 F2）。这里 `planDurationFit` 期望 `ok`——预期无回退。如果 `reconMs` 下降（A 不那么浪费 step），那是意外好处；如果上升（F1 的自然填充指令反向推出了一堆 micro-dwell），这就是 F2 该提前的信号——记下。

- [ ] **Step 4：决定是 done 还是 follow-up**

如果 `npm run eval` PASS 且 `npm run regression` 上 F1 验收 case 表现正确（`ok` + 自然填充计划，或 `underfilled` + 透明 rationale），F1 落地。

如果 **canonical case 有回退**：停下排查，**不要**合——F1 不能回退已经能跑的东西。具体报告回退点请求方向。

如果 gmaps 还是静默欠填（即 `status: ok` 但 `trimmedVideoMs` 大幅小于 `durationMs`），那是 prompt 没让模型听话——prompt 调优的事，不是架构问题；这是合理的 follow-up（试更尖的具体示例；考虑换 `LLM_RECON_MODEL` 跑一遍）。记为 follow-up note，不算 blocker——**度量诚实**已经成立，这本来就是 F1 的契约。

- [ ] **Step 5：本任务无 commit（除非有修复）**

本任务**只是验证**——这一步不 commit 代码。如果验证暴露小修复，作为单独 follow-up commit，message 里引用本次验证。

---

## 自审 checklist（声明计划完成前自己跑一遍）

**Spec 覆盖：**
- §1 Recon prompt 契约改动 → Task 5
- §2 `fitPlanToBudget` 降级 → Task 3
- §3 `Performance.planDurationFit` → Task 2
- §4 `RunMetrics.planDurationFit` → Task 4
- §5 Config knob → Task 1
- §6 self-eval canary → Task 6
- "What this is explicitly NOT" → 通过没有相应 task 显现：没改 retry、没正则禁止项、没设 step 上限、没碰 Director、没碰 rehearsal。
- 验证（§Verification）→ Task 8
- 文档（CLAUDE.md row、ADR §0040）→ Task 7

**Placeholder 扫描：** 所有 step body 都是字面代码块或精确命令。没有 "TBD" / "TODO" / "fill in details" / "handle edge cases"。Task 5 Step 6 那句"stop and ask"是**故意保留的决策点**，不是 placeholder。

**类型/名字一致性：**
- `PlanDurationFit` 形状在三处一致：`src/adapters/recon/llm-reconnoiterer.ts`（导出的 interface，Task 3）、`PerformanceSchema.planDurationFit`（Zod，Task 2）、`RunMetrics.planDurationFit`（Task 4）——四个字段（`estimatedMs`、`targetMs`、`ratio`、`status`）同名同序，status 枚举（`'ok' | 'compressed-hard' | 'underfilled'`）全程一致。
- `config.planDurationFitToleranceRatio` 是唯一命名（没有 `planDurationFitTolerance` 或 `planDurationFitRatio` 之类的别名）——Task 1/3/7 都核对过。
- `fitPlanToBudget` 新返回类型 `{ steps, fit }` 在所有调用点（Task 3 的 recon `fitOutcome.steps` / `fitOutcome.fit`、Task 3 Step 1 的测试）一致。

实施过程中若发现 task 之间名字/类型对不上，**就地修复**继续——不要问。
