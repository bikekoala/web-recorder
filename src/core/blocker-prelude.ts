import type { DirectorAction } from '../domain/director-action.js';
import type { ActionSummary, DirectorState } from '../domain/director-state.js';
import type { DirectorBriefing } from '../domain/plan.js';
import type { PageDiagnostic } from '../domain/action-log.js';
import { logger as rootLogger } from '../infra/logger.js';
import type { DecisionResponse, IFastDecider } from '../ports/fast-decider.js';
import type { IPageSession } from '../ports/page-session.js';
import { buildPreludeUserPrompt } from '../prompts/index.js';

/**
 * BlockerPrelude — pre-recording phase that detects visual blockers
 * (cookie consent, login modal, paused-video play overlay, etc.) and
 * dismisses them BEFORE the recording window opens.
 *
 * Why: when a blocker pops up DURING recording, the LLM has to identify-
 * and-dismiss it inside the budget, which (a) eats budget and (b) shows a
 * non-user-intent click in the deliverable video. Doing this BEFORE
 * recording is free and produces a cleaner deliverable.
 *
 * Serves goals.md hard non-negotiables:
 *   #2 "Fluid, no visible stalls"          — blocker hunting is not in the deliverable.
 *   #3 "User intent satisfied or transparently not"
 *                                         — the recording window starts on the page
 *                                           the user actually wants to see.
 *
 * Pipeline:
 *   probe pageDiagnostic →  if no blockers, exit.
 *   loop (bounded by maxIterations / maxMs):
 *     ask FastDecider for the next dismiss action (with a special
 *       [BLOCKER PRELUDE] prompt prefix telling the LLM its job is dismissal,
 *       not the user's task).
 *     if non-click action → bail (decider thinks we're done).
 *     click the target. on failure → log decision_failure click_failed and bail.
 *     wait for visual stability.
 *     re-probe pageDiagnostic. if clean → exit.
 *
 * Decision entries written to the action log use NEGATIVE decisionIds
 * (`-1, -2, ...`) so they never collide with the Director's positive
 * numbering and are grep-friendly: "negative decisionId == prelude".
 *
 * Failures inside this phase NEVER kill the recording — every error path
 * returns a report and lets the runner proceed to the Director.
 */

export interface BlockerPreludeOpts {
  decider: IFastDecider;
  /** Max LLM iterations. Default 3. Bounds wall clock. */
  maxIterations?: number;
  /** Max wall-clock ms regardless of iterations. Default 15000. */
  maxMs?: number;
}

export type BlockerPreludeEndReason =
  | 'clean'
  | 'iter_cap'
  | 'time_cap'
  | 'decider_done'
  | 'click_failed';

export interface BlockerPreludeReport {
  iterations: number;
  /** Signals that disappeared after some click. */
  resolvedSignals: string[];
  /** Signals still present when the prelude gave up. */
  remainingSignals: string[];
  totalMs: number;
  endReason: BlockerPreludeEndReason;
}

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MAX_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

export class BlockerPrelude {
  private readonly decider: IFastDecider;
  private readonly maxIterations: number;
  private readonly maxMs: number;
  private readonly logger = rootLogger.child({ component: 'BlockerPrelude' });

  constructor(opts: BlockerPreludeOpts) {
    this.decider = opts.decider;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  }

  async run(
    session: IPageSession,
    briefing: DirectorBriefing,
  ): Promise<BlockerPreludeReport> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + this.maxMs;

    try {
      // 1. First probe. If clean, return early — common case for content pages.
      const initialDiag = await safePageDiagnostic(session);
      const initialSignals = [...initialDiag.blockerSignals];
      if (initialSignals.length === 0) {
        return {
          iterations: 0,
          resolvedSignals: [],
          remainingSignals: [],
          totalMs: Date.now() - startedAt,
          endReason: 'clean',
        };
      }

      this.logger.info(
        { signals: initialSignals, prompt: briefing.prompt.slice(0, 80) },
        'blocker prelude detected signals; running dismissal loop',
      );

      // 2. Loop: probe → ask LLM → click → wait → re-probe.
      let iterations = 0;
      let endReason: BlockerPreludeEndReason | null = null;
      let lastDiag: PageDiagnostic = initialDiag;

      const recentActions: ActionSummary[] = [];

      while (true) {
        if (iterations >= this.maxIterations) {
          endReason = 'iter_cap';
          break;
        }
        if (Date.now() >= deadlineAt) {
          endReason = 'time_cap';
          break;
        }

        iterations += 1;
        const decisionId = -iterations; // negative — see class doc.

        // Build a state for the decider with the prelude-flavoured prompt.
        const screenshot = await safeScreenshot(session);
        const scrollY = readScrollY(session);
        const viewport = readViewport(session);
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        const state: DirectorState = {
          prompt: buildPreludeUserPrompt(briefing.prompt, lastDiag.blockerSignals),
          remainingMs,
          currentScrollY: scrollY,
          viewport,
          screenshot,
          briefingHints: [],
          recentActions: [...recentActions],
        };

        // 2a. Ask the decider.
        const tFire = Date.now();
        let decision;
        try {
          decision = await this.decider.decide(state);
        } catch (err) {
          // LLM call failed entirely — log and bail; a blocker we couldn't
          // dismiss is the Director's problem to handle (not a fatal here).
          this.logFailure(session, decisionId, scrollY, 'llm_call_failed', errMsg(err));
          endReason = 'decider_done';
          break;
        }
        const latencyMs = Date.now() - tFire;

        // Log the decision.
        this.logDecision(session, {
          decisionId,
          firedAtMs: tFire,
          latencyMs,
          scrollY,
          viewport,
          decision,
        });

        const first = decision.actions[0];
        if (!first || first.kind !== 'click') {
          // Decider said done / scroll / dwell — it doesn't see anything to
          // dismiss (or it doesn't want to). Stop and let the Director
          // handle whatever's left.
          endReason = 'decider_done';
          break;
        }

        // 2b. Click the target. On failure, log and bail.
        try {
          await session.clickByDescription(first.target);
          // Prelude doesn't capture full evidence (it doesn't need to —
          // the next iteration's pageDiagnostic IS its verification). Use
          // a minimal click-evidence stub so ActionSummary's shape is met.
          recentActions.push({
            kind: 'click',
            brief: `click ${truncate(first.target, 40)}`,
            succeeded: true,
            evidence: {
              kind: 'click',
              urlBefore: '', urlAfter: '', urlChanged: false,
              titleBefore: '', titleAfter: '', titleChanged: false,
            },
          });
          if (recentActions.length > 3) recentActions.shift();
        } catch (err) {
          this.logFailure(
            session,
            decisionId,
            readScrollY(session),
            'click_failed',
            `${first.target}: ${errMsg(err)}`,
          );
          endReason = 'click_failed';
          break;
        }

        // 2c. Best-effort visual stability so the page settles before re-probe.
        try {
          await session.waitForVisualStability({ quietMs: 250, maxMs: 2500 });
        } catch (err) {
          this.logger.debug({ err }, 'waitForVisualStability threw; ignoring');
        }

        // 2d. Re-probe.
        const nextDiag = await safePageDiagnostic(session);
        // Log it as a page_diagnostic entry so the operator can see how the
        // page looked between dismissal attempts.
        this.logPageDiagnostic(session, nextDiag);
        lastDiag = nextDiag;

        if (nextDiag.blockerSignals.length === 0) {
          endReason = 'clean';
          break;
        }
      }

      // Compute resolved/remaining signals.
      const remainingSignals = [...lastDiag.blockerSignals];
      const remainingSet = new Set(remainingSignals);
      const resolvedSignals = initialSignals.filter((s) => !remainingSet.has(s));

      return {
        iterations,
        resolvedSignals,
        remainingSignals,
        totalMs: Date.now() - startedAt,
        endReason: endReason ?? 'iter_cap',
      };
    } catch (err) {
      // Unexpected error inside the prelude — never fatal. Log and return a
      // safe report so the runner can proceed to the Director.
      this.logger.warn({ err }, 'BlockerPrelude failed with unexpected error');
      return {
        iterations: 0,
        resolvedSignals: [],
        remainingSignals: [],
        totalMs: Date.now() - startedAt,
        endReason: 'clean',
      };
    }
  }

  // ---------------------------------------------------------------- internals

  private logDecision(
    session: IPageSession,
    args: {
      decisionId: number;
      firedAtMs: number;
      latencyMs: number;
      scrollY: number;
      viewport: { width: number; height: number };
      decision: DecisionResponse;
    },
  ): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'decision',
        decisionId: args.decisionId,
        modelId: this.decider.modelId,
        latencyMs: args.latencyMs,
        actions: args.decision.actions.map((a) => ({
          kind: a.kind,
          reasoning: a.reasoning,
          brief: briefAction(a),
        })),
        ...(args.decision.expectAfter ? { expectAfter: args.decision.expectAfter } : {}),
        scrollY: args.scrollY,
        viewport: args.viewport,
      });
    } catch (err) {
      this.logger.debug({ err }, 'logDecision append failed');
    }
  }

  private logFailure(
    session: IPageSession,
    decisionId: number,
    scrollY: number,
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
        decisionId,
        reason,
        details: details.slice(0, 500),
        scrollY,
        viewport: readViewport(session),
      });
    } catch (err) {
      this.logger.debug({ err }, 'logFailure append failed');
    }
  }

  private logPageDiagnostic(session: IPageSession, diag: PageDiagnostic): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'page_diagnostic',
        url: diag.url,
        title: diag.title,
        interactiveElementCount: diag.interactiveElementCount,
        visibleHeadings: diag.visibleHeadings,
        blockerSignals: diag.blockerSignals,
        scrollY: readScrollY(session),
        viewport: readViewport(session),
      });
    } catch (err) {
      this.logger.debug({ err }, 'logPageDiagnostic append failed');
    }
  }
}

// =============================================================================
// helpers — kept module-private so the BlockerPrelude class stays focused.
// =============================================================================

async function safePageDiagnostic(session: IPageSession): Promise<PageDiagnostic> {
  try {
    return await session.pageDiagnostic();
  } catch {
    return {
      url: '',
      title: '',
      interactiveElementCount: 0,
      visibleHeadings: [],
      blockerSignals: [],
    };
  }
}

async function safeScreenshot(session: IPageSession): Promise<Buffer> {
  try {
    return await session.screenshot();
  } catch {
    return Buffer.alloc(0);
  }
}

function readScrollY(session: IPageSession): number {
  return (session as unknown as { scrollY?: number }).scrollY ?? 0;
}

function readViewport(session: IPageSession): { width: number; height: number } {
  const v = (session as unknown as { viewport?: { width: number; height: number } }).viewport;
  return v ?? DEFAULT_VIEWPORT;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err).slice(0, 500);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
