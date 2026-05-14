import type { IUrlResolver, UrlResolution } from '../../src/ports/url-resolver.js';

/**
 * Programmable IUrlResolver for unit tests. Construct with a fixed
 * {url, reasoning}; resolve() always returns it. The fake records every prompt
 * it was called with so a test can assert the runner passed the request prompt
 * through verbatim.
 */
export class FakeUrlResolver implements IUrlResolver {
  modelId = 'fake/url-resolver';
  calls: string[] = [];
  constructor(private readonly resolution: UrlResolution = { url: 'https://test.example/', reasoning: 'fixed test URL' }) {}

  async resolve(prompt: string): Promise<UrlResolution> {
    this.calls.push(prompt);
    return this.resolution;
  }
}
