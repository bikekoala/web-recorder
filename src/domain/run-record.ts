import { z } from 'zod';

import { PerformanceSchema } from './performance.js';

/**
 * The structured record of a single recording run — persisted as `run.json`
 * next to `recording.webm` and `action-log.json` in the run's output dir.
 *
 * Schema-first (CLAUDE.md hard rule #2): `run.json` crosses the
 * file-system boundary, so it has a Zod schema and is parsed before use.
 *
 * Why this file exists at all: every recording produces (a) what the user
 * asked for, (b) what A planned and why, (c) what actually played, (d) how
 * it was measured. Today those four pieces live in disparate places (stdout
 * logs, the in-memory `RunResult`, the action log, and nothing). `run.json`
 * is the canonical entry point a human or a future AI session opens to
 * answer "what was this run, and how did it go?" — see docs/output-layout.md.
 *
 * Conventions:
 *  - `request` is the job's *input* (what the user asked).
 *  - `performance` is A's *resolved plan* (the same shape the Director
 *     played; includes rationale + per-step reasoning + rehearsal trace +
 *     planDurationFit + unresolvedTargets + blockerDismissal).
 *  - `metrics` is what the runner *measured* (the existing `RunMetrics`).
 *  - `directorReport` is what the Director *did* (terminal reason etc.).
 *  - `config` is a snapshot of public tunables, for repro — secrets
 *     (`openrouterApiKey`) are excluded by the writer, not the schema.
 *  - `schemaVersion` lets future tools detect old records.
 *
 * Round-trip safety: every field is independently parseable, so a degraded
 * file (e.g. truncated metrics) can be partly recovered.
 */

export const RUN_RECORD_SCHEMA_VERSION = 1 as const;

export const RunRequestSchema = z.object({
  url: z.string().url(),
  prompt: z.string().min(1),
  durationMs: z.number().int().positive(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  /**
   * Optional — passed through from the run request when known. Some callers
   * (smoke tests, fakes) don't construct via the headless code path, so this
   * is `.optional()`. When known it's helpful for "the video looked weird,
   * was this a headed run?" post-hoc questions.
   */
  headless: z.boolean().optional(),
});
export type RunRequestRecord = z.infer<typeof RunRequestSchema>;

export const IntentSatisfactionSchema = z.object({
  hintsResolvedPreRecording: z.number().int().nonnegative(),
  clicksExecuted: z.number().int().nonnegative(),
  scrollsExecuted: z.number().int().nonnegative(),
  level: z.enum(['complete', 'partial', 'unmet', 'unknown']),
  note: z.string(),
});
export type IntentSatisfactionRecord = z.infer<typeof IntentSatisfactionSchema>;

export const RunMetricsSchema = z.object({
  totalWallClockMs: z.number().int().nonnegative(),
  setupMs: z.number().int().nonnegative(),
  reconMs: z.number().int().nonnegative(),
  recordingMs: z.number().int().nonnegative(),
  trimMs: z.number().int().nonnegative(),
  rawVideoMs: z.number().nullable(),
  trimmedVideoMs: z.number().nullable(),
  plannedSteps: z.number().int().nonnegative(),
  replanCount: z.number().int().nonnegative(),
  intentSatisfaction: IntentSatisfactionSchema,
  // The three pulled-up Performance fields — kept null when the producer
  // didn't emit one (e.g. `reconRehearse: false` ⇒ rehearsal: null).
  rehearsal: z.union([
    z.object({
      walkedSteps: z.number().int().nonnegative(),
      divergences: z.number().int().nonnegative(),
      reconverges: z.number().int().nonnegative(),
      truncated: z.boolean(),
      timedOut: z.boolean(),
    }),
    z.null(),
  ]),
  blockerDismissal: z.union([
    z.object({
      rounds: z.number().int().nonnegative(),
      dismissed: z.array(z.string()),
      stillBlocked: z.boolean(),
    }),
    z.null(),
  ]),
  unresolvedTargets: z.array(z.string()),
  planDurationFit: z.object({
    estimatedMs: z.number().int().nonnegative(),
    targetMs: z.number().int().nonnegative(),
    ratio: z.number(),
    status: z.enum(['ok', 'compressed-hard', 'underfilled']),
  }).optional(),
  // F2 cost-tracking. See src/domain/performance.ts ReconLlmUsageSchema.
  reconLlm: z.object({
    model: z.string().min(1),
    calls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }).optional(),
});
export type RunMetricsRecord = z.infer<typeof RunMetricsSchema>;

export const DirectorReportSchema = z.object({
  totalMs: z.number().int().nonnegative(),
  stepsExecuted: z.number().int().nonnegative(),
  replanCount: z.number().int().nonnegative(),
  endReason: z.enum(['done', 'budget', 'error']),
});
export type DirectorReportRecord = z.infer<typeof DirectorReportSchema>;

export const RunTimingsSchema = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
});
export type RunTimingsRecord = z.infer<typeof RunTimingsSchema>;

/**
 * Public config snapshot for repro. Intentionally permissive — the writer
 * dumps every config field except a hard-coded redaction list (apiKey).
 * Schema is `Record<string, unknown>` so adding a new config knob doesn't
 * require a schema change here; if downstream tooling wants typed access
 * to a specific knob, it casts the relevant field. Keeps `run.json`
 * forward-compatible.
 */
export const RunConfigSnapshotSchema = z.record(z.unknown());
export type RunConfigSnapshot = z.infer<typeof RunConfigSnapshotSchema>;

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(RUN_RECORD_SCHEMA_VERSION),
  request: RunRequestSchema,
  performance: PerformanceSchema,
  metrics: RunMetricsSchema,
  directorReport: DirectorReportSchema,
  config: RunConfigSnapshotSchema,
  timings: RunTimingsSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
