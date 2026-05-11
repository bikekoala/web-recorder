import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LlmVisionJudge, RecordingJudgeError } from '../../../../src/adapters/judge/llm-vision-judge.js';

/**
 * Unit tests for LlmVisionJudge. The OpenRouter fetch is mocked via the
 * `fetcher` constructor option; we never make a real network call here.
 *
 * The actual model behaviour is exercised by the standalone `npm run judge`
 * script (manual) and by the regression suite optionally invoking the
 * judge on each video.
 */

let videoDir: string;
let videoPath: string;

beforeAll(async () => {
  videoDir = await mkdtemp(join(tmpdir(), 'judge-test-'));
  videoPath = join(videoDir, 'fake.webm');
  // Minimal valid-ish bytes so readFile succeeds. The mocked fetch never
  // looks at content, so a tiny stub is fine.
  await writeFile(videoPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML header magic
});

afterAll(async () => {
  await rm(videoDir, { recursive: true, force: true });
});

function buildResponse(body: unknown, ok = true): Response {
  const init: ResponseInit = ok ? { status: 200 } : { status: 500, statusText: 'Server Error' };
  return new Response(JSON.stringify(body), init);
}

function happyPathResponse() {
  return buildResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            verdict: 'probably_human',
            dimensions: {
              motionQuality: { level: 'pass', evidence: [] },
              pacing: {
                level: 'partial',
                evidence: [{ atSecond: 4.2, observation: 'anticipation looked uniform' }],
              },
              intentExecution: { level: 'pass', evidence: [] },
              recovery: { level: 'pass', evidence: [] },
              visualCoherence: { level: 'pass', evidence: [] },
            },
            summary: 'Generally natural with one minor pacing tell at 4.2s.',
          }),
        },
      },
    ],
  });
}

describe('LlmVisionJudge', () => {
  it('parses a happy-path response and returns a typed report', async () => {
    let requestSeen: { url: string; body: unknown } | null = null;
    const fetcher: typeof fetch = async (url, init) => {
      requestSeen = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) };
      return happyPathResponse();
    };

    const judge = new LlmVisionJudge({
      model: 'google/gemini-3.1-pro-preview',
      baseUrl: 'https://test-openrouter.local/api/v1',
      apiKey: 'test-key',
      fetcher,
    });
    const report = await judge.judge({
      videoPath,
      userPrompt: 'do the thing',
      durationMs: 10_000,
    });

    expect(report.modelId).toBe('google/gemini-3.1-pro-preview');
    expect(report.judgment.verdict).toBe('probably_human');
    expect(report.judgment.dimensions.pacing.level).toBe('partial');
    expect(report.judgment.dimensions.pacing.evidence[0]!.atSecond).toBe(4.2);
    expect(report.videoPath).toBe(videoPath);
    expect(report.userPrompt).toBe('do the thing');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify request shape: video_url part with base64 data URL.
    expect(requestSeen).not.toBeNull();
    expect(requestSeen!.url).toBe('https://test-openrouter.local/api/v1/chat/completions');
    const body = requestSeen!.body as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe('google/gemini-3.1-pro-preview');
    expect(body.messages[0]!.role).toBe('system');
    const userContent = body.messages[1]!.content as Array<{ type: string; video_url?: { url: string } }>;
    const videoPart = userContent.find((c) => c.type === 'video_url');
    expect(videoPart).toBeTruthy();
    expect(videoPart!.video_url!.url).toMatch(/^data:video\/webm;base64,/);
  });

  it('throws RecordingJudgeError on HTTP non-2xx', async () => {
    const judge = new LlmVisionJudge({
      apiKey: 'k',
      fetcher: async () => buildResponse({ error: 'no video support' }, false),
    });
    await expect(
      judge.judge({ videoPath, userPrompt: 'p', durationMs: 1000 }),
    ).rejects.toBeInstanceOf(RecordingJudgeError);
  });

  it('throws when the LLM returns invalid JSON content', async () => {
    const judge = new LlmVisionJudge({
      apiKey: 'k',
      fetcher: async () =>
        buildResponse({
          choices: [{ message: { content: 'not json at all' } }],
        }),
    });
    await expect(
      judge.judge({ videoPath, userPrompt: 'p', durationMs: 1000 }),
    ).rejects.toBeInstanceOf(RecordingJudgeError);
  });

  it('throws when the LLM JSON does not match the schema (missing dimension)', async () => {
    const judge = new LlmVisionJudge({
      apiKey: 'k',
      fetcher: async () =>
        buildResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'looks_human',
                  // recovery missing — schema requires all 5
                  dimensions: {
                    motionQuality: { level: 'pass', evidence: [] },
                    pacing: { level: 'pass', evidence: [] },
                    intentExecution: { level: 'pass', evidence: [] },
                    visualCoherence: { level: 'pass', evidence: [] },
                  },
                  summary: 'looks great',
                }),
              },
            },
          ],
        }),
    });
    await expect(
      judge.judge({ videoPath, userPrompt: 'p', durationMs: 1000 }),
    ).rejects.toBeInstanceOf(RecordingJudgeError);
  });

  it('rejects invalid verdict values via schema', async () => {
    const judge = new LlmVisionJudge({
      apiKey: 'k',
      fetcher: async () =>
        buildResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: 'totally_human', // not in enum
                  dimensions: {
                    motionQuality: { level: 'pass', evidence: [] },
                    pacing: { level: 'pass', evidence: [] },
                    intentExecution: { level: 'pass', evidence: [] },
                    recovery: { level: 'pass', evidence: [] },
                    visualCoherence: { level: 'pass', evidence: [] },
                  },
                  summary: 'fine',
                }),
              },
            },
          ],
        }),
    });
    await expect(
      judge.judge({ videoPath, userPrompt: 'p', durationMs: 1000 }),
    ).rejects.toBeInstanceOf(RecordingJudgeError);
  });

  it('strips ```json code fences before parsing', async () => {
    const judge = new LlmVisionJudge({
      apiKey: 'k',
      fetcher: async () =>
        buildResponse({
          choices: [
            {
              message: {
                content:
                  '```json\n' +
                  JSON.stringify({
                    verdict: 'looks_human',
                    dimensions: {
                      motionQuality: { level: 'pass', evidence: [] },
                      pacing: { level: 'pass', evidence: [] },
                      intentExecution: { level: 'pass', evidence: [] },
                      recovery: { level: 'pass', evidence: [] },
                      visualCoherence: { level: 'pass', evidence: [] },
                    },
                    summary: 'fine',
                  }) +
                  '\n```',
              },
            },
          ],
        }),
    });
    const report = await judge.judge({ videoPath, userPrompt: 'p', durationMs: 1000 });
    expect(report.judgment.verdict).toBe('looks_human');
  });
});
