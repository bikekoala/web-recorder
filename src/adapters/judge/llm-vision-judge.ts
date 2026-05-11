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
  constructor(message: string, cause?: unknown) {
    super('RECORDING_JUDGE_FAILED', message, cause);
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
}

export class LlmVisionJudge implements IRecordingJudge {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly logger = rootLogger.child({ component: 'LlmVisionJudge' });

  constructor(opts: LlmVisionJudgeOpts = {}) {
    this.model = opts.model ?? config.llmJudgeModel;
    this.baseUrl = opts.baseUrl ?? config.openrouterBaseUrl;
    this.apiKey = opts.apiKey ?? config.openrouterApiKey;
    this.fetcher = opts.fetcher ?? globalThis.fetch;
  }

  get modelId(): string {
    return this.model;
  }

  async judge(input: JudgeInput): Promise<RecordingJudgeReport> {
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
      max_tokens: 2000,
    };

    this.logger.info(
      { model: this.model, videoBytes: videoBytes.length, mime },
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
      throw new RecordingJudgeError('judge HTTP call failed (network)', err);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      throw new RecordingJudgeError(
        `judge HTTP ${resp.status}: ${text.slice(0, 400)}`,
      );
    }

    let completion: ChatCompletionLike;
    try {
      completion = (await resp.json()) as ChatCompletionLike;
    } catch (err) {
      throw new RecordingJudgeError('judge response was not JSON', err);
    }

    const rawContent = completion.choices?.[0]?.message?.content ?? '';
    if (!rawContent) {
      throw new RecordingJudgeError('judge returned empty content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(rawContent));
    } catch (err) {
      throw new RecordingJudgeError(
        `judge JSON parse failed: ${rawContent.slice(0, 200)}`,
        err,
      );
    }

    const validation = RecordingJudgmentSchema.safeParse(parsed);
    if (!validation.success) {
      throw new RecordingJudgeError(
        `judge output failed schema: ${validation.error.message.slice(0, 400)}`,
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
