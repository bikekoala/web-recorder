import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import type { DirectorState } from '../../domain/director-state.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import {
  DecisionResponse,
  type IFastDecider,
} from '../../ports/fast-decider.js';
import { deciderSystemPrompt, buildDeciderUserText } from '../../prompts/index.js';

/**
 * LlmFastDecider — IFastDecider backed by OpenRouter (default Gemini Flash Lite).
 *
 * Designed for sub-second p95 latency. The Director hides this latency by
 * pre-firing the next call during the previous animation; if the LLM
 * occasionally takes longer, the Director's implicit-dwell fallback covers it.
 *
 * Output is parsed strictly via Zod. Callers never see malformed actions.
 *
 * Markdown code-fence stripping is included defensively — Anthropic models
 * routed through OpenRouter sometimes wrap JSON in ```json … ``` despite
 * the response_format hint. (See `LlmPlanner` for the same defense.)
 */
export class FastDeciderError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('FAST_DECIDER_FAILED', message, cause);
  }
}

// SYSTEM_PROMPT moved to src/prompts/decider.ts — see plan.md docs/decisions
// §0023 for rationale (centralized prompt management + Sonnet 4.6 compat).

interface LlmFastDeciderOpts {
  /** Model id; defaults to config.llmDeciderModel. */
  model?: string;
  /** Pre-built OpenAI client; defaults to OpenRouter via config. */
  client?: OpenAI;
}

export class LlmFastDecider implements IFastDecider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmFastDecider' });

  constructor(opts: LlmFastDeciderOpts = {}) {
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

  async decide(state: DirectorState): Promise<DecisionResponse> {
    const userText = buildDeciderUserText(state);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (state.screenshot.length > 0) {
      const b64 = state.screenshot.toString('base64');
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
          { role: 'system', content: deciderSystemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new FastDeciderError('LLM call failed', err);
    }
    if (!raw) throw new FastDeciderError('LLM returned empty content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new FastDeciderError(`invalid json from LLM: ${raw.slice(0, 200)}`, err);
    }
    // Coerce numeric fields that LLMs commonly miss (dwell > 3000ms, scroll < 100px).
    // Strict schema is preserved; we just round/clamp into the valid range first so
    // a single off-by-some-ms LLM slop doesn't kill the whole recording.
    const coerced = coerceDecisionShape(parsed);
    const result = DecisionResponse.safeParse(coerced);
    if (!result.success) {
      throw new FastDeciderError(
        `schema validation failed: ${JSON.stringify(result.error.format()).slice(0, 500)}`,
      );
    }

    this.logger.debug(
      {
        elapsedMs: Date.now() - t0,
        actionCount: result.data.actions.length,
        firstKind: result.data.actions[0]?.kind,
      },
      'decision',
    );
    return result.data;
  }
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}

/**
 * Round + clamp numeric fields that LLMs commonly miss into the valid range.
 *
 * Why: gpt-4o-mini and friends, when asked to express "watch a video for a
 * while", naturally pick a single dwell with durationMs ≈ 5000-8000. Our
 * domain caps a single dwell at 3000 ms to keep the LLM in-the-loop. Without
 * this coercion the whole director would crash on a single off-bound number.
 *
 * Coverage:
 * - dwell.durationMs: clamp to [200, 3000]
 * - scroll.deltaPx:   clamp absolute to [100, 1500], preserve sign; deltaPx === 0
 *                     left untouched so schema rejects (no inferable direction)
 *
 * Anything else passes through unchanged — bad `kind`, missing fields, etc.
 * still fail strict validation as before.
 */
function coerceDecisionShape(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.actions)) return parsed;
  return { ...p, actions: p.actions.map(coerceAction) };
}

function coerceAction(a: unknown): unknown {
  if (!a || typeof a !== 'object') return a;
  const action = a as Record<string, unknown>;
  if (action.kind === 'dwell' && typeof action.durationMs === 'number') {
    return { ...action, durationMs: clampInt(action.durationMs, 200, 3000) };
  }
  if (action.kind === 'scroll' && typeof action.deltaPx === 'number') {
    const v = Math.round(action.deltaPx);
    if (v === 0) return action; // direction unknowable; let schema reject
    const sign = v > 0 ? 1 : -1;
    const abs = Math.max(100, Math.min(1500, Math.abs(v)));
    return { ...action, deltaPx: sign * abs };
  }
  return action;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
