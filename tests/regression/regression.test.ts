import { describe, expect, it } from 'vitest';

import { StagehandPageSession } from '../../src/adapters/agent/stagehand-session.js';
import { PerformanceDirector } from '../../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../../src/adapters/recon/llm-reconnoiterer.js';
import { RecordJobRunner } from '../../src/core/record-job-runner.js';
import { config } from '../../src/infra/config.js';
import { buildRunDir } from '../../src/infra/run-dir.js';
import { REGRESSION_CASES } from './cases.js';

/**
 * Regression suite — vitest's red/green output IS the report; the videos
 * the runs produce are the GROUND TRUTH for naturalness.
 *
 * Pipeline under test: the "prophet" pipeline (ADR §0034) —
 * `LlmReconnoiterer.recon()` → paced `Performance` → `PerformanceDirector`
 * (deterministic playback + at-most-N re-plan checkpoints).
 *
 * Per `docs/goals.md` Hard rule #6 (AI-first, not magic-numbers): we do NOT
 * assert on dwell counts, re-plan counts, or any other numeric threshold
 * that drifts when models change. We assert only that:
 *   - The pipeline did not crash.
 *   - A non-trivial recording was produced.
 *   - `intentSatisfaction` was computed (the value can be ANY level — we
 *     log it, humans interpret it).
 *   - The Director reached a terminal `endReason`.
 *
 * Naturalness is judged by opening `recording.webm` and watching it.
 *
 * Each (case × prompt) pair runs as its own `it()` so individual ones can
 * be filtered (e.g. `npx vitest -t youtube-creator-natural`).
 *
 * Per-test timeout: durationMs × 2 + 30s (covers setup + recon + recording
 * + trim + slack). Sequential by default — parallel would launch N browsers.
 */
describe('regression suite', () => {
  for (const c of REGRESSION_CASES) {
    for (const p of c.prompts) {
      const name = `[${c.id} · ${p.label}] ${c.description}`;
      const timeoutMs = c.durationMs * 2 + 30_000;

      it(name, async () => {
        if (!process.env.OPENROUTER_API_KEY) {
          console.warn(`skipping ${c.id}/${p.label} — OPENROUTER_API_KEY not set`);
          return;
        }

        const outputDir = buildRunDir({
          outputRoot: config.outputDir,
          kind: 'regression',
          sub: `${c.id}-${p.label}`,
        });

        const session = new StagehandPageSession({
          outputDir,
          headless: false,
          viewport: config.viewport,
          verbose: 0,
        });
        const reconnoiterer = new LlmReconnoiterer();
        // The PerformanceDirector reuses the reconnoiterer as its re-planner
        // at the (at most config.maxReplans) re-plan checkpoints.
        const director = new PerformanceDirector({ replanner: reconnoiterer });
        const runner = new RecordJobRunner(session, reconnoiterer, director);

        const result = await runner.run({
          url: c.url,
          prompt: p.text,
          durationMs: c.durationMs,
          outputDir,
        });

        // Always print full diagnostics — videos + metrics are the report.
        console.log(`\n══ [${c.id} · ${p.label}] ════════════════════════`);
        console.log(`  prompt:       ${p.text}`);
        console.log(`  url:          ${c.url}`);
        console.log(`  video:        ${result.videoPath}`);
        console.log(`  rawVideo:     ${result.rawVideoPath}`);
        console.log(`  log:          ${result.actionLogPath}`);
        console.log(`  plannedSteps: ${result.performance.steps.length}`);
        console.log(`  replanCount:  ${result.metrics.replanCount}`);
        console.log(`  metrics:  ${JSON.stringify(result.metrics, null, 2)}`);
        console.log(`  director: ${JSON.stringify(result.directorReport, null, 2)}`);

        // Categorical assertions only — see Hard rule #6 in docs/goals.md.
        // These say "the pipeline functioned"; they say nothing about quality.
        // Quality = humans reviewing the videos.
        expect(result.videoPath, 'video path produced').toBeTruthy();
        expect(
          result.metrics.trimmedVideoMs,
          'trimmed video has non-zero duration',
        ).toBeGreaterThan(0);
        expect(
          result.metrics.intentSatisfaction.level,
          'intentSatisfaction.level was computed',
        ).toMatch(/^(complete|partial|unmet|unknown)$/);
        expect(
          typeof result.metrics.replanCount,
          'replanCount is a number',
        ).toBe('number');
        expect(
          result.directorReport.endReason,
          'Director reached an endReason',
        ).toMatch(/^(done|budget|error)$/);
      }, timeoutMs);
    }
  }
});
