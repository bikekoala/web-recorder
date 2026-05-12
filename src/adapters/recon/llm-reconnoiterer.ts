import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  type Performance,
  type PerformanceStep,
  type RehearsalTrace,
} from '../../domain/performance.js';
import {
  ReconDraftSchema,
  ReconvergeDraftSchema,
  type ReconDraftStep,
} from '../../domain/recon-draft.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import { buildReconUserText, buildReconvergeUserText, reconnoitererSystemPrompt } from '../../prompts/index.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer, ReconInput } from '../../ports/reconnoiterer.js';
import type { IBlockerDismisser, BlockerDismissalReport } from '../../ports/blocker-dismisser.js';
import { rehearse, type ReconvergeContext } from './rehearsal.js';

/**
 * LlmReconnoiterer — IReconnoiterer backed by a vision LLM via OpenRouter.
 * Default model: config.llmReconModelResolved (the resolved planner model).
 *
 * Pipeline (ADR §0036 — ref-tagged a11y snapshot target resolution):
 *   1. session.ariaSnapshot() — a deterministic ref-tagged accessibility tree
 *      (replaces the old `observeAll()` LLM enumeration).
 *   2. one chat call (screenshot + intent + aria tree) -> a raw draft where each
 *      click/type step carries a `ref` into that tree; parsed via ReconDraftSchema.
 *   3. resolve each `ref` to a ResolvedTarget via session.resolveAriaRef() —
 *      deterministic, no LLM; a ref that won't resolve drops the step.
 *   4. (config.reconRehearse) run the off-camera rehearsal walk over the resolved
 *      draft — verifies each acting step against the live page, reconverges (with a
 *      fresh aria snapshot) on divergence — then reset the page to the start URL so
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
  blockerDismisser?: IBlockerDismisser;
}

export class LlmReconnoiterer implements IReconnoiterer {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly blockerDismisser: IBlockerDismisser | null;
  private readonly logger = rootLogger.child({ component: 'LlmReconnoiterer' });

  constructor(opts: LlmReconnoitererOpts = {}) {
    this.model = opts.model ?? config.llmReconModelResolved;
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
    this.blockerDismisser = opts.blockerDismisser ?? null;
  }

  get modelId(): string { return this.model; }

  /** Run the off-camera blocker dismisser (if configured); never throws. */
  private async dismissBlockers(session: IPageSession): Promise<BlockerDismissalReport | null> {
    if (!this.blockerDismisser) return null;
    try {
      return await this.blockerDismisser.dismiss(session);
    } catch (err) {
      this.logger.warn({ err }, 'blocker dismisser threw — proceeding without it');
      return { rounds: 0, dismissed: [], stillBlocked: true };
    }
  }

  async recon(input: ReconInput, session: IPageSession): Promise<Performance> {
    // Off-camera: clear cookie/consent banners / X-to-close modals before we
    // snapshot + plan, so the Performance is built against the real page.
    const blockerDismissal = await this.dismissBlockers(session);

    // Deterministic ref-tagged accessibility tree — the planner's view of the page.
    const snapshot = await session.ariaSnapshot().catch(() => '');
    const userText = buildReconUserText(input, snapshot);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (input.screenshot && input.screenshot.length > 0) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
    }

    const draftRaw = await this.callReconLlm(
      [
        { role: 'system', content: reconnoitererSystemPrompt },
        { role: 'user', content: userContent },
      ],
      { allowRetry: true },
    );
    const draftParsed = ReconDraftSchema.safeParse(draftRaw);
    if (!draftParsed.success) {
      throw new ReconError(`recon draft failed schema: ${draftParsed.error.message.slice(0, 400)}`);
    }
    const draft = draftParsed.data;

    // Resolve every click/type ref against the snapshot we just took (refs are
    // valid only in that page state — resolve now, not deferred). A ref that
    // won't resolve drops its step. Other kinds pass straight through.
    const resolvedSteps = await this.resolveDraftSteps(draft.steps, session);
    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after ref resolution');
    }

    // Off-camera rehearsal walk (config.reconRehearse). Verifies the draft
    // against the live page, reconverging on divergence; afterwards we reset
    // the page to the start URL so the on-camera run reproduces the start state.
    let finalSteps: PerformanceStep[] = resolvedSteps;
    let rehearsalTrace: RehearsalTrace | undefined;
    if (config.reconRehearse) {
      const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
        const snapshot = await ctx.session.ariaSnapshot().catch(() => '');
        const screenshot = await ctx.session.screenshot().catch(() => null);
        const userText = buildReconvergeUserText({
          intent: ctx.intent,
          divergedStep: ctx.divergedStep,
          observedUrl: ctx.observedUrl,
          snapshot,
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
        let obj: unknown;
        try {
          obj = JSON.parse(stripCodeFence(raw2));
        } catch {
          const extracted = extractFirstJsonObject(raw2);
          if (!extracted) {
            this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge JSON parse failed');
            return [];
          }
          try {
            obj = JSON.parse(extracted);
          } catch {
            this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge JSON parse failed');
            return [];
          }
          this.logger.warn({ rawPreview: raw2.slice(0, 120) }, 'reconverge response had non-JSON wrapper; recovered the JSON object');
        }
        const parsed = ReconvergeDraftSchema.safeParse(obj);
        if (!parsed.success) {
          this.logger.warn({ err: parsed.error.message.slice(0, 200) }, 'reconverge draft failed schema');
          return [];
        }
        return this.resolveDraftSteps(parsed.data.steps, ctx.session);
      };
      let result: Awaited<ReturnType<typeof rehearse>>;
      try {
        result = await rehearse({
          draftSteps: resolvedSteps,
          session,
          intent: draft.prompt,
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
        // The walk reloaded the page — a consent banner / modal can be back.
        // Re-dismiss so the on-camera run starts on a clean page too.
        await this.dismissBlockers(session);
        await session.waitForVisualStability();
      } catch (err) {
        this.logger.warn({ err }, 'page reset after rehearsal failed — on-camera run may diverge (the director re-plan/graceful-degradation is the backstop)');
      }
    }

    const candidate: Performance = {
      prompt: draft.prompt,
      durationMs: input.durationMs,
      steps: finalSteps,
      totalEstimatedMs: sumDurations(finalSteps),
      rationale: draft.rationale,
      ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
      ...(blockerDismissal ? { blockerDismissal } : {}),
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
   * Turn parsed {@link ReconDraftStep}s into {@link PerformanceStep}s.
   * scroll/key/dwell/back/done pass through (their schemas are shared).
   * click/type: resolve the `ref` against the most-recent aria snapshot via
   * `session.resolveAriaRef()` (deterministic, no LLM); if that misses (the LLM
   * picked a stale / wrong ref out of a huge tree) fall back to a fuzzy lookup by
   * `targetDescription` (`session.resolveTargetCandidates(...)[0]`); if BOTH miss,
   * drop the step. The kept step's `target.description` is always the LLM's
   * `targetDescription` (its intent — best fodder for the walk's dead-click sweep).
   */
  private async resolveDraftSteps(
    draftSteps: ReconDraftStep[],
    session: IPageSession,
  ): Promise<PerformanceStep[]> {
    const resolved: PerformanceStep[] = [];
    for (const step of draftSteps) {
      if (step.kind !== 'click' && step.kind !== 'type') {
        resolved.push(step);
        continue;
      }
      let r = await session.resolveAriaRef(step.ref).catch(() => null);
      if (!r || !r.bbox) {
        r = (await session.resolveTargetCandidates(step.targetDescription).catch(() => []))[0] ?? null;
        if (r && r.bbox) {
          this.logger.info({ ref: step.ref, kind: step.kind, desc: step.targetDescription }, 'recon ref miss — fell back to description lookup');
        }
      }
      if (!r || !r.bbox) {
        this.logger.info({ ref: step.ref, kind: step.kind, desc: step.targetDescription }, 'recon target did not resolve (ref + description both missed) — step dropped');
        continue;
      }
      const target = ResolvedTargetSchema.parse({ selector: r.selector, bbox: r.bbox, description: step.targetDescription });
      if (step.kind === 'click') {
        resolved.push({
          kind: 'click',
          target,
          anticipationMs: step.anticipationMs,
          reasoning: step.reasoning,
          ...(step.expectAfter !== undefined ? { expectAfter: step.expectAfter } : {}),
        });
      } else {
        resolved.push({
          kind: 'type',
          target,
          text: step.text,
          preMs: step.preMs,
          keystrokeMs: step.keystrokeMs,
          reasoning: step.reasoning,
        });
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
   * throws {@link ReconError}. (Shape validation is the caller's job — this
   * returns `unknown`.)
   */
  private async callReconLlm(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    opts: { allowRetry: boolean },
  ): Promise<unknown> {
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

    const retryWithReminder = (): Promise<unknown> =>
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
      return JSON.parse(stripCodeFence(raw));
    } catch {
      // fall through to wrapper recovery
    }

    // Recovery: pull the first balanced {...} out of a prose wrapper.
    const extracted = extractFirstJsonObject(raw);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted);
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
