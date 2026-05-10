import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import { DirectorAction } from '../../domain/director-action.js';
import { ClickHint, type DirectorBriefing } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { BriefRequest, IPlanner } from '../../ports/planner.js';
import { plannerSystemPrompt, buildPlannerUserText } from '../../prompts/index.js';

/**
 * LlmPlanner — IPlanner backed by an OpenRouter-routed LLM with vision.
 *
 * One API call per brief. The screenshot is attached when available so the
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

export class LlmPlanner implements IPlanner {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmPlanner' });

  constructor(opts?: { model?: string; client?: OpenAI }) {
    this.model = opts?.model ?? config.llmPlannerModelResolved;
    this.client =
      opts?.client ??
      new OpenAI({
        baseURL: config.openrouterBaseUrl,
        apiKey: config.openrouterApiKey,
      });
  }

  async brief(
    input: BriefRequest,
    session: IPageSession,
  ): Promise<DirectorBriefing> {
    const userText = buildPlannerUserText({
      url: input.url,
      prompt: input.prompt,
      durationMs: input.durationMs,
      viewport: input.viewport,
    });

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    if (input.screenshot) {
      const b64 = input.screenshot.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: plannerSystemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new PlannerError('LLM brief() call failed', err);
    }
    if (!raw) throw new PlannerError('LLM returned empty brief content');

    let parsed: { targets?: unknown; rationale?: unknown; draftSequence?: unknown };
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new PlannerError(`brief returned invalid JSON: ${raw.slice(0, 300)}`, err);
    }
    // Surface raw model output at debug — invaluable for tuning prompts
    // when planners under-extract or hallucinate targets.
    this.logger.debug({ raw: raw.slice(0, 500), model: this.model }, 'planner raw output');
    const targets = Array.isArray(parsed.targets)
      ? (parsed.targets as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';

    // draftSequence: parse each entry through DirectorAction. Drop entries
    // that don't validate so a single malformed action doesn't cost us the
    // whole sequence. Keep the order of valid entries.
    const draftSequence = Array.isArray(parsed.draftSequence)
      ? (parsed.draftSequence as unknown[])
          .map((entry) => DirectorAction.safeParse(entry))
          .filter((r) => r.success)
          .map((r) => (r as { success: true; data: import('../../domain/director-action.js').DirectorAction }).data)
      : [];

    // Pre-resolve each target. Misses are dropped silently — Director's
    // search loop will rediscover them if they exist.
    const hints: ClickHint[] = [];
    for (const description of targets) {
      const resolved = await session.resolveTarget(description);
      if (resolved && resolved.selector && resolved.bbox) {
        hints.push({
          description,
          selector: resolved.selector,
          bboxAtRest: resolved.bbox,
        });
      }
    }

    this.logger.info(
      {
        model: this.model,
        hintCount: hints.length,
        draftSequenceLen: draftSequence.length,
      },
      'brief generated',
    );

    return {
      prompt: input.prompt,
      durationMs: input.durationMs,
      hints,
      rationale,
      draftSequence,
    };
  }
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
