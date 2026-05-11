import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { ExpectAfter, Performance, PerformanceStep } from '../../domain/performance.js';
import type { Viewport } from '../../domain/action-log.js';
import type { IDirector, DirectorReport } from '../../ports/director.js';
import type { IPageSession } from '../../ports/page-session.js';
import type { IReconnoiterer } from '../../ports/reconnoiterer.js';

interface PerformanceDirectorOpts {
  replanner: IReconnoiterer;
}

export class PerformanceDirector implements IDirector {
  private readonly replanner: IReconnoiterer;
  private readonly logger = rootLogger.child({ component: 'PerformanceDirector' });

  constructor(opts: PerformanceDirectorOpts) {
    this.replanner = opts.replanner;
  }

  async run(performance: Performance, session: IPageSession): Promise<DirectorReport> {
    const startedAt = Date.now();
    const hardDeadlineAt = startedAt + performance.durationMs * config.directorHardBudgetMult;
    await session.beginRecording();

    let workingSteps: PerformanceStep[] = [...performance.steps];
    let stepsExecuted = 0;
    let replanCount = 0;

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
      try {
        await this.renderStep(step, session);
      } catch (err) {
        this.logger.warn({ err, kind: step.kind }, 'step render failed — stopping');
        return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'error' };
      }
      stepsExecuted += 1;

      // §0034 re-plan checkpoint — only on steps that carry an expectAfter.
      // When reality diverges from the plan (wrong URL, expected text absent),
      // we call the reconnoiterer again with the REMAINING budget and a summary
      // of the steps already executed. The new Performance replaces the tail of
      // the working step list so playback continues from the current page state.
      // Capped at config.maxReplans to prevent infinite re-plan loops.
      const ea = stepExpectAfter(step);
      if (ea && !(await this.satisfiesExpectAfter(ea, session))) {
        if (replanCount >= config.maxReplans) {
          this.logger.warn({ replanCount }, 'maxReplans reached — playing out remaining steps without re-planning');
          i += 1;
          continue;
        }
        replanCount += 1;
        const currentUrl = await safeUrl(session);
        const screenshot = await session.screenshot().catch(() => null);
        const remainingMs = Math.max(1000, hardDeadlineAt - Date.now());
        const priorSteps = workingSteps.slice(0, i + 1).map((s) => ({ kind: s.kind, reasoning: s.reasoning }));
        this.logger.info({ fromStepIndex: i, expected: ea, replanCount }, 'expectAfter mismatch — re-planning');
        this.appendReplanEntry(session, i, 'expect_after_mismatch', `expected ${JSON.stringify(ea)}; URL was ${currentUrl}`);
        let newPerf;
        try {
          newPerf = await this.replanner.recon(
            { url: currentUrl, prompt: performance.prompt, durationMs: remainingMs, viewport: viewportFrom(session), screenshot, priorSteps },
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
      i += 1;
    }
    return { totalMs: Date.now() - startedAt, stepsExecuted, replanCount, endReason: 'done' };
  }

  private async renderStep(step: PerformanceStep, session: IPageSession): Promise<void> {
    switch (step.kind) {
      case 'dwell':
        await session.wait(step.durationMs);
        return;
      case 'scroll':
        await session.scroll(step.deltaPx, { durationMs: step.durationMs, easing: step.easing });
        if (step.dwellAfterMs > 0) await session.wait(step.dwellAfterMs);
        return;
      case 'click':
        if (step.anticipationMs > 0) await session.wait(step.anticipationMs);
        await session.clickSelector(step.target.selector, { description: step.target.description });
        return;
      case 'type':
        await session.clickSelector(step.target.selector, { description: step.target.description });
        if (step.preMs > 0) await session.wait(step.preMs);
        await session.type(step.text);
        return;
      case 'key':
        await session.pressKey(step.key);
        return;
      case 'back':
        await session.goBack();
        return;
      case 'done':
        return;
    }
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
        viewport: viewportFrom(session),
      });
    } catch (err) {
      this.logger.debug({ err }, 'appendReplanEntry failed');
    }
  }
}

// ---------------------------------------------------------------- helpers

function stepExpectAfter(step: PerformanceStep): ExpectAfter | null {
  return (step.kind === 'click' || step.kind === 'key' || step.kind === 'back')
    ? (step.expectAfter ?? null)
    : null;
}

async function safeUrl(session: IPageSession): Promise<string> {
  try { return await session.currentUrl(); } catch { return ''; }
}

function viewportFrom(session: IPageSession): Viewport {
  const v = (session as unknown as { viewport?: Viewport }).viewport;
  return v ?? { width: 1280, height: 720 };
}
