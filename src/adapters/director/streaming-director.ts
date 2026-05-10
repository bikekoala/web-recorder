import { DomainError } from '../../domain/errors.js';
import type { ActionSummary, BriefingHintForState } from '../../domain/director-state.js';
import type { DirectorAction } from '../../domain/director-action.js';
import { SCROLL_SPEED_PROFILES } from '../../domain/director-action.js';
import { descriptionsMatch } from '../../domain/intent-matching.js';
import type { ClickHint, DirectorBriefing } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { track } from '../../infra/pending.js';
import { logger as rootLogger } from '../../infra/logger.js';
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
  private readonly logger = rootLogger.child({ component: 'StreamingDirector' });

  constructor(opts: StreamingDirectorOpts) {
    this.decider = opts.decider;
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
    let decisionCount = 0;
    let implicitDwellCount = 0;
    let expectAfterMismatchCount = 0;

    await session.beginRecording();

    let actionQueue: DirectorAction[] = [];
    let pending: ReturnType<typeof track<DecisionResponse>> | null = null;
    let pendingMeta: { id: number; firedAtMs: number; scrollY: number } | null = null;
    let expectAfter: ExpectAfter | null = null;

    if (opts.prefiredDecision) {
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
      // No pre-fire: fall back to the original cold start.
      const state = await this.observeState(briefing, session, recentActions, briefing.durationMs, fulfilledHints);
      pending = track(this.decider.decide(state));
      decisionCount += 1;
      pendingMeta = { id: decisionCount, firedAtMs: Date.now(), scrollY: state.currentScrollY };
    }

    while (true) {
      const remainingMs = Math.max(0, hardDeadlineAt - Date.now());

      // Top up the queue if empty.
      if (actionQueue.length === 0) {
        if (!pending) {
          const state = await this.observeState(briefing, session, recentActions, remainingMs, fulfilledHints);
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
      // EXCEPTIONS: skip pre-fire if the action is `done` (we're about to exit)
      // or if expectAfter is set (we validate first; mismatch clears and re-fires,
      // match continues with the already-queued actions).
      if (action.kind !== 'done' && pending === null && expectAfter === null) {
        const state = await this.observeState(briefing, session, recentActions, remainingMs, fulfilledHints);
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
        watchdog.then(() => ({
          kind: action.kind,
          brief: 'budget cut',
          succeeded: false,
        }) satisfies ActionSummary),
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

      // Audit: a click that came back !succeeded is worth a separate
      // failure entry — the regular `click` log entry doesn't carry a
      // success flag yet, and "click_failed" is a recoverable mismatch
      // worth seeing in the timeline.
      if (action.kind === 'click' && !summary.succeeded) {
        this.logFailure(session, pendingMeta, 'click_failed', summary.brief);
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
        const state = await this.observeState(briefing, session, recentActions, Math.max(0, hardDeadlineAt - Date.now()), fulfilledHints);
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
  ): Promise<DirectorState> {
    const screenshot = await session.screenshot();
    const scrollY = await this.readScrollY(session);
    const viewport = viewportFrom(session);
    // Filter out hints whose description matches a successful click in
    // recentActions — the LLM should not be re-shown intent it has already
    // achieved. See §0025 for why this matters in practice.
    const remainingHints = briefing.hints.filter((h) => !fulfilledHints.has(h.description));
    return {
      prompt: briefing.prompt,
      remainingMs,
      currentScrollY: scrollY,
      viewport,
      screenshot,
      briefingHints: enrichHints(remainingHints, scrollY, viewport),
      recentActions: [...recentActions],
    };
  }

  private async executeAction(action: DirectorAction, session: IPageSession): Promise<ActionSummary> {
    switch (action.kind) {
      case 'click': {
        try {
          await session.clickByDescription(action.target);
          return { kind: 'click', brief: `click ${truncate(action.target, 40)}`, succeeded: true };
        } catch (err) {
          this.logger.warn({ err, target: action.target }, 'click failed');
          return { kind: 'click', brief: `click ${truncate(action.target, 40)} [err]`, succeeded: false };
        }
      }
      case 'scroll': {
        const profile = SCROLL_SPEED_PROFILES[action.speed];
        const durationMs = clamp(
          (Math.abs(action.deltaPx) / profile.pxPerSec) * 1000,
          800,
          2800,
        );
        await session.scroll(action.deltaPx, { durationMs, easing: profile.easing });
        return {
          kind: 'scroll',
          brief: `scroll ${action.deltaPx > 0 ? '+' : ''}${action.deltaPx} ${action.speed}`,
          succeeded: true,
        };
      }
      case 'dwell': {
        await session.wait(action.durationMs);
        return { kind: 'dwell', brief: `dwell ${action.durationMs}ms`, succeeded: true };
      }
      case 'type': {
        try {
          await session.type(action.text);
          return { kind: 'type', brief: `type "${truncate(action.text, 30)}"`, succeeded: true };
        } catch (err) {
          this.logger.warn({ err, text: action.text }, 'type failed');
          return { kind: 'type', brief: `type "${truncate(action.text, 30)}" [err]`, succeeded: false };
        }
      }
      case 'key': {
        try {
          await session.pressKey(action.key);
          return { kind: 'key', brief: `key ${action.key}`, succeeded: true };
        } catch (err) {
          this.logger.warn({ err, key: action.key }, 'key failed');
          return { kind: 'key', brief: `key ${action.key} [err]`, succeeded: false };
        }
      }
      case 'back': {
        try {
          await session.goBack();
          return { kind: 'back', brief: 'back', succeeded: true };
        } catch (err) {
          this.logger.warn({ err }, 'back failed');
          return { kind: 'back', brief: 'back [err]', succeeded: false };
        }
      }
      case 'done':
        return { kind: 'done', brief: 'done', succeeded: true };
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
    // FakePageSession exposes scrollY as a field; the real adapter exposes
    // it via screenshot/observe but we can derive it from a tiny evaluate.
    return (session as unknown as { scrollY?: number }).scrollY ?? 0;
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
