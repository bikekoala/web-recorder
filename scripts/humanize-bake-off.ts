/**
 * Humanize bake-off — A/B compare `ours` vs `cloakbrowser` on-camera renderers.
 *
 *   3 scenarios × 2 strategies × N runs (default 3) = 18 recordings
 *
 * Each cell spawns a fresh `tsx scripts/_humanize-one-cell.ts <scenario>` child
 * process with `HUMANIZE_STRATEGY=...` in env (the config module reads it once
 * at module load, so per-cell processes are the only clean way to flip it).
 * Children write a single JSON result blob; we collect and print a table.
 *
 * Defaults are tuned for a ~15 min / ~$1.5 LLM run on the dev box. Override:
 *   BAKE_RUNS=2           # runs per (scenario, strategy) cell. default 3.
 *   BAKE_SCENARIOS=recordly,wiki   # subset to run. default all 3.
 *   BAKE_STRATEGIES=ours,cloakbrowser
 *
 * Run:  npm run bake-off
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { logger as rootLogger } from '../src/infra/logger.js';

const log = rootLogger.child({ script: 'humanize-bake-off' });

const ALL_SCENARIOS = ['recordly', 'google', 'wiki'] as const;
const ALL_STRATEGIES = ['ours', 'cloakbrowser'] as const;
type Scenario = typeof ALL_SCENARIOS[number];
type Strategy = typeof ALL_STRATEGIES[number];

const RUNS_PER_CELL = Number(process.env.BAKE_RUNS ?? 3);
const SCENARIOS: ReadonlyArray<Scenario> = (process.env.BAKE_SCENARIOS?.split(',').filter(Boolean) as Scenario[] | undefined) ?? ALL_SCENARIOS;
const STRATEGIES: ReadonlyArray<Strategy> = (process.env.BAKE_STRATEGIES?.split(',').filter(Boolean) as Strategy[] | undefined) ?? ALL_STRATEGIES;

interface CellResult {
  scenarioId: string;
  strategy: string;
  status: 'ok' | 'pipeline_error' | 'judge_error';
  durationMs: number;
  trimmedVideoMs: number | null;
  intentSatisfaction: string;
  verdict?: string;
  dimensions?: Record<string, string>;
  summary?: string;
  videoPath?: string;
  errorMessage?: string;
  wallClockMs: number;
}

async function runCell(scenario: Scenario, strategy: Strategy, runIdx: number, scratchDir: string): Promise<CellResult> {
  const resultPath = join(scratchDir, `${scenario}-${strategy}-${runIdx}.json`);
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(
      'npx',
      ['tsx', resolve('scripts/_humanize-one-cell.ts'), scenario, resultPath],
      {
        env: { ...process.env, HUMANIZE_STRATEGY: strategy },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    proc.on('error', rejectP);
    proc.on('close', async (code) => {
      try {
        const raw = await readFile(resultPath, 'utf8');
        resolveP(JSON.parse(raw) as CellResult);
      } catch (err) {
        if (code !== 0) rejectP(new Error(`cell exited ${code} and no result file at ${resultPath}`));
        else rejectP(err);
      }
    });
  });
}

const DIM_KEYS = ['motionQuality', 'pacing', 'intentExecution', 'recovery', 'visualCoherence'] as const;
const DIM_HEADERS = ['mq', 'pa', 'ie', 'rec', 'vc'] as const;
const VERDICT_GLYPH: Record<string, string> = {
  looks_human: 'L',
  probably_human: 'h',
  probably_synthetic: 's',
  robotic: 'R',
};
const DIM_GLYPH: Record<string, string> = { pass: '·', partial: '~', fail: '✗' };

function fmtCell(cells: CellResult[]): string {
  if (cells.length === 0) return '∅';
  return cells.map((c) => {
    if (c.status !== 'ok' || !c.verdict || !c.dimensions) return c.status === 'pipeline_error' ? 'E' : 'J';
    const dimsStr = DIM_KEYS.map((k) => DIM_GLYPH[c.dimensions?.[k] ?? ''] ?? '?').join('');
    return `${VERDICT_GLYPH[c.verdict] ?? '?'}${dimsStr}`;
  }).join(' ');
}

function passRate(cells: CellResult[]): string {
  const ok = cells.filter((c) => c.status === 'ok');
  if (ok.length === 0) return 'n/a';
  const looks = ok.filter((c) => c.verdict === 'looks_human').length;
  return `${looks}/${ok.length}`;
}

function dimPassRate(cells: CellResult[], dim: typeof DIM_KEYS[number]): string {
  const ok = cells.filter((c) => c.status === 'ok' && c.dimensions);
  if (ok.length === 0) return 'n/a';
  const passed = ok.filter((c) => c.dimensions?.[dim] === 'pass').length;
  return `${passed}/${ok.length}`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  log.info({ SCENARIOS, STRATEGIES, RUNS_PER_CELL }, 'humanize bake-off start');
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(`  humanize bake-off:  ${SCENARIOS.length} scenarios × ${STRATEGIES.length} strategies × ${RUNS_PER_CELL} runs`);
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const scratchDir = join(tmpdir(), `bake-off-${Date.now()}`);
  await mkdir(scratchDir, { recursive: true });

  const results: CellResult[] = [];
  try {
    for (const scenario of SCENARIOS) {
      for (const strategy of STRATEGIES) {
        for (let i = 0; i < RUNS_PER_CELL; i++) {
          const tag = `${scenario}/${strategy}/${i + 1}`;
          console.log(`  → ${tag} …`);
          const cellT0 = Date.now();
          try {
            const r = await runCell(scenario, strategy, i, scratchDir);
            results.push(r);
            const dur = ((Date.now() - cellT0) / 1000).toFixed(1);
            console.log(`     ${tag}  ${dur}s  status=${r.status}  verdict=${r.verdict ?? '—'}  intent=${r.intentSatisfaction}`);
          } catch (err) {
            console.log(`     ${tag}  CRASHED  ${err instanceof Error ? err.message : String(err)}`);
            results.push({
              scenarioId: scenario,
              strategy,
              status: 'pipeline_error',
              durationMs: 0,
              trimmedVideoMs: null,
              intentSatisfaction: 'crash',
              errorMessage: err instanceof Error ? err.message : String(err),
              wallClockMs: Date.now() - cellT0,
            });
          }
        }
      }
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }

  // ───────── Table 1: detailed per-cell strip
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Detailed per-cell (verdict + dims: mq, pa, ie, rec, vc)');
  console.log('    verdict: L=looks_human, h=probably_human, s=probably_synthetic, R=robotic, E=pipeline-error, J=judge-error');
  console.log('    dim:     · = pass, ~ = partial, ✗ = fail');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const labelWidth = 10;
  console.log(`  ${'scenario'.padEnd(labelWidth)}  ${'strategy'.padEnd(12)}  cells`);
  console.log(`  ${'-'.repeat(labelWidth)}  ${'-'.repeat(12)}  ${'-'.repeat(30)}`);
  for (const scenario of SCENARIOS) {
    for (const strategy of STRATEGIES) {
      const cells = results.filter((r) => r.scenarioId === scenario && r.strategy === strategy);
      console.log(`  ${scenario.padEnd(labelWidth)}  ${strategy.padEnd(12)}  ${fmtCell(cells)}`);
    }
  }

  // ───────── Table 2: summary — looks_human rate + per-dim pass rate
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Summary — looks_human rate + per-dim pass rate (n/total)');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  console.log(`  ${'scenario'.padEnd(labelWidth)}  ${'strategy'.padEnd(12)}  ${'looks_h'.padEnd(8)}  ${DIM_HEADERS.map((h) => h.padEnd(5)).join('')}`);
  console.log(`  ${'-'.repeat(labelWidth)}  ${'-'.repeat(12)}  ${'-'.repeat(8)}  ${'-'.repeat(DIM_HEADERS.length * 5)}`);
  for (const scenario of SCENARIOS) {
    for (const strategy of STRATEGIES) {
      const cells = results.filter((r) => r.scenarioId === scenario && r.strategy === strategy);
      const lh = passRate(cells).padEnd(8);
      const dims = DIM_KEYS.map((k) => dimPassRate(cells, k).padEnd(5)).join('');
      console.log(`  ${scenario.padEnd(labelWidth)}  ${strategy.padEnd(12)}  ${lh}  ${dims}`);
    }
  }

  // ───────── Table 3: per-strategy overall
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Overall by strategy (across all scenarios)');
  console.log('══════════════════════════════════════════════════════════════════════\n');
  console.log(`  ${'strategy'.padEnd(12)}  ${'looks_h'.padEnd(8)}  ${DIM_HEADERS.map((h) => h.padEnd(5)).join('')}`);
  console.log(`  ${'-'.repeat(12)}  ${'-'.repeat(8)}  ${'-'.repeat(DIM_HEADERS.length * 5)}`);
  for (const strategy of STRATEGIES) {
    const cells = results.filter((r) => r.strategy === strategy);
    const lh = passRate(cells).padEnd(8);
    const dims = DIM_KEYS.map((k) => dimPassRate(cells, k).padEnd(5)).join('');
    console.log(`  ${strategy.padEnd(12)}  ${lh}  ${dims}`);
  }

  const totalMs = Date.now() - t0;
  console.log(`\n  Wall-clock: ${(totalMs / 1000 / 60).toFixed(1)} min  (${results.length} cells, ${results.filter((r) => r.status === 'ok').length} ok)`);
  console.log('  Per-cell videos under output/<date>/<HH-MM-SS>-bake-<scenario>-<strategy>/recording.mp4');
  console.log();

  // Persist a machine-readable copy so future analysis can re-aggregate.
  const outFile = resolve(`bake-off-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(outFile, JSON.stringify({ scenarios: SCENARIOS, strategies: STRATEGIES, runsPerCell: RUNS_PER_CELL, results }, null, 2), 'utf8');
  console.log(`  Raw JSON: ${outFile}\n`);
}

main().catch((err) => {
  log.error({ err }, '❌ bake-off crashed');
  process.exit(1);
});
