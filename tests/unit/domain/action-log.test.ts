import { describe, expect, it } from 'vitest';

import { ActionLog, ActionLogEntry, ActionLogEntrySchema } from '../../../src/domain/action-log.js';

const VIEWPORT = { width: 1280, height: 720 };

/**
 * ActionLogEntry has a discriminated union with non-trivial refinements
 * (Zod enum on `decision_failure.reason`, signed `decisionId`). The tests
 * below cover only the LOAD-BEARING parts — TypeScript+Zod handle shape.
 */
describe('ActionLogEntry — load-bearing refinements', () => {
  it('accepts NEGATIVE decisionId on the legacy `decision` entry', () => {
    // Regression guard: an early version declared decisionId as
    // int().nonnegative(); the streaming-era prelude used negative ids
    // (-1, -2, ...). The `decision` entry is legacy now but still parses.
    const e = ActionLogEntry.parse({
      t: 800,
      type: 'decision',
      decisionId: -1,
      modelId: 'fake',
      latencyMs: 200,
      actions: [{ kind: 'click', reasoning: 'dismiss', brief: 'click X' }],
      scrollY: 0,
      viewport: VIEWPORT,
    });
    expect(e.type).toBe('decision');
  });

  it('rejects unknown decision_failure.reason', () => {
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

  it('full ActionLog round-trips with mixed entry types', () => {
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
  });
});

describe('action-log replan entry (§0034)', () => {
  it('accepts a replan entry', () => {
    const entry = {
      t: 4200, type: 'replan' as const, fromStepIndex: 3,
      reason: 'expect_after_mismatch', details: 'expected urlContains "/build" but URL was ".../Recordly"',
      scrollY: 1500, viewport: { width: 1280, height: 720 },
    };
    expect(ActionLogEntrySchema.parse(entry)).toMatchObject({ type: 'replan' });
  });
  it('rejects a replan entry missing fromStepIndex', () => {
    const bad = { t: 1, type: 'replan', reason: 'expect_after_mismatch', details: 'y', scrollY: 0, viewport: { width: 1, height: 1 } };
    expect(() => ActionLogEntrySchema.parse(bad)).toThrow();
  });
});
