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
import { ARIA_SNAPSHOT_TRUNCATION_MARKER } from '../../ports/page-session.js';
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
    // won't resolve (nor by visible text, nor by `observe()` description) drops
    // its step — and lands in `unresolved` so the dropped intent is reported
    // transparently. Other kinds pass straight through.
    const { steps: resolvedSteps, unresolved } = await this.resolveDraftSteps(draft.steps, session);
    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after ref resolution');
    }
    // The aria tree was too big to show in full → the ref-picking was working
    // off a truncated view; say so when we surface what we couldn't locate.
    const treeTruncated = snapshot.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);
    // Click/type targets the reconverge LLM (during the rehearsal walk) emitted
    // but couldn't be resolved either — accumulated so they're surfaced too, not
    // just the initial draft's drops (the §0038 fix only covered the latter).
    const reconvergeUnresolved: string[] = [];

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
        const { steps, unresolved: u } = await this.resolveDraftSteps(parsed.data.steps, ctx.session);
        reconvergeUnresolved.push(...u);
        return steps;
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

    // Recon LLMs routinely mis-size the window — usually over-packing (a 10 s
    // budget comes back as a 13–14 s plan), occasionally under. Compress or pad
    // the plan deterministically so it fits the duration the user paid for
    // before we hand it off (goals.md #2). "Fit the recording into the budget"
    // is mechanical — goals.md #6 carve-out.
    finalSteps = fitPlanToBudget(finalSteps, input.durationMs);

    // What requested intent we couldn't actually plan — surfaced so the metric
    // is honest (`unmet`/`partial` naming the target, never silent `unknown`):
    //  - the initial draft's unresolvable click/type targets, and the
    //    reconverge's (§0038 + this fix);
    //  - and, as a backstop, if the rehearsal walk's recovery ended up with NO
    //    click/type step at all even though the draft asked for one, name those
    //    too (the reconverge gave a click-less plan — recon-quality variance).
    const annotateMiss = (d: string): string =>
      treeTruncated ? `${d} (page tree too large to analyze in full)` : d;
    let unresolvedTargets = [...new Set([...unresolved, ...reconvergeUnresolved])].map(annotateMiss);
    const requestedActingDescriptions = draft.steps.flatMap((s) =>
      s.kind === 'click' || s.kind === 'type' ? [s.targetDescription] : [],
    );
    const finalHasActing = finalSteps.some((s) => s.kind === 'click' || s.kind === 'type');
    if (unresolvedTargets.length === 0 && requestedActingDescriptions.length > 0 && !finalHasActing) {
      unresolvedTargets = [...new Set(requestedActingDescriptions)].map(
        (d) => `${d} (the rehearsal walk's recovery couldn't keep this in the plan)`,
      );
    }

    const candidate: Performance = {
      prompt: draft.prompt,
      durationMs: input.durationMs,
      steps: finalSteps,
      totalEstimatedMs: sumDurations(finalSteps),
      rationale: draft.rationale,
      ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
      ...(blockerDismissal ? { blockerDismissal } : {}),
      ...(unresolvedTargets.length > 0 ? { unresolvedTargets } : {}),
    };
    const validation = PerformanceSchema.safeParse(candidate);
    if (!validation.success) {
      throw new ReconError(`recon Performance failed schema: ${validation.error.message.slice(0, 400)}`);
    }
    if (unresolvedTargets.length > 0) {
      this.logger.warn({ unresolvedTargets, treeTruncated }, 'recon dropped requested click/type step(s) — target(s) not locatable on the page');
    }
    this.logger.info(
      { stepCount: validation.data.steps.length, totalEstimatedMs: validation.data.totalEstimatedMs, durationMs: input.durationMs, rehearsal: rehearsalTrace, unresolvedTargets: unresolvedTargets.length || undefined },
      'recon complete',
    );
    return validation.data;
  }

  /**
   * Turn parsed {@link ReconDraftStep}s into {@link PerformanceStep}s.
   *
   * scroll/key/dwell/back/done pass through (their schemas are shared).
   * click/type: resolve the target, trying in order —
   *   1. `session.resolveAriaRef(ref)` — deterministic, no LLM (the primary path).
   *   2. (click only, when the draft gave a `targetText`)
   *      `session.resolveByVisibleText(targetText)` — a deterministic Playwright
   *      role/text lookup; no DOM serialization, so it works even on huge pages
   *      where the `observe()` fallback overflows the model context.
   *   3. `session.resolveTargetCandidates(targetDescription)[0]` — the fuzzy
   *      `observe()` re-match (the original §0036 fallback).
   * If all of them miss, the step is dropped — and its `targetDescription` is
   * collected in the returned `unresolved` list so `intentSatisfaction` can
   * report the dropped intent transparently rather than silently `unknown`.
   * The kept step's `target.description` is always the LLM's `targetDescription`
   * (its intent — best fodder for the walk's dead-click sweep / the metric).
   */
  private async resolveDraftSteps(
    draftSteps: ReconDraftStep[],
    session: IPageSession,
  ): Promise<{ steps: PerformanceStep[]; unresolved: string[] }> {
    const resolved: PerformanceStep[] = [];
    const unresolved: string[] = [];
    for (const step of draftSteps) {
      if (step.kind !== 'click' && step.kind !== 'type') {
        resolved.push(step);
        continue;
      }
      let r = await session.resolveAriaRef(step.ref).catch(() => null);
      if ((!r || !r.bbox) && step.kind === 'click' && step.targetText) {
        r = await session.resolveByVisibleText(step.targetText).catch(() => null);
        if (r && r.bbox) {
          this.logger.info({ ref: step.ref, text: step.targetText }, 'recon ref miss — resolved by visible text');
        }
      }
      if (!r || !r.bbox) {
        r = (await session.resolveTargetCandidates(step.targetDescription).catch(() => []))[0] ?? null;
        if (r && r.bbox) {
          this.logger.info({ ref: step.ref, kind: step.kind, desc: step.targetDescription }, 'recon ref miss — fell back to description lookup');
        }
      }
      if (!r || !r.bbox) {
        this.logger.info({ ref: step.ref, kind: step.kind, desc: step.targetDescription }, 'recon target did not resolve (ref + visible-text + description all missed) — step dropped');
        unresolved.push(step.targetDescription);
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
    return { steps: resolved, unresolved };
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

/**
 * Estimate how long playback of `steps` actually takes — the basis for
 * `Performance.totalEstimatedMs` and the target {@link fitPlanToBudget} fits to.
 * Mirrors what {@link PerformanceDirector} does per step, plus the unlogged
 * per-step overhead the Director can't avoid:
 *  - dwell/scroll: exactly their declared timings.
 *  - click: the anticipation pause + a page-settle wait afterwards
 *    (`config.pacingSettleEstMs`).
 *  - key/back: a page-settle wait afterwards (`config.pacingSettleEstMs`).
 *  - type: the pre-pause + per-keystroke delay (the focus click is negligible).
 *  - done: nothing — it ends the run.
 *  - every non-`done` step: `config.pacingStepOverheadMs` (mouse moves,
 *    actionability waits, the post-click `expectAfter` probe, scroll-animation
 *    overshoot, …).
 * The settle term used to be a hard-coded 400 ms and there was no per-step
 * overhead, which undercounted the window by ~1–2 s and made recordings
 * overrun the requested duration; see
 * docs/findings/2026-05-12-recordvideo-clock-drift.md.
 */
function sumDurations(steps: PerformanceStep[]): number {
  let total = 0;
  for (const s of steps) {
    if (s.kind !== 'done') total += config.pacingStepOverheadMs;
    switch (s.kind) {
      case 'dwell': total += s.durationMs; break;
      case 'scroll': total += s.durationMs + s.dwellAfterMs; break;
      case 'click': total += s.anticipationMs + config.pacingSettleEstMs; break;
      case 'type': total += s.preMs + s.text.length * s.keystrokeMs; break;
      case 'key': total += config.pacingSettleEstMs; break;
      case 'back': total += config.pacingSettleEstMs; break;
      case 'done': break;
    }
  }
  return total;
}

/**
 * Make a plan's estimated playback time fit `durationMs`.
 *
 * Reconnaissance LLMs are poor at the budget arithmetic — they typically
 * over-pack (a 10 s budget comes back as a 13–14 s plan; the recording then
 * overruns and the deliverable trips goals.md #2's ±10 % bright-line), and
 * occasionally under-pack. We fix it deterministically, off-camera, AFTER any
 * rehearsal walk:
 *
 *  - Over budget: uniformly scale down the *controllable* timings — scroll
 *    durations + their trailing dwells, dwell durations, click anticipation,
 *    type pre-pauses — keeping every step, its order, and its easing, and never
 *    below sane floors. Fixed costs the Director incurs regardless (the
 *    post-click/key/back page-settle wait, per-keystroke typing speed, the
 *    per-step overhead) are not scaled.
 *  - Well under budget (< 90 %): append one gentle closing `scroll` + `dwell`
 *    sized to the gap (clamped to the step schema's bounds), before the final
 *    `done` if there is one.
 *
 * "Fit the recording into the duration the user paid for" is mechanical, not a
 * behaviour threshold — goals.md #6 carve-out.
 */
export function fitPlanToBudget(steps: PerformanceStep[], durationMs: number): PerformanceStep[] {
  let fixedMs = 0;       // costs we can't shrink: post-action settle waits + typing speed + per-step overhead
  let controllableMs = 0; // scroll/dwell/anticipation/preMs — the slack we can compress
  for (const s of steps) {
    if (s.kind !== 'done') fixedMs += config.pacingStepOverheadMs;
    switch (s.kind) {
      case 'dwell': controllableMs += s.durationMs; break;
      case 'scroll': controllableMs += s.durationMs + s.dwellAfterMs; break;
      case 'click': controllableMs += s.anticipationMs; fixedMs += config.pacingSettleEstMs; break;
      case 'type': controllableMs += s.preMs; fixedMs += s.text.length * s.keystrokeMs; break;
      case 'key': fixedMs += config.pacingSettleEstMs; break;
      case 'back': fixedMs += config.pacingSettleEstMs; break;
      case 'done': break;
    }
  }
  const estimatedMs = fixedMs + controllableMs;

  // Over budget: compress the controllable slack to whatever room the fixed
  // costs leave. (If the fixed costs alone already exceed the budget there's
  // nothing useful to do here — leave it; the Director's hard cap is the
  // backstop.)
  if (estimatedMs > durationMs && controllableMs > 0 && durationMs > fixedMs) {
    const scale = (durationMs - fixedMs) / controllableMs;
    if (scale < 1) {
      return steps.map((s): PerformanceStep => {
        switch (s.kind) {
          case 'dwell':
            return { ...s, durationMs: Math.max(100, Math.round(s.durationMs * scale)) };
          case 'scroll':
            return {
              ...s,
              durationMs: Math.max(200, Math.round(s.durationMs * scale)),
              dwellAfterMs: Math.max(0, Math.round(s.dwellAfterMs * scale)),
            };
          case 'click':
            return { ...s, anticipationMs: Math.max(0, Math.round(s.anticipationMs * scale)) };
          case 'type':
            return { ...s, preMs: Math.max(0, Math.round(s.preMs * scale)) };
          default:
            return s;
        }
      });
    }
  }

  // Well under budget: pad with one gentle closing scroll + dwell sized to the
  // gap (within the step schema's bounds), inserted before the trailing `done`.
  // The two new steps carry their own per-step overhead, so net it out first.
  if (estimatedMs < durationMs * 0.9) {
    let gap = durationMs - estimatedMs - 2 * config.pacingStepOverheadMs;
    const scrollMs = Math.min(2200, Math.max(600, Math.round(gap * 0.45)));
    gap -= scrollMs;
    const dwellAfterMs = 200;
    gap -= dwellAfterMs;
    const dwellMs = Math.min(8000, Math.max(300, gap));
    const filler: PerformanceStep[] = [
      { kind: 'scroll', deltaPx: 320, durationMs: scrollMs, easing: 'inOutQuad', dwellAfterMs, reasoning: 'closing browse to fill the requested recording duration' },
      { kind: 'dwell', durationMs: dwellMs, reasoning: 'settle on the page before the recording ends' },
    ];
    const lastIsDone = steps.length > 0 && steps[steps.length - 1]!.kind === 'done';
    return lastIsDone ? [...steps.slice(0, -1), ...filler, steps[steps.length - 1]!] : [...steps, ...filler];
  }

  return steps;
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
