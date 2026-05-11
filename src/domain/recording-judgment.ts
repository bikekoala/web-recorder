import { z } from 'zod';

/**
 * Recording judgment — automated naturalness assessment of a trimmed
 * recording. Produced by an `IRecordingJudge` (typically a video-capable
 * vision LLM via OpenRouter).
 *
 * Replaces the "human watches the video and forms an opinion" step that
 * lived in our regression workflow. Per goals.md #6 (AI-first, not
 * magic-numbers): the judge emits CATEGORICAL levels per dimension and
 * one categorical overall verdict — no numeric scores. Regression tests
 * assert on these categories; humans only re-check when the judge says
 * `probably_synthetic` or `robotic`.
 *
 * Why 5 dimensions instead of one verdict: a flat "looks human or not"
 * is useless for debugging. Dimensions point at WHICH part of the run
 * was off (motion timing vs. recovery logic vs. visual coherence) so the
 * fix lives where the problem lives.
 *
 * The verdict is derived from the dimension levels by the LLM itself,
 * not by code aggregation — we want the model's holistic judgment, not
 * a brittle rule like "any fail → robotic".
 */

/**
 * Overall categorical verdict. Ordered most-natural → least-natural.
 *
 *  - looks_human         indistinguishable from a real person using the page
 *  - probably_human      mostly natural with minor tells
 *  - probably_synthetic  several clear robot-tells; a careful viewer would notice
 *  - robotic             obvious automation; teleports, uniform timing, etc.
 */
export const VerdictSchema = z.enum([
  'looks_human',
  'probably_human',
  'probably_synthetic',
  'robotic',
]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Per-dimension result: did this aspect of the recording read as human? */
export const DimensionLevelSchema = z.enum(['pass', 'partial', 'fail']);
export type DimensionLevel = z.infer<typeof DimensionLevelSchema>;

/**
 * The 5 rubric dimensions. Keep stable — every regression test that
 * asserts on a dimension reads these names. Add new dimensions via a new
 * ADR; don't quietly rename.
 *
 *  motionQuality     are scrolls eased / clicks approached / no teleports?
 *  pacing            are pauses anticipatory? does rhythm vary?
 *  intentExecution   were the verbs in the user's prompt visibly performed?
 *  recovery          when something fails, does the agent visibly switch
 *                    approach (vs. hammering the same target)?
 *  visualCoherence   does every page change have an explicit on-screen
 *                    cause? no unprompted popups / unrelated nav?
 */
export const DimensionKeySchema = z.enum([
  'motionQuality',
  'pacing',
  'intentExecution',
  'recovery',
  'visualCoherence',
]);
export type DimensionKey = z.infer<typeof DimensionKeySchema>;

/** One observation pointing at a specific moment in the recording. */
export const DimensionEvidenceSchema = z.object({
  /** Seconds into the trimmed video where the observation was made. */
  atSecond: z.number().min(0).max(120),
  /** One-sentence description of what looked off. */
  observation: z.string().min(1).max(280),
});
export type DimensionEvidence = z.infer<typeof DimensionEvidenceSchema>;

export const DimensionResultSchema = z.object({
  level: DimensionLevelSchema,
  /**
   * Evidence list. `pass` dimensions normally have []. `partial` and
   * `fail` dimensions must have at least one item so a reviewer can jump
   * to the moment. The judge prompt instructs the LLM to enforce this.
   */
  evidence: z.array(DimensionEvidenceSchema).default([]),
});
export type DimensionResult = z.infer<typeof DimensionResultSchema>;

/**
 * Full judgment payload. The schema matches the LLM's JSON output
 * exactly — `LlmVisionJudge` parses + validates against this and throws
 * `RecordingJudgeError` on mismatch (the regression script will surface
 * the parse failure rather than silently degrade).
 */
export const RecordingJudgmentSchema = z.object({
  verdict: VerdictSchema,
  dimensions: z.object({
    motionQuality: DimensionResultSchema,
    pacing: DimensionResultSchema,
    intentExecution: DimensionResultSchema,
    recovery: DimensionResultSchema,
    visualCoherence: DimensionResultSchema,
  }),
  /** One-paragraph free-form summary the LLM writes after filling dimensions. */
  summary: z.string().min(1).max(2000),
});
export type RecordingJudgment = z.infer<typeof RecordingJudgmentSchema>;

/**
 * The full judge return — judgment + metadata the script writes alongside.
 * Kept separate from the LLM's JSON shape so we can decorate without
 * touching prompt validation.
 */
export interface RecordingJudgeReport {
  judgment: RecordingJudgment;
  modelId: string;
  /** End-to-end latency of the judge call, including upload. */
  latencyMs: number;
  /** Path to the video that was judged, absolute. */
  videoPath: string;
  /** User's original prompt, copied for traceability. */
  userPrompt: string;
  /** Seconds duration of the trimmed video that was judged. */
  videoDurationSec: number;
}
