import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  type Performance,
  type PerformanceStep,
  type RehearsalTrace,
} from '../../domain/performance.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { buildReconUserText, buildReconvergeUserText, reconnoitererSystemPrompt } from '../../prompts/index.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer, ReconInput } from '../../ports/reconnoiterer.js';
import { rehearse, type ReconvergeContext } from './rehearsal.js';

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
 *   4. (config.reconRehearse) run the off-camera rehearsal walk over the
 *      resolved draft — verifies each acting step against the live page,
 *      reconverges on divergence — then reset the page to the start URL so
 *      the on-camera run reproduces the start state.
 *   5. Zod-validate the final Performance; throw ReconError on any failure.
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
    const promptStr = typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt;

    // Resolve targets; drop click/type steps that don't resolve.
    const resolvedSteps = await this.resolveSteps(parsedRaw.steps as Array<Record<string, unknown>>, session);
    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after target resolution');
    }

    // Off-camera rehearsal walk (config.reconRehearse). Verifies the draft
    // against the live page, reconverging on divergence; afterwards we reset
    // the page to the start URL so the on-camera run reproduces the start state.
    let finalSteps: PerformanceStep[] = resolvedSteps;
    let rehearsalTrace: RehearsalTrace | undefined;
    if (config.reconRehearse) {
      const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
        const observed = await ctx.session.observeAll().catch(() => []);
        const screenshot = await ctx.session.screenshot().catch(() => null);
        const userText = buildReconvergeUserText({
          intent: ctx.intent,
          divergedStep: ctx.divergedStep,
          observedUrl: ctx.observedUrl,
          observed: observed.map((e) => ({ selector: e.selector, description: e.description })),
        });
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
        if (screenshot && screenshot.length > 0) {
          content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot.toString('base64')}` } });
        }
        let raw2: string;
        try {
          const completion = await this.client.chat.completions.create({
            model: this.model,
            messages: [
              { role: 'system', content: reconnoitererSystemPrompt },
              { role: 'user', content },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 3000,
          });
          raw2 = completion.choices[0]?.message?.content ?? '';
        } catch (err) {
          this.logger.warn({ err }, 'reconverge LLM call failed');
          return [];
        }
        if (!raw2) return [];
        let parsed: { steps?: unknown };
        try {
          parsed = JSON.parse(stripCodeFence(raw2));
        } catch {
          this.logger.warn('reconverge JSON parse failed');
          return [];
        }
        if (!Array.isArray(parsed.steps)) return [];
        return this.resolveSteps(parsed.steps as Array<Record<string, unknown>>, ctx.session);
      };
      let result: Awaited<ReturnType<typeof rehearse>>;
      try {
        result = await rehearse({
          draftSteps: resolvedSteps,
          session,
          intent: promptStr,
          reconverge,
          rehearsalBudgetMs: config.reconRehearsalBudgetMs,
          reconvergeMax: config.reconReconvergeMax,
          logger: this.logger,
        });
      } catch (err) {
        throw new ReconError('rehearsal walk failed', err);
      }
      finalSteps = result.steps;
      rehearsalTrace = result.trace;
      try {
        await session.goto(input.url);
        await session.waitForVisualStability();
      } catch (err) {
        this.logger.warn({ err }, 'page reset after rehearsal failed — on-camera run may diverge (the director re-plan/graceful-degradation is the backstop)');
      }
    }

    const candidate: Performance = {
      prompt: promptStr,
      durationMs: input.durationMs,
      steps: finalSteps,
      totalEstimatedMs: typeof parsedRaw.totalEstimatedMs === 'number' ? parsedRaw.totalEstimatedMs : sumDurations(finalSteps),
      rationale: typeof parsedRaw.rationale === 'string' ? parsedRaw.rationale : 'no rationale provided',
      ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
    };
    const validation = PerformanceSchema.safeParse(candidate);
    if (!validation.success) {
      throw new ReconError(`recon Performance failed schema: ${validation.error.message.slice(0, 400)}`);
    }
    this.logger.info(
      { stepCount: validation.data.steps.length, totalEstimatedMs: validation.data.totalEstimatedMs, durationMs: input.durationMs, rehearsal: rehearsalTrace },
      'recon complete',
    );
    return validation.data;
  }

  /**
   * Turn raw step objects from the LLM into resolved {@link PerformanceStep}s:
   * click/type targets are resolved to a selector + bbox via
   * `session.resolveTarget()`; steps whose target won't resolve are dropped
   * (and logged). Other kinds pass through untouched.
   */
  private async resolveSteps(
    rawSteps: Array<Record<string, unknown>>,
    session: IPageSession,
  ): Promise<PerformanceStep[]> {
    const resolved: PerformanceStep[] = [];
    for (const rawStep of rawSteps) {
      const kind = rawStep.kind;
      if (kind === 'click' || kind === 'type') {
        const desc = (rawStep.target as { description?: string } | undefined)?.description;
        if (!desc) { this.logger.debug({ rawStep }, 'recon step missing target description — dropped'); continue; }
        const r = await session.resolveTarget(desc).catch(() => null);
        if (!r || !r.bbox) { this.logger.info({ desc }, 'recon target did not resolve — step dropped'); continue; }
        const target = ResolvedTargetSchema.parse({ selector: r.selector, bbox: r.bbox, description: desc });
        resolved.push({ ...rawStep, target } as unknown as PerformanceStep);
      } else {
        resolved.push(rawStep as unknown as PerformanceStep);
      }
    }
    return resolved;
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
