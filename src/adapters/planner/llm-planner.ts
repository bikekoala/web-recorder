import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import { TimelinePlan, type PlanRequest } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { IPlanner } from '../../ports/planner.js';

/**
 * LlmPlanner — IPlanner backed by an OpenRouter-routed LLM with vision.
 *
 * One API call per plan. The screenshot is attached when available so the
 * planner sees actual layout (positions of language switchers, video players,
 * etc.) instead of relying solely on text candidates.
 *
 * Default model: `google/gemini-2.5-flash` — fast multimodal, ~1-2s/call.
 * Override via `LLM_MODEL` env (just like the agent's model). Note: changing
 * the model here also changes the agent's model in the current setup, since
 * both share `config.llmModel`. For prototype simplicity that's acceptable;
 * a future refactor may split `LLM_MODEL_PLANNER` from `LLM_MODEL_AGENT`.
 */

export class PlannerError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('PLANNER_FAILED', message, cause);
  }
}

const SYSTEM_PROMPT = `You are a BROWSER VIDEO DIRECTOR. Given a URL, a natural-language instruction, a target duration, and a screenshot of the loaded page, you output a deterministic timeline of browser actions that, when executed, will produce a recording matching the user's intent.

Your output MUST be a single JSON object matching this schema:
{
  "version": 1,
  "targetDurationMs": <integer ms>,
  "steps": [
    { "type": "scroll", "deltaY": <integer px>, "durationMs": <integer ms>, "why": "<short reason>" },
    { "type": "click",  "target": "<natural-language description>", "durationMs": <integer ms>, "why": "<short reason>" },
    { "type": "wait",   "durationMs": <integer ms>, "why": "<short reason>" },
    { "type": "stable", "quietMs": <integer ms>, "maxMs": <integer ms>, "why": "<short reason>" }
  ],
  "notes": "<one sentence on overall plan>"
}

Action semantics:
- scroll: smoothly scroll the page by deltaY pixels over durationMs. Positive = down, negative = up.
- click:  resolve the described target via the runner's element finder, then click. The "target" string is what a HUMAN would say to describe the element ("the 简体中文 link in the README", "the play button", "the comments tab"). USE THE LANGUAGE OF THE USER'S PROMPT.
          IMPORTANT: every click step is automatically choreographed with a
          discovery phase — the runner will smooth-scroll the page until the
          target sits naturally in view, hold briefly (anticipation), then
          click. You DO NOT need to plan a separate scroll-to-target before
          a click. The click step's durationMs encompasses approach + pause + click.
- wait:   pause durationMs. Use sparingly; prefer "stable" after a click that may navigate.
- stable: block until the DOM has been quiet for quietMs (no mutations) or maxMs has elapsed. Use this AFTER any click that may cause navigation/re-render.

Time budget rules (CRITICAL):
- Sum of step durationMs MUST be within ±5% of targetDurationMs.
  Example: target 10000 → sum should be 9500-10500.
- Computed sum = sum of (durationMs for scroll/click/wait) + (quietMs for stable, since stable typically resolves at quietMs not maxMs).
- If your initial draft is short, EXTEND scroll durations or ADD additional scroll/wait steps until you hit the target. DO NOT under-budget.
- If your initial draft is long, SHORTEN scroll durations.
- Reserve about 500-800ms after each click for a "stable" step (use stable.quietMs=600).
- A click step's durationMs models the FULL human action: scroll-toward-target + look + click.
  Use 2000-3000ms for typical clicks (target needs to be scrolled into view).
  Use 1500-2000ms only if the target is clearly already in the initial viewport.
  Use 3000-4000ms for far-off targets.
  DO NOT use small values (<1000ms) — that produces a "teleport" effect that looks robotic.
- Default scroll speeds: "slow / 慢" = 250-350 px/s, "normal" = 400-500 px/s, "fast" = 600-800 px/s.
- For "slow scroll" instructions, prefer 3-5 medium scroll steps over 1-2 large ones.

Quality rules:
- If the prompt mentions clicking/tapping something, that MUST be a click step.
- "录制 N s" or "record for N seconds" → targetDurationMs = N * 1000.
- "慢慢滑动" / "slowly scroll" → multiple smaller scroll steps with slow speed, NOT one big jump.
- Describe click targets in the SAME LANGUAGE as the user's prompt (so the runner has the best chance of matching what the user is referring to).
- Prefer 2-5 total steps when the prompt is simple. Don't over-decompose.

Output JSON only. No markdown, no commentary outside the "notes" field.`;

export class LlmPlanner implements IPlanner {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmPlanner' });

  constructor(opts?: { model?: string; client?: OpenAI }) {
    this.model = opts?.model ?? config.llmModel;
    this.client =
      opts?.client ??
      new OpenAI({
        baseURL: config.openrouterBaseUrl,
        apiKey: config.openrouterApiKey,
      });
  }

  async plan(request: PlanRequest, screenshot: Buffer | null): Promise<TimelinePlan> {
    const userText = buildUserPrompt(request);

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (screenshot) {
      const b64 = screenshot.toString('base64');
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
        temperature: 0.3,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new PlannerError('LLM call failed', err);
    }

    if (!raw) {
      throw new PlannerError('LLM returned empty content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new PlannerError(`LLM output was not valid JSON: ${raw.slice(0, 500)}`, err);
    }

    const result = TimelinePlan.safeParse(parsed);
    if (!result.success) {
      throw new PlannerError(
        `LLM output failed schema validation: ${JSON.stringify(result.error.format())}\nRaw: ${JSON.stringify(parsed).slice(0, 1000)}`,
      );
    }

    this.logger.info(
      {
        model: this.model,
        elapsedMs: Date.now() - t0,
        steps: result.data.steps.length,
        targetDurationMs: result.data.targetDurationMs,
      },
      'plan generated',
    );

    return result.data;
  }
}

function buildUserPrompt(req: PlanRequest): string {
  const candidatesBlock =
    req.candidates.length === 0
      ? '(no candidates collected)'
      : req.candidates
          .slice(0, 30)
          .map((c, i) => `  ${i + 1}. ${c.description}`)
          .join('\n');

  return [
    `URL: ${req.url}`,
    `Prompt: ${req.prompt}`,
    `Target duration: ${req.durationMs} ms`,
    `Viewport: ${req.viewport.width} x ${req.viewport.height}`,
    `Visible candidate elements (first ${Math.min(30, req.candidates.length)}):`,
    candidatesBlock,
    '',
    'Output JSON only.',
  ].join('\n');
}

/**
 * Some models (notably Anthropic via OpenRouter) wrap JSON in markdown
 * fences despite the response_format hint. Strip them defensively.
 */
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    const without = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    return without.trim();
  }
  return trimmed;
}
