import { describe, expect, it } from 'vitest';

import { FakeFastDecider } from '../../../tests/fakes/fake-fast-decider.js';
import { FakePageSession } from '../../../tests/fakes/fake-page-session.js';
import { StreamingDirector } from './streaming-director.js';
import type { DirectorBriefing } from '../../domain/plan.js';

const briefing = (durationMs = 5_000): DirectorBriefing => ({
  prompt: 'do the thing',
  durationMs,
  hints: [],
  rationale: 'test',
});

describe('StreamingDirector — basic loop', () => {
  it('terminates on done action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.endReason).toBe('done');
    expect(decider.decisions).toHaveLength(1);
  });

  it('executes a scroll then done', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 600, speed: 'slow', reasoning: 'browse' }],
        },
      },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.payload).toMatchObject({ deltaY: 600 });
  });

  it('executes a dwell action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'dwell', durationMs: 300, reasoning: 'pause' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const waits = session.events.filter((e) => e.kind === 'wait');
    // At least one wait should be the explicit 300ms dwell action.
    // Additional waits may be implicit dwells inserted while waiting for LLM.
    expect(waits.some((w) => w.payload === 300)).toBe(true);
  });

  it('calls clickByDescription for a click action', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: '简中', reasoning: 'tap it' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    const clicks = session.events.filter((e) => e.kind === 'clickByDescription');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload).toMatchObject({ description: '简中' });
  });

  it('calls beginRecording exactly once', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    await director.run(briefing(), session);

    expect(session.events.filter((e) => e.kind === 'beginRecording')).toHaveLength(1);
  });
});

describe('StreamingDirector — streaming overlap', () => {
  it('fires next decider call DURING current animation', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 600, speed: 'slow', reasoning: 'first' }],
        },
        delayMs: 50,  // very fast LLM
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'finished' }] },
        delayMs: 50,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    await director.run(briefing(), session);

    // The scroll animation duration: 600 / 250 * 1000 = 2400ms (clamped to 2400)
    // First decision should arrive at t≈50ms (defaultDelayMs).
    // Scroll starts at t≈50, ends at t≈50+2400=2450.
    // Second decision call should fire DURING the scroll, i.e. at t<2450.
    expect(decider.decisions).toHaveLength(2);
    const secondDecisionT = decider.decisions[1]!.t;
    // The second call must have STARTED before the scroll animation ended.
    // Streaming director fires it right after the action begins, so t≈50ms.
    // (If sequential, t would be ≈2450ms.)
    expect(secondDecisionT).toBeLessThan(500); // generous bound
  });

  it('does not fire a second call if the first action is "done"', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'finished' }] } },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    await director.run(briefing(), session);
    expect(decider.decisions).toHaveLength(1); // not 2
  });
});

describe('StreamingDirector — implicit dwell on LLM lag', () => {
  it('inserts an implicit dwell when queue empty AND pending not yet resolved', async () => {
    // First call: SLOW, takes 600ms. Returns scroll.
    // Second call: queued; the test ends after the scroll.
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'tiny' }],
        },
        delayMs: 600,
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'fin' }] },
        delayMs: 50,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    // The first call takes 600ms. Action queue is empty initially.
    // Director should insert at least one implicit dwell (200ms each)
    // before the first call resolves.
    expect(report.implicitDwellCount).toBeGreaterThanOrEqual(1);
    // wait events on the fake session reflect both implicit and explicit dwells
    const waits = session.events.filter((e) => e.kind === 'wait');
    expect(waits.length).toBeGreaterThanOrEqual(1);
  });

  it('caps consecutive implicit dwells at 4 and continues', async () => {
    // Pending call never resolves until 1000ms.
    const decider = new FakeFastDecider([
      {
        response: { actions: [{ kind: 'done', reasoning: 'late' }] },
        delayMs: 1000,
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    // 1000ms / 200ms = 5 implicit dwells but cap is 4.
    expect(report.implicitDwellCount).toBeLessThanOrEqual(4);
  });
});
