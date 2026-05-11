import { describe, expect, it } from 'vitest';
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
    session.resolveTargetResult = { selector: 'text=Sign in', description: 'the sign-in link', bbox: { x: 10, y: 20, width: 80, height: 30 } };
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
});
