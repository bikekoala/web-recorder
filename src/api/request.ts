/**
 * HTTP request / response schemas. Everything crossing the wire is Zod-parsed
 * (Hard Rule 2) so malformed input never reaches RecordJobRunner.
 *
 * Design notes (per the v1 API spec discussion):
 *   - No `url` field. The URL is THE prompt input — the runner's
 *     IUrlResolver picks it (explicit URL inline, well-known name, or
 *     intent-only → search engine). AI-first, goals.md #6.
 *   - No `headless` field. The HTTP service hard-codes `headless: true`
 *     server-side; the manual prototype script hard-codes `headless: false`.
 *     Behavior follows the entry point, not the request.
 *   - `width` × `height` default to config.viewport (1280×720).
 *   - `format` defaults to `mp4` for the H.264 + AAC pipeline; `webm` is
 *     accepted as the raw-passthrough escape hatch.
 *   - `crf` (H.264 constant-rate factor; lower = better quality, bigger file)
 *     defaults to 18 (visually lossless). Range 0–51. Ignored when format is
 *     `webm` (Playwright's recordVideo is fixed-quality VP8/9).
 *   - `audio` defaults to false. v1 returns 501 NOT_IMPLEMENTED when set to
 *     true — Playwright's recordVideo has no audio track support and the
 *     ffmpeg-based recorder stack is a follow-up sub-project. See ADR §0043.
 */

import { z } from 'zod';

import { config } from '../infra/config.js';

export const RecordingFormatSchema = z.enum(['mp4', 'webm']);
export type RecordingFormat = z.infer<typeof RecordingFormatSchema>;

/**
 * Coarse device class. Sites serve different HTML/CSS for mobile than for
 * desktop, so this is a first-class request parameter, not a server-side
 * tunable. The session adapter maps each kind to a Playwright `devices[…]`
 * preset (viewport + UA + isMobile/hasTouch/scaleFactor); UA strings come
 * from Playwright's auto-maintained table.
 */
export const DeviceKindSchema = z.enum(['desktop', 'mobile', 'tablet']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const RecordRequestSchema = z.object({
  /**
   * Free-form recording instruction. Must be non-empty. The URL the recording
   * starts at is resolved from this by the LlmUrlResolver — explicit URL inline,
   * well-known site name, or pure intent ("搜一下 X") all work.
   */
  prompt: z.string().min(1).max(2000),
  /** Target recording duration in ms. ±10% is the project's goal (goals.md #2). */
  durationMs: z.number().int().min(1000).max(config.maxRecordingDurationMs),
  /**
   * Viewport width in CSS pixels. Defaults to config.viewport.width.
   * Honoured only when `device === 'desktop'` — mobile/tablet inherit their
   * preset's viewport so the emulation is internally consistent.
   */
  width: z.number().int().min(320).max(3840).default(config.viewport.width),
  /** Viewport height in CSS pixels. Desktop-only; see `width`. */
  height: z.number().int().min(240).max(2160).default(config.viewport.height),
  /**
   * Coarse device class — desktop / mobile / tablet. Default `desktop`.
   * Selects the UA + isMobile + hasTouch + deviceScaleFactor (and viewport,
   * for non-desktop) the browser emulates. Sites with responsive variants
   * render their mobile HTML when this is `mobile`.
   */
  device: DeviceKindSchema.default('desktop'),
  /** Output container/codec. mp4 (H.264) by default for the clearer-than-webm + audio path. */
  format: RecordingFormatSchema.default('mp4'),
  /** H.264 CRF (constant-rate factor): 0=lossless, 18≈visually lossless, 23=default, 28+=fuzzy. */
  crf: z.number().int().min(0).max(51).default(18),
  /** Record system audio. v1 returns 501 NOT_IMPLEMENTED — tracked under ADR §0043. */
  audio: z.boolean().default(false),
});
export type RecordRequest = z.infer<typeof RecordRequestSchema>;

/** State of one recording job. */
export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Body of GET /api/v1/recordings/:runId. */
export const JobStateSchema = z.object({
  runId: z.string().min(1),
  status: JobStatusSchema,
  request: RecordRequestSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** Pointer the client can GET as soon as the job exists. */
  statusUrl: z.string().min(1),
  /** Pointer the client can GET when status === 'succeeded'. */
  videoUrl: z.string().min(1).optional(),
  /** Same for the structured run record. */
  runJsonUrl: z.string().min(1).optional(),
  /** Present on `succeeded`. */
  result: z.object({
    runDir: z.string().min(1),
    runJsonPath: z.string().min(1),
    videoPath: z.string().min(1),
    videoUrl: z.string().min(1),
    runJsonUrl: z.string().min(1),
    /** AI-resolved starting URL + the one-line LLM rationale. (Resolver model id is in run.json.) */
    urlResolution: z.object({
      url: z.string().url(),
      reasoning: z.string().min(1),
    }),
  }).optional(),
  /** Present on `failed` — error message + code (DomainError.code where applicable). */
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
});
export type JobState = z.infer<typeof JobStateSchema>;
