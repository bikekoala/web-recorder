/**
 * Standalone test for IPlanner — no recording, no execution.
 *
 * Pipeline:
 *   1. Launch browser, navigate, wait for visual stability.
 *   2. Take a screenshot.
 *   3. observeAll() to collect candidate elements.
 *   4. Call LlmPlanner.plan() with (url, prompt, duration, screenshot, candidates).
 *   5. Print the plan.
 *
 * Goal: prove that the planner produces a reasonable timeline for the
 * Recordly scenario before we wire it into the full runner.
 */

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmPlanner } from '../src/adapters/planner/llm-planner.js';
import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';

const TARGET_URL = 'https://github.com/webadderallorg/Recordly';
const USER_PROMPT = '点击简体中文链接，然后慢慢滑动';
const DURATION_MS = 10_000;

async function main(): Promise<void> {
  const log = logger.child({ script: 'test-planner' });

  const session = new StagehandPageSession({
    outputDir: 'output/test-planner',
    headless: false,
    viewport: config.viewport,
    verbose: 1,
  });

  await session.start();
  try {
    log.info({ url: TARGET_URL }, 'navigating');
    const tNav = Date.now();
    await session.goto(TARGET_URL);
    await session.waitForVisualStability({ quietMs: 400, maxMs: 3000 });
    log.info({ elapsedMs: Date.now() - tNav }, 'page is visually stable');

    log.info('capturing context for the planner...');
    const tCap = Date.now();
    const [screenshot, candidates] = await Promise.all([
      session.screenshot(),
      session.observeAll(),
    ]);
    log.info(
      { elapsedMs: Date.now() - tCap, candidateCount: candidates.length, screenshotBytes: screenshot.length },
      'context captured',
    );
    log.info({ candidates: candidates.slice(0, 10).map((c) => c.description) }, 'top candidates');

    log.info({ model: config.llmModel, prompt: USER_PROMPT }, 'calling planner');
    const planner = new LlmPlanner();
    const tPlan = Date.now();
    const plan = await planner.plan(
      {
        url: TARGET_URL,
        prompt: USER_PROMPT,
        durationMs: DURATION_MS,
        viewport: config.viewport,
        candidates: candidates.map((c) => ({
          description: c.description,
          ...(c.selector ? { selectorHint: c.selector } : {}),
        })),
      },
      screenshot,
    );
    log.info({ elapsedMs: Date.now() - tPlan }, 'plan returned');

    // Pretty-print the plan
    log.info('📋 PLAN:');
    log.info({ targetDurationMs: plan.targetDurationMs, notes: plan.notes });
    plan.steps.forEach((s, i) => {
      log.info({ step: i + 1, ...s }, '  step');
    });

    const totalMs = plan.steps.reduce((acc, s) => {
      switch (s.type) {
        case 'scroll': return acc + s.durationMs;
        case 'click':  return acc + s.durationMs;
        case 'wait':   return acc + s.durationMs;
        case 'stable': return acc + s.maxMs / 2; // expected, not max
      }
    }, 0);
    log.info({ summedDurationMs: totalMs, targetDurationMs: plan.targetDurationMs }, '⏱ duration check');
  } finally {
    await session.stop();
  }
}

main().catch((err) => {
  logger.error(
    {
      err: err instanceof Error
        ? { name: err.name, message: err.message, code: (err as { code?: string }).code }
        : err,
    },
    '❌ planner test failed',
  );
  process.exit(1);
});
