import { describe, expect, it } from 'vitest';
import { PerformanceSchema, PerformanceStepSchema } from '../../../src/domain/performance.js';

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
