import { describe, expect, it } from 'vitest';
import { PerformanceDirector } from '../../../../src/adapters/director/performance-director.js';
import { FakeReconnoiterer } from '../../../fakes/fake-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { Performance } from '../../../../src/domain/performance.js';
import type { ActionLogEntry } from '../../../../src/domain/action-log.js';

// Default helper: a target whose bbox center is well inside the (1280×720)
// fake viewport at scrollY 0, so the director coordinate-clicks it (`clickAt`).
const target = (sel: string) => ({ selector: sel, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: sel });
// A target whose bbox is far below the viewport at scrollY 0 → coord-click is
// out of range → the director falls back to `clickSelector`.
const offscreenTarget = (sel: string) => ({ selector: sel, bbox: { x: 0, y: 5000, width: 10, height: 10 }, description: sel });

const perf = (steps: Performance['steps'], durationMs = 20000): Performance => ({
  prompt: 'do the thing', durationMs, steps, totalEstimatedMs: 5000, rationale: 'test',
});

// Long enough that `hardDeadlineAt - Date.now()` (≈ durationMs * directorHardBudgetMult)
// stays well above config.replanMinRemainingMs (60 s) — so the heavyweight
// re-plan branch fires instead of graceful degradation.
const REPLAN_OK_MS = 120_000;

describe('PerformanceDirector — deterministic playback', () => {
  it('calls beginRecording once and stops on a done step', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    const report = await director.run(perf([{ kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.filter((e) => e.kind === 'beginRecording')).toHaveLength(1);
    expect(report.endReason).toBe('done');
    expect(report.stepsExecuted).toBe(1);
  });

  it('renders a scroll step with its planned duration + dwellAfter', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'scroll', deltaPx: 400, durationMs: 1500, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 'browse' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.payload).toMatchObject({ deltaY: 400, durationMs: 1500 });
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 200)).toBe(true);
  });

  it('coordinate-clicks a target after an anticipation wait', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'click', target: target('text=Go'), anticipationMs: 500, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 500)).toBe(true);
    const coordClicks = session.events.filter((e) => e.kind === 'clickAt');
    expect(coordClicks).toHaveLength(1);
    expect(coordClicks[0]!.payload).toMatchObject({ x: 5, y: 5 });
    expect(session.events.some((e) => e.kind === 'click')).toBe(false);
  });

  it('clicks a target by coordinate when its bbox is in the viewport', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'click', target: { selector: 'xpath=//a[1]', bbox: { x: 100, y: 200, width: 40, height: 18 }, description: 'a link' }, anticipationMs: 0, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    const coordClicks = session.events.filter((e) => e.kind === 'clickAt');
    expect(coordClicks).toHaveLength(1);
    expect(coordClicks[0]!.payload).toMatchObject({ x: 120, y: 209, description: 'a link' });
    expect(session.events.some((e) => e.kind === 'click')).toBe(false);
  });

  it('falls back to clickSelector when the bbox is out of the viewport', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'click', target: offscreenTarget('xpath=//a[1]'), anticipationMs: 0, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'clickAt')).toBe(false);
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'xpath=//a[1]')).toBe(true);
  });

  it('falls back to clickSelector when clickAt throws', async () => {
    const session = new FakePageSession();
    session.clickAtImpl = () => { throw new Error('pixel click failed'); };
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'click', target: target('text=Go'), anticipationMs: 0, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'clickAt')).toBe(true); // attempted
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'text=Go')).toBe(true); // fell back
  });

  it('waits for visual stability after a click', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'click', target: target('text=Go'), anticipationMs: 0, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    const clickIdx = session.events.findIndex((e) => e.kind === 'clickAt');
    expect(clickIdx).toBeGreaterThanOrEqual(0);
    expect(session.events.slice(clickIdx + 1).some((e) => e.kind === 'stable')).toBe(true);
  });

  it('renders a type step: focus, pre-pause, type', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([
      { kind: 'type', target: target('input[name=q]'), text: 'hi', preMs: 250, keystrokeMs: 80, reasoning: 'enter query' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'clickAt')).toBe(true);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 250)).toBe(true);
    expect(session.events.some((e) => e.kind === 'type' && e.payload === 'hi')).toBe(true);
  });

  it('plays a dwell step as a wait of the planned duration', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(perf([{ kind: 'dwell', durationMs: 1234, reasoning: 'read' }, { kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 1234)).toBe(true);
  });

  it('stops with endReason "budget" if the steps overrun durationMs * hardBudgetMult', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    const report = await director.run(
      { prompt: 'p', durationMs: 200, steps: [{ kind: 'dwell', durationMs: 1000, reasoning: 'long' }, { kind: 'done', reasoning: 'fin' }], totalEstimatedMs: 1000, rationale: 't' },
      session,
    );
    expect(report.endReason).toBe('budget');
  });
});

describe('PerformanceDirector — duration soft-alignment (§0039)', () => {
  it('shortens the next dwell when a slow page-settle pushed playback over the proportional schedule', async () => {
    const session = new FakePageSession();
    // Model a ~1.5 s navigation settle: the click's `waitForVisualStability`
    // really sleeps, so by the time we reach the dwell ~1.5 s of the 3 s budget
    // is already spent — the planned 3 s dwell must shrink to ~1.5 s.
    session.waitForVisualStabilityImpl = () => new Promise((r) => setTimeout(r, 1500));
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: true });
    const report = await director.run(
      {
        prompt: 'p', durationMs: 3000, totalEstimatedMs: 3000, rationale: 't',
        steps: [
          { kind: 'click', target: { selector: 'a', bbox: { x: 0, y: 0, width: 10, height: 10 }, description: 'go' }, anticipationMs: 0, reasoning: 'tap' },
          { kind: 'dwell', durationMs: 3000, reasoning: 'read' },
          { kind: 'done', reasoning: 'fin' },
        ],
      },
      session,
    );
    const dwellWaits = session.events.filter((e) => e.kind === 'wait' && typeof e.payload === 'number' && (e.payload as number) >= 100);
    expect(dwellWaits).toHaveLength(1);
    expect(dwellWaits[0]!.payload).toBeLessThan(2200);   // shortened from 3000
    expect(dwellWaits[0]!.payload).toBeGreaterThan(800);  // …but not slammed to the floor
    // and the recording landed near durationMs (settle + shortened dwell ≈ 3 s)
    expect(report.totalMs).toBeGreaterThan(2400);
    expect(report.totalMs).toBeLessThan(3600);
    expect(report.endReason).toBe('done');
  });

  it('lengthens an under-budget dwell — but no further than the stretch cap', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: true });
    await director.run(
      {
        prompt: 'p', durationMs: 5000, totalEstimatedMs: 5000, rationale: 't',
        steps: [
          { kind: 'scroll', deltaPx: 400, durationMs: 500, easing: 'inOutQuad', dwellAfterMs: 0, reasoning: 'browse' },
          { kind: 'dwell', durationMs: 1000, reasoning: 'read' },
          { kind: 'done', reasoning: 'fin' },
        ],
      },
      session,
    );
    const dwellWaits = session.events.filter((e) => e.kind === 'wait').map((e) => e.payload as number);
    expect(dwellWaits).toHaveLength(1);
    // proportional target wants ~4.5 s here; the cap (planned 1000 + config 2000) holds it to 3000.
    expect(dwellWaits[0]).toBe(3000);
  });

  it('softAlign: false ⇒ the dwell renders its planned duration verbatim (no nudge)', async () => {
    const session = new FakePageSession();
    session.waitForVisualStabilityImpl = () => new Promise((r) => setTimeout(r, 500));
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer(), softAlign: false });
    await director.run(
      {
        prompt: 'p', durationMs: 9000, totalEstimatedMs: 9000, rationale: 't',
        steps: [
          { kind: 'click', target: { selector: 'a', bbox: { x: 0, y: 0, width: 10, height: 10 }, description: 'go' }, anticipationMs: 0, reasoning: 'tap' },
          { kind: 'dwell', durationMs: 1234, reasoning: 'read' },
          { kind: 'done', reasoning: 'fin' },
        ],
      },
      session,
    );
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 1234)).toBe(true);
  });
});

describe('PerformanceDirector — re-plan checkpoint', () => {
  it('re-plans when a step expectAfter does not match reality', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    const replan = new FakeReconnoiterer([
      perf([{ kind: 'click', target: target('text=Recovered'), anticipationMs: 100, reasoning: 'try a different link' }, { kind: 'done', reasoning: 'fin' }]),
    ]);
    const director = new PerformanceDirector({ replanner: replan, softAlign: false });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 100, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ], REPLAN_OK_MS), session);
    expect(report.replanCount).toBe(1);
    expect(replan.calls).toHaveLength(1);
    expect(replan.calls[0]!.priorSteps?.[0]).toMatchObject({ kind: 'click' });
    expect(session.appendedEntries.some((e: ActionLogEntry) => e.type === 'replan')).toBe(true);
    expect(report.endReason).toBe('done');
    // The recovered step is also coordinate-clicked (its bbox is in-viewport).
    expect(session.events.filter((e) => e.kind === 'clickAt')).toHaveLength(2);
  });

  it('does NOT re-plan when expectAfter matches', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/build/';
    const replan = new FakeReconnoiterer(); // empty — throws if called
    const director = new PerformanceDirector({ replanner: replan, softAlign: false });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 50, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(report.replanCount).toBe(0);
    expect(replan.calls).toHaveLength(0);
  });

  it('stops re-planning after maxReplans (config default 3)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start'; // never satisfies /build
    const loopStep = () => perf([{ kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'retry', expectAfter: { urlContains: '/build' } }, { kind: 'done', reasoning: 'fin' }], REPLAN_OK_MS);
    const replan = new FakeReconnoiterer([loopStep(), loopStep(), loopStep(), loopStep(), loopStep()]);
    const director = new PerformanceDirector({ replanner: replan, softAlign: false });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ], REPLAN_OK_MS), session);
    expect(report.replanCount).toBeLessThanOrEqual(3);
  });

  it('degrades gracefully when budget is below replanMinRemainingMs', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start'; // never satisfies /build
    const replan = new FakeReconnoiterer(); // empty queue — would throw if recon() were called
    const director = new PerformanceDirector({ replanner: replan, softAlign: false });
    // durationMs 8000 ⇒ hardDeadline ≈ +9.6 s ≪ 60 s ⇒ no on-camera re-plan.
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'click', target: target('text=stale'), anticipationMs: 10, reasoning: 'stale tail step that should be dropped' },
      { kind: 'done', reasoning: 'fin' },
    ], 8000), session);

    expect(report.replanCount).toBe(0);
    expect(report.endReason).toBe('done');
    expect(replan.calls).toHaveLength(0); // heavyweight recon NOT invoked
    expect(session.appendedEntries.some(
      (e: ActionLogEntry) => e.type === 'decision_failure' && e.reason === 'expect_after_mismatch',
    )).toBe(true);
    // The stale tail click was dropped; the filler scroll + dwell were rendered instead.
    expect(session.events.some((e) => e.kind === 'clickAt' && (e.payload as { description: string }).description === 'text=stale')).toBe(false);
    const failedClickIdx = session.events.findIndex((e) => e.kind === 'clickAt' && (e.payload as { description: string }).description === 'text=build');
    expect(failedClickIdx).toBeGreaterThanOrEqual(0);
    expect(session.events.slice(failedClickIdx + 1).some((e) => e.kind === 'scroll')).toBe(true);
    expect(session.events.slice(failedClickIdx + 1).some((e) => e.kind === 'wait' && e.payload === 700)).toBe(true);
  });

  it('stops gracefully (endReason "error") if a re-plan call throws', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    const replan = new FakeReconnoiterer(); // empty queue → recon() throws
    const director = new PerformanceDirector({ replanner: replan, softAlign: false });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ], REPLAN_OK_MS), session);
    expect(report.endReason).toBe('error');
  });
});
