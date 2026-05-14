import { describe, expect, it } from 'vitest';

import {
  RUN_RECORD_SCHEMA_VERSION,
  RunMetricsSchema,
  RunRecordSchema,
  RunRequestSchema,
} from '../../../src/domain/run-record.js';

const validRequest = {
  prompt: 'click X then scroll',
  durationMs: 10_000,
  viewport: { width: 1280, height: 720 },
};

const validUrlResolution = {
  url: 'https://example.com/page',
  reasoning: 'prompt named example.com',
  model: 'anthropic/claude-haiku-4.5',
};

const validPerformance = {
  prompt: 'click X then scroll',
  durationMs: 10_000,
  rationale: 'sign-in is in view',
  totalEstimatedMs: 9500,
  steps: [{ kind: 'dwell' as const, durationMs: 1000, reasoning: 'absorb' }],
};

const validMetrics = {
  totalWallClockMs: 41_500,
  setupMs: 8000,
  reconMs: 25_000,
  recordingMs: 9500,
  trimMs: 1000,
  rawVideoMs: 12_000,
  trimmedVideoMs: 10_000,
  plannedSteps: 1,
  replanCount: 0,
  intentSatisfaction: {
    hintsResolvedPreRecording: 0,
    clicksExecuted: 0,
    scrollsExecuted: 0,
    level: 'complete' as const,
    note: 'no clicks planned, no scrolls planned',
  },
  rehearsal: null,
  blockerDismissal: null,
  unresolvedTargets: [],
};

const validRecord = {
  schemaVersion: RUN_RECORD_SCHEMA_VERSION,
  request: validRequest,
  urlResolution: validUrlResolution,
  performance: validPerformance,
  metrics: validMetrics,
  directorReport: { totalMs: 9500, stepsExecuted: 1, replanCount: 0, endReason: 'done' as const },
  config: { llmModel: 'openai/gpt-4o-mini', viewport: { width: 1280, height: 720 } },
  timings: {
    startedAt: '2026-05-13T15:00:00.000Z',
    endedAt:   '2026-05-13T15:00:42.000Z',
  },
};

describe('RunRecordSchema', () => {
  it('accepts a well-formed RunRecord', () => {
    expect(() => RunRecordSchema.parse(validRecord)).not.toThrow();
  });

  it('rejects a record with the wrong schemaVersion', () => {
    expect(() => RunRecordSchema.parse({ ...validRecord, schemaVersion: 999 })).toThrow();
  });

  it('config is opaque — any record of unknown values is accepted (forward-compat for new config knobs)', () => {
    const out = RunRecordSchema.parse({
      ...validRecord,
      config: { hugeNewKnob: { nested: ['anything'] }, anotherKnob: 42 },
    });
    expect(out.config).toEqual({ hugeNewKnob: { nested: ['anything'] }, anotherKnob: 42 });
  });

  it('rejects an invalid timings.startedAt (must be an ISO 8601 datetime)', () => {
    expect(() => RunRecordSchema.parse({
      ...validRecord,
      timings: { startedAt: 'yesterday morning', endedAt: '2026-05-13T15:00:42.000Z' },
    })).toThrow();
  });

  it('rejects an invalid urlResolution.url', () => {
    expect(() => RunRecordSchema.parse({
      ...validRecord,
      urlResolution: { ...validUrlResolution, url: 'not a url' },
    })).toThrow();
  });

  it('requires urlResolution (no longer optional in v1)', () => {
    const { urlResolution, ...withoutResolution } = validRecord;
    void urlResolution;
    expect(() => RunRecordSchema.parse(withoutResolution)).toThrow();
  });
});

describe('RunRequestSchema — prompt + durationMs + viewport only', () => {
  it('rejects a request with an empty prompt', () => {
    expect(() => RunRequestSchema.parse({ ...validRequest, prompt: '' })).toThrow();
  });
  it('rejects extra fields silently (Zod strips by default)', () => {
    const out = RunRequestSchema.parse({ ...validRequest, url: 'https://x.test', headless: true } as unknown as typeof validRequest);
    expect('url' in out).toBe(false);
    expect('headless' in out).toBe(false);
  });
});

describe('RunMetricsSchema — F1 planDurationFit is optional + nullables behave', () => {
  it('accepts metrics with planDurationFit', () => {
    const m = RunMetricsSchema.parse({
      ...validMetrics,
      planDurationFit: { estimatedMs: 9500, targetMs: 10000, ratio: 0.95, status: 'ok' },
    });
    expect(m.planDurationFit?.status).toBe('ok');
  });
  it('accepts metrics without planDurationFit (legacy fixtures)', () => {
    expect(RunMetricsSchema.parse(validMetrics).planDurationFit).toBeUndefined();
  });
  it('rejects planDurationFit with an unknown status', () => {
    expect(() => RunMetricsSchema.parse({
      ...validMetrics,
      planDurationFit: { estimatedMs: 1, targetMs: 1, ratio: 1, status: 'padded' as unknown as 'ok' },
    })).toThrow();
  });
  it('rehearsal can be null (when reconRehearse: false)', () => {
    expect(RunMetricsSchema.parse(validMetrics).rehearsal).toBeNull();
  });
  it('rehearsal accepts the full trace shape', () => {
    const m = RunMetricsSchema.parse({
      ...validMetrics,
      rehearsal: { walkedSteps: 8, divergences: 0, reconverges: 0, truncated: false, timedOut: false },
    });
    expect(m.rehearsal).not.toBeNull();
  });
});
