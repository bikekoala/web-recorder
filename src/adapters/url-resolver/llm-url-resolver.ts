/**
 * LlmUrlResolver — IUrlResolver backed by a small chat LLM via OpenRouter.
 *
 * Job: take a free-form user prompt (which may or may not contain a literal
 * URL — "去 https://github.com 看本周热门" vs "打开维基百科看热门词条" vs
 * "搜一下 mechanical keyboard") and produce the absolute http(s) URL the
 * recording should `goto` first. AI-first per goals.md #6 — no regex
 * extraction, no hardcoded site map; the LLM decides.
 *
 * The default model is `config.llmUrlResolverModel` (Haiku 4.5 — cheap, fast,
 * ~200 tokens in / ~80 out per call, costing roughly $0.0003 per request).
 * The recon pipeline is the budget hog; the resolver is incidental.
 *
 * Output is one JSON object {url, reasoning}, Zod-parsed before return
 * (Hard Rule 2). All failure modes — network, empty content, JSON parse,
 * schema validation, non-absolute URL — surface as UrlResolverError so
 * core/api don't have to inspect vendor error shapes (Hard Rule 3).
 */

import OpenAI from 'openai';
import { z } from 'zod';

import { DomainError } from '../../domain/errors.js';
import { config } from '../../infra/config.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { IUrlResolver, UrlResolution } from '../../ports/url-resolver.js';

export class UrlResolverError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('URL_RESOLVE_FAILED', message, cause);
  }
}

const ResolutionSchema = z.object({
  url: z.string().url().refine((v) => /^https?:\/\//i.test(v), {
    message: 'URL must be absolute http(s)',
  }),
  reasoning: z.string().min(1).max(400),
});

const SYSTEM_PROMPT = `You turn a user's free-form recording instruction into the starting URL of the recording.

The user's prompt may be in any language. It may contain a literal URL (e.g. "去 https://github.com 看看"), name a well-known site by its common name (e.g. "打开维基百科", "open YouTube", "go to Hacker News"), or only describe an intent (e.g. "搜一下 mechanical keyboard"). Your job is to return ONE absolute http(s) URL the browser can navigate to as the starting page.

Decision policy:
1. If the prompt contains a literal http(s) URL, return that URL verbatim — strip trailing punctuation only if it's clearly not part of the URL.
2. If the prompt names a well-known site, return its canonical entry URL (Wikipedia → https://en.wikipedia.org/wiki/Main_Page or the language-appropriate Main_Page, YouTube → https://www.youtube.com, Hacker News → https://news.ycombinator.com, GitHub → https://github.com, etc.). Pick the language edition that matches the prompt's language when relevant.
3. If the prompt only describes a search intent ("搜一下 X", "search for X", "look up X"), return https://www.google.com — the user will type the query on the page.
4. If no reasonable URL can be inferred at all (the prompt is "做点什么" / "do something"), still pick the most plausible starting page rather than refusing; explain your guess in reasoning.

Output a SINGLE JSON object with two fields and nothing else — no prose, no markdown fences:
{
  "url": "<absolute http(s) URL>",
  "reasoning": "<one short sentence, English or the prompt's language — why this URL>"
}`;

interface LlmUrlResolverOpts {
  model?: string;
  client?: OpenAI;
}

export class LlmUrlResolver implements IUrlResolver {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger = rootLogger.child({ component: 'LlmUrlResolver' });

  constructor(opts: LlmUrlResolverOpts = {}) {
    this.model = opts.model ?? config.llmUrlResolverModel;
    this.client = opts.client ?? new OpenAI({ baseURL: config.openrouterBaseUrl, apiKey: config.openrouterApiKey });
  }

  get modelId(): string { return this.model; }

  async resolve(prompt: string): Promise<UrlResolution> {
    if (!prompt || prompt.trim().length === 0) {
      throw new UrlResolverError('prompt is empty');
    }

    let raw: string;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 300,
      });
      raw = completion.choices[0]?.message?.content ?? '';
      promptTokens = completion.usage?.prompt_tokens ?? 0;
      completionTokens = completion.usage?.completion_tokens ?? 0;
    } catch (err) {
      throw new UrlResolverError('url resolver LLM call failed', err);
    }

    if (!raw) throw new UrlResolverError('url resolver returned empty content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      // Recover JSON wrapped in prose (some providers ignore response_format).
      const extracted = extractFirstJsonObject(raw);
      if (!extracted) throw new UrlResolverError(`url resolver JSON parse failed: ${raw.slice(0, 200)}`);
      try {
        parsed = JSON.parse(extracted);
      } catch {
        throw new UrlResolverError(`url resolver JSON parse failed: ${raw.slice(0, 200)}`);
      }
    }

    const validation = ResolutionSchema.safeParse(parsed);
    if (!validation.success) {
      throw new UrlResolverError(`url resolver output failed schema: ${validation.error.message.slice(0, 200)}`);
    }

    this.logger.info(
      { url: validation.data.url, reasoning: validation.data.reasoning, model: this.model, promptTokens, completionTokens },
      'resolved prompt to starting URL',
    );
    return validation.data;
  }
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return t;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
