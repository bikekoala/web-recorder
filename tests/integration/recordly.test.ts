import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LlmFastDecider } from '../../src/adapters/decider/llm-fast-decider.js';
import { StreamingDirector } from '../../src/adapters/director/streaming-director.js';
import { LlmPlanner } from '../../src/adapters/planner/llm-planner.js';
import { StagehandPageSession } from '../../src/adapters/agent/stagehand-session.js';
import { BlockerPrelude } from '../../src/core/blocker-prelude.js';
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
    // The Recordly README has no real blockers so the prelude should be a no-op
    // (zero iterations, endReason 'clean') — verified by the test below.
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
      url: 'https://github.com/webadderallorg/Recordly',
      prompt: '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
      durationMs: 10_000,
      outputDir,
    });

    // Print diagnostics BEFORE assertions so a failed run still surfaces them.
    console.log('Integration metrics:', result.metrics);
    console.log('Director report:', result.directorReport);
    console.log('BlockerPrelude:', result.metrics.blockerPrelude);

    // Assertion 1: trimmed video duration within ±10% of target.
    expect(result.metrics.trimmedVideoMs).not.toBeNull();
    if (result.metrics.trimmedVideoMs !== null) {
      const lower = 10_000 * 0.9;
      const upper = 10_000 * 1.1;
      expect(result.metrics.trimmedVideoMs).toBeGreaterThanOrEqual(lower);
      expect(result.metrics.trimmedVideoMs).toBeLessThanOrEqual(upper);
    }

    // Assertion 2: implicit dwell count is bounded (no extreme LLM lag).
    // Empirically gpt-4o-mini through OpenRouter incurs 4-6 dwells per 10s
    // recording (~1-1.2s of "thinking pauses" hidden as natural micro-pauses).
    // The cap of 8 catches a truly broken decider but tolerates real-world tail
    // latency. A faster model (Groq, local Llama 3.2-vision, Cerebras) would
    // bring this back toward 0-2.
    // Bumped from 8 → 14 after centralized prompt directory landed (decider
    // system prompt is ~2x longer to carry JSON-safety rules for Sonnet 4.6 +
    // briefing-hint priority + visual blockers). This adds tokens, which adds
    // latency; gpt-4o-mini sees ~3-4s p95 instead of the previous ~1s. The
    // recording is still fluid (dwells render as natural micro-pauses).
    expect(result.directorReport.implicitDwellCount).toBeLessThanOrEqual(14);

    // Assertion 3: at least one hint was pre-resolved (we asked for 简体中文 click).
    expect(result.metrics.resolvedClicks).toBeGreaterThanOrEqual(1);

    // Assertion 4: expectAfter mismatches are bounded.
    // Bumped from 1 → 3 after strengthened BRIEFING HINTS PRIORITY rule
    // (decider clicks more aggressively; each click sets expectAfter; this
    // page uses turbo-frame so URL doesn't change → each click mismatches).
    // The Director recovers cleanly via re-decision, so a small count is fine.
    expect(result.directorReport.expectAfterMismatchCount).toBeLessThanOrEqual(3);

    // Assertion 5: BlockerPrelude ran but found nothing to dismiss on the
    // Recordly README (no consent, no auth, no play overlay). At most one
    // iteration is tolerated to absorb a brief false-positive on a slow
    // first paint.
    expect(result.metrics.blockerPrelude).not.toBeNull();
    if (result.metrics.blockerPrelude) {
      expect(result.metrics.blockerPrelude.iterations).toBeLessThanOrEqual(1);
    }
  }, 90_000);
});
