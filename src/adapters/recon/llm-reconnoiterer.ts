import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  type Performance,
  type PerformanceStep,
} from '../../domain/performance.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { buildReconUserText, reconnoitererSystemPrompt } from '../../prompts/index.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer, ReconInput } from '../../ports/reconnoiterer.js';

/**
 * LlmReconnoiterer — IReconnoiterer backed by a vision LLM via OpenRouter.
 * Default model: config.llmReconModelResolved (the resolved planner model).
 *
 * Pipeline:
 *   1. session.observeAll() — ground-truth interactive elements.
 *   2. one chat call (screenshot + intent + observed list) -> raw Performance
 *      JSON where each click/type target is just {description}.
 *   3. resolve each target via session.resolveTarget(); drop steps whose
 *      target won't resolve.
 *   4. Zod-validate the final Performance; throw ReconError on any failure.
 */
export class ReconError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('RECON_FAILED', message, cause);
  }
}

interface LlmReconnoitererOpts {
  model?: string;
  client?: OpenAI;
}

export class LlmReconnoiterer implements IReconnoiterer {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmReconnoiterer' });

  constructor(opts: LlmReconnoitererOpts = {}) {
    this.model = opts.model ?? config.llmReconModelResolved;
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
  }

  get modelId(): string { return this.model; }

  async recon(input: ReconInput, session: IPageSession): Promise<Performance> {
    const observed = await session.observeAll().catch(() => []);
    const userText = buildReconUserText(input, observed);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (input.screenshot && input.screenshot.length > 0) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
    }

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: reconnoitererSystemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 4000,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new ReconError('recon LLM call failed', err);
    }
    if (!raw) throw new ReconError('recon returned empty content');

    let parsedRaw: { prompt?: unknown; durationMs?: unknown; steps?: unknown; totalEstimatedMs?: unknown; rationale?: unknown };
    try {
      parsedRaw = JSON.parse(stripCodeFence(raw));
    } catch (err) {
      throw new ReconError(`recon JSON parse failed: ${raw.slice(0, 200)}`, err);
    }
    if (!Array.isArray(parsedRaw.steps)) throw new ReconError('recon output has no steps array');

    // Resolve targets; drop click/type steps that don't resolve.
    const resolvedSteps: PerformanceStep[] = [];
    for (const rawStep of parsedRaw.steps as Array<Record<string, unknown>>) {
      const kind = rawStep.kind;
      if (kind === 'click' || kind === 'type') {
        const desc = (rawStep.target as { description?: string } | undefined)?.description;
        if (!desc) { this.logger.debug({ rawStep }, 'recon step missing target description — dropped'); continue; }
        const resolved = await session.resolveTarget(desc).catch(() => null);
        if (!resolved || !resolved.bbox) { this.logger.info({ desc }, 'recon target did not resolve — step dropped'); continue; }
        const target = ResolvedTargetSchema.parse({ selector: resolved.selector, bbox: resolved.bbox, description: desc });
        resolvedSteps.push({ ...rawStep, target } as unknown as PerformanceStep);
      } else {
        resolvedSteps.push(rawStep as unknown as PerformanceStep);
      }
    }
    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after target resolution');
    }

    const candidate: Performance = {
      prompt: typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt,
      durationMs: input.durationMs,
      steps: resolvedSteps,
      totalEstimatedMs: typeof parsedRaw.totalEstimatedMs === 'number' ? parsedRaw.totalEstimatedMs : sumDurations(resolvedSteps),
      rationale: typeof parsedRaw.rationale === 'string' ? parsedRaw.rationale : 'no rationale provided',
    };
    const validation = PerformanceSchema.safeParse(candidate);
    if (!validation.success) {
      throw new ReconError(`recon Performance failed schema: ${validation.error.message.slice(0, 400)}`);
    }
    this.logger.info(
      { stepCount: validation.data.steps.length, totalEstimatedMs: validation.data.totalEstimatedMs, durationMs: input.durationMs },
      'recon complete',
    );
    return validation.data;
  }
}

function sumDurations(steps: PerformanceStep[]): number {
  let total = 0;
  for (const s of steps) {
    switch (s.kind) {
      case 'dwell': total += s.durationMs; break;
      case 'scroll': total += s.durationMs + s.dwellAfterMs; break;
      case 'click': total += s.anticipationMs + 400; break;
      case 'type': total += s.preMs + s.text.length * s.keystrokeMs; break;
      case 'key': total += 200; break;
      case 'back': total += 800; break;
      case 'done': break;
    }
  }
  return total;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return t;
}
