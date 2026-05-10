import { describe, expect, it } from 'vitest';

import { FakeFastDecider } from '../../../fakes/fake-fast-decider.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import { StreamingDirector } from '../../../../src/adapters/director/streaming-director.js';
import type { DirectorBriefing } from '../../../../src/domain/plan.js';

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

describe('StreamingDirector — expectAfter validation', () => {
  it('continues normally when expectAfter matches', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'go' },
            { kind: 'done', reasoning: 'fin' },
          ],
          expectAfter: { urlContains: 'test.example' }, // matches the fake's url
        },
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.expectAfterMismatchCount).toBe(0);
    expect(decider.decisions).toHaveLength(1);
  });

  it('clears the queue and re-decides on expectAfter mismatch', async () => {
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'go' },
            { kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'more' },
          ],
          expectAfter: { urlContains: 'NEVER_MATCHES_THIS_STRING' },
        },
      },
      {
        response: { actions: [{ kind: 'done', reasoning: 'recovered' }] },
      },
    ]);
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.expectAfterMismatchCount).toBeGreaterThanOrEqual(1);
    // Only ONE scroll executed — the second was discarded due to mismatch.
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(1);
    // The next decider call should have received lastActionFailure context.
    expect(decider.decisions.length).toBeGreaterThanOrEqual(2);
    const secondCallState = decider.decisions[1]!.state;
    expect(secondCallState.lastActionFailure).toContain('expectAfter');
  });
});

describe('StreamingDirector — error + budget paths', () => {
  it('returns error endReason when FastDecider rejects on first call', async () => {
    const decider = new FakeFastDecider();
    decider.decide = async () => { throw new Error('network down'); };
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });
    const report = await director.run(briefing(), session);

    expect(report.endReason).toBe('error');
  });

  it('exits with budget endReason when hard deadline hit', async () => {
    // FastDecider keeps returning slow scrolls, never `done`.
    const decider = new FakeFastDecider();
    decider.decide = async () => ({
      actions: [{ kind: 'scroll' as const, deltaPx: 600, speed: 'slow' as const, reasoning: 'forever' }],
    });
    const session = new FakePageSession();
    const director = new StreamingDirector({ decider });

    // Set a tiny duration so the hard cap (1.2x) is reached fast.
    const report = await director.run({ ...briefing(), durationMs: 200 }, session);
    expect(report.endReason).toBe('budget');
  });
});

describe('StreamingDirector — click verifier (§0027)', () => {
  it('flags click as failed when verifier returns matched=false, then re-decides with failure context', async () => {
    // Decision 1 from a draftSequence-like queue: click + type + key Enter
    // (typed-twice / wrong-target failure mode if the click missed).
    // Decision 2 (after click failure) must be a different click.
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [
            { kind: 'click', target: 'the search bar', reasoning: 'focus' },
            { kind: 'type', text: 'hello', reasoning: 'enter query' },
            { kind: 'key', key: 'Enter', reasoning: 'submit' },
          ],
        },
      },
      // Recovery decision after queue clear:
      { response: { actions: [{ kind: 'click', target: 'the actual search input', reasoning: 'try again' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'ok' }] } },
    ]);
    const session = new FakePageSession();
    // Verifier rejects the first click target only (the suspicious one).
    let verifierCalls = 0;
    const verifier = {
      modelId: 'fake/verifier',
      verify: async () => {
        verifierCalls += 1;
        if (verifierCalls === 1) {
          return { matched: false, reason: 'sidebar opened, search untouched', latencyMs: 10 };
        }
        return { matched: true, reason: 'looks focused', latencyMs: 10 };
      },
    };
    const director = new StreamingDirector({ decider, clickVerifier: verifier });

    await director.run(briefing(20_000), session);

    // The first click was made (Playwright-side); but type + key Enter
    // from the same queue must NOT have fired (queue cleared).
    const clicks = session.events.filter((e) => e.kind === 'clickByDescription');
    const types = session.events.filter((e) => e.kind === 'type');
    const keys = session.events.filter((e) => e.kind === 'key');
    expect(clicks.length).toBeGreaterThanOrEqual(2); // first click + recovery click
    expect(types).toHaveLength(0); // type never fired thanks to queue clear
    expect(keys).toHaveLength(0);

    // First click's evidence carries the AI verdict (false + reason).
    const failureEntries = session.appendedEntries.filter(
      (e) => e.type === 'decision_failure' && e.reason === 'click_failed',
    );
    expect(failureEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('passes click through cleanly when verifier returns matched=true', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: 'the right thing', reasoning: 'go' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'ok' }] } },
    ]);
    const session = new FakePageSession();
    const verifier = {
      modelId: 'fake/verifier',
      verify: async () => ({ matched: true, reason: 'looks correct', latencyMs: 10 }),
    };
    const director = new StreamingDirector({ decider, clickVerifier: verifier });

    const report = await director.run(briefing(), session);
    expect(report.endReason).toBe('done');

    // No click_failed entries when verifier approves.
    const failureEntries = session.appendedEntries.filter(
      (e) => e.type === 'decision_failure' && e.reason === 'click_failed',
    );
    expect(failureEntries).toHaveLength(0);
  });

  it('treats verifier errors as optimistic match (does not fail the click)', async () => {
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: 'somewhere', reasoning: 'go' }] } },
      { response: { actions: [{ kind: 'done', reasoning: 'ok' }] } },
    ]);
    const session = new FakePageSession();
    const verifier = {
      modelId: 'fake/verifier',
      verify: async () => {
        throw new Error('network down');
      },
    };
    const director = new StreamingDirector({ decider, clickVerifier: verifier });

    const report = await director.run(briefing(), session);

    // Verifier errored, but the click is treated as succeeded — the recording
    // continues to the second decision (`done`).
    expect(report.endReason).toBe('done');
    const failureEntries = session.appendedEntries.filter(
      (e) => e.type === 'decision_failure' && e.reason === 'click_failed',
    );
    expect(failureEntries).toHaveLength(0);
  });
});
