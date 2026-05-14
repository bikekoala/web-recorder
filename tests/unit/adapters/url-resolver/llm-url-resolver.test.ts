import { describe, expect, it, vi } from 'vitest';

import { LlmUrlResolver, UrlResolverError } from '../../../../src/adapters/url-resolver/llm-url-resolver.js';

// Minimal OpenAI-shaped client.
function fakeClient(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }) } },
  } as unknown as ConstructorParameters<typeof LlmUrlResolver>[0]['client'];
}

function throwingClient(err: unknown) {
  return {
    chat: { completions: { create: vi.fn(async () => { throw err; }) } },
  } as unknown as ConstructorParameters<typeof LlmUrlResolver>[0]['client'];
}

describe('LlmUrlResolver', () => {
  it('parses {url, reasoning} from a valid LLM response', async () => {
    const r = new LlmUrlResolver({
      model: 'test/url-model',
      client: fakeClient(JSON.stringify({ url: 'https://github.com', reasoning: 'prompt named GitHub' })),
    });
    const out = await r.resolve('打开 GitHub 首页看看');
    expect(out).toEqual({ url: 'https://github.com', reasoning: 'prompt named GitHub' });
    expect(r.modelId).toBe('test/url-model');
  });

  it('recovers a JSON object wrapped in prose (provider ignored response_format)', async () => {
    const noisy = 'Sure! Here is the result: ```json\n{"url":"https://en.wikipedia.org/wiki/Main_Page","reasoning":"prompt named Wikipedia"}\n```';
    const r = new LlmUrlResolver({ model: 'm', client: fakeClient(noisy) });
    const out = await r.resolve('打开维基百科看热门词条');
    expect(out.url).toBe('https://en.wikipedia.org/wiki/Main_Page');
  });

  it('throws UrlResolverError on an empty prompt', async () => {
    const r = new LlmUrlResolver({ model: 'm', client: fakeClient('{}') });
    await expect(r.resolve('   ')).rejects.toBeInstanceOf(UrlResolverError);
  });

  it('throws UrlResolverError when the LLM call fails', async () => {
    const r = new LlmUrlResolver({ model: 'm', client: throwingClient(new Error('network down')) });
    await expect(r.resolve('p')).rejects.toBeInstanceOf(UrlResolverError);
  });

  it('throws UrlResolverError on empty content', async () => {
    const r = new LlmUrlResolver({ model: 'm', client: fakeClient('') });
    await expect(r.resolve('p')).rejects.toBeInstanceOf(UrlResolverError);
  });

  it('throws UrlResolverError on unparseable JSON', async () => {
    const r = new LlmUrlResolver({ model: 'm', client: fakeClient('not even close to JSON') });
    await expect(r.resolve('p')).rejects.toBeInstanceOf(UrlResolverError);
  });

  it('throws UrlResolverError when the URL is not absolute http(s)', async () => {
    const r = new LlmUrlResolver({
      model: 'm',
      client: fakeClient(JSON.stringify({ url: 'file:///etc/passwd', reasoning: 'bad' })),
    });
    await expect(r.resolve('p')).rejects.toBeInstanceOf(UrlResolverError);
  });

  it('throws UrlResolverError when reasoning is missing', async () => {
    const r = new LlmUrlResolver({
      model: 'm',
      client: fakeClient(JSON.stringify({ url: 'https://example.com' })),
    });
    await expect(r.resolve('p')).rejects.toBeInstanceOf(UrlResolverError);
  });
});
