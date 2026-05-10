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
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload).toBe(300);
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
