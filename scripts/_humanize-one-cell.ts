/**
 * Single cell of the humanize bake-off — one (scenario, strategy) pair.
 *
 * Spawned by `scripts/humanize-bake-off.ts`. Reads:
 *   - argv[2]: scenario id  (one of: recordly | google | wiki)
 *   - argv[3]: result-out path
 *   - env: HUMANIZE_STRATEGY (already read by src/infra/config.ts at import time)
 *
 * Runs the recording → judge pipeline once and writes a result blob to
 * `result-out`. The orchestrator collects them all and prints a table.
 *
 * Separate process per cell because the `config` module reads env once at
 * load — flipping HUMANIZE_STRATEGY between cells requires a fresh process.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { LlmUrlResolver } from '../src/adapters/url-resolver/llm-url-resolver.js';
import { LlmVisionJudge } from '../src/adapters/judge/llm-vision-judge.js';
import { RecordJobRunner } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger as rootLogger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';
import { writeJudgmentReport } from '../src/infra/run-record-writer.js';
import type { RecordingJudgeReport } from '../src/domain/recording-judgment.js';

interface Scenario {
  id: 'recordly' | 'google' | 'wiki';
  prompt: string;
  durationMs: number;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'recordly',
    prompt: '去 https://github.com/webadderallorg/Recordly 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
    durationMs: 10_000,
  },
  {
    id: 'google',
    prompt: '去 https://www.google.com 搜索 mechanical keyboard，结果出来后慢慢往下浏览',
    durationMs: 15_000,
  },
  {
    id: 'wiki',
    prompt: '去 https://en.wikipedia.org/wiki/Photosynthesis 慢慢往下读这篇文章',
    durationMs: 25_000,
  },
];

interface CellResult {
  scenarioId: string;
  strategy: string;
  status: 'ok' | 'pipeline_error' | 'judge_error';
  durationMs: number;
  trimmedVideoMs: number | null;
  intentSatisfaction: string;
  verdict?: RecordingJudgeReport['judgment']['verdict'];
  dimensions?: {
    motionQuality: string;
    pacing: string;
    intentExecution: string;
    recovery: string;
    visualCoherence: string;
  };
  summary?: string;
  videoPath?: string;
  errorMessage?: string;
  wallClockMs: number;
}

async function main(): Promise<void> {
  const log = rootLogger.child({ script: 'humanize-bake-off-cell' });
  const t0 = Date.now();

  const scenarioId = process.argv[2] ?? '';
  const resultPath = process.argv[3] ?? '';
  if (!scenarioId || !resultPath) {
    console.error('usage: _humanize-one-cell.ts <scenario-id> <result-out-path>');
    process.exit(2);
  }
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    console.error(`unknown scenario id "${scenarioId}" — expected one of ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }

  const strategy = config.humanizeStrategy;
  log.info({ scenario: scenario.id, strategy, durationMs: scenario.durationMs }, 'bake-off cell start');

  const result: CellResult = {
    scenarioId: scenario.id,
    strategy,
    status: 'pipeline_error',
    durationMs: scenario.durationMs,
    trimmedVideoMs: null,
    intentSatisfaction: 'unknown',
    wallClockMs: 0,
  };

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'bake', sub: `${scenario.id}-${strategy}` });

  try {
    const session = new StagehandPageSession({
      outputDir,
      headless: true,
      viewport: config.viewport,
      device: 'desktop',
      verbose: 0,
    });
    const reconnoiterer = new LlmReconnoiterer(
      config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {},
    );
    const director = new PerformanceDirector({ replanner: reconnoiterer });
    const urlResolver = new LlmUrlResolver();
    const runner = new RecordJobRunner(session, urlResolver, reconnoiterer, director);

    let runResult;
    try {
      runResult = await runner.run({
        prompt: scenario.prompt,
        durationMs: scenario.durationMs,
        outputDir,
      });
      result.videoPath = runResult.videoPath;
      result.trimmedVideoMs = runResult.metrics.trimmedVideoMs;
      result.intentSatisfaction = runResult.metrics.intentSatisfaction.level;
    } catch (err) {
      result.status = 'pipeline_error';
      result.errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.warn({ err }, 'pipeline error');
    } finally {
      try { await session.stop(); } catch { /* ignore */ }
    }

    if (runResult) {
      try {
        const judge = await new LlmVisionJudge().judge({
          videoPath: runResult.videoPath,
          userPrompt: scenario.prompt,
          durationMs: scenario.durationMs,
        });
        await writeJudgmentReport(outputDir, judge).catch(() => {});
        result.status = 'ok';
        result.verdict = judge.judgment.verdict;
        result.dimensions = {
          motionQuality: judge.judgment.dimensions.motionQuality.level,
          pacing: judge.judgment.dimensions.pacing.level,
          intentExecution: judge.judgment.dimensions.intentExecution.level,
          recovery: judge.judgment.dimensions.recovery.level,
          visualCoherence: judge.judgment.dimensions.visualCoherence.level,
        };
        result.summary = judge.judgment.summary;
      } catch (err) {
        result.status = 'judge_error';
        result.errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log.warn({ err }, 'judge error');
      }
    }
  } finally {
    result.wallClockMs = Date.now() - t0;
    await writeFile(resolve(resultPath), JSON.stringify(result, null, 2), 'utf8');
    log.info({ result }, 'bake-off cell done');
  }
}

main().catch((err) => {
  rootLogger.error({ err }, 'bake-off cell crashed unexpectedly');
  process.exit(1);
});
