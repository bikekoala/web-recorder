/**
 * Natural-language driven recording prototype ("prophet" pipeline, ADR §0034).
 *
 * Input:  { prompt, durationMs }  — the URL is resolved from the prompt by the
 *         LlmUrlResolver (handles explicit URLs, well-known sites, pure intent;
 *         AI-first per goals.md #6).
 * Output: { trimmed video, raw video, action log, metrics, urlResolution }
 *
 * The whole pipeline is LLM-planned off-camera (reconnaissance), then played
 * back deterministically on-camera. See `src/core/record-job-runner.ts` for
 * the orchestration.
 *
 * Run:
 *   npm run prototype:stagehand
 *
 * To override the test scenario, edit the constants below or set:
 *   PROTOTYPE_PROMPT       the natural-language instruction (may include a URL)
 *   PROTOTYPE_DURATION_MS  the target recording duration in ms
 *
 * This is a manual dev script — runs headed (`headless: false`) so you can
 * watch the browser. The HTTP server entry (scripts/serve.ts) is the service
 * counterpart and runs headless.
 */

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { LlmUrlResolver } from '../src/adapters/url-resolver/llm-url-resolver.js';
import { RecordJobRunner } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';

const USER_PROMPT =
  process.env.PROTOTYPE_PROMPT ??
  '去 https://github.com/webadderallorg/Recordly 点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容';
const DURATION_MS = Number(process.env.PROTOTYPE_DURATION_MS ?? 10_000);
// PROTOTYPE_DEVICE=desktop|mobile|tablet (default desktop). Mobile/tablet use
// the matching Playwright preset's viewport — the script's viewport config is
// ignored for those.
const DEVICE = (process.env.PROTOTYPE_DEVICE as 'desktop' | 'mobile' | 'tablet' | undefined) ?? 'desktop';

async function main(): Promise<void> {
  const log = logger.child({ script: 'prototype-stagehand' });

  log.info(
    {
      prompt: USER_PROMPT,
      durationMs: DURATION_MS,
      model: config.llmModel,
      reconModel: config.llmReconModelResolved,
      urlResolverModel: config.llmUrlResolverModel,
    },
    'starting',
  );

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'prototype' });

  // Manual dev script runs headed so you can watch the browser — service-mode
  // runs through scripts/serve.ts which hard-codes headless: true.
  const session = new StagehandPageSession({
    outputDir,
    headless: false,
    viewport: config.viewport,
    device: DEVICE,
    verbose: 1,
  });
  const urlResolver = new LlmUrlResolver();
  const reconnoiterer = new LlmReconnoiterer(config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {});
  // The PerformanceDirector reuses the reconnoiterer as its re-planner at
  // the (at most config.maxReplans) re-plan checkpoints.
  const director = new PerformanceDirector({ replanner: reconnoiterer });

  const runner = new RecordJobRunner(session, urlResolver, reconnoiterer, director);

  try {
    const result = await runner.run({
      prompt: USER_PROMPT,
      durationMs: DURATION_MS,
      outputDir,
      device: DEVICE,
    });

    log.info({ metrics: result.metrics }, '📊 RUN METRICS');
    log.info({ directorReport: result.directorReport }, '🎬 DIRECTOR REPORT');
    log.info({ urlResolution: result.urlResolution }, '🧭 URL RESOLUTION');
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
