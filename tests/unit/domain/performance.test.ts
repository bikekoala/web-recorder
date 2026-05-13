import { describe, expect, it } from 'vitest';
import { PerformanceSchema, PerformanceStepSchema, RehearsalTraceSchema, BlockerDismissalReportSchema, BlockerDismissDecisionSchema } from '../../../src/domain/performance.js';

const validClickStep = {
  kind: 'click' as const,
  target: { selector: 'text=Sign in', bbox: { x: 10, y: 20, width: 80, height: 30 }, description: 'the sign-in link' },
  anticipationMs: 600,
  reasoning: 'user asked to sign in',
  expectAfter: { urlContains: '/login' },
};
const validScrollStep = {
  kind: 'scroll' as const, deltaPx: 600, durationMs: 1800, easing: 'inOutQuad' as const,
  dwellAfterMs: 200, reasoning: 'browse the README',
};
const validDwellStep = { kind: 'dwell' as const, durationMs: 2400, reasoning: 'reading the intro' };
const validDoneStep = { kind: 'done' as const, reasoning: 'all verbs satisfied' };

const validPerformance = {
  prompt: 'sign in then read the page',
  durationMs: 10000,
  steps: [validClickStep, validDwellStep, validScrollStep, validDoneStep],
  totalEstimatedMs: 9800,
  rationale: 'sign-in is below the fold; after it lands, browse',
};

describe('Performance schema', () => {
  it('accepts a well-formed Performance', () => {
    expect(PerformanceSchema.parse(validPerformance)).toMatchObject({ steps: expect.any(Array) });
  });
  it('accepts each step kind', () => {
    for (const s of [validClickStep, validScrollStep, validDwellStep, validDoneStep]) {
      expect(PerformanceStepSchema.parse(s)).toBeTruthy();
    }
  });
  it('rejects a click step with no target', () => {
    const bad = { kind: 'click', anticipationMs: 600, reasoning: 'x' };
    expect(() => PerformanceStepSchema.parse(bad)).toThrow();
  });
  it('rejects a scroll step with a bad easing', () => {
    const bad = { ...validScrollStep, easing: 'bouncy' };
    expect(() => PerformanceStepSchema.parse(bad)).toThrow();
  });
  it('rejects negative durations', () => {
    expect(() => PerformanceStepSchema.parse({ ...validDwellStep, durationMs: -1 })).toThrow();
  });
  it('rejects a Performance with an empty steps array', () => {
    expect(() => PerformanceSchema.parse({ ...validPerformance, steps: [] })).toThrow();
  });
});

describe('RehearsalTrace + Performance.rehearsal', () => {
  it('RehearsalTraceSchema accepts a well-formed trace', () => {
    const t = { walkedSteps: 5, divergences: 1, reconverges: 1, truncated: false, timedOut: false };
    expect(RehearsalTraceSchema.parse(t)).toEqual(t);
  });
  it('Performance.rehearsal is optional — absent is valid', () => {
    const perf = { prompt: 'x', durationMs: 10000, totalEstimatedMs: 9000, rationale: 'r', steps: [{ kind: 'dwell', durationMs: 300, reasoning: 'open' }] };
    expect(PerformanceSchema.parse(perf).rehearsal).toBeUndefined();
  });
  it('Performance.rehearsal round-trips when present', () => {
    const perf = { prompt: 'x', durationMs: 10000, totalEstimatedMs: 9000, rationale: 'r', steps: [{ kind: 'dwell', durationMs: 300, reasoning: 'open' }], rehearsal: { walkedSteps: 3, divergences: 0, reconverges: 0, truncated: false, timedOut: false } };
    expect(PerformanceSchema.parse(perf).rehearsal).toEqual(perf.rehearsal);
  });
});

describe('BlockerDismissalReport + Performance.blockerDismissal', () => {
  const base = { prompt: 'p', durationMs: 1000, totalEstimatedMs: 0, rationale: 'r', steps: [{ kind: 'done', reasoning: 'x' }] };
  it('round-trips a report', () => {
    const r = { rounds: 2, dismissed: ['Accept all cookies', 'Close newsletter modal'], stillBlocked: false };
    expect(BlockerDismissalReportSchema.parse(r)).toEqual(r);
  });
  it('rejects a negative round count', () => {
    expect(() => BlockerDismissalReportSchema.parse({ rounds: -1, dismissed: [], stillBlocked: true })).toThrow();
  });
  it('Performance.blockerDismissal is optional — absent is valid', () => {
    expect(PerformanceSchema.parse(base).blockerDismissal).toBeUndefined();
  });
  it('Performance.blockerDismissal round-trips when present', () => {
    const perf = { ...base, blockerDismissal: { rounds: 1, dismissed: ['Accept all'], stillBlocked: false } };
    expect(PerformanceSchema.parse(perf).blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all'], stillBlocked: false });
  });
});

describe('BlockerDismissDecisionSchema', () => {
  it('accepts a "blocker, dismiss this" decision and ignores extra fields', () => {
    const d = BlockerDismissDecisionSchema.parse({ blocker: true, dismissTargetDescription: 'Accept all cookies', rationale: 'GDPR banner at the bottom' });
    expect(d.blocker).toBe(true);
    expect(d.dismissTargetDescription).toBe('Accept all cookies');
  });
  it('accepts a "no blocker" decision with no target', () => {
    expect(BlockerDismissDecisionSchema.parse({ blocker: false }).blocker).toBe(false);
  });
  it('rejects a non-boolean blocker / empty target string', () => {
    expect(() => BlockerDismissDecisionSchema.parse({ blocker: 'yes' })).toThrow();
    expect(() => BlockerDismissDecisionSchema.parse({ blocker: true, dismissTargetDescription: '' })).toThrow();
  });
});

describe('PerformanceSchema.planDurationFit', () => {
  const basePerf = {
    prompt: 'click X',
    durationMs: 10000,
    steps: [{ kind: 'dwell' as const, durationMs: 1000, reasoning: 'r' }],
    totalEstimatedMs: 1280,
    rationale: 'r',
  };

  it('accepts a Performance with planDurationFit { ok }', () => {
    const out = PerformanceSchema.parse({
      ...basePerf,
      planDurationFit: { estimatedMs: 1280, targetMs: 10000, ratio: 0.128, status: 'ok' },
    });
    expect(out.planDurationFit?.status).toBe('ok');
  });

  it('accepts each of `ok` / `compressed-hard` / `underfilled` status values', () => {
    for (const status of ['ok', 'compressed-hard', 'underfilled'] as const) {
      expect(() => PerformanceSchema.parse({
        ...basePerf,
        planDurationFit: { estimatedMs: 1, targetMs: 1, ratio: 1, status },
      })).not.toThrow();
    }
  });

  it('rejects an unknown status', () => {
    expect(() => PerformanceSchema.parse({
      ...basePerf,
      planDurationFit: { estimatedMs: 1, targetMs: 1, ratio: 1, status: 'padded' as unknown as 'ok' },
    })).toThrow();
  });

  it('omitting planDurationFit is fine (optional)', () => {
    expect(() => PerformanceSchema.parse(basePerf)).not.toThrow();
  });
});
