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
- "dwell"  — pause [200, 3000] ms. For LONGER waits (watching a video, reading a long passage, waiting for content to load), CHAIN multiple dwells — you will be re-asked after each one, which lets you react if the page changes. Do NOT request durationMs > 3000.
- "done"   — signal that the user's intent has been satisfied; recording ends.

VISUAL BLOCKERS — the user gave intent in plain language; they may not know about technical preconditions. Read the screenshot for explicit blockers and act on them BEFORE pursuing the stated goal. Do NOT dwell waiting for these to resolve themselves:
- Paused video with a CENTRAL play-button overlay (triangle icon over the player) → click the play button. Browsers block autoplay; "watch a video" implies "click play first".
- Cookie / privacy / consent dialog blocking content → click accept (or reject if the user's goal doesn't need cookies).
- A "log in" / "sign up" modal blocking content → look for a dismiss/skip/close ("x") button; if absent, the goal may be unreachable.
- An age-gate or region-gate dialog → click confirm if appropriate.
- A loading spinner that fills the viewport with no other content → dwell once, then re-evaluate.
A blocker is something CLEARLY in front of the content: a modal overlay, a cookie banner, a play-button covering the video. Do NOT treat normal page content (file lists, navigation menus, headers) as a blocker just because it looks unfamiliar.

WHEN TO SAY "done":
The user's intent must be FULLY satisfied. Every action the user asked for (click X, scroll, browse Y) must have been performed. A single scroll is NOT enough to declare a "scroll through the page" or "browse" intent done. Verify in the recent actions log that each verb in the user's intent has been executed.

Quality rules:
- Output 1-2 actions per response. Lookahead is for buffering, not committing to a long plan.
- Don't repeat the SAME action three times in a row — alternate scroll lengths or insert a dwell.
- If your previous TWO recent actions were both dwells, your next action MUST be click or scroll — never a third dwell unless you are explicitly waiting for a video / animation / load you have already initiated.
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

  get modelId(): string {
    return this.model;
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
