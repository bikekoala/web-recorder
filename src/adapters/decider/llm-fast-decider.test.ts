import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';

import { LlmFastDecider } from './llm-fast-decider.js';
import type { DirectorState } from '../../domain/director-state.js';

function buildState(overrides: Partial<DirectorState> = {}): DirectorState {
  return {
    prompt: 'click 简中',
    remainingMs: 8_000,
    currentScrollY: 0,
    viewport: { width: 1280, height: 720 },
    screenshot: Buffer.alloc(10), // tiny dummy
    briefingHints: [
      { description: 'the simplified Chinese link', position: 'in_view', scrollToReveal: 0 },
    ],
    recentActions: [],
    ...overrides,
  };
}

function buildClient(content: string): OpenAI {
  const client = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
  return client;
}

describe('LlmFastDecider', () => {
  it('parses a valid response with a click action', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'click', target: 'the 简体中文 link', reasoning: 'user asked' }],
      expectAfter: { urlContains: 'zh' },
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const result = await decider.decide(buildState());
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.kind).toBe('click');
    expect(result.expectAfter?.urlContains).toBe('zh');
  });

  it('strips markdown code fences if present', async () => {
    const wrapped = '```json\n' + JSON.stringify({
      actions: [{ kind: 'dwell', durationMs: 600, reasoning: 'pause' }],
    }) + '\n```';
    const decider = new LlmFastDecider({ client: buildClient(wrapped) });
    const result = await decider.decide(buildState());
    expect(result.actions[0]!.kind).toBe('dwell');
  });

  it('throws when LLM returns invalid JSON', async () => {
    const decider = new LlmFastDecider({ client: buildClient('not json') });
    await expect(decider.decide(buildState())).rejects.toThrow(/invalid json/i);
  });

  it('throws when response fails schema validation (missing required field)', async () => {
    const json = JSON.stringify({
      // scroll missing both deltaPx and speed — not coercible
      actions: [{ kind: 'scroll', reasoning: 'malformed' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('throws when actions array is empty', async () => {
    const json = JSON.stringify({ actions: [] });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('clamps oversize dwell durationMs (LLM asks for 5s, we cap to 3s)', async () => {
    // The exact failure mode that took down the YouTube run: LLM expressed
    // "watch a video for a while" as dwell durationMs=5000.
    const json = JSON.stringify({
      actions: [{ kind: 'dwell', durationMs: 5000, reasoning: 'watch video' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const r = await decider.decide(buildState());
    expect(r.actions[0]).toMatchObject({ kind: 'dwell', durationMs: 3000 });
  });

  it('clamps undersize dwell durationMs to lower bound', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'dwell', durationMs: 50, reasoning: 'tiny' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const r = await decider.decide(buildState());
    expect(r.actions[0]).toMatchObject({ kind: 'dwell', durationMs: 200 });
  });

  it('clamps oversize scroll deltaPx (positive direction)', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'scroll', deltaPx: 5000, speed: 'fast', reasoning: 'big jump' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const r = await decider.decide(buildState());
    expect(r.actions[0]).toMatchObject({ kind: 'scroll', deltaPx: 1500 });
  });

  it('clamps undersize scroll deltaPx and preserves sign (negative)', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'scroll', deltaPx: -10, speed: 'slow', reasoning: 'small up' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const r = await decider.decide(buildState());
    expect(r.actions[0]).toMatchObject({ kind: 'scroll', deltaPx: -100 });
  });

  it('still rejects deltaPx=0 (direction unknowable)', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'scroll', deltaPx: 0, speed: 'slow', reasoning: 'no scroll' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('does not error when one of two actions is coercible — both get returned', async () => {
    // The actual YouTube failure shape: actions[0] click is fine,
    // actions[1] dwell is oversize. Whole response should succeed after coercion.
    const json = JSON.stringify({
      actions: [
        { kind: 'click', target: 'first video', reasoning: 'pick a video' },
        { kind: 'dwell', durationMs: 8000, reasoning: 'let it play' },
      ],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    const r = await decider.decide(buildState());
    expect(r.actions).toHaveLength(2);
    expect(r.actions[0]!.kind).toBe('click');
    expect(r.actions[1]).toMatchObject({ kind: 'dwell', durationMs: 3000 });
  });

  it('passes lastActionFailure into the prompt', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'done', reasoning: 'recovering' }],
    });
    const client = buildClient(json);
    const decider = new LlmFastDecider({ client, model: 'fake' });
    await decider.decide(buildState({ lastActionFailure: 'expectAfter mismatch' }));
    const callArg = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const userMsg = callArg.messages.find((m: { role: string }) => m.role === 'user');
    const textContent = userMsg.content.find((c: { type: string }) => c.type === 'text').text;
    expect(textContent).toContain('expectAfter mismatch');
  });
});
