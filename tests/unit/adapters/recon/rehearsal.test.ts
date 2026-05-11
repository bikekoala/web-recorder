import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { rehearse, type ReconvergeContext } from '../../../../src/adapters/recon/rehearsal.js';
import type { PerformanceStep } from '../../../../src/domain/performance.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';

const log = pino({ level: 'silent' });
const NEVER_RECONVERGE = async (_ctx: ReconvergeContext): Promise<PerformanceStep[]> => { throw new Error('reconverge should not have been called'); };

function clickStep(desc: string, expectAfter?: { urlContains?: string; visibleText?: string[] }): PerformanceStep {
  return { kind: 'click', target: { selector: `sel:${desc}`, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: desc }, anticipationMs: 200, reasoning: `click ${desc}`, ...(expectAfter ? { expectAfter } : {}) };
}
const dwell = (ms: number): PerformanceStep => ({ kind: 'dwell', durationMs: ms, reasoning: 'd' });
const scroll = (px: number): PerformanceStep => ({ kind: 'scroll', deltaPx: px, durationMs: 2000, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 's' });
const done: PerformanceStep = { kind: 'done', reasoning: 'fin' };

describe('rehearse()', () => {
  it('no divergence: walks all steps, rewrites click expectAfter to observed state, keeps scroll/dwell params', async () => {
    const session = new FakePageSession();
    session.url = 'https://test.example/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    session.clickSelectorImpl = () => {
      session.url = 'https://test.example/zh';
      session.observeResults = [{ selector: 'a#y', description: 'y' }] as any;
      session.pageDiagnosticImpl = () => ({ url: session.url, title: 'ZH', interactiveElementCount: 5, visibleHeadings: ['Heading ZH'], blockerSignals: [] });
    };
    const draft: PerformanceStep[] = [dwell(300), scroll(800), clickStep('the link', { urlContains: '/wrong', visibleText: ['gone'] }), dwell(400), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(trace).toMatchObject({ divergences: 0, reconverges: 0, truncated: false, timedOut: false });
    expect(steps[0]).toEqual(dwell(300));
    expect(steps[1]).toEqual(scroll(800));
    const click = steps[2] as Extract<PerformanceStep, { kind: 'click' }>;
    expect(click.expectAfter?.urlContains).toBe('/zh');
    expect(click.expectAfter?.visibleText).toContain('Heading ZH');
    expect(click.expectAfter?.visibleText).not.toContain('gone');
    expect(steps[steps.length - 1].kind).toBe('done');
  });

  it('dead click (page unchanged after click) → divergence → reconverge → working list replaced', async () => {
    const session = new FakePageSession();
    session.url = 'https://test.example/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    const reconverged: PerformanceStep[] = [clickStep('the REAL link'), done];
    let reconvergeCalls = 0;
    const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
      reconvergeCalls++;
      expect(ctx.divergedStep.kind).toBe('click');
      session.clickSelectorImpl = () => { session.url = 'https://test.example/real'; session.observeResults = [{ selector: 'a#z', description: 'z' }] as any; };
      return reconverged;
    };
    const draft: PerformanceStep[] = [clickStep('the link'), dwell(400), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(reconvergeCalls).toBe(1);
    expect(trace).toMatchObject({ divergences: 1, reconverges: 1, truncated: false, timedOut: false });
    expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the link')).toBe(false);
    expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the REAL link')).toBe(true);
  });

  it('reconverge cap hit → truncate at the divergence + graceful tail', async () => {
    const session = new FakePageSession();
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    const reconverge = async (_ctx: ReconvergeContext): Promise<PerformanceStep[]> => [clickStep('still dead'), done];
    const draft: PerformanceStep[] = [clickStep('a'), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 1, logger: log });
    expect(trace.truncated).toBe(true);
    expect(trace.reconverges).toBe(1);
    const tail = steps.slice(-3);
    expect(tail.map((s) => s.kind)).toEqual(['scroll', 'dwell', 'done']);
  });

  it('wall-clock budget exceeded → truncate (timedOut)', async () => {
    const session = new FakePageSession();
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    const draft: PerformanceStep[] = [scroll(100), scroll(100), scroll(100), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 0, reconvergeMax: 2, logger: log });
    expect(trace.timedOut).toBe(true);
    expect(trace.truncated).toBe(true);
    expect(steps[steps.length - 1].kind).toBe('done');
  });

  it('never returns zero steps', async () => {
    const session = new FakePageSession();
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    const reconverge = async (): Promise<PerformanceStep[]> => [];
    const draft: PerformanceStep[] = [clickStep('a')];
    const { steps } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[steps.length - 1].kind).toBe('done');
  });
});
