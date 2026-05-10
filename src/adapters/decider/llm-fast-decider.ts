import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import type { DirectorState } from '../../domain/director-state.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import {
  DecisionResponse,
  type IFastDecider,
} from '../../ports/fast-decider.js';

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

const SYSTEM_PROMPT = `You are a streaming browser-recording DIRECTOR. On each call you receive the user's intent, the current page state, and a screenshot. You output 1-2 next "micro actions" the executor will play immediately.

Output JSON ONLY, matching this exact shape:
{
  "actions": [ <DirectorAction>, ... ],
  "expectAfter": { "urlContains": "...", "visibleText": ["..."] }   // optional
}

Where each DirectorAction is one of:
  { "kind": "click",  "target": "<natural language description, in the user's language>", "reasoning": "<short>" }
  { "kind": "scroll", "deltaPx": <integer in [-1500,-100] or [100,1500]>, "speed": "slow"|"normal"|"fast", "reasoning": "<short>" }
  { "kind": "dwell",  "durationMs": <integer in [200,3000]>, "reasoning": "<short>" }
  { "kind": "done",   "reasoning": "<short>" }

Action semantics:
- "click"  — the executor will smoothly scroll the target into view, pause briefly, then click. You do NOT need a separate scroll-to-target before a click.
- "scroll" — smooth scroll. Speed: slow=250 px/s (reading), normal=450 (scanning), fast=800 (flinging).
- "dwell"  — pause. Use for reading or before a click that follows other content.
- "done"   — signal that the user's intent has been satisfied; recording ends.

Quality rules:
- Output 1-2 actions per response. Lookahead is for buffering, not committing to a long plan.
- Don't repeat the SAME action three times in a row — alternate scroll lengths or insert a dwell.
- "expectAfter.urlContains" should be a SUBSTRING expected in URL after these actions complete (e.g. "zh-CN" after a language switch). Omit if no navigation expected.
- "expectAfter.visibleText" should be 1-3 short strings expected to be visible after these actions. Omit if uncertain.
- If lastActionFailure is set, address it explicitly in your reasoning.

Output JSON only. No markdown, no commentary outside the schema.`;

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

  async decide(state: DirectorState): Promise<DecisionResponse> {
    const userText = buildUserPrompt(state);
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
          { role: 'system', content: SYSTEM_PROMPT },
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
    const result = DecisionResponse.safeParse(parsed);
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

function buildUserPrompt(s: DirectorState): string {
  const recent =
    s.recentActions.length === 0
      ? '(none)'
      : s.recentActions
          .map((a) => `${a.kind}: ${a.brief}${a.succeeded ? '' : ' [FAILED]'}`)
          .join('; ');
  const hints = s.visibleHints.length === 0 ? '(none in view)' : s.visibleHints.join('; ');
  return [
    `User intent: ${s.prompt}`,
    `Time remaining (ms): ${s.remainingMs}`,
    `Current scrollY: ${s.currentScrollY}`,
    `Viewport: ${s.viewport.width}x${s.viewport.height}`,
    `Briefing hints currently in viewport: ${hints}`,
    `Recent actions (oldest→newest): ${recent}`,
    s.lastActionFailure ? `LAST ACTION FAILED: ${s.lastActionFailure}` : '',
    '',
    'Choose 1-2 next actions. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}
