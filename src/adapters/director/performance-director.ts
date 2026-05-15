import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { ExpectAfter, Performance, PerformanceStep, ResolvedTarget } from '../../domain/performance.js';
import type { IDirector, DirectorReport } from '../../ports/director.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer } from '../../ports/reconnoiterer.js';

interface PerformanceDirectorOpts {
  replanner: IReconnoiterer;
  /**
   * Closed-loop duration soft-alignment (§0039) — default `true`. When on, each
   * `dwell` step's length is nudged at playback time so the recording tracks the
   * proportional `durationMs` schedule (shorten when running over, lengthen when
   * under, both bounded). Pass `false` in tests that assert on exact `dwell`
   * durations (the fakes' instant `waitForVisualStability` doesn't match the
   * pacing model the alignment compares against).
   */
  softAlign?: boolean;
}

export class PerformanceDirector implements IDirector {
  private readonly replanner: IReconnoiterer;
  private readonly softAlign: boolean;
  private readonly logger = rootLogger.child({ component: 'PerformanceDirector' });

  constructor(opts: PerformanceDirectorOpts) {
    this.replanner = opts.replanner;
    // Default softAlign follows the humanize strategy: when cloakbrowser owns
    // on-camera rendering, our dwell-stretching would compete with its own
    // pacing; explicit `opts.softAlign` always wins so unit tests stay
    // deterministic.
    this.softAlign = opts.softAlign ?? (config.humanizeStrategy === 'ours');
  }

  async run(performance: Performance, session: IPageSession): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + performance.durationMs * config.directorHardBudgetMult;
    await session.beginRecording();

    let workingSteps: PerformanceStep[] = [...performance.steps];
    let stepsExecuted = 0;
    let replanCount = 0;
    // Soft-alignment bookkeeping: the declared (self-stated) timing of the steps
    // rendered so far. The recording should be at ~(renderedDeclaredMs /
    // totalDeclaredMs) of `durationMs` by now; the gap vs the real elapsed time
    // (which also carries the unlogged settle / per-step overhead) is what each
    // `dwell` absorbs. Always accumulates the PLANNED dwell duration, not the
    // adjusted one, so it stays on the declared schedule.
    let renderedDeclaredMs = 0;

    let i = 0;
    while (i < workingSteps.length) {
      if (Date.now() >= hardDeadlineAt) {
        this.logger.info({ stepsExecuted }, 'budget exhausted — stopping playback');
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'budget' };
      }
      const step = workingSteps[i]!;
      if (step.kind === 'done') {
        stepsExecuted += 1;
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'done' };
      }
      const dwellMs =
        step.kind === 'dwell' && this.softAlign
          ? alignedDwellMs(step.durationMs, renderedDeclaredMs, totalDeclaredMs(workingSteps), performance.durationMs, Date.now() - startedAt)
          : undefined;
      try {
        await this.renderStep(step, session, dwellMs !== undefined ? { dwellMs } : undefined);
      } catch (err) {
        this.logger.warn({ err, kind: step.kind }, 'step render failed — stopping');
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'error' };
      }
      renderedDeclaredMs += declaredMs(step);
      stepsExecuted += 1;

      // §0034 re-plan checkpoint — only on steps that carry an expectAfter.
      // When reality diverges from the plan (wrong URL, expected text absent),
      // we *would* call the reconnoiterer again with the REMAINING budget and a
      // summary of the steps already executed, replacing the tail of the working
      // step list so playback continues from the current page state.
      //
      // BUT: recon() is a heavyweight call (~30–50 s) that freezes the recording
      // frame for its duration — catastrophic on short recordings. So we only do
      // it when there's plenty of budget left (>= config.replanMinRemainingMs)
      // AND we haven't hit config.maxReplans. Otherwise we degrade gracefully:
      // log a decision_failure, drop the now-stale remaining steps, append a
      // short gentle closing scroll + dwell so the video ends with motion rather
      // than a freeze, and let the loop run out (even if the task is incomplete).
      const ea = stepExpectAfter(step);
      if (ea && !(await this.satisfiesExpectAfter(ea, session))) {
        const remainingMs = hardDeadlineAt - Date.now();
        if (replanCount < config.maxReplans && remainingMs >= config.replanMinRemainingMs) {
          replanCount += 1;
          const currentUrl = await safeUrl(session);
          const screenshot = await session.screenshot().catch(() => null);
          const reconBudgetMs = Math.max(1000, remainingMs);
          const priorSteps = workingSteps.slice(0, i + 1).map((s) => ({ kind: s.kind, reasoning: s.reasoning }));
          this.logger.info({ fromStepIndex: i, expected: ea, replanCount, remainingMs }, 'expectAfter mismatch — re-planning');
          this.appendReplanEntry(session, i, 'expect_after_mismatch', `expected ${JSON.stringify(ea)}; URL was ${currentUrl}`);
          let newPerf;
          try {
            newPerf = await this.replanner.recon(
              { url: currentUrl, prompt: performance.prompt, durationMs: reconBudgetMs, viewport: session.viewport, screenshot, priorSteps },
              session,
            );
          } catch (err) {
            this.logger.warn({ err }, 're-plan failed — stopping');
            return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'error' };
          }
          workingSteps = [...workingSteps.slice(0, i + 1), ...newPerf.steps];
          i += 1;
          continue;
        }

        // Graceful degradation — no on-camera recon.
        const exhausted = replanCount >= config.maxReplans;
        this.logger.warn(
          { fromStepIndex: i, expected: ea, replanCount, remainingMs },
          'expectAfter mismatch — not re-planning (budget too low or replans exhausted); degrading gracefully',
        );
        this.appendDecisionFailure(
          session,
          'expect_after_mismatch',
          `mismatch at step ${i} (${step.kind}); skipped re-plan: ${exhausted ? 'replans exhausted' : 'insufficient budget'}`,
        );
        workingSteps = workingSteps.slice(0, i + 1);
        if (remainingMs > 800) {
          const fillerScrollMs = Math.min(1800, Math.max(600, remainingMs - 600));
          workingSteps.push({
            kind: 'scroll',
            reasoning: 'graceful tail: gentle scroll to close the recording smoothly after a plan divergence',
            deltaPx: 320,
            durationMs: fillerScrollMs,
            easing: 'inOutQuad',
            dwellAfterMs: 0,
          });
          workingSteps.push({
            kind: 'dwell',
            reasoning: 'graceful tail: brief settle before the recording ends',
            durationMs: 700,
          });
        }
        i += 1;
        continue;
      }
      i += 1;
    }
    return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'done' };
  }

  private async renderStep(
    step: PerformanceStep,
    session: IPageSession,
    opts?: { dwellMs?: number },
  ): Promise<void> {
    switch (step.kind) {
      case 'dwell':
        await session.wait(opts?.dwellMs ?? step.durationMs);
        return;
      case 'scroll':
        await session.scroll(step.deltaPx, { durationMs: step.durationMs, easing: step.easing });
        if (step.dwellAfterMs > 0) await session.wait(step.dwellAfterMs);
        return;
      case 'click':
        if (step.anticipationMs > 0) await session.wait(step.anticipationMs);
        await this.clickTarget(step.target, session);
        await this.settle(session);
        return;
      case 'type':
        await this.clickTarget(step.target, session);
        if (step.preMs > 0) await session.wait(step.preMs);
        await session.type(step.text, { preMs: 0, keystrokeMs: step.keystrokeMs });
        return;
      case 'key':
        await session.pressKey(step.key);
        await this.settle(session);
        return;
      case 'back':
        await session.goBack();
        await this.settle(session);
        return;
      case 'goto':
        // ADR §0041 — direct URL navigation, played on-camera. The
        // `anticipationMs` wait represents the user typing the URL into the
        // address bar (silent in the viewport recording — URL bar is browser
        // chrome, not in the captured frame). Then we navigate and wait for
        // the page to settle, just like a click that navigates.
        if (step.anticipationMs > 0) await session.wait(step.anticipationMs);
        await session.goto(step.url);
        await this.settle(session);
        return;
      case 'done':
        return;
    }
  }

  /**
   * Click a resolved target. Prefers coordinate-clicking (robust to React
   * re-renders that stale the XPath): the bbox is page-absolute (recon
   * resolved it at scrollY 0), so the viewport position now is bbox.y -
   * currentScrollY. If that lands inside the viewport, click the pixel;
   * otherwise the plan's scrolls didn't position the element as expected —
   * fall back to the selector (Playwright scrolls it into view).
   */
  private async clickTarget(target: ResolvedTarget, session: IPageSession): Promise<void> {
    const scrollY = await session.scrollY().catch(() => 0);
    const vp = session.viewport;
    const cx = target.bbox.x + target.bbox.width / 2;
    const cy = target.bbox.y - scrollY + target.bbox.height / 2;
    const inViewport = cx >= 0 && cx < vp.width && cy >= 0 && cy < vp.height;
    if (inViewport) {
      try {
        await session.clickAt(cx, cy, { description: target.description });
        return;
      } catch (err) {
        this.logger.debug({ err, target: target.description }, 'coord click failed — falling back to selector');
      }
    }
    await session.clickSelector(target.selector, { description: target.description });
  }

  /** Let the page settle after a navigation-capable action before the expectAfter check. */
  private async settle(session: IPageSession): Promise<void> {
    await session.waitForVisualStability({ maxMs: 2500 }).catch(() => {});
  }

  private async satisfiesExpectAfter(ea: ExpectAfter, session: IPageSession): Promise<boolean> {
    if (ea.urlContains) {
      const url = await safeUrl(session);
      if (!url.includes(ea.urlContains)) return false;
    }
    if (ea.visibleText && ea.visibleText.length > 0) {
      for (const txt of ea.visibleText) {
        const found = await session.quickFindOnPage(txt).catch(() => null);
        if (!found) return false;
      }
    }
    const url = await safeUrl(session);
    if (url === 'about:blank') return false;
    return true;
  }

  private appendReplanEntry(
    session: IPageSession,
    fromStepIndex: number,
    reason: 'expect_after_mismatch' | 'about_blank' | 'target_vanished',
    details: string,
  ): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'replan',
        fromStepIndex,
        reason,
        details: details.slice(0, 500),
        scrollY: 0,
        viewport: session.viewport,
      });
    } catch (err) {
      this.logger.debug({ err }, 'appendReplanEntry failed');
    }
  }

  /**
   * Audit entry for the graceful-degradation path: an `expectAfter` mismatch
   * we deliberately did NOT re-plan (budget too low / replans exhausted).
   * Distinct from a `replan` entry, which means "we actually re-planned".
   */
  private appendDecisionFailure(
    session: IPageSession,
    reason: 'expect_after_mismatch',
    details: string,
  ): void {
    try {
      session.appendEntry({
        t: session.nowMs(),
        type: 'decision_failure',
        reason,
        details: details.slice(0, 500),
        scrollY: 0,
        viewport: session.viewport,
      });
    } catch (err) {
      this.logger.debug({ err }, 'appendDecisionFailure failed');
    }
  }
}

// ---------------------------------------------------------------- helpers

/**
 * A step's *declared* (self-stated) playback time — the timings the recon put
 * in the step, NOT the unlogged settle / per-step overhead. Used only by the
 * soft-alignment proportional schedule. (`fitPlanToBudget` makes the sum of
 * these + the fixed costs ≈ `durationMs`.)
 */
function declaredMs(step: PerformanceStep): number {
  // Same shape as the recon estimator (`sumDurations` in the LLM adapter):
  // anticipationMs for click/goto (the planner's pause-before-act), the
  // explicit durations for dwell/scroll/type, zero for instant key/back/done.
  // The runner-side per-step overhead and the post-action settle estimate
  // are NOT included here — they're the unlogged costs the soft-align
  // arithmetic accounts for separately. (ADR §0039 / §0041.)
  switch (step.kind) {
    case 'dwell': return step.durationMs;
    case 'scroll': return step.durationMs + step.dwellAfterMs;
    case 'click': return step.anticipationMs;
    case 'goto': return step.anticipationMs;
    case 'type': return step.preMs + step.text.length * step.keystrokeMs;
    case 'key':
    case 'back':
    case 'done': return 0;
  }
}

function totalDeclaredMs(steps: ReadonlyArray<PerformanceStep>): number {
  let total = 0;
  for (const s of steps) total += declaredMs(s);
  return total;
}

/**
 * Pick the wall-clock duration for a `dwell` step so the recording tracks the
 * proportional `durationMs` schedule. `renderedDeclared` is the declared timing
 * of steps already played; after this dwell the recording "should" be at
 * `(renderedDeclared + plannedDwell) / totalDeclared` of `durationMs`. Aim the
 * dwell at that point given the real `elapsedActual` (which also carries the
 * settle/overhead the declared schedule omits) — shortening it if we're over
 * (down to `config.directorDwellMinMs`), lengthening it if we're under (by at
 * most `config.directorDwellStretchMaxMs` beyond the plan, so a tiny dwell can't
 * balloon). The Director's hard-budget cap is the ultimate backstop.
 */
function alignedDwellMs(
  plannedDwell: number,
  renderedDeclared: number,
  totalDeclared: number,
  durationMs: number,
  elapsedActual: number,
): number {
  if (totalDeclared <= 0) return plannedDwell;
  const targetAfterDwell = ((renderedDeclared + plannedDwell) / totalDeclared) * durationMs;
  const ideal = Math.round(targetAfterDwell - elapsedActual);
  return Math.max(
    config.directorDwellMinMs,
    Math.min(ideal, plannedDwell + config.directorDwellStretchMaxMs),
  );
}

function stepExpectAfter(step: PerformanceStep): ExpectAfter | null {
  return (step.kind === 'click' || step.kind === 'key' || step.kind === 'back')
    ? (step.expectAfter ?? null)
    : null;
}

async function safeUrl(session: IPageSession): Promise<string> {
  try { return await session.currentUrl(); } catch { return ''; }
}
