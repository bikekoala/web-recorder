/**
 * Stability sweep — run a canonical scenario set N times each and report
 * the *distribution* of outcomes, not a single sample.
 *
 * Why this exists: single-eval results have huge LLM-driven variance. The
 * same prompt + site can produce a 5/5 looks_human run one minute and a
 * 0/5 robotic run the next (measured 2026-05-15: Recordly judge verdict
 * shifted between consecutive identical runs). Judging "did a change help?"
 * from a single before/after pair is fitting to noise.
 *
 * This script spawns `bun scripts/self-eval.ts` N times per scenario,
 * parses each run's `run.json` + `judgment.json` from the output dir,
 * and prints aggregated metrics: bright-line pass rate, trim distribution,
 * judge verdict distribution, intent distribution, Y trigger / shrink rate.
 *
 * Run:  bun run stability
 * Env:  STABILITY_N (default 3 runs per scenario)
 *       EVAL_HEADLESS (passes through; platform default if unset)
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';

import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';

const log = logger.child({ script: 'stability-sweep' });

interface Scenario {
  name: string;
  prompt: string;
  durationMs: number;
}

// Three canonical, divergent-enough scenarios that have surfaced past bugs
// (HN short page, Wiki long read, GitHub heavy SPA). Keep this list small —
// each addition is 3× the wall-clock budget.
const SCENARIOS: Scenario[] = [
  {
    name: 'recordly-zh-scroll',
    prompt: '去 https://github.com/webadderallorg/Recordly 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
    durationMs: 10_000,
  },
  {
    name: 'hn-top-stories',
    prompt: '去 https://news.ycombinator.com/ 看看头条故事',
    durationMs: 10_000,
  },
  {
    name: 'wiki-photosynthesis-read',
    prompt: '去 https://en.wikipedia.org/wiki/Photosynthesis 慢慢往下读这篇文章',
    durationMs: 25_000,
  },
];

const N = Number(process.env.STABILITY_N ?? 3);

interface RunOutcome {
  scenario: string;
  runIndex: number;
  brightLinePass: boolean;
  trimmedMs: number | null;
  trimmedPct: number | null;        // signed % diff vs durationMs
  durationMs: number;
  wallClockMs: number;
  reconMs: number;
  intentLevel: string;              // complete / partial / unmet / unknown
  planFitStatus: string;            // ok / compressed-hard / underfilled
  planFitRatio: number;
  reconLlmCalls: number;            // 1 = no reconverge; ≥2 = Y fired
  yShrunk: boolean;                 // post-Y plan smaller than walked? (heuristic: ratio ≤ 1 + 0.20)
  judgeVerdict: string;             // looks_human / probably_human / probably_synthetic / robotic / (error)
  judgeDims: Record<string, string>; // motionQuality/pacing/.../ : pass|partial|fail
  err?: string;
}

function listEvalDirs(): string[] {
  const root = config.outputDir;
  const days = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => resolvePath(root, d.name));
  const dirs: string[] = [];
  for (const day of days) {
    for (const e of readdirSync(day, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith('-eval')) {
        dirs.push(resolvePath(day, e.name));
      }
    }
  }
  return dirs;
}

function newestEvalDirSince(beforeMs: number): string | null {
  const dirs = listEvalDirs();
  let best: { path: string; mtimeMs: number } | null = null;
  for (const p of dirs) {
    const stat = statSync(p);
    if (stat.mtimeMs > beforeMs && (!best || stat.mtimeMs > best.mtimeMs)) {
      best = { path: p, mtimeMs: stat.mtimeMs };
    }
  }
  return best?.path ?? null;
}

async function spawnEval(scenario: Scenario): Promise<{ exitCode: number }>{
  return new Promise((resolveP) => {
    const child = spawn('bun', ['scripts/self-eval.ts'], {
      env: {
        ...process.env,
        EVAL_PROMPT: scenario.prompt,
        EVAL_DURATION_MS: String(scenario.durationMs),
      },
      stdio: 'inherit',  // pass through stdout/stderr — operator sees progress
    });
    child.on('close', (code) => resolveP({ exitCode: code ?? -1 }));
  });
}

function parseRun(dir: string, scenario: Scenario, runIndex: number, exitCode: number): RunOutcome {
  const runJson = JSON.parse(readFileSync(resolvePath(dir, 'run.json'), 'utf-8'));
  const metrics = runJson.metrics ?? {};
  const perf = runJson.performance ?? {};
  const planFit = perf.planDurationFit ?? {};
  const reconLlm = perf.reconLlm ?? {};
  const intent = metrics.intentSatisfaction ?? {};
  const trimmedMs: number | null = metrics.trimmedVideoMs ?? null;
  const trimmedPct = trimmedMs !== null
    ? ((trimmedMs - scenario.durationMs) / scenario.durationMs) * 100
    : null;

  // Judge artifact may be absent or partially failed.
  let judgeVerdict = 'absent';
  const judgeDims: Record<string, string> = {};
  try {
    const judgment = JSON.parse(readFileSync(resolvePath(dir, 'judgment.json'), 'utf-8'));
    const j = judgment.judgment ?? {};
    judgeVerdict = j.verdict ?? 'absent';
    for (const [name, body] of Object.entries(j.dimensions ?? {})) {
      const b = body as { level?: string };
      judgeDims[name] = b.level ?? 'absent';
    }
  } catch {
    judgeVerdict = 'absent';
  }

  return {
    scenario: scenario.name,
    runIndex,
    brightLinePass: exitCode === 0,
    trimmedMs,
    trimmedPct,
    durationMs: scenario.durationMs,
    wallClockMs: metrics.totalWallClockMs ?? 0,
    reconMs: metrics.reconMs ?? 0,
    intentLevel: intent.level ?? 'unknown',
    planFitStatus: planFit.status ?? 'unknown',
    planFitRatio: planFit.ratio ?? 0,
    reconLlmCalls: reconLlm.calls ?? 0,
    yShrunk: (reconLlm.calls ?? 0) >= 2 && (planFit.ratio ?? Infinity) <= 1.2,
    judgeVerdict,
    judgeDims,
  };
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDistribution(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
}

function fmtPercent(num: number, denom: number): string {
  return denom === 0 ? '?' : `${num}/${denom} (${((num / denom) * 100).toFixed(0)}%)`;
}

function summarize(outcomes: RunOutcome[]): void {
  const byScenario = new Map<string, RunOutcome[]>();
  for (const o of outcomes) {
    if (!byScenario.has(o.scenario)) byScenario.set(o.scenario, []);
    byScenario.get(o.scenario)!.push(o);
  }

  console.log('\n══ STABILITY SWEEP ═══════════════════════════════════════════════════');
  console.log(`  ${outcomes.length} runs across ${byScenario.size} scenarios, N=${N} each\n`);

  for (const [name, runs] of byScenario) {
    console.log(`◆ ${name}  (durationMs=${runs[0]!.durationMs})`);
    const pass = runs.filter((r) => r.brightLinePass).length;
    console.log(`    bright-line PASS:    ${fmtPercent(pass, runs.length)}`);
    const trimPcts = runs.map((r) => r.trimmedPct).filter((p): p is number => p !== null);
    if (trimPcts.length) {
      const fmt = trimPcts.map((p) => `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`).join(', ');
      console.log(`    trim Δ vs target:    [${fmt}]`);
    }
    console.log(`    intent:              ${fmtDistribution(runs.map((r) => r.intentLevel))}`);
    console.log(`    judge verdict:       ${fmtDistribution(runs.map((r) => r.judgeVerdict))}`);
    const judgePassPerDim: Record<string, { pass: number; partial: number; fail: number; absent: number }> = {};
    for (const r of runs) {
      for (const [d, lvl] of Object.entries(r.judgeDims)) {
        if (!judgePassPerDim[d]) judgePassPerDim[d] = { pass: 0, partial: 0, fail: 0, absent: 0 };
        judgePassPerDim[d][lvl as 'pass' | 'partial' | 'fail' | 'absent']++;
      }
    }
    for (const [d, c] of Object.entries(judgePassPerDim)) {
      console.log(`      ${d.padEnd(18)} pass×${c.pass}, partial×${c.partial}, fail×${c.fail}${c.absent ? `, absent×${c.absent}` : ''}`);
    }
    console.log(`    planFit:             ${fmtDistribution(runs.map((r) => r.planFitStatus))}`);
    const yFired = runs.filter((r) => r.reconLlmCalls >= 2).length;
    const yShrunk = runs.filter((r) => r.yShrunk).length;
    console.log(`    plan Y fired:        ${fmtPercent(yFired, runs.length)}, of those shrunk to ok: ${yShrunk}/${yFired || 1}`);
    const wallMs = runs.map((r) => r.wallClockMs);
    console.log(`    wall-clock:          [${wallMs.map(fmtMs).join(', ')}]`);
    const reconMs = runs.map((r) => r.reconMs);
    console.log(`    recon time:          [${reconMs.map(fmtMs).join(', ')}]`);
    console.log();
  }

  const overallPass = outcomes.filter((r) => r.brightLinePass).length;
  console.log(`▸ OVERALL bright-line PASS rate: ${fmtPercent(overallPass, outcomes.length)}`);
  console.log(`▸ OVERALL judge verdict distribution: ${fmtDistribution(outcomes.map((r) => r.judgeVerdict))}`);
}

async function main(): Promise<void> {
  log.info({ scenarios: SCENARIOS.length, N, headless: process.env.EVAL_HEADLESS ?? '(platform default)' }, 'starting stability sweep');
  const outcomes: RunOutcome[] = [];

  for (const scenario of SCENARIOS) {
    for (let i = 1; i <= N; i++) {
      log.info({ scenario: scenario.name, runIndex: i, of: N }, '— starting run');
      const beforeMs = Date.now();
      const { exitCode } = await spawnEval(scenario);
      const dir = newestEvalDirSince(beforeMs);
      if (!dir) {
        log.warn({ scenario: scenario.name, runIndex: i, exitCode }, 'no eval output dir found — skipping outcome');
        outcomes.push({
          scenario: scenario.name, runIndex: i, brightLinePass: false,
          trimmedMs: null, trimmedPct: null, durationMs: scenario.durationMs,
          wallClockMs: 0, reconMs: 0, intentLevel: 'unknown',
          planFitStatus: 'unknown', planFitRatio: 0, reconLlmCalls: 0, yShrunk: false,
          judgeVerdict: 'absent', judgeDims: {}, err: 'no output dir',
        });
        continue;
      }
      try {
        const outcome = parseRun(dir, scenario, i, exitCode);
        outcomes.push(outcome);
        log.info({ scenario: scenario.name, runIndex: i, brightLinePass: outcome.brightLinePass, verdict: outcome.judgeVerdict, intent: outcome.intentLevel }, 'run complete');
      } catch (err) {
        log.warn({ err, dir }, 'failed to parse run artifacts');
        outcomes.push({
          scenario: scenario.name, runIndex: i, brightLinePass: false,
          trimmedMs: null, trimmedPct: null, durationMs: scenario.durationMs,
          wallClockMs: 0, reconMs: 0, intentLevel: 'unknown',
          planFitStatus: 'unknown', planFitRatio: 0, reconLlmCalls: 0, yShrunk: false,
          judgeVerdict: 'absent', judgeDims: {}, err: String(err),
        });
      }
    }
  }

  summarize(outcomes);
}

main().catch((err) => {
  log.error({ err }, 'stability sweep failed');
  process.exit(1);
});
