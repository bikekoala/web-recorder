import { describe, expect, it } from 'vitest';

import { ElementNotFoundError } from '../../../src/domain/errors.js';
import type { PageDiagnostic } from '../../../src/domain/action-log.js';
import { FakeFastDecider } from '../../fakes/fake-fast-decider.js';
import { FakePageSession } from '../../fakes/fake-page-session.js';
import { BlockerPrelude } from '../../../src/core/blocker-prelude.js';

const USER_PROMPT = 'click play and watch the video';

const cleanDiag: PageDiagnostic = {
  url: 'https://test.example/',
  title: 'Test',
  interactiveElementCount: 20,
  visibleHeadings: ['Welcome'],
  blockerSignals: [],
};

const blockerDiag = (signals: string[]): PageDiagnostic => ({
  url: 'https://test.example/',
  title: 'Test',
  interactiveElementCount: 20,
  visibleHeadings: ['Welcome'],
  blockerSignals: signals,
});

describe('BlockerPrelude — clean page', () => {
  it('returns immediately with iterations: 0 when no blockers', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [cleanDiag];
    const decider = new FakeFastDecider();
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.iterations).toBe(0);
    expect(report.endReason).toBe('clean');
    expect(report.resolvedSignals).toEqual([]);
    expect(report.remainingSignals).toEqual([]);
    expect(decider.decisions).toHaveLength(0);
  });

  it('does not log decision entries when there is nothing to dismiss', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [cleanDiag];
    const decider = new FakeFastDecider();
    const prelude = new BlockerPrelude({ decider });

    await prelude.run(session, USER_PROMPT);

    const decisions = session.appendedEntries.filter((e) => e.type === 'decision');
    expect(decisions).toHaveLength(0);
  });
});

describe('BlockerPrelude — single blocker dismissal', () => {
  it('dismisses one blocker and returns clean', async () => {
    const session = new FakePageSession();
    // First probe: blocker present. Second probe (after click): clean.
    session.pageDiagnosticResults = [
      blockerDiag(['play_overlay']),
      cleanDiag,
    ];
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'click', target: 'play button', reasoning: 'dismiss play overlay' }],
        },
      },
    ]);
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.iterations).toBe(1);
    expect(report.endReason).toBe('clean');
    expect(report.resolvedSignals).toEqual(['play_overlay']);
    expect(report.remainingSignals).toEqual([]);
    expect(decider.decisions).toHaveLength(1);

    const clicks = session.events.filter((e) => e.kind === 'clickByDescription');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload).toMatchObject({ description: 'play button' });
  });

  it('writes a decision and a page_diagnostic entry per iteration', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [
      blockerDiag(['consent_dialog']),
      cleanDiag,
    ];
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'click', target: 'Accept all', reasoning: 'dismiss consent' }],
        },
      },
    ]);
    const prelude = new BlockerPrelude({ decider });

    await prelude.run(session, USER_PROMPT);

    const decisions = session.appendedEntries.filter((e) => e.type === 'decision');
    const diagnostics = session.appendedEntries.filter((e) => e.type === 'page_diagnostic');
    expect(decisions).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);

    // Negative decisionId distinguishes prelude entries from Director numbering.
    expect(decisions[0]).toMatchObject({ type: 'decision' });
    if (decisions[0]?.type === 'decision') {
      expect(decisions[0].decisionId).toBeLessThan(0);
    }
  });

  it('uses the user prompt in the decider call (so the LLM knows the goal)', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [
      blockerDiag(['auth_modal']),
      cleanDiag,
    ];
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'click', target: 'close modal', reasoning: 'dismiss modal' }],
        },
      },
    ]);
    const prelude = new BlockerPrelude({ decider });

    await prelude.run(session, 'do something specific to this user');

    expect(decider.decisions).toHaveLength(1);
    expect(decider.decisions[0]!.state.prompt).toContain('do something specific to this user');
    expect(decider.decisions[0]!.state.prompt).toContain('BLOCKER PRELUDE');
  });
});

describe('BlockerPrelude — bounds', () => {
  it('stops at maxIterations cap when blockers keep regenerating', async () => {
    const session = new FakePageSession();
    // Every probe shows a blocker — never resolves.
    session.pageDiagnosticImpl = () => blockerDiag(['play_overlay']);
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: 'play 1', reasoning: '1' }] } },
      { response: { actions: [{ kind: 'click', target: 'play 2', reasoning: '2' }] } },
      { response: { actions: [{ kind: 'click', target: 'play 3', reasoning: '3' }] } },
      { response: { actions: [{ kind: 'click', target: 'play 4', reasoning: 'should not happen' }] } },
    ]);
    const prelude = new BlockerPrelude({ decider, maxIterations: 3 });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.iterations).toBe(3);
    expect(report.endReason).toBe('iter_cap');
    expect(report.remainingSignals).toEqual(['play_overlay']);
    expect(decider.decisions).toHaveLength(3);
  });

  it('stops at maxMs cap when iterations would exceed wall clock', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => blockerDiag(['play_overlay']);
    const decider = new FakeFastDecider();
    decider.defaultDelayMs = 100;
    decider.decide = async () => {
      // Each call takes 100ms. Combined with click+wait the prelude
      // should hit the time cap before the iteration cap.
      await new Promise((r) => setTimeout(r, 100));
      return {
        actions: [{ kind: 'click' as const, target: 'play', reasoning: 'go' }],
      };
    };
    const prelude = new BlockerPrelude({ decider, maxIterations: 100, maxMs: 500 });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.endReason).toBe('time_cap');
    expect(report.totalMs).toBeGreaterThanOrEqual(500);
    expect(report.iterations).toBeGreaterThan(0);
  });
});

describe('BlockerPrelude — decider returns non-click', () => {
  it('bails out when decider returns done', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => blockerDiag(['play_overlay']);
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'done', reasoning: 'cannot dismiss' }] } },
    ]);
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.endReason).toBe('decider_done');
    expect(report.iterations).toBe(1);
    expect(report.remainingSignals).toEqual(['play_overlay']);
    // No click was attempted.
    const clicks = session.events.filter((e) => e.kind === 'clickByDescription');
    expect(clicks).toHaveLength(0);
  });

  it('bails out when decider returns scroll (non-click)', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => blockerDiag(['play_overlay']);
    const decider = new FakeFastDecider([
      {
        response: {
          actions: [{ kind: 'scroll', deltaPx: 200, speed: 'normal', reasoning: 'scroll past' }],
        },
      },
    ]);
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.endReason).toBe('decider_done');
    const scrolls = session.events.filter((e) => e.kind === 'scroll');
    expect(scrolls).toHaveLength(0);
  });
});

describe('BlockerPrelude — click failure', () => {
  it('logs decision_failure click_failed and bails out when click throws', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => blockerDiag(['play_overlay']);
    session.clickByDescriptionImpl = () => {
      throw new ElementNotFoundError('play button');
    };
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: 'play button', reasoning: 'dismiss' }] } },
    ]);
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.endReason).toBe('click_failed');
    const failures = session.appendedEntries.filter((e) => e.type === 'decision_failure');
    expect(failures).toHaveLength(1);
    if (failures[0]?.type === 'decision_failure') {
      expect(failures[0].reason).toBe('click_failed');
    }
  });
});

describe('BlockerPrelude — never breaks recording', () => {
  it('returns iterations: 0 with endReason on unexpected error', async () => {
    const session = new FakePageSession();
    // Simulate pageDiagnostic throwing — the prelude must catch and
    // produce a clean report rather than letting the error escape.
    session.pageDiagnosticImpl = () => {
      throw new Error('boom');
    };
    const decider = new FakeFastDecider();
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    // Whatever the endReason, it must be one of the allowed values and
    // iterations must be 0. The recording continues regardless.
    expect(['clean', 'iter_cap', 'time_cap', 'decider_done', 'click_failed'])
      .toContain(report.endReason);
    expect(report.iterations).toBe(0);
  });
});

describe('BlockerPrelude — multiple iterations', () => {
  it('resolves blockers across multiple iterations', async () => {
    const session = new FakePageSession();
    // First two probes: blocker. Third probe: clean.
    session.pageDiagnosticResults = [
      blockerDiag(['consent_dialog', 'auth_modal']),
      blockerDiag(['auth_modal']),
      cleanDiag,
    ];
    const decider = new FakeFastDecider([
      { response: { actions: [{ kind: 'click', target: 'Accept', reasoning: 'consent' }] } },
      { response: { actions: [{ kind: 'click', target: 'Close', reasoning: 'modal' }] } },
    ]);
    const prelude = new BlockerPrelude({ decider });

    const report = await prelude.run(session, USER_PROMPT);

    expect(report.endReason).toBe('clean');
    expect(report.iterations).toBe(2);
    // Both initial blockers resolved.
    expect(report.resolvedSignals.sort()).toEqual(['auth_modal', 'consent_dialog']);
    expect(report.remainingSignals).toEqual([]);
  });
});
