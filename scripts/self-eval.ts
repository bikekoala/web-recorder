/**
 * Self-eval — run the prophet pipeline (ADR §0034/§0036) on one scenario, judge
 * the recording, and print a structured assessment against `docs/goals.md`'s
 * evaluation criteria + the operator canaries. The point: judge "did this change
 * regress something?" WITHOUT watching the video.
 *
 *   - Bright-line specs (#2/#3/#5: trimmed duration within ±10% of durationMs,
 *     disk < 100 MB, total wall-clock < 60 s) → hard-fail (exit 1) if violated.
 *   - Quality / robustness (#1 naturalness via the LLM judge, #4 graceful
 *     degradation, the rehearsal/blocker canaries) → flagged as CONCERNS for
 *     human/agent review, exit 0 (per goals.md #6 — quality isn't a numeric gate;
 *     "let humans review the videos for naturalness — that's the only ground
 *     truth we trust"). CONCERNS still print loudly so you don't miss them.
 *
 * Run:  npm run eval
 * Env:  EVAL_URL / EVAL_PROMPT / EVAL_DURATION_MS / EVAL_HEADLESS (default true)
 *       — single scenario only; for multi-site robustness use `npm run regression`.
 */
import { statSync } from 'node:fs';

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { LlmVisionJudge } from '../src/adapters/judge/llm-vision-judge.js';
import type { RecordingJudgeReport } from '../src/domain/recording-judgment.js';
import { RecordJobRunner, type RunResult } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';

const URL = process.env.EVAL_URL ?? 'https://github.com/webadderallorg/Recordly';
const PROMPT = process.env.EVAL_PROMPT ?? '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容';
const DURATION_MS = Number(process.env.EVAL_DURATION_MS ?? 10_000);
const HEADLESS = process.env.EVAL_HEADLESS !== 'false';

const WALL_CLOCK_LIMIT_MS = 60_000; // goals.md #5
const DISK_LIMIT_BYTES = 100 * 1024 * 1024; // goals.md #5
const DURATION_TOLERANCE = 0.1; // goals.md eval criterion #2: ±10%
const RECON_SOFT_LIMIT_MS = 45_000; // soft canary, not a gate

type Status = 'ok' | 'warn' | 'fail';
interface Row { status: Status; label: string; value: string; note?: string | undefined }

const ICON: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' };

function fmtMs(ms: number | null): string {
  return ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`;
}

function assess(result: RunResult, judge: RecordingJudgeReport | { error: string }, videoBytes: number): { rows: Row[]; hardFail: boolean; concerns: boolean } {
  const rows: Row[] = [];
  const m = result.metrics;

  // ── #2 Recording fidelity (bright-line) ────────────────────────────────────
  const trimmed = m.trimmedVideoMs;
  if (trimmed == null) {
    rows.push({ status: 'fail', label: 'trimmed-video duration', value: 'n/a', note: 'could not measure — ffprobe failed?' });
  } else {
    const lo = DURATION_MS * (1 - DURATION_TOLERANCE);
    const hi = DURATION_MS * (1 + DURATION_TOLERANCE);
    const ok = trimmed >= lo && trimmed <= hi;
    const pct = ((trimmed - DURATION_MS) / DURATION_MS) * 100;
    rows.push({ status: ok ? 'ok' : 'fail', label: 'trimmed-video duration', value: `${fmtMs(trimmed)} (target ${fmtMs(DURATION_MS)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`, note: ok ? undefined : `outside ±${DURATION_TOLERANCE * 100}% — goals.md eval #2` });
  }

  // intent verbs executed (#3 — transparent either way; flag non-complete)
  const sat = m.intentSatisfaction;
  rows.push({ status: sat.level === 'complete' ? 'ok' : 'warn', label: 'intentSatisfaction', value: `${sat.level} — ${sat.clicksExecuted} click(s), ${sat.scrollsExecuted} scroll(s)`, note: sat.level === 'complete' ? undefined : `${sat.note} — check whether the missed target was actually on the page (goals.md #3 — '${sat.level}' must reflect reality, not a resolution failure we could have avoided)` });

  // on-camera re-plan = a frozen frame ≈ a stall (#2)
  rows.push({ status: m.replanCount > 0 ? 'warn' : 'ok', label: 'on-camera re-plans', value: String(m.replanCount), note: m.replanCount > 0 ? 'each re-plan freezes the frame for a full recon — a near-stall' : undefined });
  rows.push({ status: ['done', 'budget'].includes(result.directorReport.endReason) ? 'ok' : 'warn', label: 'director endReason', value: result.directorReport.endReason });

  // ── #3 / #5 Cost & speed ───────────────────────────────────────────────────
  rows.push({ status: m.totalWallClockMs > WALL_CLOCK_LIMIT_MS ? 'fail' : 'ok', label: 'total wall-clock', value: fmtMs(m.totalWallClockMs), note: m.totalWallClockMs > WALL_CLOCK_LIMIT_MS ? `over ${WALL_CLOCK_LIMIT_MS / 1000}s — goals.md #5` : undefined });
  rows.push({ status: m.reconMs > RECON_SOFT_LIMIT_MS ? 'warn' : 'ok', label: 'recon time', value: fmtMs(m.reconMs), note: m.reconMs > RECON_SOFT_LIMIT_MS ? 'slow recon (off-camera but counts against the wall-clock budget)' : undefined });
  rows.push({ status: videoBytes > DISK_LIMIT_BYTES ? 'fail' : 'ok', label: 'trimmed-video size', value: `${(videoBytes / (1024 * 1024)).toFixed(1)} MB`, note: videoBytes > DISK_LIMIT_BYTES ? `over ${DISK_LIMIT_BYTES / 1024 / 1024} MB — goals.md #5` : undefined });
  rows.push({ status: 'warn', label: 'recon LLM $', value: 'not measured here', note: `the aria tree is the recon prompt's big input on the expensive recon model — goals.md #5 ($0.01) is over-budget; see ADR §0036. (Re-measure with token logging if you touch this.)` });

  // ── #1 Naturalness (LLM judge — CONCERNS, never a hard gate per #6) ─────────
  if ('error' in judge) {
    rows.push({ status: 'warn', label: 'naturalness judge', value: 'unavailable', note: judge.error });
  } else {
    const v = judge.judgment.verdict;
    rows.push({ status: v === 'looks_human' ? 'ok' : v === 'probably_human' ? 'warn' : 'warn', label: 'judge verdict', value: v, note: v === 'looks_human' ? undefined : 'a real person review is the ground truth (goals.md #1/#6) — this LLM verdict is a signal, not a gate' });
    for (const [k, d] of Object.entries(judge.judgment.dimensions)) {
      if (d.level === 'pass') { rows.push({ status: 'ok', label: `  judge:${k}`, value: 'pass' }); continue; }
      const ev = d.evidence.map((e) => `@${e.atSecond}s: ${e.observation}`).join(' | ') || '(no evidence)';
      rows.push({ status: 'warn', label: `  judge:${k}`, value: d.level, note: ev });
    }
  }

  // ── Operator canaries ──────────────────────────────────────────────────────
  const r = result.performance.rehearsal;
  if (r) {
    const bad = r.truncated || r.timedOut || r.divergences > 0;
    rows.push({ status: bad ? 'warn' : 'ok', label: 'rehearsal walk', value: `${r.walkedSteps} steps, ${r.divergences} div, ${r.reconverges} reconv${r.truncated ? ', truncated' : ''}${r.timedOut ? ', timedOut' : ''}`, note: bad ? "the recon's first-draft plan needed correction on this site — inspect the action log" : undefined });
  }
  const b = result.performance.blockerDismissal;
  if (b) {
    rows.push({ status: b.stillBlocked ? 'warn' : 'ok', label: 'blocker dismissal', value: `${b.rounds} round(s)${b.dismissed.length ? `, dismissed: ${b.dismissed.join('; ')}` : ''}${b.stillBlocked ? ', STILL BLOCKED' : ''}`, note: b.stillBlocked ? 'a blocker may still cover the page — the recon planned against it' : undefined });
  }

  const hardFail = rows.some((x) => x.status === 'fail');
  const concerns = rows.some((x) => x.status === 'warn');
  return { rows, hardFail, concerns };
}

function printReport(rows: Row[], hardFail: boolean, concerns: boolean): void {
  const label = (s: string) => s.padEnd(24);
  console.log('\n══ SELF-EVAL ═══════════════════════════════════════════════════════════');
  for (const r of rows) {
    console.log(`  ${ICON[r.status]} ${label(r.label)} ${r.value}${r.note ? `\n      ↳ ${r.note}` : ''}`);
  }
  const verdict = hardFail ? 'FAIL  — a bright-line spec (duration / wall-clock / disk) is violated; this regresses goals.md.'
    : concerns ? 'CONCERNS — bright-line specs OK; the flagged ⚠ items need a look (some are expected/parked).'
    : 'PASS  — bright-line specs OK and nothing flagged.';
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`  ${verdict}\n`);
}

async function main(): Promise<void> {
  const log = logger.child({ script: 'self-eval' });
  log.info({ url: URL, prompt: PROMPT, durationMs: DURATION_MS, headless: HEADLESS, reconModel: config.llmReconModelResolved, judgeModel: config.llmJudgeModel }, 'self-eval: running the pipeline');

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'eval' });
  const session = new StagehandPageSession({ outputDir, headless: HEADLESS, viewport: config.viewport, verbose: 1 });
  const reconnoiterer = new LlmReconnoiterer(config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {});
  const director = new PerformanceDirector({ replanner: reconnoiterer });
  const runner = new RecordJobRunner(session, reconnoiterer, director);

  let result: RunResult;
  try {
    result = await runner.run({ url: URL, prompt: PROMPT, durationMs: DURATION_MS, outputDir });
  } catch (err) {
    try { await session.stop(); } catch { /* ignore */ }
    throw err;
  }

  log.info({ metrics: result.metrics, directorReport: result.directorReport }, 'pipeline done — now judging the recording');

  let judge: RecordingJudgeReport | { error: string };
  try {
    judge = await new LlmVisionJudge().judge({ videoPath: result.videoPath, userPrompt: PROMPT, durationMs: DURATION_MS });
  } catch (err) {
    judge = { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    log.warn({ err }, 'judge call failed — continuing without it');
  }

  let videoBytes = 0;
  try { videoBytes = statSync(result.videoPath).size; } catch { /* leave 0 */ }

  const { rows, hardFail, concerns } = assess(result, judge, videoBytes);
  printReport(rows, hardFail, concerns);
  console.log(`  video:  open "${result.videoPath}"`);
  console.log(`  log:    cat  "${result.actionLogPath}"\n`);

  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : err }, '❌ self-eval crashed');
  process.exit(2);
});
