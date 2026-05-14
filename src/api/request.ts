/**
 * HTTP request/response schemas. Everything crossing the wire is Zod-parsed
 * (Hard Rule 2) so malformed input never reaches RecordJobRunner.
 */

import { z } from 'zod';

import { config } from '../infra/config.js';

/**
 * Body of POST /record. `headless` defaults to `true` for service-mode (the
 * HTTP API targets self-hosted Linux/Docker per goals.md). Override on a per-
 * request basis only when debugging locally.
 */
export const RecordRequestSchema = z.object({
  url: z.string().url(),
  prompt: z.string().min(1).max(2000),
  durationMs: z.number().int().min(1000).max(config.maxRecordingDurationMs),
  headless: z.boolean().default(true),
});
export type RecordRequest = z.infer<typeof RecordRequestSchema>;

/** State of one recording job. Mirrors `JobStore.put/update`. */
export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Body of GET /record/:runId. Minimal — points the client at run.json / video. */
export const JobStateSchema = z.object({
  runId: z.string().min(1),
  status: JobStatusSchema,
  request: RecordRequestSchema.optional(),
  createdAt: z.string(), // ISO 8601
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** Present on `succeeded` — paths inside the run output dir. */
  result: z.object({
    runDir: z.string().min(1),
    runJsonPath: z.string().min(1),
    videoPath: z.string().min(1),
  }).optional(),
  /** Present on `failed` — error message + code (DomainError.code where applicable). */
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
});
export type JobState = z.infer<typeof JobStateSchema>;
