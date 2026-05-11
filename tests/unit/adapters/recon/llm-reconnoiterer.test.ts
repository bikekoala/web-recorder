import { describe, expect, it, vi } from 'vitest';
import { LlmReconnoiterer, ReconError } from '../../../../src/adapters/recon/llm-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';

// Minimal fake OpenAI-shaped client.
function fakeClient(content: string) {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  } as unknown as ConstructorParameters<typeof LlmReconnoiterer>[0]['client'];
}

/**
 * Fake client whose `create` returns `contents[n]` on the n-th call (clamps to
 * the last entry once exhausted), and records every call's args for assertions.
 */
function sequencedClient(...contents: string[]) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const create = vi.fn(async (args: { messages: Array<{ role: string; content: unknown }> }) => {
    const idx = Math.min(calls.length, contents.length - 1);
    calls.push(args);
    return { choices: [{ message: { content: contents[idx] } }] };
  });
  const client = { chat: { completions: { create } } } as unknown as ConstructorParameters<typeof LlmReconnoiterer>[0]['client'];
  return { client, create, calls };
}

const llmPerformanceJson = JSON.stringify({
  prompt: 'click sign in then browse',
  durationMs: 10000,
  steps: [
    { kind: 'dwell', durationMs: 350, reasoning: 'absorbing the page' },
    { kind: 'click', target: { description: 'the sign-in link' }, anticipationMs: 600, reasoning: 'user asked', expectAfter: { urlContains: '/login' } },
    { kind: 'dwell', durationMs: 2000, reasoning: 'reading the login form' },
    { kind: 'done', reasoning: 'done' },
  ],
  totalEstimatedMs: 2950,
  rationale: 'sign-in is in view',
});

describe('LlmReconnoiterer', () => {
  it('parses the LLM output, resolves targets, returns a validated Performance', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/';
    session.resolveTargetResult = { selector: 'text=Sign in', description: 'the sign-in link', bbox: { x: 10, y: 20, width: 80, height: 30 } };
    // The rehearsal walk actually clicks (coord-click first, selector fallback);
    // model the click navigating to /login so it doesn't diverge — wire both paths.
    const goLogin = () => { session.url = 'https://x.test/login'; };
    session.clickAtImpl = goLogin;
    session.clickSelectorImpl = goLogin;
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(llmPerformanceJson) });
    const perf = await recon.recon(
      { url: 'https://x.test/', prompt: 'click sign in then browse', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: Buffer.from([0x89]) },
      session,
    );
    expect(perf.steps).toHaveLength(4);
    const clickStep = perf.steps.find((s) => s.kind === 'click')!;
    expect(clickStep).toMatchObject({ kind: 'click', target: { selector: 'text=Sign in', description: 'the sign-in link' } });
    expect(recon.modelId).toBe('test/model');
  });

  it('throws ReconError on malformed JSON', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient('not json') });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('throws ReconError when the LLM output fails the schema', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(JSON.stringify({ prompt: 'p', durationMs: 1, steps: [], totalEstimatedMs: 0, rationale: 'x' })) });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('unresolvable click → kept with a sentinel → walk re-resolves → still null → divergence → truncate; no click in the final Performance', async () => {
    const session = new FakePageSession();
    session.resolveTargetResult = null; // never resolves — eagerly OR in the walk
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(llmPerformanceJson) });
    const perf = await recon.recon({ url: 'u', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    // recon keeps the click (sentinel) instead of dropping it eagerly, the
    // rehearsal walk re-resolves at the live page, that also fails → divergence
    // → reconverge (still unresolvable) → truncate + graceful tail. End result:
    // no click step survives, but the Performance still has its graceful tail.
    expect(perf.steps.some((s) => s.kind === 'click')).toBe(false);
    expect(perf.steps.some((s) => s.kind === 'type')).toBe(false);
    expect(perf.steps[perf.steps.length - 1].kind).toBe('done');
    expect(perf.rehearsal?.truncated).toBe(true);
  });

  const goPlanJson = JSON.stringify({
    prompt: 'go somewhere',
    durationMs: 10000,
    steps: [
      { kind: 'click', target: { description: 'go' }, anticipationMs: 500, reasoning: 'navigate' },
      { kind: 'done', reasoning: 'done' },
    ],
    totalEstimatedMs: 900,
    rationale: 'one click',
  });

  it('runs the rehearsal walk by default and resets the page afterwards', async () => {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext;
    session.clickSelectorImpl = goNext;
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goPlanJson) });
    const perf = await recon.recon(
      { url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(perf.rehearsal).toBeDefined();
    expect(perf.rehearsal!.walkedSteps).toBeGreaterThan(0);
    // reset: a goto back to the start URL + a stability wait, AFTER the walk's click
    const gotos = session.events.filter((e) => e.kind === 'goto');
    expect(gotos[gotos.length - 1]!.payload).toBe('https://site.test/');
    expect(session.events.some((e) => e.kind === 'stable')).toBe(true);
    // sanity: the walk did click during rehearsal (coord-click → 'clickAt')
    expect(session.events.some((e) => e.kind === 'click' || e.kind === 'clickAt')).toBe(true);
  });

  const dwellOnlyPlan = JSON.stringify({
    prompt: 'just look around',
    durationMs: 5000,
    steps: [
      { kind: 'dwell', durationMs: 400, reasoning: 'absorbing the page' },
      { kind: 'dwell', durationMs: 2000, reasoning: 'reading' },
      { kind: 'done', reasoning: 'done' },
    ],
    totalEstimatedMs: 2400,
    rationale: 'nothing to click',
  });

  it('recovers JSON wrapped in prose (no retry)', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/';
    const { client, create } = sequencedClient('Sure, here is the plan: ' + dwellOnlyPlan + ' Let me know if you need changes.');
    const recon = new LlmReconnoiterer({ model: 'test/model', client });
    const perf = await recon.recon(
      { url: 'https://x.test/', prompt: 'just look around', durationMs: 5000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(perf.steps.map((s) => s.kind)).toEqual(['dwell', 'dwell', 'done']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries once on a non-JSON response, then succeeds', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/';
    const { client, create, calls } = sequencedClient(
      "I can't see the target you mentioned, let me explain what I'd do instead...",
      dwellOnlyPlan,
    );
    const recon = new LlmReconnoiterer({ model: 'test/model', client });
    const perf = await recon.recon(
      { url: 'https://x.test/', prompt: 'just look around', durationMs: 5000, viewport: { width: 1280, height: 720 }, screenshot: null },
      session,
    );
    expect(perf.steps.map((s) => s.kind)).toEqual(['dwell', 'dwell', 'done']);
    expect(create).toHaveBeenCalledTimes(2);
    const secondCallMessages = calls[1]!.messages;
    expect(secondCallMessages.some((m) => typeof m.content === 'string' && m.content.includes('REMINDER'))).toBe(true);
  });

  it('throws ReconError if both attempts are non-JSON', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/';
    const { client, create } = sequencedClient(
      'I cannot help with that, here is why...',
      'Still no JSON, sorry.',
    );
    const recon = new LlmReconnoiterer({ model: 'test/model', client });
    await expect(
      recon.recon({ url: 'https://x.test/', prompt: 'p', durationMs: 5000, viewport: { width: 1280, height: 720 }, screenshot: null }, session),
    ).rejects.toBeInstanceOf(ReconError);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reconRehearse=false skips the walk — no rehearsal field, no extra clicks/goto', async () => {
    vi.resetModules();
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('RECON_REHEARSE', 'false');
    const { LlmReconnoiterer: FreshReconnoiterer } = await import('../../../../src/adapters/recon/llm-reconnoiterer.js');
    const donePlanJson = JSON.stringify({
      prompt: 'p',
      durationMs: 10000,
      steps: [
        { kind: 'click', target: { description: 'go' }, anticipationMs: 500, reasoning: 'navigate' },
        { kind: 'done', reasoning: 'done' },
      ],
      totalEstimatedMs: 900,
      rationale: 'one click',
    });
    const session = new FakePageSession();
    session.resolveTargetResult = { selector: 'a#go', description: 'go', bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const fresh = new FreshReconnoiterer({ model: 'm', client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: donePlanJson } }] }) } } } as unknown as ConstructorParameters<typeof FreshReconnoiterer>[0]['client'] });
    const perf = await fresh.recon({ url: 'https://site.test/', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    expect(perf.rehearsal).toBeUndefined();
    expect(session.events.some((e) => e.kind === 'click')).toBe(false);
    expect(session.events.some((e) => e.kind === 'goto')).toBe(false);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
