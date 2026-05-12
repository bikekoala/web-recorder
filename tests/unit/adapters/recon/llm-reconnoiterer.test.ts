import { describe, expect, it, vi } from 'vitest';
import { LlmReconnoiterer, ReconError } from '../../../../src/adapters/recon/llm-reconnoiterer.js';
import { FakePageSession } from '../../../fakes/fake-page-session.js';
import type { IBlockerDismisser, BlockerDismissalReport } from '../../../../src/ports/blocker-dismisser.js';
import type { IPageSession, ObservedElement } from '../../../../src/ports/page-session.js';

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

const target = (selector: string, description: string): ObservedElement => ({
  selector, description, bbox: { x: 10, y: 20, width: 80, height: 30 },
});

// A recon draft: click/type carry `ref` (+ `targetDescription` fallback) — ADR §0036.
const llmDraftJson = JSON.stringify({
  prompt: 'click sign in then browse',
  durationMs: 10000,
  steps: [
    { kind: 'dwell', durationMs: 350, reasoning: 'absorbing the page' },
    { kind: 'click', ref: 'e7', targetDescription: 'the sign-in link', anticipationMs: 600, reasoning: 'user asked', expectAfter: { urlContains: '/login' } },
    { kind: 'dwell', durationMs: 2000, reasoning: 'reading the login form' },
    { kind: 'done', reasoning: 'done' },
  ],
  totalEstimatedMs: 2950,
  rationale: 'sign-in is in view',
});

describe('LlmReconnoiterer', () => {
  it('takes an aria snapshot, parses the draft, resolves refs, returns a validated Performance', async () => {
    const session = new FakePageSession();
    session.url = 'https://x.test/';
    session.ariaSnapshotResult = '- link "Sign in" [ref=e7]';
    session.resolveAriaRefResults = { e7: target('text=Sign in', 'Sign in') };
    // The rehearsal walk actually clicks (coord-click first, selector fallback);
    // model the click navigating to /login so it doesn't diverge — wire both paths.
    const goLogin = () => { session.url = 'https://x.test/login'; };
    session.clickAtImpl = goLogin;
    session.clickSelectorImpl = goLogin;
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(llmDraftJson) });
    const perf = await recon.recon(
      { url: 'https://x.test/', prompt: 'click sign in then browse', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: Buffer.from([0x89]) },
      session,
    );
    expect(session.events.some((e) => e.kind === 'ariaSnapshot')).toBe(true);
    expect(session.events.filter((e) => e.kind === 'resolveAriaRef').map((e) => e.payload)).toContain('e7');
    expect(perf.steps).toHaveLength(4);
    const clickStep = perf.steps.find((s) => s.kind === 'click')!;
    // selector from resolveAriaRef; description is the LLM's targetDescription (not the resolved element's name)
    expect(clickStep).toMatchObject({ kind: 'click', target: { selector: 'text=Sign in', description: 'the sign-in link' } });
    expect(recon.modelId).toBe('test/model');
  });

  it('throws ReconError on malformed JSON', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient('not json') });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('throws ReconError when the draft fails the schema (empty steps)', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(JSON.stringify({ prompt: 'p', steps: [], totalEstimatedMs: 0, rationale: 'x' })) });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('throws ReconError when a click step has no ref', async () => {
    const session = new FakePageSession();
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(JSON.stringify({
      prompt: 'p', steps: [{ kind: 'click', targetDescription: 'x', anticipationMs: 500, reasoning: 'x' }, { kind: 'done', reasoning: 'd' }], totalEstimatedMs: 0, rationale: 'x',
    })) });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  it('a click whose ref AND description both miss is dropped; surviving steps still form the Performance', async () => {
    const session = new FakePageSession();
    session.ariaSnapshotResult = '- generic [ref=e1]';
    session.resolveAriaRefResults = {}; // e7 → null
    session.resolveTargetCandidatesResult = []; // description fallback also misses
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(llmDraftJson) });
    const perf = await recon.recon({ url: 'u', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    expect(perf.steps.some((s) => s.kind === 'click')).toBe(false);
    expect(perf.steps.some((s) => s.kind === 'type')).toBe(false);
    // [dwell, <dropped click>, dwell, done] → walk over [dwell, dwell, done]
    expect(perf.steps.map((s) => s.kind)).toContain('dwell');
    expect(perf.steps[perf.steps.length - 1]!.kind).toBe('done');
  });

  it('a click whose ref misses but whose targetDescription resolves → kept, target carries the LLM description', async () => {
    const session = new FakePageSession();
    session.resolveAriaRefResults = {}; // e7 → null (LLM picked a stale/wrong ref)
    session.resolveTargetCandidatesResult = [target('text=Sign in', 'Sign in')]; // fallback by description hits
    const goLogin = () => { session.url = 'https://x.test/login'; };
    session.clickAtImpl = goLogin; session.clickSelectorImpl = goLogin;
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(llmDraftJson) });
    const perf = await recon.recon({ url: 'https://x.test/', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    const click = perf.steps.find((s) => s.kind === 'click')!;
    expect(click).toMatchObject({ kind: 'click', target: { selector: 'text=Sign in', description: 'the sign-in link' } });
  });

  it('throws ReconError when every step is a click whose ref + description both miss (zero usable steps)', async () => {
    const session = new FakePageSession();
    session.resolveAriaRefResults = {};
    session.resolveTargetCandidatesResult = [];
    const recon = new LlmReconnoiterer({ model: 'm', client: fakeClient(JSON.stringify({
      prompt: 'p', steps: [{ kind: 'click', ref: 'eX', targetDescription: 'nonexistent thing', anticipationMs: 500, reasoning: 'x' }], totalEstimatedMs: 0, rationale: 'x',
    })) });
    await expect(recon.recon({ url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1280, height: 720 }, screenshot: null }, session))
      .rejects.toBeInstanceOf(ReconError);
  });

  const goDraftJson = JSON.stringify({
    prompt: 'go somewhere',
    durationMs: 10000,
    steps: [
      { kind: 'click', ref: 'eGo', targetDescription: 'the Go link', anticipationMs: 500, reasoning: 'navigate' },
      { kind: 'done', reasoning: 'done' },
    ],
    totalEstimatedMs: 900,
    rationale: 'one click',
  });

  it('runs the rehearsal walk by default and resets the page afterwards', async () => {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.ariaSnapshotResult = '- link "Go" [ref=eGo]';
    session.resolveAriaRefResults = { eGo: { selector: 'a#go', description: 'Go', bbox: { x: 0, y: 0, width: 10, height: 10 } } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext;
    session.clickSelectorImpl = goNext;
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goDraftJson) });
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

  const dwellOnlyDraft = JSON.stringify({
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
    const { client, create } = sequencedClient('Sure, here is the plan: ' + dwellOnlyDraft + ' Let me know if you need changes.');
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
      dwellOnlyDraft,
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
    const session = new FakePageSession();
    session.ariaSnapshotResult = '- link "Go" [ref=eGo]';
    session.resolveAriaRefResults = { eGo: { selector: 'a#go', description: 'Go', bbox: { x: 0, y: 0, width: 10, height: 10 } } };
    const fresh = new FreshReconnoiterer({ model: 'm', client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: goDraftJson } }] }) } } } as unknown as ConstructorParameters<typeof FreshReconnoiterer>[0]['client'] });
    const perf = await fresh.recon({ url: 'https://site.test/', prompt: 'p', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null }, session);
    expect(perf.rehearsal).toBeUndefined();
    expect(perf.steps.some((s) => s.kind === 'click')).toBe(true); // the click step survives, unwalked
    expect(session.events.some((e) => e.kind === 'click' || e.kind === 'clickAt')).toBe(false);
    expect(session.events.some((e) => e.kind === 'goto')).toBe(false);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('LlmReconnoiterer + blockerDismisser', () => {
  const goDraftJson = JSON.stringify({
    prompt: 'go somewhere',
    durationMs: 10000,
    steps: [
      { kind: 'click', ref: 'eGo', targetDescription: 'the Go link', anticipationMs: 500, reasoning: 'navigate' },
      { kind: 'done', reasoning: 'done' },
    ],
    totalEstimatedMs: 900,
    rationale: 'one click',
  });
  // Spy IBlockerDismisser — counts dismiss() calls; returns a fixed report.
  class SpyDismisser implements IBlockerDismisser {
    calls = 0;
    report: BlockerDismissalReport = { rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false };
    async dismiss(_session: IPageSession): Promise<BlockerDismissalReport> { this.calls++; return this.report; }
  }
  function wireSession() {
    const session = new FakePageSession();
    session.url = 'https://site.test/';
    session.ariaSnapshotResult = '- link "Go" [ref=eGo]';
    session.resolveAriaRefResults = { eGo: { selector: 'a#go', description: 'Go', bbox: { x: 0, y: 0, width: 10, height: 10 } } };
    const goNext = () => { session.url = 'https://site.test/next'; };
    session.clickAtImpl = goNext;
    session.clickSelectorImpl = goNext;
    return session;
  }
  const reconInput = { url: 'https://site.test/', prompt: 'go somewhere', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null };

  it('calls dismiss() and surfaces the report on Performance.blockerDismissal', async () => {
    const session = wireSession();
    const dismisser = new SpyDismisser();
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goDraftJson), blockerDismisser: dismisser });
    const perf = await recon.recon(reconInput, session);
    expect(dismisser.calls).toBeGreaterThanOrEqual(1); // recon-start call (+ one more from the walk reset)
    expect(perf.blockerDismissal).toEqual({ rounds: 1, dismissed: ['Accept all cookies'], stillBlocked: false });
  });

  it('without a dismisser, Performance.blockerDismissal is undefined', async () => {
    const session = wireSession();
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goDraftJson) });
    const perf = await recon.recon(reconInput, session);
    expect(perf.blockerDismissal).toBeUndefined();
  });

  it('a dismiss() that throws does not fail recon — report is stillBlocked', async () => {
    const session = wireSession();
    const throwing: IBlockerDismisser = { dismiss: async () => { throw new Error('boom'); } };
    const recon = new LlmReconnoiterer({ model: 'test/model', client: fakeClient(goDraftJson), blockerDismisser: throwing });
    const perf = await recon.recon(reconInput, session);
    expect(perf.blockerDismissal).toEqual({ rounds: 0, dismissed: [], stillBlocked: true });
  });
});
