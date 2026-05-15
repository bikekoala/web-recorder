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
function typeStep(desc: string, text: string): PerformanceStep {
  return { kind: 'type', target: { selector: `sel:${desc}`, bbox: { x: 0, y: 0, width: 10, height: 10 }, description: desc }, text, preMs: 0, keystrokeMs: 0, reasoning: `type into ${desc}` };
}
const enterKey: PerformanceStep = { kind: 'key', key: 'Enter', reasoning: 'submit' };
const dwell = (ms: number): PerformanceStep => ({ kind: 'dwell', durationMs: ms, reasoning: 'd' });
const scroll = (px: number): PerformanceStep => ({ kind: 'scroll', deltaPx: px, durationMs: 2000, easing: 'inOutQuad', dwellAfterMs: 200, reasoning: 's' });
const done: PerformanceStep = { kind: 'done', reasoning: 'fin' };

describe('rehearse()', () => {
  it('no divergence: walks all steps, rewrites click expectAfter to observed state, keeps scroll/dwell params', async () => {
    const session = new FakePageSession();
    session.url = 'https://test.example/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    // The walk runs the click as-resolved (ADR §0036 — no re-resolve). It coord-
    // clicks if the bbox lands in the viewport, else falls back to clickSelector —
    // wire both hooks to the same navigation effect.
    const nav = () => {
      session.url = 'https://test.example/zh';
      session.observeResults = [{ selector: 'a#y', description: 'y' }] as any;
      session.pageDiagnosticImpl = () => ({ url: session.url, title: 'ZH', interactiveElementCount: 5, visibleHeadings: ['Heading ZH'], blockerSignals: [] });
    };
    session.clickAtImpl = nav;
    session.clickSelectorImpl = nav;
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

  it('a click that "worked" but whose expectAfter is now unverifiable → the stale expectAfter is cleared, not kept (bug 3)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/page'; // URL won't change — the click only mutates the page
    // Clicking changes the page signature (a panel opened) but the planner's
    // expectAfter.visibleText is NOT on the resulting page, and the page has no
    // heading to anchor a new check on.
    session.clickAtImpl = () => { session.pageDiagnosticImpl = () => ({ url: session.url, title: '', interactiveElementCount: 9, visibleHeadings: [], blockerSignals: [] }); };
    const draft: PerformanceStep[] = [clickStep('open the panel', { visibleText: ['Some text that never appears'] }), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'open the panel', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(trace.divergences).toBe(0); // the click "worked" (page changed) — not a divergence
    const click = steps[0] as Extract<PerformanceStep, { kind: 'click' }>;
    expect(click.expectAfter).toEqual({}); // cleared — an unverifiable stale check would only trip the on-camera Director
  });

  it('a SEARCH flow [click box, type, Enter] does not spurious-diverge even though the click/type change no page signature (bug 2)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/search';
    // Neither the click (focus) nor the type changes the page signature. Pre-fix
    // this spurious-diverged on the first click ("page unchanged after a click");
    // now it should not (the click feeds an input → not a divergence).
    const draft: PerformanceStep[] = [clickStep('the search box'), typeStep('the search box', 'cats'), enterKey, dwell(500), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'search for cats', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(trace).toMatchObject({ divergences: 0, reconverges: 0, truncated: false, timedOut: false });
    expect(steps.map((s) => s.kind)).toEqual(['click', 'type', 'key', 'dwell', 'done']);
  });

  it('dead click → recovered via another resolve candidate, no reconverge (finding 6)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/start';
    // The recon-resolved target (clickStep's default bbox, center y≈5) navigates
    // nowhere — a dead click. The sweep's candidate list has a working alternative.
    session.resolveTargetCandidatesResult = [
      { selector: 'sel:wrong', description: 'the link', bbox: { x: 0, y: 0, width: 10, height: 10 } },
      { selector: 'sel:right', description: 'the link', bbox: { x: 0, y: 60, width: 10, height: 10 } },
    ];
    // Only a click at the RIGHT element (center y≈65) navigates.
    session.clickAtImpl = (_x, y) => { if (y === 65) session.url = 'https://x/target'; };
    const draft: PerformanceStep[] = [clickStep('the link', { urlContains: '/target' }), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(trace).toMatchObject({ divergences: 1, reconverges: 0, truncated: false, timedOut: false });
    const click = steps[0] as Extract<PerformanceStep, { kind: 'click' }>;
    expect(click.target.selector).toBe('sel:right');
    expect(click.expectAfter?.urlContains).toBe('/target');
    expect(steps[steps.length - 1].kind).toBe('done');
  });

  it('dead click + no usable candidates → falls back to reconverge (sweep is a no-op)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/start';
    session.resolveTargetCandidatesResult = []; // no alternatives for the sweep
    let reconvergeCalls = 0;
    const reconverge = async (): Promise<PerformanceStep[]> => {
      reconvergeCalls++;
      session.clickAtImpl = () => { session.url = 'https://x/real'; };
      return [clickStep('real'), done];
    };
    const draft: PerformanceStep[] = [clickStep('the link', { urlContains: '/target' }), done];
    const { trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(reconvergeCalls).toBe(1);
    expect(trace).toMatchObject({ divergences: 1, reconverges: 1 });
  });

  it('dead click (page unchanged after click) → divergence → reconverge → working list replaced', async () => {
    const session = new FakePageSession();
    session.url = 'https://test.example/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    // The click is executable but with no clickAtImpl/clickSelectorImpl wired it
    // changes nothing → "dead element" divergence. The sweep finds no alternative.
    const reconverged: PerformanceStep[] = [clickStep('the REAL link'), done];
    let reconvergeCalls = 0;
    const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
      reconvergeCalls++;
      expect(ctx.divergedStep.kind).toBe('click');
      const nav = () => { session.url = 'https://test.example/real'; session.observeResults = [{ selector: 'a#z', description: 'z' }] as any; };
      session.clickAtImpl = nav;
      session.clickSelectorImpl = nav;
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
    // Every click is dead (no click impl wired).
    const reconverge = async (_ctx: ReconvergeContext): Promise<PerformanceStep[]> => [clickStep('still dead'), done];
    const draft: PerformanceStep[] = [clickStep('a'), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 1, logger: log });
    expect(trace.truncated).toBe(true);
    expect(trace.reconverges).toBe(1);
    const tail = steps.slice(-3);
    expect(tail.map((s) => s.kind)).toEqual(['scroll', 'dwell', 'done']);
  });

  it('wall-clock budget exceeded → truncate (timedOut), keep un-walked tail un-verified', async () => {
    // Regression: 2026-05-15 eval-2 — pre-fix the wall-clock truncation
    // replaced the un-walked tail (which contained the user's requested click)
    // with a 2-step graceful filler. Director's expectAfter is the backstop;
    // losing the click to a 45 s deadline is strictly worse than attempting it
    // un-verified.
    const session = new FakePageSession();
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    const draft: PerformanceStep[] = [scroll(100), clickStep('the requested link'), dwell(500), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 0, reconvergeMax: 2, logger: log });
    expect(trace.timedOut).toBe(true);
    expect(trace.truncated).toBe(true);
    // The whole un-walked tail (here: every original step, since deadline
    // fires before walking step 0) is kept. Crucially the click survives.
    expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the requested link')).toBe(true);
    expect(steps[steps.length - 1].kind).toBe('done');
  });

  it('wall-clock truncation appends `done` only if the kept tail doesn\'t already end with one', async () => {
    const session = new FakePageSession();
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    // Draft without a trailing `done`: truncation should add exactly one.
    const draft: PerformanceStep[] = [scroll(100), clickStep('x')];
    const { steps } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 0, reconvergeMax: 2, logger: log });
    expect(steps.filter((s) => s.kind === 'done')).toHaveLength(1);
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

  it('dead click on the original target → divergence → reconverge → working list replaced; diverged step carries the original target description', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    session.resolveTargetCandidatesResult = []; // sweep has nothing
    let reconvergeCalls = 0;
    let divergedDesc: string | undefined;
    const reconverge = async (ctx: ReconvergeContext): Promise<PerformanceStep[]> => {
      reconvergeCalls++;
      divergedDesc = ctx.divergedStep.kind === 'click' ? ctx.divergedStep.target.description : undefined;
      // The reconverged plan's click navigates.
      session.clickAtImpl = () => { session.url = 'https://x/done'; };
      return [clickStep('the working link'), done];
    };
    const draft: PerformanceStep[] = [clickStep('the missing link'), done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'click the link', reconverge, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(reconvergeCalls).toBe(1);
    expect(divergedDesc).toBe('the missing link');
    expect(trace).toMatchObject({ divergences: 1, reconverges: 1, truncated: false, timedOut: false });
    expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the working link')).toBe(true);
    expect(steps.some((s) => s.kind === 'click' && s.target.description === 'the missing link')).toBe(false);
  });

  it('a click is coord-clicked at its (recon-resolved, page-absolute) bbox minus the current scrollY', async () => {
    const session = new FakePageSession();
    session.url = 'https://x/';
    session.observeResults = [{ selector: 'a#x', description: 'x' }] as any;
    // The recon resolved this element at scrollY 0, so its stored bbox is
    // page-absolute: y=1200. The walk runs the click after a scroll(1000), so
    // currentScrollY === 1000 → the coord click lands at viewport y = 1200-1000+5.
    const target: PerformanceStep = { kind: 'click', target: { selector: 'sel:t', bbox: { x: 50, y: 1200, width: 10, height: 10 }, description: 't' }, anticipationMs: 200, reasoning: 'click t' };
    const clicks: Array<{ x: number; y: number }> = [];
    // The click must produce a visible change or the walk flags it as a dead
    // element (a divergence) — make it "navigate".
    session.clickAtImpl = (x, y) => { clicks.push({ x, y }); session.url = 'https://x/landed'; };
    const draft: PerformanceStep[] = [scroll(1000), target, done];
    const { steps, trace } = await rehearse({ draftSteps: draft, session, intent: 'x', reconverge: NEVER_RECONVERGE, rehearsalBudgetMs: 30000, reconvergeMax: 2, logger: log });
    expect(trace.divergences).toBe(0);
    const click = steps.find((s) => s.kind === 'click') as Extract<PerformanceStep, { kind: 'click' }>;
    expect(click.target.bbox.y).toBe(1200); // unchanged — no re-resolve, no rewrite
    // clickResolvedTarget: cx = 50 + width/2(5) = 55; cy = 1200 - scrollY(1000) + height/2(5) = 205 → clickAt(55, 205).
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!).toEqual({ x: 55, y: 205 });
  });
});
