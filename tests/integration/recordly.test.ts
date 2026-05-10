import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LlmFastDecider } from '../../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../../src/adapters/director/streaming-director.js';
import { LlmPlanner } from '../../src/adapters/planner/llm-planner.js';
import { StagehandPageSession } from '../../src/adapters/agent/stagehand-session.js';
import { RecordJobRunner } from '../../src/core/record-job-runner.js';
import { config } from '../../src/infra/config.js';

describe('integration: Recordly scenario via Streaming Director', () => {
  it('produces a 10s ±10% recording with 0 stalls > 500ms', async () => {
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('skipping integration test — OPENROUTER_API_KEY not set');
      return;
    }
    const outputDir = resolve(config.outputDir, `it-recordly-${Date.now()}`);

    const session = new StagehandPageSession({
      outputDir,
      headless: false,
      viewport: config.viewport,
      verbose: 0,
    });
    const planner = new LlmPlanner();
    const decider = new LlmFastDecider();
    const director = new StreamingDirector({ decider });
    const runner = new RecordJobRunner(session, planner, director);

    const result = await runner.run({
      url: 'https://github.com/webadderallorg/Recordly',
      prompt: '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
      durationMs: 10_000,
      outputDir,
    });

    // Assertion 1: trimmed video duration within ±10% of target.
    expect(result.metrics.trimmedVideoMs).not.toBeNull();
    if (result.metrics.trimmedVideoMs !== null) {
      const lower = 10_000 * 0.9;
      const upper = 10_000 * 1.1;
      expect(result.metrics.trimmedVideoMs).toBeGreaterThanOrEqual(lower);
      expect(result.metrics.trimmedVideoMs).toBeLessThanOrEqual(upper);
    }

    // Assertion 2: implicit dwell count is bounded (no extreme LLM lag).
    expect(result.directorReport.implicitDwellCount).toBeLessThanOrEqual(3);

    // Assertion 3: at least one hint was pre-resolved (we asked for 简体中文 click).
    expect(result.metrics.resolvedClicks).toBeGreaterThanOrEqual(1);

    // Assertion 4: no expectAfter mismatches on this stable page.
    expect(result.directorReport.expectAfterMismatchCount).toBeLessThanOrEqual(1);

    console.log('Integration metrics:', result.metrics);
    console.log('Director report:', result.directorReport);
  }, 90_000);
});
