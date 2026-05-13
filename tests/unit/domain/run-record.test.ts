import { describe, expect, it } from 'vitest';

import {
  RUN_RECORD_SCHEMA_VERSION,
  RunMetricsSchema,
  RunRecordSchema,
  RunRequestSchema,
} from '../../../src/domain/run-record.js';

const validRequest = {
  url: 'https://example.com/page',
  prompt: 'click X then scroll',
  durationMs: 10_000,
  viewport: { width: 1280, height: 720 },
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

  it('rejects an invalid request.url', () => {
    expect(() => RunRecordSchema.parse({
      ...validRecord,
      request: { ...validRequest, url: 'not a url' },
    })).toThrow();
  });
});

describe('RunRequestSchema — headless is optional', () => {
  it('accepts request without headless', () => {
    expect(RunRequestSchema.parse(validRequest).headless).toBeUndefined();
  });
  it('accepts request with headless: true', () => {
    expect(RunRequestSchema.parse({ ...validRequest, headless: true }).headless).toBe(true);
  });
  it('rejects headless of the wrong type', () => {
    expect(() => RunRequestSchema.parse({ ...validRequest, headless: 'yes' })).toThrow();
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
