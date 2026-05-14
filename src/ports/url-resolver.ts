/**
 * IUrlResolver — picks the starting URL for a recording from a free-form prompt.
 *
 * Rationale: the API contract is "give me a prompt, get a recording" — no
 * separate `url` parameter. So the prompt is THE input, and somewhere upstream
 * we must turn it into a concrete URL the browser can `goto`. Examples:
 *
 *   "去 https://github.com 看本周热门"   → `https://github.com`            (URL inline)
 *   "打开维基百科看热门词条"               → `https://en.wikipedia.org/wiki/Main_Page`  (well-known site)
 *   "搜一下 mechanical keyboard"          → `https://www.google.com`        (intent → search engine)
 *   "做点什么"                            → throw — unanswerable.
 *
 * The resolver decides; it's an LLM judgement (no regex hardcoded). Pure
 * AI-first per goals.md #6.
 */

import type { DomainError } from '../domain/errors.js';

export interface UrlResolution {
  /** The URL the recording should `goto` first. Must be an absolute http(s) URL. */
  url: string;
  /** Short LLM-emitted explanation (1 line) — surfaced in logs and run.json for goal-#3 transparency. */
  reasoning: string;
}

/**
 * Best-effort contract: returns a UrlResolution OR throws a typed error
 * (UrlResolverError, see the LLM adapter). The caller surfaces a recon failure
 * if this throws — without a URL the recording can't start.
 */
export interface IUrlResolver {
  resolve(prompt: string): Promise<UrlResolution>;
  /** Stable identifier for the underlying model — surfaced in logs. */
  readonly modelId: string;
}

/** Re-export DomainError so adapter implementations don't need a direct import path. */
export type { DomainError };
