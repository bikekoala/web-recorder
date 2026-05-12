import { describe, expect, it, vi } from 'vitest';
import { LlmBlockerDismisser } from '../../../../src/adapters/blocker/llm-blocker-dismisser.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { PageDiagnostic } from '../../../../src/ports/page-session.js';

const diag = (blockerSignals: string[]): PageDiagnostic => ({
  url: 'https://x.test/',
  title: '',
  interactiveElementCount: 10,
  visibleHeadings: [],
  blockerSignals,
});

// Fake OpenAI-shaped client returning contents[n] on the n-th call (clamps to the last).
function sequencedClient(...contents: string[]) {
  const create = vi.fn(async () => {
    const idx = Math.min(create.mock.calls.length - 1, contents.length - 1);
    return { choices: [{ message: { content: contents[Math.max(0, idx)] } }] };
  });
  return {
    client: { chat: { completions: { create } } } as unknown as ConstructorParameters<typeof LlmBlockerDismisser>[0]['client'],
    create,
  };
}
function throwingClient() {
  const create = vi.fn(async () => {
    throw new Error('LLM down');
  });
  return {
    client: { chat: { completions: { create } } } as unknown as ConstructorParameters<typeof LlmBlockerDismisser>[0]['client'],
    create,
  };
}

describe('LlmBlockerDismisser', () => {
  it('clean page (no blockerSignals) → 0 rounds, 0 LLM calls', async () => {
    const session = new FakePageSession(); // empty pageDiagnosticResults ⇒ default diag, blockerSignals: []
    const { client, create } = sequencedClient('{"blocker":false}');
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 0, dismissed: [], stillBlocked: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('one consent banner → detect → click → re-probe clean → rounds 1', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog']), diag([])]; // initial probe sees it; re-probe clean
    session.resolveTargetResult = { selector: '#accept', description: 'Accept all cookies', bbox: { x: 100, y: 600, width: 120, height: 40 } };
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all cookies' }));
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });
  });

  it('banner then modal → 2 rounds, two dismissed', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog']), diag(['auth_modal']), diag([])];
    session.resolveTargetResult = { selector: '#x', description: 'a dismiss control', bbox: { x: 10, y: 10, width: 20, height: 20 } };
    const { client } = sequencedClient(
      JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all cookies' }),
      JSON.stringify({ blocker: true, dismissTargetDescription: 'Close the modal' }),
    );
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r.rounds).toBe(2);
    expect(r.dismissed).toEqual(['Accept all cookies', 'Close the modal']);
    expect(r.stillBlocked).toBe(false);
  });

  it('round cap: every re-probe still flags a blocker → rounds capped, stillBlocked', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticImpl = () => diag(['consent_dialog']); // always non-empty
    session.resolveTargetResult = { selector: '#x', description: 'dismiss', bbox: { x: 10, y: 10, width: 20, height: 20 } };
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'dismiss' }));
    const d = new LlmBlockerDismisser({ client, model: 'm', maxRounds: 2, maxMs: 60_000 });
    const r = await d.dismiss(session);
    expect(r.rounds).toBe(2);
    expect(r.stillBlocked).toBe(true);
  });

  it('LLM says blocker:false → 1 round (one detect), nothing clicked', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    const { client } = sequencedClient('{"blocker":false}');
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: [], stillBlocked: false });
  });

  it('resolveTarget returns null → 1 round, stillBlocked, no click', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    session.resolveTargetResult = null;
    const { client } = sequencedClient(JSON.stringify({ blocker: true, dismissTargetDescription: 'Accept all' }));
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r).toEqual({ rounds: 1, dismissed: [], stillBlocked: true });
  });

  it('LLM throws → caught, stillBlocked, never throws', async () => {
    const session = new FakePageSession();
    session.pageDiagnosticResults = [diag(['consent_dialog'])];
    const { client } = throwingClient();
    const d = new LlmBlockerDismisser({ client, model: 'm' });
    const r = await d.dismiss(session);
    expect(r.stillBlocked).toBe(true);
    expect(r.dismissed).toEqual([]);
  });
});
