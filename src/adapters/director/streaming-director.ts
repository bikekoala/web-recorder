import { DomainError } from '../../domain/errors.js';
import type { ActionEvidence, ActionSummary, BriefingHintForState } from '../../domain/director-state.js';
import type { DirectorAction } from '../../domain/director-action.js';
import { SCROLL_SPEED_PROFILES } from '../../domain/director-action.js';
import { descriptionsMatch } from '../../domain/intent-matching.js';
import type { ClickHint, DirectorBriefing } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { track } from '../../infra/pending.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { IClickVerifier } from '../../ports/click-verifier.js';
import type { DirectorReport, DirectorRunOpts, IDirector } from '../../ports/director.js';
import type { DecisionResponse, ExpectAfter, IFastDecider } from '../../ports/fast-decider.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { DirectorState } from '../../domain/director-state.js';

export class DirectorError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('DIRECTOR_FAILED', message, cause);
  }
}

interface StreamingDirectorOpts {
  decider: IFastDecider;
  /**
   * Optional AI click verifier (§0027). When provided, every successful
   * click is followed by a verification call: "did the click hit the
   * intended target?". A negative verdict marks the click as failed,
   * which clears the action queue and triggers a fresh decider call
   * with the failure reason — preventing wrong-target clicks from
   * cascading into wasted downstream actions (e.g. typing into the
   * wrong element after clicking the hamburger menu instead of the
   * search bar).
   */
  clickVerifier?: IClickVerifier;
}

/**
 * StreamingDirector — see `docs/superpowers/specs/2026-05-10-streaming-director-design.md`.
 *
 * This first version implements the core sequential loop. Streaming
 * (pre-fired LLM calls during animation) is added in the next task to
 * keep diffs small and tests narrow.
 */
export class StreamingDirector implements IDirector {
  private readonly decider: IFastDecider;
  private readonly clickVerifier: IClickVerifier | null;
  private readonly logger = rootLogger.child({ component: 'StreamingDirector' });

  constructor(opts: StreamingDirectorOpts) {
    this.decider = opts.decider;
    this.clickVerifier = opts.clickVerifier ?? null;
  }

  async run(
    briefing: DirectorBriefing,
    session: IPageSession,
    opts: DirectorRunOpts = {},
  ): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + briefing.durationMs * config.directorHardBudgetMult;
    const recentActions: ActionSummary[] = [];
    /**
     * Hint descriptions that have been satisfied by a successful click
     * during this recording. Filtered out of `briefingHints` shown to the
     * LLM in subsequent decisions, so the LLM sees only REMAINING intent
     * — preventing the "click the same hint 3 times" loop.
     */
    const fulfilledHints = new Set<string>();
    /**
     * Per-run rejection tally for click targets — keyed by `action.target`
     * (the LLM's exact phrasing). Incremented every time a click for that
     * description fails (Playwright throw OR verifier `matched=false`).
     * Once any entry hits `config.directorClickRejectionLimit`, the
     * Director treats that target as unreachable for the rest of the run:
     * filtered out of briefingHints (by fuzzy descriptionsMatch) and
     * surfaced as `state.unreachableTargets` to the decider so it picks a
     * different element. See ADR §0028.
     */
    const rejectedClickTargets = new Map<string, number>();
    let decisionCount = 0;
    let implicitDwellCount = 0;
    let expectAfterMismatchCount = 0;

    await session.beginRecording();

    // Naturalness C4 — "opening hold". A real person opening a page spends
    // 200-500ms scanning before they move the cursor. We mirror that with
    // a randomized wait right at the top of the recording window so the
    // viewer sees a beat of stillness on a freshly-loaded page, not the
    // first scroll/click firing on frame 1. Pure rendering parameter
    // (goals.md #6 carve-out). Skipped when max=0 (test bypass).
    await this.openingHold(session);

    let actionQueue: DirectorAction[] = [];
    let pending: ReturnType<typeof track<DecisionResponse>> | null = null;
    let pendingMeta: { id: number; firedAtMs: number; scrollY: number } | null = null;
    let expectAfter: ExpectAfter | null = null;

    if (briefing.draftSequence && briefing.draftSequence.length > 0) {
      // §0026: planner pre-planned a draft action sequence. Seed the queue
      // with it — no cold-start LLM call needed. The agent acts immediately
      // on the recording-window opening; LLM is only invoked when evidence
      // shows the plan needs adapting (or the queue empties).
      actionQueue = [...briefing.draftSequence];
      this.logger.info(
        { steps: actionQueue.length, kinds: actionQueue.map((a) => a.kind) },
        'seeded queue from planner draft',
      );
    } else if (opts.prefiredDecision) {
      // The runner pre-fired the first decision DURING setup/prelude (using
      // the same screenshot the planner saw). It's already in flight or
      // resolved by the time we get here — we skip the cold-start LLM call
      // entirely. This is what hides the 1-7s cold-start latency that
      // previously ate up to 70% of a 10s recording budget.
      pending = opts.prefiredDecision;
      decisionCount += 1;
      pendingMeta = {
        id: decisionCount,
        firedAtMs: opts.prefiredDecision.firedAtMs,
        scrollY: opts.prefiredDecision.scrollYAtFire,
      };
    } else {
      // No draft sequence and no pre-fire: fall back to the original cold start.
      const state = await this.observeState(briefing, session, recentActions, briefing.durationMs, fulfilledHints, rejectedClickTargets);
      pending = track(this.decider.decide(state));
      decisionCount += 1;
      pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
    }

    while (true) {
      const remainingMs = Math.max(0, hardDeadlineAt - Date.now());

      // Top up the queue if empty.
      if (actionQueue.length === 0) {
        if (!pending) {
          const state = await this.observeState(briefing, session, recentActions, remainingMs, fulfilledHints, rejectedClickTargets);
          pending = track(this.decider.decide(state));
          decisionCount += 1;
          pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
        }
        // Wait for pending, but if it takes longer than the implicit-dwell
        // duration, insert a dwell action and re-check. Caps at 4 dwells.
        let consecutiveDwells = 0;
        while (!pending.isResolved && consecutiveDwells < 4) {
          if (Date.now() >= hardDeadlineAt) break;
          await session.wait(config.directorDwellFallbackMs);
          implicitDwellCount += 1;
          consecutiveDwells += 1;
        }
        if (consecutiveDwells >= 4) {
          this.logger.warn(
            { consecutiveDwells },
            'consecutive implicit dwells hit cap — LLM tail latency or stuck',
          );
        }
        // Hard-cap enforcement: if the deadline has already passed we MUST
        // exit immediately, even if the LLM call hasn't returned. Without
        // this, a slow LLM blocks here unboundedly, blowing the budget.
        if (Date.now() >= hardDeadlineAt) {
          this.logFailure(session, pendingMeta, 'budget_exceeded', 'deadline reached while awaiting decider');
          return this.endReport('budget', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
        }
        // Race the LLM call against remaining budget so a tail-latency
        // outlier cannot run past the hard deadline.
        const remainingBudget = Math.max(50, hardDeadlineAt - Date.now());
        try {
          const decision = await Promise.race([
            pending.promise,
            new Promise<null>((r) => setTimeout(() => r(null), remainingBudget)),
          ]);
          if (decision === null) {
            // Budget exhausted while waiting on LLM — exit cleanly.
            this.logFailure(session, pendingMeta, 'budget_exceeded', 'budget exhausted while awaiting decider');
            return this.endReport('budget', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
          }
          if (pendingMeta) this.logDecision(session, pendingMeta, decision);
          actionQueue = [...decision.actions];
          expectAfter = decision.expectAfter ?? null;
          pending = null;
          pendingMeta = null;
        } catch (err) {
          this.logger.warn({ err }, 'decider failed at queue top-up');
          this.logFailure(session, pendingMeta, 'llm_call_failed', errorMessage(err));
          return this.endReport('error', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
        }
      }

      const action = actionQueue.shift()!;

      // Pre-fire the next decision call BEFORE awaiting the animation.
      // EXCEPTIONS:
      //   1. `done` (we're about to exit).
      //   2. `expectAfter` set (we validate first; mismatch clears + re-fires).
      //   3. State-changing actions (click/type/key/back) — pre-fire would
      //      see a stale screenshot from BEFORE the action's effect lands,
      //      causing the "type the same text twice" / "click again to make
      //      sure" loop. We accept ~1-2s implicit dwell after these actions
      //      in exchange for accurate post-action observation. (§0026)
      const stateChanging = isStateChangingActionKind(action.kind);
      if (action.kind !== 'done' && pending === null && expectAfter === null && !stateChanging) {
        const state = await this.observeState(briefing, session, recentActions, remainingMs, fulfilledHints, rejectedClickTargets);
        pending = track(this.decider.decide(state));
        decisionCount += 1;
        pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
      }

      // Execute the animation with an upper-bound watchdog.
      const watchdog = new Promise<'budget'>((resolve) => {
        setTimeout(() => resolve('budget'), Math.max(50, hardDeadlineAt - Date.now()));
      });
      const summary = await Promise.race([
        this.executeAction(action, session),
        watchdog.then(() => buildBudgetCutSummary(action) satisfies ActionSummary),
      ]);
      recentActions.push(summary);
      if (recentActions.length > 3) recentActions.shift();

      // After a successful click, mark any matching briefing-hints as
      // fulfilled so they're filtered out of subsequent observeState calls.
      // This is the load-bearing fix for "LLM keeps re-clicking 简体中文 even
      // after the click already worked" (see §0025).
      if (action.kind === 'click' && summary.succeeded) {
        for (const hint of briefing.hints) {
          if (descriptionsMatch(hint.description, action.target)) {
            fulfilledHints.add(hint.description);
          }
        }
      }

      // Audit + recovery on a failed click. Two paths into here:
      //   - Playwright threw (target not found, page closed, etc.)
      //   - AI verifier judged the click hit the wrong element (§0027)
      // Either way, downstream actions in the queue (especially `type`
      // and `key Enter` from a draftSequence) would now fire into the
      // wrong page state. Clear the queue, log, and force a fresh
      // decision with the failure reason in `lastActionFailure` so the
      // LLM can recover with full context.
      if (action.kind === 'click' && !summary.succeeded) {
        const failureDetail = (summary.evidence.kind === 'click' && summary.evidence.aiReason)
          ? `wrong target — ${summary.evidence.aiReason}`
          : summary.brief;
        this.logFailure(session, pendingMeta, 'click_failed', failureDetail);
        // §0028: tally per-target rejections. After
        // `directorClickRejectionLimit` failures on the SAME description,
        // observeState will filter this hint and surface it as
        // unreachable so the LLM stops re-picking it.
        const previousCount = rejectedClickTargets.get(action.target) ?? 0;
        const newCount = previousCount + 1;
        rejectedClickTargets.set(action.target, newCount);
        if (newCount === config.directorClickRejectionLimit) {
          this.logger.info(
            { target: action.target, rejections: newCount },
            'click target hit rejection limit — marking unreachable',
          );
        }
        actionQueue = [];
        pending = null;
        pendingMeta = null;
        const remainingAfter = Math.max(0, hardDeadlineAt - Date.now());
        const state = await this.observeState(briefing, session, recentActions, remainingAfter, fulfilledHints, rejectedClickTargets);
        const stateWithFailure: DirectorState = {
          ...state,
          lastActionFailure: `click on '${action.target}' did not land: ${failureDetail}`,
        };
        pending = track(this.decider.decide(stateWithFailure));
        decisionCount += 1;
        pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
        // Skip the rest of this iteration's checks — the queue is empty,
        // the next iteration will pull from `pending`.
        continue;
      }

      // expectAfter check — cheap text-based validation.
      if (expectAfter && !(await this.validateExpectAfter(expectAfter, session))) {
        expectAfterMismatchCount += 1;
        this.logFailure(
          session,
          pendingMeta,
          'expect_after_mismatch',
          `expected ${JSON.stringify(expectAfter)}`,
        );
        actionQueue = [];
        // Cancel any in-flight pre-fire (its premise is stale) and
        // force a fresh call with the failure context.
        pending = null;
        pendingMeta = null;
        const state = await this.observeState(briefing, session, recentActions, Math.max(0, hardDeadlineAt - Date.now()), fulfilledHints, rejectedClickTargets);
        const stateWithFailure: DirectorState = { ...state, lastActionFailure: 'expectAfter mismatch' };
        pending = track(this.decider.decide(stateWithFailure));
        decisionCount += 1;
        pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
        expectAfter = null;
        continue;
      }

      // If the pending decision resolved during animation, REPLACE the queue.
      if (pending && pending.isResolved) {
        if (pending.error) {
          this.logger.warn({ err: pending.error }, 'decider failed in-flight');
          this.logFailure(session, pendingMeta, 'llm_call_failed', errorMessage(pending.error));
          pending = null;
          pendingMeta = null;
        } else if (pending.value) {
          if (pendingMeta) this.logDecision(session, pendingMeta, pending.value);
          actionQueue = [...pending.value.actions];
          expectAfter = pending.value.expectAfter ?? null;
          pending = null;
          pendingMeta = null;
        }
      }

      if (action.kind === 'done') {
        return this.endReport('done', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
      }
      if (Date.now() >= hardDeadlineAt) {
        return this.endReport('budget', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
      }
    }
  }

  private endReport(
    endReason: 'done' | 'budget' | 'error',
    startedAt: number,
    decisionCount: number,
    implicitDwellCount: number,
    expectAfterMismatchCount: number,
  ): DirectorReport {
    return {
      totalMs: Date.now() - startedAt,
      decisionCount,
      implicitDwellCount,
      expectAfterMismatchCount,
      endReason,
    };
  }

  // ---------------------------------------------------------------- internals

  private async observeState(
    briefing: DirectorBriefing,
    session: IPageSession,
    recentActions: ActionSummary[],
    remainingMs: number,
    fulfilledHints: ReadonlySet<string> = new Set(),
    rejectedClickTargets: ReadonlyMap<string, number> = new Map(),
  ): Promise<DirectorState> {
    const screenshot = await session.screenshot();
    const scrollY = await this.readScrollY(session);
    const viewport = viewportFrom(session);
    // §0028: a target is "unreachable" when its rejection count hit the
    // configured cap. Use the LLM's exact phrasing as the user-visible
    // label — that's what it will recognise in the next decision.
    const unreachableTargets: string[] = [];
    for (const [target, count] of rejectedClickTargets) {
      if (count >= config.directorClickRejectionLimit) {
        unreachableTargets.push(target);
      }
    }
    // Filter out hints whose description matches:
    //   - a successful click (§0025 fulfilled hints), or
    //   - an unreachable target (§0028) — fuzzy match so e.g. the
    //     planner's "the 简体中文 link" hint stops being shown after the
    //     LLM's "the simplified Chinese link" click hit the rejection cap.
    const remainingHints = briefing.hints.filter((h) => {
      if (fulfilledHints.has(h.description)) return false;
      for (const t of unreachableTargets) {
        if (descriptionsMatch(h.description, t)) return false;
      }
      return true;
    });
    return {
      prompt: briefing.prompt,
      remainingMs,
      currentScrollY: scrollY,
      viewport,
      screenshot,
      briefingHints: enrichHints(remainingHints, scrollY, viewport),
      recentActions: [...recentActions],
      ...(unreachableTargets.length > 0 ? { unreachableTargets } : {}),
    };
  }

  private async executeAction(action: DirectorAction, session: IPageSession): Promise<ActionSummary> {
    switch (action.kind) {
      case 'click': {
        const urlBefore = await safeUrl(session);
        const titleBefore = await safeTitle(session);
        let succeeded = true;
        try {
          await session.clickByDescription(action.target);
        } catch (err) {
          this.logger.warn({ err, target: action.target }, 'click failed');
          succeeded = false;
        }
        const urlAfter = await safeUrl(session);
        const titleAfter = await safeTitle(session);

        // §0027: AI verification. Only fires when the underlying click
        // didn't already throw — a Playwright-thrown click is unambiguously
        // failed; no need to ask the LLM. Verifier errors are swallowed:
        // we'd rather miss a wrong-click than block the recording on a
        // network blip in the verifier path.
        let aiVerified: boolean | null = null;
        let aiReason: string | null = null;
        if (succeeded && this.clickVerifier) {
          try {
            const screenshot = await session.screenshot();
            const verdict = await this.clickVerifier.verify({
              targetDescription: action.target,
              screenshot,
              urlChanged: urlBefore !== urlAfter,
              titleChanged: titleBefore !== titleAfter,
            });
            aiVerified = verdict.matched;
            aiReason = verdict.reason;
            if (!verdict.matched) {
              succeeded = false;
              this.logger.info(
                { target: action.target, reason: verdict.reason, latencyMs: verdict.latencyMs },
                'click verifier flagged wrong target',
              );
            }
          } catch (err) {
            this.logger.debug({ err }, 'click verifier errored — treating as optimistic match');
            // aiVerified stays null = "unknown". succeeded stays whatever
            // the underlying click reported.
          }
        }

        const evidence: ActionEvidence = {
          kind: 'click',
          urlBefore, urlAfter, urlChanged: urlBefore !== urlAfter,
          titleBefore, titleAfter, titleChanged: titleBefore !== titleAfter,
          aiVerified, aiReason,
        };
        const brief = `click ${truncate(action.target, 40)}${succeeded ? '' : ' [err]'}`;
        return { kind: 'click', brief, succeeded, evidence };
      }
      case 'scroll': {
        const profile = SCROLL_SPEED_PROFILES[action.speed];
        const durationMs = clamp(
          (Math.abs(action.deltaPx) / profile.pxPerSec) * 1000,
          800,
          2800,
        );
        const scrollYBefore = await safeScrollY(session);
        await session.scroll(action.deltaPx, { durationMs, easing: profile.easing });
        const scrollYAfter = await safeScrollY(session);
        const evidence: ActionEvidence = {
          kind: 'scroll',
          scrollYBefore, scrollYAfter,
          deltaRequested: action.deltaPx,
          deltaAchieved: scrollYAfter - scrollYBefore,
        };
        return {
          kind: 'scroll',
          brief: `scroll ${action.deltaPx > 0 ? '+' : ''}${action.deltaPx} ${action.speed}`,
          succeeded: true,
          evidence,
        };
      }
      case 'dwell': {
        await session.wait(action.durationMs);
        return {
          kind: 'dwell',
          brief: `dwell ${action.durationMs}ms`,
          succeeded: true,
          evidence: { kind: 'dwell', durationMs: action.durationMs },
        };
      }
      case 'type': {
        let succeeded = true;
        try {
          await session.type(action.text);
        } catch (err) {
          this.logger.warn({ err, text: action.text }, 'type failed');
          succeeded = false;
        }
        const focusedValueAfter = await safeFocusedValue(session);
        const matched =
          focusedValueAfter != null && focusedValueAfter.includes(action.text);
        const evidence: ActionEvidence = {
          kind: 'type',
          expectedText: action.text,
          focusedValueAfter,
          matched,
        };
        return {
          kind: 'type',
          brief: `type "${truncate(action.text, 30)}"${succeeded ? '' : ' [err]'}`,
          succeeded,
          evidence,
        };
      }
      case 'key': {
        const urlBefore = await safeUrl(session);
        const titleBefore = await safeTitle(session);
        let succeeded = true;
        try {
          await session.pressKey(action.key);
        } catch (err) {
          this.logger.warn({ err, key: action.key }, 'key failed');
          succeeded = false;
        }
        const urlAfter = await safeUrl(session);
        const titleAfter = await safeTitle(session);
        const evidence: ActionEvidence = {
          kind: 'key',
          key: action.key,
          urlBefore, urlAfter, urlChanged: urlBefore !== urlAfter,
          titleBefore, titleAfter, titleChanged: titleBefore !== titleAfter,
        };
        return {
          kind: 'key',
          brief: `key ${action.key}${succeeded ? '' : ' [err]'}`,
          succeeded,
          evidence,
        };
      }
      case 'back': {
        const urlBefore = await safeUrl(session);
        let succeeded = true;
        try {
          await session.goBack();
        } catch (err) {
          this.logger.warn({ err }, 'back failed');
          succeeded = false;
        }
        const urlAfter = await safeUrl(session);
        const evidence: ActionEvidence = {
          kind: 'back',
          urlBefore, urlAfter, urlChanged: urlBefore !== urlAfter,
        };
        return {
          kind: 'back',
          brief: `back${succeeded ? '' : ' [err]'}`,
          succeeded,
          evidence,
        };
      }
      case 'done':
        return { kind: 'done', brief: 'done', succeeded: true, evidence: { kind: 'done' } };
    }
  }

  private async validateExpectAfter(
    expect: ExpectAfter,
    session: IPageSession,
  ): Promise<boolean> {
    if (expect.urlContains) {
      const url = await session.currentUrl();
      if (!url.includes(expect.urlContains)) return false;
    }
    if (expect.visibleText && expect.visibleText.length > 0) {
      // Cheap path: try quickFindInViewport for each text. We don't need
      // ALL to match — at least one signals the page is roughly where the
      // LLM expected. Tunable if it proves too lenient/strict.
      let anyFound = false;
      for (const t of expect.visibleText) {
        const r = await session.quickFindInViewport(t);
        if (r) { anyFound = true; break; }
      }
      if (!anyFound) return false;
    }
    return true;
  }

  private async readScrollY(session: IPageSession): Promise<number> {
    return safeScrollY(session);
  }

  private async openingHold(session: IPageSession): Promise<void> {
    const min = config.openingHoldMinMs;
    const max = config.openingHoldMaxMs;
    if (max <= 0 || max < min) return;
    const duration = min + Math.floor(Math.random() * (max - min + 1));
    this.logger.info({ durationMs: duration }, 'opening hold (context absorption)');
    await session.wait(duration);
  }

  /**
   * Append a `decision` entry to the action log capturing what the LLM
   * returned. Best-effort — never lets a logging failure break recording.
   */
  private logDecision(
    session: IPageSession,
    meta: { id: number; firedAtMs: number; scrollY: number },
    decision: DecisionResponse,
  ): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'decision',
        decisionId: meta.id,
        modelId: this.decider.modelId,
        latencyMs: Date.now() - meta.firedAtMs,
        actions: decision.actions.map((a) => ({
          kind: a.kind,
          reasoning: a.reasoning,
          brief: briefAction(a),
        })),
        ...(decision.expectAfter ? { expectAfter: decision.expectAfter } : {}),
        scrollY: meta.scrollY,
        viewport: viewportFrom(session),
      });
    } catch (err) {
      this.logger.debug({ err }, 'logDecision append failed');
    }
  }

  private logFailure(
    session: IPageSession,
    meta: { id: number; scrollY: number } | null,
    reason:
      | 'schema_validation'
      | 'expect_after_mismatch'
      | 'llm_call_failed'
      | 'click_failed'
      | 'budget_exceeded',
    details: string,
  ): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'decision_failure',
        ...(meta ? { decisionId: meta.id } : {}),
        reason,
        details: details.slice(0, 500),
        scrollY: meta?.scrollY ?? 0,
        viewport: viewportFrom(session),
      });
    } catch (err) {
      this.logger.debug({ err }, 'logFailure append failed');
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err).slice(0, 500);
}

function briefAction(a: DirectorAction): string {
  switch (a.kind) {
    case 'click':
      return `click ${truncate(a.target, 40)}`;
    case 'scroll':
      return `scroll ${a.deltaPx > 0 ? '+' : ''}${a.deltaPx} ${a.speed}`;
    case 'dwell':
      return `dwell ${a.durationMs}ms`;
    case 'type':
      return `type "${truncate(a.text, 30)}"`;
    case 'key':
      return `key ${a.key}`;
    case 'back':
      return 'back';
    case 'done':
      return 'done';
  }
}

function viewportFrom(session: IPageSession): { width: number; height: number } {
  return (session as unknown as { viewport?: { width: number; height: number } }).viewport
    ?? { width: 1280, height: 720 };
}

// Best-effort state probes — every Director executeAction wraps a port
// read so a momentary glitch (page closed, evaluate threw) doesn't cause
// the action's evidence-capture to bubble an error. We'd rather log
// ambiguous evidence ("urlBefore=''") than fail the recording.
async function safeUrl(session: IPageSession): Promise<string> {
  try { return await session.currentUrl(); } catch { return ''; }
}
async function safeTitle(session: IPageSession): Promise<string> {
  try { return await session.pageTitle(); } catch { return ''; }
}
async function safeScrollY(session: IPageSession): Promise<number> {
  try { return await session.scrollY(); } catch { return 0; }
}
async function safeFocusedValue(session: IPageSession): Promise<string | null> {
  try { return await session.focusedValue(); } catch { return null; }
}

/**
 * State-changing actions whose effects must land BEFORE the next
 * decision's screenshot is taken. Pre-fire is skipped during these so
 * the next LLM call sees the post-action page.
 */
function isStateChangingActionKind(kind: DirectorAction['kind']): boolean {
  return kind === 'click' || kind === 'type' || kind === 'key' || kind === 'back';
}

/**
 * Build a placeholder ActionSummary for the watchdog-cut path. Evidence
 * is a "noop" shape per kind — the action did NOT actually run, so we
 * record empty/zero state, with `succeeded: false` and a `[budget cut]`
 * brief so the LLM can see what happened on the next decision.
 */
function buildBudgetCutSummary(action: DirectorAction): ActionSummary {
  const kind = action.kind;
  const evidence: ActionEvidence = (() => {
    switch (kind) {
      case 'click':
        return { kind: 'click', urlBefore: '', urlAfter: '', urlChanged: false, titleBefore: '', titleAfter: '', titleChanged: false, aiVerified: null, aiReason: null };
      case 'scroll':
        return { kind: 'scroll', scrollYBefore: 0, scrollYAfter: 0, deltaRequested: action.deltaPx, deltaAchieved: 0 };
      case 'dwell':
        return { kind: 'dwell', durationMs: 0 };
      case 'type':
        return { kind: 'type', expectedText: action.text, focusedValueAfter: null, matched: false };
      case 'key':
        return { kind: 'key', key: action.key, urlBefore: '', urlAfter: '', urlChanged: false, titleBefore: '', titleAfter: '', titleChanged: false };
      case 'back':
        return { kind: 'back', urlBefore: '', urlAfter: '', urlChanged: false };
      case 'done':
        return { kind: 'done' };
    }
  })();
  return { kind, brief: 'budget cut', succeeded: false, evidence };
}

/**
 * Surface ALL planner hints to the LLM — not just the ones in the current
 * viewport — annotated with their position so the LLM can pick `click` for
 * off-fold targets. The executor's discovery-click choreography handles the
 * scroll-to-target internally; the LLM just needs to know the target exists.
 */
function enrichHints(
  hints: ClickHint[],
  scrollY: number,
  viewport: { width: number; height: number },
): BriefingHintForState[] {
  return hints.map((h) => {
    const yInView = h.bboxAtRest.y - scrollY;
    if (yInView >= 0 && yInView < viewport.height) {
      return { description: h.description, position: 'in_view', scrollToReveal: 0 };
    }
    if (yInView < 0) {
      // Above viewport. Scroll up by enough to put the hint at ~35% from top.
      const reveal = Math.round(yInView - viewport.height * 0.35);
      return { description: h.description, position: 'above', scrollToReveal: reveal };
    }
    // Below viewport.
    const reveal = Math.round(yInView - viewport.height * 0.35);
    return { description: h.description, position: 'below', scrollToReveal: reveal };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
