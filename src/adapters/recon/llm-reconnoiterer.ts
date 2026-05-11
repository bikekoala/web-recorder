import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  UNRESOLVED_SENTINEL,
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

    const parsedRaw = await this.callReconLlm(
      [
        { role: 'system', content: reconnoitererSystemPrompt },
        { role: 'user', content: userContent },
      ],
      { allowRetry: true },
    );
    if (!Array.isArray(parsedRaw.steps)) throw new ReconError('recon output has no steps array');
    const promptStr = typeof parsedRaw.prompt === 'string' ? parsedRaw.prompt : input.prompt;

    // Resolve targets. When a rehearsal walk will follow (config.reconRehearse),
    // a click/type step whose target won't resolve *here* (at scrollY 0, right
    // after goto) is KEPT with a sentinel target — the walk re-resolves it at
    // the actual page state it'll run in. Without a rehearsal walk there's no
    // such retry, so an unresolvable step is dropped as before.
    const resolvedSteps = await this.resolveSteps(parsedRaw.steps as Array<Record<string, unknown>>, session, {
      keepUnresolvable: config.reconRehearse,
    });
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
          const extracted = extractFirstJsonObject(raw2);
          if (!extracted) {
            this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge JSON parse failed');
            return [];
          }
          try {
            parsed = JSON.parse(extracted);
          } catch {
            this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge JSON parse failed');
            return [];
          }
          this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge response had non-JSON wrapper; recovered the JSON object');
        }
        if (!Array.isArray(parsed.steps)) return [];
        // Reconverge output always feeds the walk → keep unresolvable steps.
        return this.resolveSteps(parsed.steps as Array<Record<string, unknown>>, ctx.session, { keepUnresolvable: true });
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
   * `session.resolveTarget()`. Other kinds pass through untouched.
   *
   * When `opts.keepUnresolvable` is true, a click/type step whose target won't
   * resolve right now is kept with a sentinel target ({@link UNRESOLVED_SENTINEL}
   * + zero bbox) — the rehearsal walk re-resolves it at the actual page state.
   * When it's false (no rehearsal walk follows), or the step has no `target.description`
   * at all, the step is dropped (and logged).
   */
  private async resolveSteps(
    rawSteps: Array<Record<string, unknown>>,
    session: IPageSession,
    opts: { keepUnresolvable: boolean },
  ): Promise<PerformanceStep[]> {
    const resolved: PerformanceStep[] = [];
    for (const rawStep of rawSteps) {
      const kind = rawStep.kind;
      if (kind === 'click' || kind === 'type') {
        const desc = (rawStep.target as { description?: string } | undefined)?.description;
        if (!desc) { this.logger.debug({ rawStep }, 'recon step missing target description — dropped'); continue; }
        const r = await session.resolveTarget(desc).catch(() => null);
        if (!r || !r.bbox) {
          if (opts.keepUnresolvable) {
            this.logger.debug({ desc }, 'recon target unresolved eagerly — rehearsal walk will retry');
            const target = ResolvedTargetSchema.parse({ selector: UNRESOLVED_SENTINEL, bbox: { x: 0, y: 0, width: 0, height: 0 }, description: desc });
            resolved.push({ ...rawStep, target } as unknown as PerformanceStep);
          } else {
            this.logger.info({ desc }, 'recon target did not resolve — step dropped');
          }
          continue;
        }
        const target = ResolvedTargetSchema.parse({ selector: r.selector, bbox: r.bbox, description: desc });
        resolved.push({ ...rawStep, target } as unknown as PerformanceStep);
      } else {
        resolved.push(rawStep as unknown as PerformanceStep);
      }
    }
    return resolved;
  }

  /**
   * Make the recon chat call and parse a single JSON object out of the
   * response — even if the model (e.g. an Anthropic model via OpenRouter,
   * where `response_format: json_object` isn't reliably enforced) wraps it in
   * prose or markdown. On a hard parse failure / empty content, retries ONCE
   * with an emphatic JSON-only reminder appended; if the retry also fails,
   * throws {@link ReconError}.
   */
  private async callReconLlm(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    opts: { allowRetry: boolean },
  ): Promise<{ prompt?: unknown; durationMs?: unknown; steps?: unknown; totalEstimatedMs?: unknown; rationale?: unknown }> {
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 4000,
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw new ReconError('recon LLM call failed', err);
    }

    const retryWithReminder = (): ReturnType<LlmReconnoiterer['callReconLlm']> =>
      this.callReconLlm(
        [
          ...messages,
          {
            role: 'user',
            content:
              'REMINDER: your previous response was not valid JSON. Respond with ONLY a single JSON object — no prose, no markdown, nothing before or after it.',
          },
        ],
        { allowRetry: false },
      );

    if (!raw) {
      if (opts.allowRetry) return retryWithReminder();
      throw new ReconError('recon returned empty content');
    }

    // Fast path: the whole response is JSON (possibly fenced).
    try {
      return JSON.parse(stripCodeFence(raw)) as Record<string, unknown>;
    } catch {
      // fall through to wrapper recovery
    }

    // Recovery: pull the first balanced {...} out of a prose wrapper.
    const extracted = extractFirstJsonObject(raw);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted) as Record<string, unknown>;
        this.logger.warn({ rawPreview: raw.slice(0, 120) }, 'recon response had non-JSON wrapper; recovered the JSON object');
        return parsed;
      } catch {
        // fall through to retry / throw
      }
    }

    if (opts.allowRetry) return retryWithReminder();
    throw new ReconError(`recon JSON parse failed (after retry): ${raw.slice(0, 200)}`);
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

/**
 * Scan `s` for the first `{`, then walk forward tracking brace depth — being
 * string-literal aware (braces inside `"..."` don't count, and `\"` escapes
 * are handled) — until depth returns to 0. Returns that balanced `{...}`
 * substring, or `null` if there's no `{` or no balanced object. Lets us
 * recover JSON wrapped in prose, e.g. `Here's the plan: { ... } Hope it helps!`
 */
export function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
