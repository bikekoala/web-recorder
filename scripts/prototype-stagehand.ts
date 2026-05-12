/**
 * Natural-language driven recording prototype ("prophet" pipeline, ADR §0034).
 *
 * Input:  { url, prompt, durationMs }
 * Output: { trimmed video, raw video, action log, metrics }
 *
 * The whole pipeline is LLM-planned off-camera (reconnaissance), then played
 * back deterministically on-camera. See `src/core/record-job-runner.ts` for
 * the orchestration.
 *
 * Run:
 *   npm run prototype:stagehand
 *
 * To override the test scenario, edit the constants below or set:
 *   PROTOTYPE_URL   the URL to record
 *   PROTOTYPE_PROMPT  the natural-language instruction
 *   PROTOTYPE_DURATION_MS  the target recording duration in ms
 *   PROTOTYPE_HEADLESS  "true" to run headless (no browser window); default is
 *                       visible so you can watch.
 */

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { RecordJobRunner } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';

const TARGET_URL = process.env.PROTOTYPE_URL ?? 'https://github.com/webadderallorg/Recordly';
const USER_PROMPT =
  process.env.PROTOTYPE_PROMPT ??
  '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容';
const DURATION_MS = Number(process.env.PROTOTYPE_DURATION_MS ?? 10_000);
// Visible by default so you can watch; set PROTOTYPE_HEADLESS=true for no
// window (no focus-stealing, but you can't see it).
const HEADLESS = process.env.PROTOTYPE_HEADLESS === 'true';

async function main(): Promise<void> {
  const log = logger.child({ script: 'prototype-stagehand' });

  log.info(
    {
      url: TARGET_URL,
      prompt: USER_PROMPT,
      durationMs: DURATION_MS,
      model: config.llmModel,
      reconModel: config.llmReconModelResolved,
    },
    'starting',
  );

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'prototype' });

  const session = new StagehandPageSession({
    outputDir,
    headless: HEADLESS,
    viewport: config.viewport,
    verbose: 1,
  });
  const reconnoiterer = new LlmReconnoiterer(config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {});
  // The PerformanceDirector reuses the reconnoiterer as its re-planner at
  // the (at most config.maxReplans) re-plan checkpoints.
  const director = new PerformanceDirector({ replanner: reconnoiterer });

  const runner = new RecordJobRunner(session, reconnoiterer, director);

  try {
    const result = await runner.run({
      url: TARGET_URL,
      prompt: USER_PROMPT,
      durationMs: DURATION_MS,
      outputDir,
    });

    log.info({ metrics: result.metrics }, '📊 RUN METRICS');
    log.info({ directorReport: result.directorReport }, '🎬 DIRECTOR REPORT');
    log.info(
      {
        plannedSteps: result.metrics.plannedSteps,
        finalSteps: result.performance.steps.length,
        reconMs: result.metrics.reconMs,
        replanCount: result.metrics.replanCount,
        endReason: result.directorReport.endReason,
        stepsExecuted: result.directorReport.stepsExecuted,
      },
      '🔮 PROPHET SUMMARY',
    );
    log.info(
      `\n  Trimmed video: open "${result.videoPath}"`
        + `\n  Raw video:     open "${result.rawVideoPath}"`
        + `\n  Action log:    cat "${result.actionLogPath}"\n`,
    );
  } catch (err) {
    // Make sure session is stopped even if runner threw mid-pipeline.
    try {
      await session.stop();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

main().catch((err) => {
  logger.error(
    {
      err: err instanceof Error
        ? { name: err.name, message: err.message, code: (err as { code?: string }).code }
        : err,
    },
    '❌ prototype failed',
  );
  process.exit(1);
});
