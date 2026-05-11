import type { RecordingJudgeReport } from '../domain/recording-judgment.js';

/**
 * IRecordingJudge — automated naturalness grader for a finished
 * recording. Consumes the trimmed video + the user's original prompt
 * and returns a structured judgment (5 dimensions + overall verdict).
 *
 * Why this is its own port (not piggy-backed on `IReconnoiterer`):
 *
 *   - Different input shape: full video bytes vs. a screenshot.
 *   - Different model class: needs native video understanding (Gemini
 *     2.5/3.x). Conflating them forces one model to do both badly.
 *   - Different cadence: judge runs ONCE per finished recording.
 *     Latency/cost tradeoffs are opposite.
 *   - Different consumer: the regression test (and a standalone script),
 *     not the Director. Keeping the seam clean means the Director never
 *     accidentally depends on judge output.
 *
 * Best-effort contract: implementations throw on network / parse
 * failure. The standalone script surfaces the throw; the regression
 * test treats throw as "judge unavailable" and skips the assertion
 * rather than red-failing the suite (per goals.md #6 — we don't want
 * the judge model going down to break the recording pipeline tests).
 */
export interface IRecordingJudge {
  judge(input: JudgeInput): Promise<RecordingJudgeReport>;
  /** Stable identifier for the underlying model. */
  readonly modelId: string;
}

export interface JudgeInput {
  /** Absolute path to the trimmed video file (typically `recording.webm`). */
  videoPath: string;
  /** User's original natural-language instruction, verbatim. */
  userPrompt: string;
  /** The target durationMs the user requested for this recording. */
  durationMs: number;
}
