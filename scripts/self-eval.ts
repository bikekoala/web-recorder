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
import { LlmUrlResolver } from '../src/adapters/url-resolver/llm-url-resolver.js';
import { LlmVisionJudge } from '../src/adapters/judge/llm-vision-judge.js';
import type { RecordingJudgeReport } from '../src/domain/recording-judgment.js';
import { RecordJobRunner, type RunResult } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';
import { writeJudgmentReport } from '../src/infra/run-record-writer.js';

// EVAL_PROMPT is the only input — embed any URL inline ("去 https://… 看看").
// The LlmUrlResolver picks it up (or names a well-known site for "看维基百科").
const PROMPT = process.env.EVAL_PROMPT
  ?? '去 https://github.com/webadderallorg/Recordly 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容';
const DURATION_MS = Number(process.env.EVAL_DURATION_MS ?? 10_000);
const HEADLESS = process.env.EVAL_HEADLESS !== 'false';
const DEVICE = (process.env.EVAL_DEVICE as 'desktop' | 'mobile' | 'tablet' | undefined) ?? 'desktop';

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

/**
 * Per-million-token USD rates for recon LLM cost estimation (goals.md #5 line).
 * Best-effort: prices change, and OpenRouter sometimes adds a small markup vs.
 * provider-direct. Order-of-magnitude is what matters for the goal #5 visibility.
 * Returns null when the model id isn't in the table (we don't make up a number).
 */
function estimateUsdCost(model: string, promptTokens: number, completionTokens: number): number | null {
  // [inputPerMillion, outputPerMillion] in USD.
  const RATES: Record<string, [number, number]> = {
    'anthropic/claude-sonnet-4.6': [3, 15],
    'anthropic/claude-haiku-4.5': [1, 5],
    'anthropic/claude-opus-4.6': [15, 75],
    'anthropic/claude-opus-4.7': [15, 75],
    'openai/gpt-4o-mini': [0.15, 0.6],
    'openai/gpt-4o': [2.5, 10],
    'openai/gpt-5-mini': [0.25, 2],
    'google/gemini-2.5-pro': [1.25, 5],
    'google/gemini-3.1-pro-preview': [1.25, 5],
  };
  const r = RATES[model];
  if (!r) return null;
  return (promptTokens * r[0] + completionTokens * r[1]) / 1_000_000;
}

function assess(result: RunResult, judge: RecordingJudgeReport | { error: string }, videoBytes: number): { rows: Row[]; hardFail: boolean; concerns: boolean } {
  const rows: Row[] = [];
  const m = result.metrics;

  // ── #2 Recording fidelity (bright-line) ────────────────────────────────────
  const trimmed = m.trimmedVideoMs;
  if (trimmed == null) {
    rows.push({ status: 'fail', label: 'trimmed-video duration', value: 'n/a', note: 'could not probe — ffmpeg failed?' });
  } else {
    const lo = DURATION_MS * (1 - DURATION_TOLERANCE);
    const hi = DURATION_MS * (1 + DURATION_TOLERANCE);
    const ok = trimmed >= lo && trimmed <= hi;
    const pct = ((trimmed - DURATION_MS) / DURATION_MS) * 100;
    rows.push({ status: ok ? 'ok' : 'fail', label: 'trimmed-video duration', value: `${fmtMs(trimmed)} (target ${fmtMs(DURATION_MS)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`, note: ok ? undefined : `outside ±${DURATION_TOLERANCE * 100}% — goals.md eval #2` });
  }
  // recording window (from action-log timestamps) vs the probed video length —
  // a wide gap means the trim window is offset (recordVideo's frame clock lags
  // the wall clock — see docs/findings/2026-05-12-recordvideo-clock-drift.md).
  const winMs = result.directorReport.totalMs;
  const gap = trimmed == null ? null : Math.abs(winMs - trimmed);
  rows.push({ status: gap != null && gap > 1500 ? 'warn' : 'ok', label: 'recording window', value: `${fmtMs(winMs)} (director.run)${gap != null ? `, vs probed ${fmtMs(trimmed)} — Δ${fmtMs(gap)}` : ''}`, note: gap != null && gap > 1500 ? 'window ≠ probed video length → trim offset / recordVideo clock drift (docs/findings/2026-05-12-recordvideo-clock-drift.md)' : undefined });

  // intent verbs executed (#3 — transparent either way; flag non-complete)
  const sat = m.intentSatisfaction;
  rows.push({ status: sat.level === 'complete' ? 'ok' : 'warn', label: 'intentSatisfaction', value: `${sat.level} — ${sat.clicksExecuted} click(s), ${sat.scrollsExecuted} scroll(s)`, note: sat.level === 'complete' ? undefined : `${sat.note} — check whether the missed target was actually on the page (goals.md #3 — '${sat.level}' must reflect reality, not a resolution failure we could have avoided)` });

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

  // on-camera re-plan = a frozen frame ≈ a stall (#2)
  rows.push({ status: m.replanCount > 0 ? 'warn' : 'ok', label: 'on-camera re-plans', value: String(m.replanCount), note: m.replanCount > 0 ? 'each re-plan freezes the frame for a full recon — a near-stall' : undefined });
  rows.push({ status: ['done', 'budget'].includes(result.directorReport.endReason) ? 'ok' : 'warn', label: 'director endReason', value: result.directorReport.endReason });

  // ── #3 / #5 Cost & speed ───────────────────────────────────────────────────
  rows.push({ status: m.totalWallClockMs > WALL_CLOCK_LIMIT_MS ? 'fail' : 'ok', label: 'total wall-clock', value: fmtMs(m.totalWallClockMs), note: m.totalWallClockMs > WALL_CLOCK_LIMIT_MS ? `over ${WALL_CLOCK_LIMIT_MS / 1000}s — goals.md #5` : undefined });
  rows.push({ status: m.reconMs > RECON_SOFT_LIMIT_MS ? 'warn' : 'ok', label: 'recon time', value: fmtMs(m.reconMs), note: m.reconMs > RECON_SOFT_LIMIT_MS ? 'slow recon (off-camera but counts against the wall-clock budget)' : undefined });
  rows.push({ status: videoBytes > DISK_LIMIT_BYTES ? 'fail' : 'ok', label: 'trimmed-video size', value: `${(videoBytes / (1024 * 1024)).toFixed(1)} MB`, note: videoBytes > DISK_LIMIT_BYTES ? `over ${DISK_LIMIT_BYTES / 1024 / 1024} MB — goals.md #5` : undefined });
  // F2 cost-tracking — actual token-usage measurement landed; was "not measured here".
  if (m.reconLlm) {
    const { model, calls, promptTokens, completionTokens } = m.reconLlm;
    const cost = estimateUsdCost(model, promptTokens, completionTokens);
    const tokensStr = `${(promptTokens / 1000).toFixed(1)}k in / ${(completionTokens / 1000).toFixed(1)}k out`;
    const costStr = cost != null ? ` ≈ $${cost.toFixed(3)}` : '';
    const overBudget = cost != null && cost > 0.01;
    rows.push({
      status: overBudget ? 'warn' : 'ok',
      label: 'recon LLM cost',
      value: `${tokensStr}${costStr} (calls: ${calls}, model: ${model})`,
      note: overBudget
        ? `over the goals.md #5 $0.01 target — F2 territory (cheaper recon model or tighter aria-tree pruning)`
        : cost == null
          ? `pricing unknown for this model — exposing token counts only; goals.md #5 target is $0.01`
          : undefined,
    });
  } else {
    rows.push({ status: 'warn', label: 'recon LLM cost', value: 'no usage reported', note: 'recon adapter did not return token usage — check that the OpenAI SDK response.usage came through' });
  }

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

    // F3 cross-check (docs/findings/2026-05-13-wild-prompts-sweep.md P2):
    // intentSatisfaction counts click EVENTS, the judge watches whether those
    // clicks actually ACCOMPLISHED the intent. When the metric says `complete`
    // but the judge's intentExecution dimension says `fail`, the metric is
    // lying — the click(s) ran but the deliverable didn't satisfy the prompt
    // (github trending: A clicked the date dropdown but never selected
    // 'This week'). Surface the disagreement loudly instead of letting it
    // hide between two adjacent ✓/⚠ rows.
    const ie = judge.judgment.dimensions.intentExecution;
    if (sat.level === 'complete' && ie.level !== 'pass') {
      const ev = ie.evidence.map((e) => `@${e.atSecond}s: ${e.observation}`).join(' | ') || '(no evidence)';
      rows.push({
        status: 'warn',
        label: 'intent cross-check',
        value: `DISAGREE — metric says \`complete\`, judge says \`${ie.level}\``,
        note: `the deterministic metric counts click EVENTS, not click EFFECTS — the recording's clicks ran but the visual outcome did NOT fully satisfy the prompt. Judge evidence: ${ev}. The judge is the ground truth here (goals.md #3 — F3 follow-up parked).`,
      });
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
  log.info({ prompt: PROMPT, durationMs: DURATION_MS, headless: HEADLESS, reconModel: config.llmReconModelResolved, judgeModel: config.llmJudgeModel, urlResolverModel: config.llmUrlResolverModel }, 'self-eval: running the pipeline');

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'eval' });
  const session = new StagehandPageSession({ outputDir, headless: HEADLESS, viewport: config.viewport, device: DEVICE, verbose: 1 });
  const urlResolver = new LlmUrlResolver();
  const reconnoiterer = new LlmReconnoiterer(config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {});
  const director = new PerformanceDirector({ replanner: reconnoiterer });
  const runner = new RecordJobRunner(session, urlResolver, reconnoiterer, director);

  let result: RunResult;
  try {
    result = await runner.run({ prompt: PROMPT, durationMs: DURATION_MS, outputDir, device: DEVICE });
  } catch (err) {
    try { await session.stop(); } catch { /* ignore */ }
    throw err;
  }
  log.info({ urlResolution: result.urlResolution }, '🧭 url resolved');

  log.info({ metrics: result.metrics, directorReport: result.directorReport }, 'pipeline done — now judging the recording');

  let judge: RecordingJudgeReport | { error: string };
  try {
    judge = await new LlmVisionJudge().judge({ videoPath: result.videoPath, userPrompt: PROMPT, durationMs: DURATION_MS });
  } catch (err) {
    judge = { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    log.warn({ err }, 'judge call failed — continuing without it');
  }

  // Persist the judge verdict next to recording.webm + run.json so it's
  // reviewable post-hoc (see docs/output-layout.md). Best-effort — a write
  // failure shouldn't sink the eval (the verdict is in stdout / the structured
  // log either way).
  if (!('error' in judge)) {
    try {
      await writeJudgmentReport(outputDir, judge);
    } catch (err) {
      log.warn({ err }, 'failed to write judgment.json');
    }
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
