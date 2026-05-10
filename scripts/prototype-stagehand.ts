/**
 * Natural-language driven recording prototype.
 *
 * Input:  { url, prompt, durationMs }
 * Output: { trimmed video, raw video, action log, metrics }
 *
 * The whole pipeline is now LLM-planned — no hand-coded scenario. See
 * `src/core/record-job-runner.ts` for the orchestration.
 *
 * Run:
 *   npm run prototype:stagehand
 *
 * To override the test scenario, edit the constants below or set:
 *   PROTOTYPE_URL   the URL to record
 *   PROTOTYPE_PROMPT  the natural-language instruction
 *   PROTOTYPE_DURATION_MS  the target recording duration in ms
 */

import { resolve } from 'node:path';

import { LlmFastDecider } from '../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../src/adapters/director/streaming-director.js';
import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmPlanner } from '../src/adapters/planner/llm-planner.js';
import { BlockerPrelude } from '../src/core/blocker-prelude.js';
import { RecordJobRunner } from '../src/core/record-job-runner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';

const TARGET_URL = process.env.PROTOTYPE_URL ?? 'https://github.com/webadderallorg/Recordly';
const USER_PROMPT =
  process.env.PROTOTYPE_PROMPT ??
  '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容';
const DURATION_MS = Number(process.env.PROTOTYPE_DURATION_MS ?? 10_000);

async function main(): Promise<void> {
  const log = logger.child({ script: 'prototype-stagehand' });

  log.info(
    { url: TARGET_URL, prompt: USER_PROMPT, durationMs: DURATION_MS, model: config.llmModel },
    'starting',
  );

  const outputDir = resolve(config.outputDir, `prototype-${Date.now()}`);

  const session = new StagehandPageSession({
    outputDir,
    headless: false,
    viewport: config.viewport,
    verbose: 1,
  });
  const planner = new LlmPlanner();
  // The Director and BlockerPrelude share an LlmFastDecider implementation
  // (same model, same OpenRouter endpoint). Each constructs its own instance
  // so latency stats from the prelude don't pollute the Director's report.
  const director = new StreamingDirector({ decider: new LlmFastDecider() });
  const blockerPrelude = new BlockerPrelude({ decider: new LlmFastDecider() });
  // Pre-fire decider — separate instance again, but the LLM call it makes
  // becomes Decision 1 inside the Director, replacing the cold-start.
  const preFireDecider = new LlmFastDecider();

  const runner = new RecordJobRunner(
    session,
    planner,
    director,
    blockerPrelude,
    preFireDecider,
  );

  try {
    const result = await runner.run({
      url: TARGET_URL,
      prompt: USER_PROMPT,
      durationMs: DURATION_MS,
      outputDir,
    });

    log.info({ metrics: result.metrics }, '📊 RUN METRICS');
    log.info({ directorReport: result.directorReport }, '🎬 DIRECTOR REPORT');
    if (result.metrics.blockerPrelude) {
      log.info({ blockerPrelude: result.metrics.blockerPrelude }, '🚧 BLOCKER PRELUDE');
    }
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
