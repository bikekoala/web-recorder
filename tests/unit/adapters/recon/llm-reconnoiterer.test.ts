import { describe, expect, it, vi } from 'vitest';
import { LlmReconnoiterer, ReconError } from '../../../../src/adapters/recon/llm-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';

// Minimal fake OpenAI-shaped client.
function fakeClient(content: string) {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  } as unknown as ConstructorParameters<typeof LlmReconnoiterer>[0]['client'];
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
    // The rehearsal walk actually clicks; model the click navigating to /login so it doesn't diverge.
    session.clickSelectorImpl = () => { session.url = 'https://x.test/login'; };
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

  it('drops a click step whose target will not resolve, keeping the rest', async () => {
    const session = new FakePageSession();
    session.resolveTargetResult = null; // nothing resolves
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(llmPerformanceJson) });
    const perf = await recon.recon({ url: 'u', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    // The click is dropped; dwell + dwell + done remain.
    expect(perf.steps.some((s) => s.kind === 'click')).toBe(false);
    expect(perf.steps.length).toBeGreaterThanOrEqual(2);
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
    session.clickSelectorImpl = () => { session.url = 'https://site.test/next'; };
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
    // sanity: the walk did click during rehearsal
    expect(session.events.some((e) => e.kind === 'click')).toBe(true);
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
