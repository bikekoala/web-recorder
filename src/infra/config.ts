import 'dotenv/config';
import { z } from 'zod';

/**
 * Single source of truth for runtime configuration.
 *
 * - All tunables live here, not as magic numbers in adapters.
 * - Validated at module load. If config is invalid, the process exits before
 *   any I/O happens.
 * - Treat the exported `config` object as immutable.
 *
 * LLM provider: OpenRouter only. See `docs/decisions.md` §0009.
 */

const Schema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  outputDir: z.string().min(1).default('output'),

  // OpenRouter (OpenAI-API-compatible aggregator). The OpenRouter model id
  // (e.g. `anthropic/claude-sonnet-4.5`) goes in `LLM_MODEL`.
  openrouterApiKey: z.string().min(1),
  openrouterBaseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  llmModel: z.string().min(1).default('anthropic/claude-sonnet-4.5'),

  /**
   * FastDecider model — used by the Director's per-action decision calls.
   * Optimized for low latency + cost. Default: `google/gemini-2.5-flash-lite`.
   * Override with LLM_DECIDER_MODEL.
   */
  llmDeciderModel: z.string().min(1).default('google/gemini-2.5-flash-lite'),

  /**
   * Maximum actions per FastDecider response (lookahead depth).
   * Higher = more buffer against LLM tail latency, but more chance of
   * stale lookahead. Default 2.
   */
  directorLookaheadMax: z.number().int().min(1).max(5).default(2),

  /**
   * Implicit dwell duration when LLM is slower than animation, ms.
   * Per-iteration; the Director will keep dwelling in 200ms chunks until
   * the FastDecider response arrives.
   */
  directorDwellFallbackMs: z.number().int().min(50).max(800).default(200),

  /**
   * Recording window hard cap as multiple of `durationMs`. The Director
   * forcibly injects `done` if the recording exceeds this.
   */
  directorHardBudgetMult: z.number().min(1.0).max(2.0).default(1.2),

  // Browser / recording defaults. These are baseline values; specific jobs
  // may override per-session in the future (e.g. mobile viewports).
  viewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
  }).default({}),

  /**
   * Which Chromium build Playwright should launch. Leave undefined to use
   * Playwright's bundled Chromium (most reproducible, requires
   * `npx playwright install chromium`). Set to 'chrome' to use the system
   * Google Chrome — useful in dev when the bundled download is unavailable.
   */
  browserChannel: z
    .enum(['chromium', 'chrome', 'chrome-beta', 'msedge', 'msedge-beta', 'msedge-dev'])
    .optional(),
});

const raw = {
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
  outputDir: process.env.OUTPUT_DIR,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  llmModel: process.env.LLM_MODEL,
  llmDeciderModel: process.env.LLM_DECIDER_MODEL,
  directorLookaheadMax: process.env.DIRECTOR_LOOKAHEAD_MAX
    ? Number(process.env.DIRECTOR_LOOKAHEAD_MAX)
    : undefined,
  directorDwellFallbackMs: process.env.DIRECTOR_DWELL_FALLBACK_MS
    ? Number(process.env.DIRECTOR_DWELL_FALLBACK_MS)
    : undefined,
  directorHardBudgetMult: process.env.DIRECTOR_HARD_BUDGET_MULT
    ? Number(process.env.DIRECTOR_HARD_BUDGET_MULT)
    : undefined,
  viewport: {
    width: process.env.VIEWPORT_WIDTH ? Number(process.env.VIEWPORT_WIDTH) : undefined,
    height: process.env.VIEWPORT_HEIGHT ? Number(process.env.VIEWPORT_HEIGHT) : undefined,
  },
  browserChannel: process.env.BROWSER_CHANNEL,
};

const parsed = Schema.safeParse(raw);

if (!parsed.success) {
  // Use console here because logger depends on this module — avoid the cycle.
  // eslint-disable-next-line no-console
  console.error('Invalid configuration:', parsed.error.format());
  process.exit(1);
}

const data = parsed.data;

export const config = {
  ...data,
  isDev: data.nodeEnv === 'development',
  isProd: data.nodeEnv === 'production',
} as const;

export type Config = typeof config;
