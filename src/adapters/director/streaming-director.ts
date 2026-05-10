import { DomainError } from '../../domain/errors.js';
import type { ActionSummary } from '../../domain/director-state.js';
import type { DirectorAction } from '../../domain/director-action.js';
import { SCROLL_SPEED_PROFILES } from '../../domain/director-action.js';
import type { ClickHint, DirectorBriefing } from '../../domain/plan.js';
import { config } from '../../infra/config.js';
import { track } from '../../infra/pending.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { DirectorReport, IDirector } from '../../ports/director.js';
import type { DecisionResponse, IFastDecider } from '../../ports/fast-decider.js';
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
  ): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + briefing.durationMs * config.directorHardBudgetMult;
    const recentActions: ActionSummary[] = [];
    let decisionCount = 0;
    let implicitDwellCount = 0;
    let expectAfterMismatchCount = 0;

    await session.beginRecording();

    let actionQueue: DirectorAction[] = [];
    let pending: ReturnType<typeof track<DecisionResponse>> | null = null;

    // Cold start: fire first decision call.
    {
      const state = await this.observeState(briefing, session, recentActions, briefing.durationMs);
      pending = track(this.decider.decide(state));
      decisionCount += 1;
    }

    while (true) {
      const remainingMs = Math.max(0, hardDeadlineAt - Date.now());

      // Top up the queue if empty: block on pending decision.
      if (actionQueue.length === 0) {
        if (!pending) {
          const state = await this.observeState(briefing, session, recentActions, remainingMs);
          pending = track(this.decider.decide(state));
          decisionCount += 1;
        }
        try {
          const decision = await pending.promise;
          actionQueue = [...decision.actions];
          pending = null;
        } catch (err) {
          this.logger.warn({ err }, 'decider failed at queue top-up');
          return this.endReport('error', startedAt, decisionCount, implicitDwellCount, expectAfterMismatchCount);
        }
      }

      const action = actionQueue.shift()!;

      // Pre-fire the next decision call BEFORE awaiting the animation.
      // EXCEPTION: skip pre-fire if the action is `done` (we're about to exit).
      if (action.kind !== 'done' && pending === null) {
        const state = await this.observeState(briefing, session, recentActions, remainingMs);
        pending = track(this.decider.decide(state));
        decisionCount += 1;
      }

      // Execute the animation.
      const summary = await this.executeAction(action, session);
      recentActions.push(summary);
      if (recentActions.length > 3) recentActions.shift();

      // If the pending decision resolved during animation, REPLACE the queue.
      if (pending && pending.isResolved) {
        if (pending.error) {
          this.logger.warn({ err: pending.error }, 'decider failed in-flight');
          // Fall through; next loop iteration will try a fresh call.
          pending = null;
        } else if (pending.value) {
          actionQueue = [...pending.value.actions];
          pending = null;
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
  ): Promise<DirectorState> {
    const screenshot = await session.screenshot();
    const scrollY = await this.readScrollY(session);
    const viewport = viewportFrom(session);
    return {
      prompt: briefing.prompt,
      remainingMs,
      currentScrollY: scrollY,
      viewport,
      screenshot,
      visibleHints: visibleHintNames(briefing.hints, scrollY, viewport),
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
      case 'done':
        return { kind: 'done', brief: 'done', succeeded: true };
    }
  }

  private async readScrollY(session: IPageSession): Promise<number> {
    // FakePageSession exposes scrollY as a field; the real adapter exposes
    // it via screenshot/observe but we can derive it from a tiny evaluate.
    return (session as unknown as { scrollY?: number }).scrollY ?? 0;
  }
}

function viewportFrom(session: IPageSession): { width: number; height: number } {
  return (session as unknown as { viewport?: { width: number; height: number } }).viewport
    ?? { width: 1280, height: 720 };
}

function visibleHintNames(
  hints: ClickHint[],
  scrollY: number,
  viewport: { width: number; height: number },
): string[] {
  return hints
    .filter((h) => {
      const yInView = h.bboxAtRest.y - scrollY;
      return yInView >= 0 && yInView < viewport.height;
    })
    .map((h) => h.description);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
