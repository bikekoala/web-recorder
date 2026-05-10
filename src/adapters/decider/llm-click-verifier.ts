import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import {
  buildClickVerifierUserText,
  clickVerifierSystemPrompt,
} from '../../prompts/index.js';
import type {
  ClickVerifyInput,
  ClickVerifyResult,
  IClickVerifier,
} from '../../ports/click-verifier.js';

/**
 * LlmClickVerifier — `IClickVerifier` backed by OpenRouter.
 *
 * Tight scope: one screenshot, one boolean + reason out. Reuses the same
 * decider model by default (gpt-4o-mini, sub-second p95) so this verifier
 * call lands within the post-click natural settle window without
 * stretching the recording budget.
 *
 * Best-effort: any OpenRouter / parse error throws `ClickVerifierError`,
 * which the Director catches and treats as "unknown / optimistic" — it
 * proceeds without flagging click failure rather than blocking the run.
 */
export class ClickVerifierError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('CLICK_VERIFIER_FAILED', message, cause);
  }
}

interface LlmClickVerifierOpts {
  /** Model id; defaults to `config.llmDeciderModel` (typically gpt-4o-mini). */
  model?: string;
  /** Pre-built OpenAI client; defaults to OpenRouter via config. */
  client?: OpenAI;
}

export class LlmClickVerifier implements IClickVerifier {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmClickVerifier' });

  constructor(opts: LlmClickVerifierOpts = {}) {
    this.model = opts.model ?? config.llmDeciderModel;
    this.client =
      opts.client ??
      new OpenAI({
        baseURL: config.openrouterBaseUrl,
        apiKey: config.openrouterApiKey,
      });
  }

  get modelId(): string {
    return this.model;
  }

  async verify(input: ClickVerifyInput): Promise<ClickVerifyResult> {
    const userText = buildClickVerifierUserText(input);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (input.screenshot.length > 0) {
      const b64 = input.screenshot.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }

    const t0 = Date.now();
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: clickVerifierSystemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        // Lower temperature than the decider — verification is judgement,
        // not creativity. Wider variance just hurts.
        temperature: 0.1,
        // Tight cap. We expect ~50-80 tokens out.
        max_tokens: 200,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new ClickVerifierError('verifier LLM call failed', err);
    }
    if (!raw) throw new ClickVerifierError('verifier returned empty content');

    let parsed: { matched?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new ClickVerifierError(`verifier JSON parse failed: ${raw.slice(0, 200)}`, err);
    }

    const matched = parsed.matched === true;
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const reason = reasonRaw.slice(0, 200);
    const latencyMs = Date.now() - t0;

    this.logger.debug({ matched, reason, latencyMs, target: input.targetDescription }, 'verify');
    return { matched, reason, latencyMs };
  }
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}
