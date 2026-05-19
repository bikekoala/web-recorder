import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { DomainError } from '../../domain/errors.js';
import {
  RecordingJudgmentSchema,
  type RecordingJudgment,
  type RecordingJudgeReport,
} from '../../domain/recording-judgment.js';
import { videoDurationMs } from '../../infra/ffmpeg.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import {
  buildRecordingJudgeUserText,
  recordingJudgeSystemPrompt,
} from '../../prompts/index.js';
import type { IRecordingJudge, JudgeInput } from '../../ports/recording-judge.js';

/**
 * LlmVisionJudge — `IRecordingJudge` backed by a video-capable LLM via
 * OpenRouter. Default model `google/gemini-3.1-pro-preview` (configurable
 * via LLM_JUDGE_MODEL) — needs native video input.
 *
 * Implementation detail: this adapter uses raw `fetch` rather than the
 * `openai` SDK because the SDK's `ChatCompletionContentPart` type does
 * not include `video_url`. OpenRouter's request schema follows the
 * OpenAI-compatible chat-completions shape with an additional content
 * type `video_url` (mirroring `image_url`). When the SDK adds first-
 * class video support we can flip this adapter to use it without
 * touching the port or domain types.
 *
 * Best-effort: any HTTP / parse error throws `RecordingJudgeError`. The
 * standalone script surfaces this; the regression test catches and
 * skips the assertion (we never want a judge outage to red-fail a run
 * that itself succeeded).
 */
export class RecordingJudgeError extends DomainError {
  /**
   * True for transient failure classes the judge retry loop should re-attempt
   * (network, 5xx, 429, empty content, JSON-parse, schema). False for hard
   * request errors (4xx≠429) where a retry can't help. Defaults to false so
   * an untagged throw is treated conservatively as non-retryable.
   */
  readonly retryable: boolean;
  constructor(message: string, cause?: unknown, opts: { retryable?: boolean } = {}) {
    super('RECORDING_JUDGE_FAILED', message, cause);
    this.retryable = opts.retryable ?? false;
  }
}

interface LlmVisionJudgeOpts {
  /** Model id; defaults to `config.llmJudgeModel` (gemini-3.1-pro-preview). */
  model?: string;
  /** Override the OpenRouter base URL; defaults to config. */
  baseUrl?: string;
  /** Override the API key; defaults to config. */
  apiKey?: string;
  /**
   * Inject a fetch (test seam). Defaults to globalThis.fetch.
   */
  fetcher?: typeof fetch;
  /** Override the retry attempt cap (test seam). Defaults to config.judgeMaxAttempts. */
  maxAttempts?: number;
  /** Override the inter-attempt backoff sleep (test seam — pass a no-op for fast tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class LlmVisionJudge implements IRecordingJudge {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger = rootLogger.child({ component: 'LlmVisionJudge' });

  constructor(opts: LlmVisionJudgeOpts = {}) {
    this.model = opts.model ?? config.llmJudgeModel;
    this.baseUrl = opts.baseUrl ?? config.openrouterBaseUrl;
    this.apiKey = opts.apiKey ?? config.openrouterApiKey;
    this.fetcher = opts.fetcher ?? globalThis.fetch;
    this.maxAttempts = opts.maxAttempts ?? config.judgeMaxAttempts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get modelId(): string {
    return this.model;
  }

  async judge(input: JudgeInput): Promise<RecordingJudgeReport> {
    // Video-capable models (Gemini 3.1 Pro) are flaky on longer videos —
    // empty content / truncated JSON happen on ~2/3 of 25 s recordings
    // (2026-05-19 sweep) and almost always clear on a re-request. Retry
    // transient classes; surface a hard request error (4xx≠429) at once.
    const maxAttempts = this.maxAttempts;
    let lastErr: RecordingJudgeError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.judgeOnce(input, attempt, maxAttempts);
      } catch (err) {
        if (!(err instanceof RecordingJudgeError) || !err.retryable || attempt === maxAttempts) {
          throw err;
        }
        lastErr = err;
        const backoffMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
        this.logger.warn(
          { attempt, maxAttempts, backoffMs, reason: err.message.slice(0, 160) },
          'judge attempt failed (transient) — retrying after backoff',
        );
        await this.sleep(backoffMs);
      }
    }
    // Unreachable (the loop either returns or throws), but satisfies the
    // type checker and is a defensive backstop.
    throw lastErr ?? new RecordingJudgeError('judge exhausted all attempts');
  }

  private async judgeOnce(
    input: JudgeInput,
    attempt: number,
    maxAttempts: number,
  ): Promise<RecordingJudgeReport> {
    const t0 = Date.now();

    // Read the video file. We base64-encode inline; for our typical
    // 10-30s webm at ~720p the file is ~5-15 MB which becomes ~7-20 MB
    // of base64 — well within OpenRouter's request body cap. If we ever
    // grow to multi-minute recordings we'll need a downsample step
    // before this (ffmpeg -vf scale=...) or a file-upload flow.
    const videoBytes = await readFile(input.videoPath);
    const mime = mimeForVideo(input.videoPath);
    const dataUrl = `data:${mime};base64,${videoBytes.toString('base64')}`;

    const userText = buildRecordingJudgeUserText({
      userPrompt: input.userPrompt,
      durationMs: input.durationMs,
    });

    // OpenRouter chat-completions request. The `video_url` content type
    // is the standard convention mirroring `image_url`. If the upstream
    // model doesn't support video, OpenRouter returns 4xx with an
    // explanatory body — we surface that in the thrown error.
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: recordingJudgeSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'video_url', video_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      // Generous — the rubric asks for per-dimension evidence lists which
      // can run long on a messy recording. 2000 truncated mid-JSON on a
      // robotic case; 4000 leaves comfortable headroom.
      max_tokens: 4000,
    };

    this.logger.info(
      { model: this.model, videoBytes: videoBytes.length, mime, attempt, maxAttempts },
      'judge call starting',
    );

    let resp: Response;
    try {
      resp = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network blip — transient.
      throw new RecordingJudgeError('judge HTTP call failed (network)', err, { retryable: true });
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      // 5xx + 429 (rate limit) are transient; other 4xx is a hard request
      // error (bad body / unsupported model / auth) — retrying won't help.
      const retryable = resp.status >= 500 || resp.status === 429;
      throw new RecordingJudgeError(
        `judge HTTP ${resp.status}: ${text.slice(0, 400)}`,
        undefined,
        { retryable },
      );
    }

    let completion: ChatCompletionLike;
    try {
      completion = (await resp.json()) as ChatCompletionLike;
    } catch (err) {
      throw new RecordingJudgeError('judge response was not JSON', err, { retryable: true });
    }

    const choice = completion.choices?.[0];
    const rawContent = choice?.message?.content ?? '';
    if (!rawContent) {
      // Gemini commonly returns empty content with a finish_reason on long
      // videos (safety filter / processing timeout / silent drop). Transient
      // — a re-request usually returns a full judgment. Surface finish_reason
      // for triage.
      throw new RecordingJudgeError(
        `judge returned empty content (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
        undefined,
        { retryable: true },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(rawContent));
    } catch (err) {
      // Truncated / malformed JSON — usually a mid-stream cutoff. Transient.
      throw new RecordingJudgeError(
        `judge JSON parse failed: ${rawContent.slice(0, 200)}`,
        err,
        { retryable: true },
      );
    }

    const validation = RecordingJudgmentSchema.safeParse(parsed);
    if (!validation.success) {
      // Model returned well-formed JSON of the wrong shape — re-rolling the
      // sample often yields a conformant one (temperature 0.1, not 0).
      throw new RecordingJudgeError(
        `judge output failed schema: ${validation.error.message.slice(0, 400)}`,
        undefined,
        { retryable: true },
      );
    }
    const judgment: RecordingJudgment = validation.data;

    const latencyMs = Date.now() - t0;
    const videoDurMs = await videoDurationMs(input.videoPath).catch(() => null);

    this.logger.info(
      { verdict: judgment.verdict, latencyMs },
      'judge call complete',
    );

    return {
      judgment,
      modelId: this.model,
      latencyMs,
      videoPath: input.videoPath,
      userPrompt: input.userPrompt,
      videoDurationSec: videoDurMs ? videoDurMs / 1000 : 0,
    };
  }
}

// ---------------------------------------------------------------- helpers

interface ChatCompletionLike {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

function mimeForVideo(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    default: return 'video/webm';
  }
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}
