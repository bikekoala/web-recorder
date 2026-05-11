import { describe, expect, it } from 'vitest';
import { PerformanceDirector } from '../../../../src/adapters/director/performance-director.js';
import { FakeReconnoiterer } from '../../../fakes/fake-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { Performance } from '../../../../src/domain/performance.js';
import type { ActionLogEntry } from '../../../../src/domain/action-log.js';

const target = (sel: string) => ({ selector: sel, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: sel });

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
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    const report = await director.run(perf([{ kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.filter((e) => e.kind === 'beginRecording')).toHaveLength(1);
    expect(report.endReason).toBe('done');
    expect(report.stepsExecuted).toBe(1);
  });

  it('renders a scroll step with its planned duration + dwellAfter', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'scroll', deltaPx: 400, durationMs: 1500, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 'browse' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.payload).toMatchObject({ deltaY: 400, durationMs: 1500 });
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 200)).toBe(true);
  });

  it('renders a click step via clickSelector after an anticipation wait', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'click', target: target('text=Go'), anticipationMs: 500, reasoning: 'tap' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 500)).toBe(true);
    const clicks = session.events.filter((e) => e.kind === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload).toMatchObject({ selector: 'text=Go' });
  });

  it('renders a type step: focus, pre-pause, type', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([
      { kind: 'type', target: target('input[name=q]'), text: 'hi', preMs: 250, keystrokeMs: 80, reasoning: 'enter query' },
      { kind: 'done', reasoning: 'fin' },
    ]), session);
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'input[name=q]')).toBe(true);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 250)).toBe(true);
    expect(session.events.some((e) => e.kind === 'type' && e.payload === 'hi')).toBe(true);
  });

  it('plays a dwell step as a wait of the planned duration', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    await director.run(perf([{ kind: 'dwell', durationMs: 1234, reasoning: 'read' }, { kind: 'done', reasoning: 'fin' }]), session);
    expect(session.events.some((e) => e.kind === 'wait' && e.payload === 1234)).toBe(true);
  });

  it('stops with endReason "budget" if the steps overrun durationMs * hardBudgetMult', async () => {
    const session = new FakePageSession();
    const director = new PerformanceDirector({ replanner: new FakeReconnoiterer() });
    const report = await director.run(
      { prompt: 'p', durationMs: 200, steps: [{ kind: 'dwell', durationMs: 1000, reasoning: 'long' }, { kind: 'done', reasoning: 'fin' }], totalEstimatedMs: 1000, rationale: 't' },
      session,
    );
    expect(report.endReason).toBe('budget');
  });
});

describe('PerformanceDirector — re-plan checkpoint', () => {
  it('re-plans when a step expectAfter does not match reality', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    const replan = new FakeReconnoiterer([
      perf([{ kind: 'click', target: target('text=Recovered'), anticipationMs: 100, reasoning: 'try a different link' }, { kind: 'done', reasoning: 'fin' }]),
    ]);
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 100, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ], REPLAN_OK_MS), session);
    expect(report.replanCount).toBe(1);
    expect(replan.calls).toHaveLength(1);
    expect(replan.calls[0]!.priorSteps?.[0]).toMatchObject({ kind: 'click' });
    expect(session.appendedEntries.some((e: ActionLogEntry) => e.type === 'replan')).toBe(true);
    expect(report.endReason).toBe('done');
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'text=Recovered')).toBe(true);
  });

  it('does NOT re-plan when expectAfter matches', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/build/';
    const replan = new FakeReconnoiterer(); // empty — throws if called
    const director = new PerformanceDirector({ replanner: replan });
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
    const director = new PerformanceDirector({ replanner: replan });
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
    const director = new PerformanceDirector({ replanner: replan });
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
    expect(session.events.some((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'text=stale')).toBe(false);
    const failedClickIdx = session.events.findIndex((e) => e.kind === 'click' && (e.payload as { selector: string }).selector === 'text=build');
    expect(failedClickIdx).toBeGreaterThanOrEqual(0);
    expect(session.events.slice(failedClickIdx + 1).some((e) => e.kind === 'scroll')).toBe(true);
    expect(session.events.slice(failedClickIdx + 1).some((e) => e.kind === 'wait' && e.payload === 700)).toBe(true);
  });

  it('stops gracefully (endReason "error") if a re-plan call throws', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/start';
    const replan = new FakeReconnoiterer(); // empty queue → recon() throws
    const director = new PerformanceDirector({ replanner: replan });
    const report = await director.run(perf([
      { kind: 'click', target: target('text=build'), anticipationMs: 10, reasoning: 'open build', expectAfter: { urlContains: '/build' } },
      { kind: 'done', reasoning: 'fin' },
    ], REPLAN_OK_MS), session);
    expect(report.endReason).toBe('error');
  });
});
