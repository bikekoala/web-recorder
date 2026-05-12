import { describe, expect, it } from 'vitest';
import { ReconDraftSchema, ReconDraftStepSchema, ReconvergeDraftSchema } from '../../../src/domain/recon-draft.js';
import { PerformanceStepSchema } from '../../../src/domain/performance.js';

const clickDraft = { kind: 'click' as const, ref: 'e7', anticipationMs: 600, reasoning: 'user asked', expectAfter: { urlContains: '/login' } };
const typeDraft = { kind: 'type' as const, ref: 'e11', text: 'cats', preMs: 300, keystrokeMs: 90, reasoning: 'search' };
const scrollStep = { kind: 'scroll' as const, deltaPx: 600, durationMs: 1800, easing: 'inOutQuad' as const, dwellAfterMs: 200, reasoning: 'browse' };
const keyStep = { kind: 'key' as const, key: 'Enter' as const, reasoning: 'submit' };
const dwellStep = { kind: 'dwell' as const, durationMs: 2400, reasoning: 'reading' };
const backStep = { kind: 'back' as const, reasoning: 'return' };
const doneStep = { kind: 'done' as const, reasoning: 'all done' };

const validDraft = {
  prompt: 'sign in then read',
  steps: [dwellStep, clickDraft, scrollStep, doneStep],
  totalEstimatedMs: 9800,
  rationale: 'sign-in is in view',
};

describe('ReconDraft schema', () => {
  it('accepts a well-formed draft', () => {
    expect(ReconDraftSchema.parse(validDraft)).toMatchObject({ steps: expect.any(Array) });
  });
  it('accepts each draft step kind', () => {
    for (const s of [clickDraft, typeDraft, scrollStep, keyStep, dwellStep, backStep, doneStep]) {
      expect(ReconDraftStepSchema.parse(s)).toBeTruthy();
    }
  });
  it('rejects a click step with no ref', () => {
    expect(() => ReconDraftStepSchema.parse({ kind: 'click', anticipationMs: 600, reasoning: 'x' })).toThrow();
  });
  it('rejects a type step with no ref', () => {
    expect(() => ReconDraftStepSchema.parse({ kind: 'type', text: 'x', preMs: 0, keystrokeMs: 0, reasoning: 'x' })).toThrow();
  });
  it('rejects negative durations', () => {
    expect(() => ReconDraftStepSchema.parse({ ...dwellStep, durationMs: -1 })).toThrow();
  });
  it('strips a stray `target` field on a click draft step (draft targets are refs, not ResolvedTargets)', () => {
    const parsed = ReconDraftStepSchema.parse({ ...clickDraft, target: { selector: 's', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'd' } }) as Record<string, unknown>;
    expect(parsed.ref).toBe('e7');
    expect(parsed.target).toBeUndefined();
  });
  it('rejects a draft with an empty steps array', () => {
    expect(() => ReconDraftSchema.parse({ ...validDraft, steps: [] })).toThrow();
  });
  it('scroll/key/dwell/back/done parse identically under ReconDraftStepSchema and PerformanceStepSchema', () => {
    for (const s of [scrollStep, keyStep, dwellStep, backStep, doneStep]) {
      expect(ReconDraftStepSchema.parse(s)).toEqual(PerformanceStepSchema.parse(s));
    }
  });
});

describe('ReconvergeDraft schema', () => {
  it('accepts a bare { steps } object', () => {
    expect(ReconvergeDraftSchema.parse({ steps: [clickDraft, doneStep] }).steps).toHaveLength(2);
  });
  it('rejects { steps: [] }', () => {
    expect(() => ReconvergeDraftSchema.parse({ steps: [] })).toThrow();
  });
  it('rejects a non-object / missing steps', () => {
    expect(() => ReconvergeDraftSchema.parse({})).toThrow();
    expect(() => ReconvergeDraftSchema.parse('nope')).toThrow();
  });
});
