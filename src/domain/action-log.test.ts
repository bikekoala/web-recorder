import { describe, expect, it } from 'vitest';

import { ActionLog, ActionLogEntry } from './action-log.js';

const VIEWPORT = { width: 1280, height: 720 };

describe('ActionLogEntry — introspection variants', () => {
  it('parses a `decision` entry round-trip', () => {
    const e = ActionLogEntry.parse({
      t: 1500,
      type: 'decision',
      decisionId: 1,
      modelId: 'openai/gpt-4o-mini',
      latencyMs: 920,
      actions: [
        { kind: 'click', reasoning: 'user asked', brief: 'click 简体中文' },
        { kind: 'scroll', reasoning: 'browse', brief: 'scroll +300 slow' },
      ],
      expectAfter: { urlContains: 'zh-CN' },
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(e.type).toBe('decision');
    if (e.type !== 'decision') throw new Error('narrowing failed');
    expect(e.actions).toHaveLength(2);
    expect(e.actions[0]!.kind).toBe('click');
    expect(e.expectAfter?.urlContains).toBe('zh-CN');
  });

  it('accepts NEGATIVE decisionId (BlockerPrelude phase, see §0021)', () => {
    // Regression guard: an early version of the schema declared decisionId
    // as `int().nonnegative()`, which conflicted with §0021's design where
    // BlockerPrelude uses negative ids (-1, -2, ...) to mark prelude-phase
    // decisions. ActionLog.parse() then crashed at session.stop() whenever
    // the prelude actually fired (e.g. on YouTube watch URLs). The fix is
    // here in the schema — negative ids are valid; this test locks it in.
    const e = ActionLogEntry.parse({
      t: 800,
      type: 'decision',
      decisionId: -1,
      modelId: 'fake',
      latencyMs: 200,
      actions: [{ kind: 'click', reasoning: 'dismiss banner', brief: 'click X' }],
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(e.type).toBe('decision');
    if (e.type !== 'decision') throw new Error('narrowing');
    expect(e.decisionId).toBe(-1);

    const f = ActionLogEntry.parse({
      t: 850,
      type: 'decision_failure',
      decisionId: -2,
      reason: 'click_failed',
      details: 'prelude bail',
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(f.type).toBe('decision_failure');
  });

  it('rejects a `decision` with empty actions array? actions array allows empty for now', () => {
    // Schema allows zero-length actions for `decision` (vs DecisionResponse which
    // requires ≥1). The action log is a record of what happened — if the LLM
    // returned a malformed-but-coerced-to-empty response, that's history we
    // still want to keep.
    const e = ActionLogEntry.parse({
      t: 1500,
      type: 'decision',
      decisionId: 1,
      modelId: 'fake',
      latencyMs: 0,
      actions: [],
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(e.type).toBe('decision');
  });

  it('parses a `decision_failure` entry with each known reason', () => {
    const reasons = [
      'schema_validation',
      'expect_after_mismatch',
      'llm_call_failed',
      'click_failed',
      'budget_exceeded',
    ] as const;
    for (const reason of reasons) {
      const e = ActionLogEntry.parse({
        t: 2000,
        type: 'decision_failure',
        reason,
        details: `caused by ${reason}`,
        scrollY: 100,
        viewport: VIEWPORT,
      });
      expect(e.type).toBe('decision_failure');
      if (e.type !== 'decision_failure') throw new Error('narrowing');
      expect(e.reason).toBe(reason);
    }
  });

  it('rejects a `decision_failure` with unknown reason', () => {
    expect(() =>
      ActionLogEntry.parse({
        t: 2000,
        type: 'decision_failure',
        reason: 'nuclear_meltdown',
        details: 'oops',
        scrollY: 0,
        viewport: VIEWPORT,
      }),
    ).toThrow();
  });

  it('parses a `page_diagnostic` entry with full payload', () => {
    const e = ActionLogEntry.parse({
      t: 8000,
      type: 'page_diagnostic',
      url: 'https://example.com/foo',
      title: 'Example',
      interactiveElementCount: 42,
      visibleHeadings: ['Hello', 'World'],
      blockerSignals: ['consent_dialog', 'play_overlay'],
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(e.type).toBe('page_diagnostic');
    if (e.type !== 'page_diagnostic') throw new Error('narrowing');
    expect(e.blockerSignals).toEqual(['consent_dialog', 'play_overlay']);
    expect(e.interactiveElementCount).toBe(42);
  });

  it('full ActionLog still parses with mixed entry types', () => {
    const log = ActionLog.parse({
      version: 1,
      startedAt: new Date().toISOString(),
      durationMs: 12000,
      recording: { startedAtMs: 5000, endedAtMs: 12000 },
      entries: [
        { t: 0, type: 'goto', url: 'https://x.test/', scrollY: 0, viewport: VIEWPORT },
        { t: 5000, type: 'recording_start', scrollY: 0, viewport: VIEWPORT },
        {
          t: 5100,
          type: 'page_diagnostic',
          url: 'https://x.test/',
          title: 'Test',
          interactiveElementCount: 10,
          visibleHeadings: ['Hi'],
          blockerSignals: [],
          scrollY: 0,
          viewport: VIEWPORT,
        },
        {
          t: 6000,
          type: 'decision',
          decisionId: 1,
          modelId: 'fake/decider',
          latencyMs: 200,
          actions: [{ kind: 'done', reasoning: 'task complete', brief: 'done' }],
          scrollY: 0,
          viewport: VIEWPORT,
        },
      ],
    });
    expect(log.entries).toHaveLength(4);
    expect(log.entries[2]!.type).toBe('page_diagnostic');
  });
});
