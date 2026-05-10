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
    visibleHints: ['the 简体中文 link'],
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

  it('throws when response fails schema validation', async () => {
    const json = JSON.stringify({
      actions: [{ kind: 'scroll', deltaPx: 10, speed: 'slow', reasoning: 'too small' }],
    });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
  });

  it('throws when actions array is empty', async () => {
    const json = JSON.stringify({ actions: [] });
    const decider = new LlmFastDecider({ client: buildClient(json) });
    await expect(decider.decide(buildState())).rejects.toThrow(/schema/i);
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
