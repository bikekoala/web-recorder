import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LlmFastDecider } from '../../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../../src/adapters/director/streaming-director.js';
import { LlmPlanner } from '../../src/adapters/planner/llm-planner.js';
import { StagehandPageSession } from '../../src/adapters/agent/stagehand-session.js';
import { BlockerPrelude } from '../../src/core/blocker-prelude.js';
import { RecordJobRunner } from '../../src/core/record-job-runner.js';
import { config } from '../../src/infra/config.js';
import { REGRESSION_CASES } from './cases.js';

/**
 * Regression suite — vitest's red/green output IS the report.
 *
 * Each case is a self-contained `(URL, prompt, durationMs)` exercising a
 * different axis of the pipeline. The mechanical assertions only check
 * metric ranges; per-case `coverageNotes` in `cases.ts` document WHY.
 *
 * Per-case timeout 120s = ~50s setup + ≤30s recording + headroom.
 * Suite total bound by `vitest.regression.config.ts` testTimeout.
 *
 * Tests run SEQUENTIALLY (vitest default) — parallel would launch 4 browsers,
 * which is not what we want.
 */
describe('regression suite', () => {
  for (const c of REGRESSION_CASES) {
    it(`[${c.id}] ${c.description}`, async () => {
      if (!process.env.OPENROUTER_API_KEY) {
        console.warn(`skipping ${c.id} — OPENROUTER_API_KEY not set`);
        return;
      }
      const outputDir = resolve(config.outputDir, `regression-${c.id}-${Date.now()}`);
      const session = new StagehandPageSession({
        outputDir,
        headless: false,
        viewport: config.viewport,
        verbose: 0,
      });
      const planner = new LlmPlanner();
      const director = new StreamingDirector({ decider: new LlmFastDecider() });
      const blockerPrelude = new BlockerPrelude({ decider: new LlmFastDecider() });
      const preFireDecider = new LlmFastDecider();
      const runner = new RecordJobRunner(
        session,
        planner,
        director,
        blockerPrelude,
        preFireDecider,
      );

      const result = await runner.run({
        url: c.url,
        prompt: c.prompt,
        durationMs: c.durationMs,
        outputDir,
      });

      // Print BEFORE assertions so failures show metrics.
      console.log(`\n=== [${c.id}] ===`);
      console.log('  description:', c.description);
      console.log('  metrics:', JSON.stringify(result.metrics, null, 2));
      console.log('  director:', JSON.stringify(result.directorReport, null, 2));

      // Mechanical assertions — keep messages descriptive.
      expect(
        result.metrics.trimmedVideoMs,
        `${c.id}: trimmed duration`,
      ).toBeGreaterThanOrEqual(c.expect.trimmedVideoMsMin);
      expect(
        result.metrics.trimmedVideoMs,
        `${c.id}: trimmed duration`,
      ).toBeLessThanOrEqual(c.expect.trimmedVideoMsMax);
      expect(
        result.directorReport.implicitDwellCount,
        `${c.id}: implicit dwells`,
      ).toBeLessThanOrEqual(c.expect.implicitDwellMax);
      expect(
        result.directorReport.expectAfterMismatchCount,
        `${c.id}: expectAfter mismatches`,
      ).toBeLessThanOrEqual(c.expect.expectAfterMismatchMax);
      expect(
        result.metrics.resolvedClicks,
        `${c.id}: resolved click hints`,
      ).toBeGreaterThanOrEqual(c.expect.resolvedClicksMin);
      if (c.expect.acceptableIntentLevels.length > 0) {
        expect(
          c.expect.acceptableIntentLevels,
          `${c.id}: intent level`,
        ).toContain(result.metrics.intentSatisfaction.level);
      }
    }, 120_000);
  }
});
