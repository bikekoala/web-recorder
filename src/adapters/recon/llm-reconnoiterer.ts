import OpenAI from 'openai';

import { DomainError } from '../../domain/errors.js';
import {
  PerformanceSchema,
  ResolvedTargetSchema,
  type Performance,
  type PerformanceStep,
  type PlanDurationFit,
  type ReconLlmUsage,
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

/**
 * Mutable token-usage accumulator passed through the recon() call chain so
 * every LLM completions.create() invocation (initial draft, reconverge-on-drop,
 * mid-walk reconverge) contributes to one running total. Materialized into the
 * Performance's optional `reconLlm` field at the end. F2 cost-tracking.
 */
interface UsageAccumulator {
  calls: number;
  promptTokens: number;
  completionTokens: number;
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
    // Per-recon usage accumulator — every LLM call inside this method (initial
    // draft, reconverge-on-drop, mid-walk reconverges) contributes to it. F2
    // cost tracking: surfaces on Performance.reconLlm at the end.
    const usage: UsageAccumulator = { calls: 0, promptTokens: 0, completionTokens: 0 };

    // Off-camera: clear cookie/consent banners / X-to-close modals before we
    // snapshot + plan, so the Performance is built against the real page.
    const blockerDismissal = await this.dismissBlockers(session);

    // Deterministic ref-tagged accessibility tree — the planner's view of the page.
    const snapshot = await session.ariaSnapshot().catch(() => '');
    // Measure how far the page can scroll below the current position. Lets the
    // recon prompt size scrolls against reality (2026-05-15 HN finding —
    // blind 600px scrolls on a 200-px-tall page are no-ops + dead air). Caller
    // can pre-fill via input.pageScrollableHeight (re-plan paths know what
    // they observed); first-recon path measures here.
    const pageScrollableHeight = input.pageScrollableHeight
      ?? await session.scrollableHeight().catch(() => 0);
    const userText = buildReconUserText({ ...input, pageScrollableHeight }, snapshot);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText }];
    if (input.screenshot && input.screenshot.length > 0) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
    }

    const draftRaw = await this.callReconLlm(
      [
        { role: 'system', content: reconnoitererSystemPrompt },
        { role: 'user', content: userContent },
      ],
      { allowRetry: true, usage },
    );
    const draftParsed = ReconDraftSchema.safeParse(draftRaw);
    if (!draftParsed.success) {
      throw new ReconError(`recon draft failed schema: ${draftParsed.error.message.slice(0, 400)}`);
    }
    // `let` (not `const`): the reconverge-on-drop branch below may replace this
    // with the second-attempt draft so downstream checks (e.g. the requested-
    // acting-descriptions backstop) operate against the plan that's actually
    // being executed.
    let draft = draftParsed.data;

    // Resolve every click/type ref against the snapshot we just took (refs are
    // valid only in that page state — resolve now, not deferred). A ref that
    // won't resolve (nor by visible text, nor by `observe()` description) drops
    // its step — and lands in `unresolved` so the dropped intent is reported
    // transparently. Other kinds pass straight through.
    let { steps: resolvedSteps, unresolved } = await this.resolveDraftSteps(draft.steps, session, input.url);
    let treeTruncated = snapshot.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);

    // §0042 / P13 fix — reconverge-on-initial-resolve-drop. If A's first draft
    // requested targets that couldn't be located on this page, give A one more
    // shot with the dropped descriptions as a "don't try these" hint plus a
    // fresh aria snapshot. Symmetric with the rehearsal walk's mid-step
    // reconverge but fired here so the walk runs on the better plan. Only ever
    // ONE retry — if it still drops, that's the honest §0042 graceful-degrade.
    //
    // GATE — skip on truncated trees: the aria tree was too big to show in full
    // and A literally cannot see what we're asking it to avoid (the target was
    // pruned out, not mis-picked). Re-asking against the same truncated slice
    // produces a similarly-shaped plan and burns 30-60 s of recon LLM time for
    // no quality gain — sweep R8.1 MDN confirmed this. Truncated cases stay on
    // the §0042 honest-graceful-degrade path (`unresolvedTargets` surfaces the
    // miss; intentSatisfaction reports `unmet` with reason).
    if (config.reconReconvergeOnDrop && unresolved.length > 0 && !input.priorAttemptDrops && !treeTruncated) {
      this.logger.info({ drops: unresolved, treeTruncated }, 'initial resolve dropped targets — reconverging on drop');
      try {
        const snapshot2 = await session.ariaSnapshot();
        const treeTruncated2 = snapshot2.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);
        const pageScrollableHeight2 = await session.scrollableHeight().catch(() => pageScrollableHeight);
        const userText2 = buildReconUserText({ ...input, priorAttemptDrops: unresolved, pageScrollableHeight: pageScrollableHeight2 }, snapshot2);
        const userContent2: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText2 }];
        if (input.screenshot && input.screenshot.length > 0) {
          userContent2.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
        }
        const draftRaw2 = await this.callReconLlm(
          [
            { role: 'system', content: reconnoitererSystemPrompt },
            { role: 'user', content: userContent2 },
          ],
          { allowRetry: true, usage },
        );
        const draftParsed2 = ReconDraftSchema.safeParse(draftRaw2);
        if (!draftParsed2.success) {
          this.logger.warn({ err: draftParsed2.error.message.slice(0, 200) }, 'reconverge-on-drop draft failed schema — keeping initial residue');
        } else {
          const result2 = await this.resolveDraftSteps(draftParsed2.data.steps, session, input.url);
          if (result2.steps.length > 0) {
            resolvedSteps = result2.steps;
            unresolved = result2.unresolved;
            treeTruncated = treeTruncated2;
            // Replace `draft` so the downstream requested-acting backstop reflects
            // the SECOND draft's intent, not the first one's discarded clicks.
            draft = draftParsed2.data;
            this.logger.info({ remainingDrops: unresolved.length, newStepCount: resolvedSteps.length }, 'reconverge-on-drop produced a usable replacement plan');
          } else {
            this.logger.warn('reconverge-on-drop produced zero usable steps — keeping initial residue');
          }
        }
      } catch (err) {
        this.logger.warn({ err }, 'reconverge-on-drop failed — keeping initial residue');
      }
    }

    if (resolvedSteps.length === 0) {
      throw new ReconError('recon produced zero usable steps after ref resolution');
    }
    // `treeTruncated` was set above against whichever snapshot fed the surviving
    // plan (initial or reconverge-on-drop). When we surface unresolved targets
    // we annotate them with "(page tree too large to analyze in full)" if true.
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
        const remainingDurationMs = Math.max(0, input.durationMs - (ctx.walkedDeclaredMs ?? 0));
        const userText = buildReconvergeUserText({
          intent: ctx.intent,
          divergedStep: ctx.divergedStep,
          observedUrl: ctx.observedUrl,
          snapshot,
          remainingDurationMs,
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
            // 4000 (was 3000): aligned with the initial recon bump above —
            // F1's natural-filler instruction encourages longer plans, and a
            // reconverge for the remaining tail can still be sizeable.
            max_tokens: 4000,
          });
          raw2 = completion.choices[0]?.message?.content ?? '';
          if (completion.usage) {
            usage.calls += 1;
            usage.promptTokens += completion.usage.prompt_tokens ?? 0;
            usage.completionTokens += completion.usage.completion_tokens ?? 0;
          }
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
        const { steps, unresolved: u } = await this.resolveDraftSteps(parsed.data.steps, ctx.session, input.url);
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

    // Plan Y (2026-05-15): reconverge-on-overbudget. B computes the
    // deterministic cost of the walked plan; if it overshoots the budget by
    // more than the tolerance, give A ONE retry with the actual gap. A no
    // longer self-reports cost — the runner does, and tells A the truth.
    // Independent of the §0042 reconverge-on-drop and the rehearsal walk's
    // mid-step reconverge. Gated after the walk (not before) because the
    // walk's divergence-driven adjustments can grow the plan — that's the
    // cost we actually need to gate against.
    //
    // We do NOT walk the reconverged plan a second time: the reconverge is
    // asked to drop steps from an already-walked plan, so most of the new
    // plan is a subset of validated steps. The Director's graceful-degrade
    // handles any residual divergence on-camera.
    //
    // GATE — only "are we over budget" and "is this not already a retry".
    // A truncated tree is NOT a gate here (unlike §0042 reconverge-on-drop):
    // overbudget asks A to drop steps from the SAME tree it just planned
    // against — truncation didn't cause the overshoot, the planner's
    // step-count choice did. The 2026-05-15 HN run had a truncated tree and
    // a 2× overshoot; gating on truncation kept the dwell-crush failure
    // mode alive.
    const TOL = config.planDurationFitToleranceRatio;
    const walkedCostMs = sumDurations(finalSteps);
    if (
      config.reconReconvergeOnOverbudget
      && !input.priorAttemptOverBudgetMs
      && walkedCostMs > Math.round(input.durationMs * (1 + TOL))
    ) {
      this.logger.info({ walkedCostMs, budgetMs: input.durationMs, ratio: +(walkedCostMs / input.durationMs).toFixed(2) }, 'plan over budget — reconverging on overbudget');
      try {
        const snapshot3 = await session.ariaSnapshot();
        const treeTruncated3 = snapshot3.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);
        const pageScrollableHeight3 = await session.scrollableHeight().catch(() => pageScrollableHeight);
        const userText3 = buildReconUserText({
          ...input,
          pageScrollableHeight: pageScrollableHeight3,
          priorAttemptOverBudgetMs: { actualMs: walkedCostMs, budgetMs: input.durationMs },
        }, snapshot3);
        const userContent3: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: userText3 }];
        if (input.screenshot && input.screenshot.length > 0) {
          userContent3.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshot.toString('base64')}` } });
        }
        const draftRaw3 = await this.callReconLlm(
          [
            { role: 'system', content: reconnoitererSystemPrompt },
            { role: 'user', content: userContent3 },
          ],
          { allowRetry: true, usage },
        );
        const draftParsed3 = ReconDraftSchema.safeParse(draftRaw3);
        if (!draftParsed3.success) {
          this.logger.warn({ err: draftParsed3.error.message.slice(0, 200) }, 'reconverge-on-overbudget draft failed schema — keeping walked plan');
        } else {
          const result3 = await this.resolveDraftSteps(draftParsed3.data.steps, session, input.url);
          const newCostMs = sumDurations(result3.steps);
          // Take the new plan only if it's actually shorter and resolves to
          // a usable set of steps. A occasionally returns a plan as long as
          // (or longer than) the original — in that case the original is no
          // worse and we save the swap.
          if (result3.steps.length > 0 && newCostMs < walkedCostMs) {
            finalSteps = result3.steps;
            // Merge unresolved targets so nothing gets silently dropped
            // between attempts (§0042 transparency).
            unresolved = [...new Set([...unresolved, ...result3.unresolved])];
            treeTruncated = treeTruncated3;
            draft = draftParsed3.data;
            this.logger.info({ newCostMs, oldCostMs: walkedCostMs, gapMs: walkedCostMs - newCostMs }, 'reconverge-on-overbudget produced a shorter plan');
          } else {
            this.logger.warn({ newCostMs, oldCostMs: walkedCostMs, newStepCount: result3.steps.length }, 'reconverge-on-overbudget did not shrink the plan — keeping walked plan');
          }
        }
      } catch (err) {
        this.logger.warn({ err }, 'reconverge-on-overbudget failed — keeping walked plan');
      }
    }

    // Recon LLMs routinely mis-size the window — usually over-packing (a 10 s
    // budget comes back as a 13–14 s plan), occasionally under. Compress or pad
    // the plan deterministically so it fits the duration the user paid for
    // before we hand it off (goals.md #2). "Fit the recording into the budget"
    // is mechanical — goals.md #6 carve-out.
    const fitOutcome = fitPlanToBudget(finalSteps, input.durationMs, draft.totalEstimatedMs);
    finalSteps = fitOutcome.steps;

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
    // `goto` is an acting step too — if A planned to navigate but the walk's
    // recovery dropped it (e.g. cross-host enforcement, or reconverge picked a
    // pure read-plan), surface the lost navigation the same way we surface a
    // lost click. The `targetDescription` for a goto is its destination URL.
    const requestedActingDescriptions = draft.steps.flatMap((s) =>
      s.kind === 'click' || s.kind === 'type' ? [s.targetDescription]
        : s.kind === 'goto' ? [`goto ${s.url}`]
        : [],
    );
    const finalHasActing = finalSteps.some((s) => s.kind === 'click' || s.kind === 'type' || s.kind === 'goto');
    if (unresolvedTargets.length === 0 && requestedActingDescriptions.length > 0 && !finalHasActing) {
      unresolvedTargets = [...new Set(requestedActingDescriptions)].map(
        (d) => `${d} (the rehearsal walk's recovery couldn't keep this in the plan)`,
      );
    }

    const reconLlm: ReconLlmUsage = { model: this.model, ...usage };
    const candidate: Performance = {
      prompt: draft.prompt,
      durationMs: input.durationMs,
      steps: finalSteps,
      totalEstimatedMs: sumDurations(finalSteps),
      rationale: draft.rationale,
      ...(rehearsalTrace ? { rehearsal: rehearsalTrace } : {}),
      ...(blockerDismissal ? { blockerDismissal } : {}),
      ...(unresolvedTargets.length > 0 ? { unresolvedTargets } : {}),
      planDurationFit: fitOutcome.fit,
      reconLlm,
    };
    const validation = PerformanceSchema.safeParse(candidate);
    if (!validation.success) {
      throw new ReconError(`recon Performance failed schema: ${validation.error.message.slice(0, 400)}`);
    }
    if (unresolvedTargets.length > 0) {
      this.logger.warn({ unresolvedTargets, treeTruncated }, 'recon dropped requested click/type step(s) — target(s) not locatable on the page');
    }
    this.logger.info(
      {
        stepCount: validation.data.steps.length,
        totalEstimatedMs: validation.data.totalEstimatedMs,
        durationMs: input.durationMs,
        rehearsal: rehearsalTrace,
        unresolvedTargets: unresolvedTargets.length || undefined,
        planDurationFit: fitOutcome.fit,
        reconLlm,
      },
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
    startingUrl: string,
  ): Promise<{ steps: PerformanceStep[]; unresolved: string[] }> {
    const resolved: PerformanceStep[] = [];
    const unresolved: string[] = [];
    const startingHost = safeHostname(startingUrl);
    for (const step of draftSteps) {
      // goto: same-host enforcement (ADR §0041). Cross-host gotos are dropped
      // and surfaced via `unresolvedTargets` — A shouldn't be teleporting away
      // from the user's intended site. Same-host gotos pass through; the
      // Director plays them as `wait(anticipationMs)` + `session.goto(url)` +
      // `waitForVisualStability()`.
      if (step.kind === 'goto') {
        const targetHost = safeHostname(step.url);
        if (!targetHost || !startingHost || targetHost !== startingHost) {
          this.logger.warn(
            { stepUrl: step.url, startingUrl, targetHost, startingHost },
            'recon planned a cross-host goto — dropping (same-host only per ADR §0041)',
          );
          unresolved.push(`goto ${step.url} (cross-host — same-host rule per ADR §0041)`);
          continue;
        }
        resolved.push(step);
        continue;
      }
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
    opts: { allowRetry: boolean; usage?: UsageAccumulator },
  ): Promise<unknown> {
    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        // 8000 (was 6000, originally 4000): post-F1's DURATION & SCOPE prompt
        // encourages the recon LLM to plan more natural-filler steps; on
        // open-ended Chinese prompts (gmaps "just observe" / "看一眼就好") the
        // model's reasoning fields can run past 6000 tokens occasionally and
        // truncate mid-response → ReconError. 8000 gives breathing room
        // without being lavish. Real fix is F2 (plan-size budget — "steps per
        // second" + "reasoning under N chars"), which would let the cap go
        // back down; for now, just give it room.
        max_tokens: 8000,
      });
      raw = completion.choices[0]?.message?.content ?? '';
      if (opts.usage && completion.usage) {
        opts.usage.calls += 1;
        opts.usage.promptTokens += completion.usage.prompt_tokens ?? 0;
        opts.usage.completionTokens += completion.usage.completion_tokens ?? 0;
      }
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
              'REMINDER: your previous response was not valid JSON. Respond with ONLY a single JSON object — no prose, no markdown, nothing before or after it. Common failure mode I have just seen: writing a paragraph of narrative inside one step\'s `reasoning` field — keep each `reasoning` to one short clause and put any overall explanation in the top-level `rationale` field.',
          },
        ],
        opts.usage ? { allowRetry: false, usage: opts.usage } : { allowRetry: false },
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
    // Dump diagnostics BEFORE throwing — the slice in the error message hides
    // whether `raw` is short (truncated by max_tokens) or long-but-malformed.
    // For triage we want both the total length and a tail snippet (truncated
    // mid-string ends in mid-word; well-formed-but-noisy ends in closing
    // braces or trailing prose).
    this.logger.warn(
      { rawLen: raw.length, head: raw.slice(0, 200), tail: raw.slice(-200) },
      'recon JSON parse failed (about to throw) — full-length + tail of raw response for triage',
    );
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
/**
 * Best-effort URL hostname extraction. Returns `null` on any parse error —
 * callers treat null as "can't compare" and conservatively reject the
 * navigation (ADR §0041 same-host rule). Never throws.
 */
function safeHostname(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

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
      // goto: same shape as click — `anticipationMs` while the user types the
      // URL, then `pacingSettleEstMs` for the page-load settle. ADR §0041.
      case 'goto': total += s.anticipationMs + config.pacingSettleEstMs; break;
      case 'done': break;
    }
  }
  return total;
}

/**
 * F1 corrector: the ±X% tolerance window for the LLM's plan duration.
 *
 * Reconnaissance LLMs mis-size the playback window — typically over-pack
 * ("a 10 s budget back as 13–14 s"), occasionally under-pack. F1 makes
 * `durationMs` a first-class constraint **in the recon prompt itself** (A
 * owns natural filler — only A has the prompt + page + prohibition context
 * for "what a real person would do in the spare time"). This function (B)
 * is no longer a content-inventor; it is a deterministic ±X% corrector that
 * SURFACES out-of-band misses to `RunMetrics.planDurationFit` instead of
 * silently papering over them. The well-under-budget mechanical scroll+dwell
 * pad branch that used to live here was **removed in F1** — see ADR §0040 +
 * docs/superpowers/specs/2026-05-13-plan-duration-fit-design.md.
 *
 * Behavior, where TOL = config.planDurationFitToleranceRatio (default 0.20):
 *   ratio = estimated / durationMs
 *   |ratio - 1| <= TOL  → status 'ok'; if estimated > durationMs, run the
 *                         per-step compress (kept) to land it inside ±10%;
 *                         otherwise return steps as-is (B does not pad).
 *   ratio > 1 + TOL     → status 'compressed-hard'; run the per-step compress
 *                         (best-effort). Surface for the canary.
 *   ratio < 1 - TOL     → status 'underfilled'; return steps as-is. B never
 *                         invents filler — that is A's job. Surface for the
 *                         canary; the trimmed-duration line will hard-fail.
 *
 * "Fit the recording into the duration the user paid for" is mechanical, not a
 * behaviour threshold — goals.md #6 carve-out (pacing carve-out).
 */
export function fitPlanToBudget(
  steps: PerformanceStep[],
  durationMs: number,
  /**
   * Optional: the `totalEstimatedMs` the LLM self-reported in its draft.
   * Surfaced verbatim on the returned `fit.claimedMs` so we can tell A's
   * self-estimate apart from B's recomputation. HN dwell-crush investigation —
   * see {@link PlanDurationFitSchema}.
   */
  claimedMs?: number,
): { steps: PerformanceStep[]; fit: PlanDurationFit } {
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
      // goto: same shape as click — anticipationMs is controllable, settle is fixed.
      case 'goto': controllableMs += s.anticipationMs; fixedMs += config.pacingSettleEstMs; break;
      case 'done': break;
    }
  }
  const estimatedMs = fixedMs + controllableMs;
  // durationMs=0 is a degenerate input; treat as "fits fine" — the Director's hard cap is the real backstop.
  const ratio = durationMs > 0 ? estimatedMs / durationMs : 1;
  const TOL = config.planDurationFitToleranceRatio;

  // Compress helper — the existing per-step scale-down, lifted verbatim so
  // both the inside-tolerance "slightly over" case and the out-of-tolerance
  // 'compressed-hard' case share it.
  const compressIfPossible = (): PerformanceStep[] => {
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
            case 'goto':
              return { ...s, anticipationMs: Math.max(0, Math.round(s.anticipationMs * scale)) };
            case 'type':
              return { ...s, preMs: Math.max(0, Math.round(s.preMs * scale)) };
            default:
              return s;
          }
        });
      }
    }
    return steps;
  };

  // Out-of-tolerance over: compress (best-effort) + surface as compressed-hard.
  if (ratio > 1 + TOL) {
    return { steps: compressIfPossible(), fit: { estimatedMs, targetMs: durationMs, ratio, status: 'compressed-hard', ...(claimedMs !== undefined ? { claimedMs } : {}) } };
  }

  // Out-of-tolerance under: surface as underfilled. F1 explicitly forbids B
  // from inventing filler — A owns natural filler (durationMs is now a
  // first-class constraint in the recon prompt). Return steps untouched.
  if (ratio < 1 - TOL) {
    return { steps, fit: { estimatedMs, targetMs: durationMs, ratio, status: 'underfilled', ...(claimedMs !== undefined ? { claimedMs } : {}) } };
  }

  // Inside tolerance: still allow a light compress when the plan is slightly
  // over (so C's ±2 s soft-align can land it inside ±10%); never pad.
  return { steps: compressIfPossible(), fit: { estimatedMs, targetMs: durationMs, ratio, status: 'ok', ...(claimedMs !== undefined ? { claimedMs } : {}) } };
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
