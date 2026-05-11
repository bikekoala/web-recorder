import type { ExpectAfter, PerformanceStep, RehearsalTrace } from '../../domain/performance.js';
import type { PageDiagnostic } from '../../domain/action-log.js';
import type { Logger } from '../../infra/logger.js';
import type { IPageSession } from '../../ports/page-session.js';

/**
 * Off-camera "graduated walk" over a recon draft (ADR §0034 — the rehearsing
 * reconnoiterer). `recon()` hands `rehearse()` the resolved draft + the live
 * IPageSession; this walks the draft *instantly* (no animations, no dwells),
 * actually executing click/type/key/back, observing what really happens, and:
 *
 *  - rewriting each acting step's `expectAfter` to the observed post-state,
 *  - reconverging (via a caller-supplied callback, capped) when a step
 *    diverges (threw / landed on about:blank / a dead element / expectAfter
 *    unsatisfied with no visible change),
 *  - truncating + appending a graceful tail when the reconverge cap or a
 *    wall-clock budget is hit.
 *
 * Returns `{ steps, trace }`. Does NOT reset the page — the caller does that
 * after `rehearse()` returns.
 *
 * Depends only on the IPageSession port (+ the `reconverge` callback). No
 * config, no OpenAI, no core.
 */

export interface ReconvergeContext {
  session: IPageSession;
  divergedAtIndex: number;
  divergedStep: PerformanceStep;
  intent: string;
  observedUrl: string;
}

export interface RehearsalOpts {
  draftSteps: PerformanceStep[];
  session: IPageSession;
  intent: string;
  reconverge: (ctx: ReconvergeContext) => Promise<PerformanceStep[]>;
  rehearsalBudgetMs: number;
  reconvergeMax: number;
  logger: Logger;
}

export async function rehearse(
  opts: RehearsalOpts,
): Promise<{ steps: PerformanceStep[]; trace: RehearsalTrace }> {
  const { session, logger } = opts;
  const deadlineAt = Date.now() + opts.rehearsalBudgetMs;

  let steps: PerformanceStep[] = [...opts.draftSteps];
  const walked: PerformanceStep[] = [];
  let divergences = 0;
  let reconverges = 0;
  let truncated = false;
  let timedOut = false;

  let i = 0;
  while (i < steps.length) {
    if (Date.now() >= deadlineAt) {
      timedOut = true;
      truncated = true;
      break;
    }
    const step = steps[i]!;

    if (step.kind === 'done') {
      walked.push(step);
      i++;
      continue;
    }
    if (step.kind === 'dwell') {
      // Skip the wait; keep the step (with its original durationMs).
      walked.push(step);
      i++;
      continue;
    }
    if (step.kind === 'scroll') {
      // Instant scroll — duration 1, NOT the plan's durationMs. The plan's
      // durationMs/easing/dwellAfterMs stay untouched in the kept step.
      await session.scroll(step.deltaPx, { durationMs: 1 }).catch((err: unknown) => {
        logger.debug({ err }, 'rehearsal scroll threw');
      });
      walked.push(step);
      i++;
      continue;
    }

    // Acting step: click | type | key | back.
    const urlBefore = await safeCurrentUrl(session);
    const diagBefore = await session.pageDiagnostic().catch(() => null);
    const sigBefore = pageSignature(diagBefore);

    let threw = false;
    try {
      await renderActingStepInstant(step, session);
    } catch (err) {
      threw = true;
      logger.debug({ err, kind: step.kind }, 'rehearsal acting step threw');
    }

    // Let a navigation-capable step settle before we observe the post-state —
    // otherwise we'd rewrite expectAfter from a mid-navigation snapshot.
    // (Not after `type`: typing into a field doesn't navigate.)
    if (step.kind === 'click' || step.kind === 'key' || step.kind === 'back') {
      await session.waitForVisualStability({ maxMs: 3000 }).catch(() => {});
    }

    const urlAfter = await safeCurrentUrl(session);
    const diag = await session.pageDiagnostic().catch(() => null);
    const sigAfter = pageSignature(diag);

    const ea = stepExpectAfter(step);
    const eaSatisfied = ea ? await expectAfterSatisfied(ea, urlAfter, session) : true;
    const aboutBlank = urlAfter === 'about:blank';
    const pageChanged = urlBefore !== urlAfter || sigBefore !== sigAfter;
    // A dead element was clicked (the §0034 failure this whole thing exists to catch).
    const unchanged =
      (step.kind === 'click' || step.kind === 'type') && !threw && !pageChanged;
    // An expectAfter mismatch only counts as a divergence when the action also
    // produced no visible change. If the page *did* change, the action "worked"
    // — the planner just guessed the post-state wrong — and we rewrite it below.
    // (This gating is required by the no-divergence rehearsal test.)
    const eaMismatch = !!ea && !eaSatisfied && !pageChanged;
    const diverged = threw || aboutBlank || unchanged || eaMismatch;

    if (!diverged) {
      walked.push(await rewriteExpectAfter(step, urlBefore, urlAfter, ea, diag, session));
      i++;
      continue;
    }

    divergences++;
    logger.info(
      { i, kind: step.kind, threw, aboutBlank, unchanged, eaSatisfied },
      'rehearsal divergence',
    );

    if (reconverges < opts.reconvergeMax && Date.now() < deadlineAt) {
      let newSteps: PerformanceStep[] | null = null;
      try {
        newSteps = await opts.reconverge({
          session,
          divergedAtIndex: i,
          divergedStep: step,
          intent: opts.intent,
          observedUrl: urlAfter,
        });
      } catch (err) {
        logger.warn({ err }, 'reconverge failed');
        newSteps = null;
      }
      if (newSteps && newSteps.length > 0) {
        // Drop the diverged step (it didn't work; it's not in `walked`),
        // replace the whole remaining working list with the reconverged steps,
        // restart the walk index. The new steps go through the same loop —
        // same divergence checks, same divergences/reconverges/deadline caps.
        reconverges++;
        steps = [...newSteps];
        i = 0;
        continue;
      }
      // reconverge gave nothing usable — fall through to truncate.
    }

    truncated = true;
    break;
  }

  if (truncated) {
    walked.push(...gracefulTail());
  } else if (!walked.some((s) => s.kind === 'done')) {
    walked.push({ kind: 'done', reasoning: 'rehearsal walk completed; nothing left to do' });
  }
  if (walked.length === 0) {
    // Never return zero steps — PerformanceSchema requires steps.min(1).
    walked.push(...gracefulTail());
    truncated = true;
  }

  return {
    steps: walked,
    trace: { walkedSteps: walked.length, divergences, reconverges, truncated, timedOut },
  };
}

// ---------------------------------------------------------------- helpers

function gracefulTail(): PerformanceStep[] {
  return [
    {
      kind: 'scroll',
      deltaPx: 320,
      durationMs: 1500,
      easing: 'inOutQuad',
      dwellAfterMs: 0,
      reasoning: 'rehearsal truncated: gentle closing scroll',
    },
    { kind: 'dwell', durationMs: 700, reasoning: 'rehearsal truncated: brief settle' },
    { kind: 'done', reasoning: 'rehearsal truncated — playing out gracefully' },
  ];
}

async function safeCurrentUrl(session: IPageSession): Promise<string> {
  try {
    return await session.currentUrl();
  } catch {
    return '';
  }
}

/**
 * A noise-tolerant fingerprint of "what's on the page", from a PageDiagnostic.
 * We deliberately do NOT use observeAll() selectors here — React apps churn
 * dynamic element ids/selectors between calls, which would make the "did the
 * click change anything?" check fire false-negatives (we'd think a dead click
 * "worked" because the selector list shifted). The interactive-element COUNT,
 * the page title, and the first few headings are far more stable signals.
 */
function pageSignature(diag: PageDiagnostic | null): string {
  if (!diag) return '';
  return `${diag.interactiveElementCount}:${diag.title}:${diag.visibleHeadings.join('|')}`;
}

function stepExpectAfter(step: PerformanceStep): ExpectAfter | null {
  return step.kind === 'click' || step.kind === 'key' || step.kind === 'back'
    ? step.expectAfter ?? null
    : null;
}

async function expectAfterSatisfied(
  ea: ExpectAfter,
  urlAfter: string,
  session: IPageSession,
): Promise<boolean> {
  if (ea.urlContains && !urlAfter.includes(ea.urlContains)) return false;
  for (const t of ea.visibleText ?? []) {
    const found = await session.quickFindOnPage(t).catch(() => null);
    if (!found) return false;
  }
  return true;
}

/**
 * Click a resolved target the way PerformanceDirector does on-camera: prefer a
 * coordinate click (robust to React re-renders that stale the deep XPath) — the
 * bbox is page-absolute (recon resolved it at scrollY 0), so its viewport
 * position now is bbox.y - currentScrollY. If that lands inside the viewport,
 * click the pixel; otherwise (or if the pixel-click throws) fall back to the
 * selector. Small duplication of PerformanceDirector.clickTarget — acceptable,
 * same as the stepExpectAfter duplication above.
 */
async function clickResolvedTarget(
  target: { selector: string; bbox: { x: number; y: number; width: number; height: number }; description: string },
  session: IPageSession,
): Promise<void> {
  const scrollY = await session.scrollY().catch(() => 0);
  const vp = session.viewport;
  const cx = target.bbox.x + target.bbox.width / 2;
  const cy = target.bbox.y - scrollY + target.bbox.height / 2;
  const inViewport = cx >= 0 && cx < vp.width && cy >= 0 && cy < vp.height;
  if (inViewport) {
    try {
      await session.clickAt(cx, cy, { description: target.description });
      return;
    } catch {
      // fall through to the selector
    }
  }
  await session.clickSelector(target.selector, { description: target.description });
}

async function renderActingStepInstant(step: PerformanceStep, session: IPageSession): Promise<void> {
  switch (step.kind) {
    case 'click':
      await clickResolvedTarget(step.target, session);
      return;
    case 'type':
      await clickResolvedTarget(step.target, session);
      await session.type(step.text, { preMs: 0, keystrokeMs: 0 });
      return;
    case 'key':
      await session.pressKey(step.key);
      return;
    case 'back':
      await session.goBack();
      return;
    default:
      throw new Error(`renderActingStepInstant called with non-acting kind: ${step.kind}`);
  }
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname || u;
  } catch {
    return u;
  }
}

async function rewriteExpectAfter(
  step: PerformanceStep,
  urlBefore: string,
  urlAfter: string,
  eaBefore: ExpectAfter | null,
  diag: PageDiagnostic | null,
  session: IPageSession,
): Promise<PerformanceStep> {
  // Only click/key/back carry expectAfter.
  if (step.kind !== 'click' && step.kind !== 'key' && step.kind !== 'back') return step;

  const next: { urlContains?: string; visibleText?: string[] } = {};

  if (urlAfter && urlAfter !== urlBefore && urlAfter !== 'about:blank') {
    next.urlContains = pathOf(urlAfter);
  }

  const candidates: string[] = [];
  for (const t of eaBefore?.visibleText ?? []) {
    const found = await session.quickFindOnPage(t).catch(() => null);
    if (found) candidates.push(t);
  }
  const heading = diag?.visibleHeadings?.[0];
  if (heading) candidates.push(heading);
  const deduped = [...new Set(candidates)].slice(0, 2);
  if (deduped.length > 0) next.visibleText = deduped;

  if (next.urlContains !== undefined || next.visibleText !== undefined) {
    return { ...step, expectAfter: next };
  }
  // No new evidence — keep whatever the step already had (it was satisfied,
  // which is the only way we reach here for a step that carried one).
  return step;
}
