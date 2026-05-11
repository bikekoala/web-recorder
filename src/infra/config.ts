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
  // (e.g. `google/gemini-3.1-pro-preview`) goes in `LLM_MODEL`.
  openrouterApiKey: z.string().min(1),
  openrouterBaseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  /**
   * Agent model — used by the underlying Stagehand SDK for its INTERNAL
   * observe/act calls (it has its own prompts that expect specific output
   * shapes). Must be a model whose JSON-mode output matches Stagehand's
   * parsers — empirically `openai/gpt-4o-mini` is the most reliable here.
   *
   * Despite the name, this is NOT the planner's model. See `llmPlannerModel`.
   * (Historical note: these were one variable; we split when Anthropic
   * planners broke Stagehand's internal expectations — see §0023.)
   */
  llmModel: z.string().min(1).default('openai/gpt-4o-mini'),

  /**
   * Planner model — used once per job for the brief() vision call. Needs
   * strong visual reasoning to extract click hints from a screenshot.
   * Defaults to `LLM_MODEL` for backwards compatibility, but you SHOULD
   * set `LLM_PLANNER_MODEL` explicitly for production. Suggested: a
   * stronger vision model like `google/gemini-3.1-pro-preview` or
   * `anthropic/claude-sonnet-4.6`.
   */
  llmPlannerModel: z.string().min(1).optional(),

  /**
   * FastDecider model — used by the Director's per-action decision calls.
   * Optimized for low latency + cost.
   *
   * Default `openai/gpt-4o-mini` — empirically faster (~0.6-1.0s p95) than
   * `google/gemini-3.1-flash-lite` on OpenRouter today (preview, ~1.5s p95).
   * Revisit when 3.1 Flash Lite goes GA (non-preview).
   *
   * Override with LLM_DECIDER_MODEL.
   */
  llmDeciderModel: z.string().min(1).default('openai/gpt-4o-mini'),

  /**
   * Reconnaissance model — used once per recording (and again per re-plan)
   * to build the Performance. Needs strong vision + planning. Defaults to
   * the resolved planner model. Override with LLM_RECON_MODEL.
   */
  llmReconModel: z.string().min(1).optional(),

  /**
   * Per-recording cap on re-plan checkpoints. After this many, the
   * PerformanceDirector stops re-planning and plays out remaining steps
   * as-is (reality checks become advisory). Test/eval infra, not a
   * behaviour threshold (goals.md #6 carve-out). Override with MAX_REPLANS.
   */
  maxReplans: z.number().int().min(0).max(10).default(3),

  /**
   * Recording-judge model — used ONCE per finished recording to grade
   * naturalness against the 5-dimension rubric (§0030). Needs native
   * VIDEO input support (not just images), so the default is Gemini
   * 3.1 Pro Preview. Override with LLM_JUDGE_MODEL — e.g. switch to
   * `google/gemini-3.1-flash-lite` for cheap routine grading.
   *
   * Latency is not constrained (one offline call per recording); we
   * pick for judgment quality.
   */
  llmJudgeModel: z.string().min(1).default('google/gemini-3.1-pro-preview'),

  /**
   * Recording window hard cap as multiple of `durationMs`. The
   * PerformanceDirector forcibly stops playback if the recording exceeds
   * this.
   */
  directorHardBudgetMult: z.number().min(1.0).max(2.0).default(1.2),

  /**
   * Typing rendering (catalog F2 + the gmaps "text appears instantly" finding).
   * - `typingPreMs`: pause AFTER focusing the input, BEFORE first keystroke.
   *   Real users glance at the empty field for a beat before starting.
   * - `typingKeystrokeMs`: inter-keystroke delay range. Each `session.type`
   *   call picks one value in this range and passes it to Playwright's
   *   `keyboard.type({ delay })`. Higher than the historic 40-90 ms
   *   because the judge flagged short queries as "instant" at that pace.
   * Both are pure rendering parameters per goals.md #6 carve-out.
   */
  typingPreMinMs: z.number().int().min(0).max(2000).default(200),
  typingPreMaxMs: z.number().int().min(0).max(2000).default(400),
  typingKeystrokeMinMs: z.number().int().min(0).max(500).default(60),
  typingKeystrokeMaxMs: z.number().int().min(0).max(500).default(140),

  /**
   * Inter-scroll micro-pause (catalog A6). After every scroll completes,
   * insert a brief pause before the NEXT action begins — emulates "I
   * scrolled, let me look at what's there". Applied at the Director
   * level (only between two consecutive scrolls or after the final scroll
   * before a decision settles), not inside session.scroll, because
   * discovery clicks already build their own anticipation pause and we
   * don't want to double-tail.
   */
  scrollTailMinMs: z.number().int().min(0).max(2000).default(120),
  scrollTailMaxMs: z.number().int().min(0).max(2000).default(280),

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

  /**
   * Optional path to a Playwright `storageState.json` file. When set, the
   * browser launches with the cookies + localStorage + sessionStorage from
   * that file pre-loaded — letting recordings start from a "logged-in"
   * state without us managing credentials.
   *
   * Generate one offline with: `npx playwright codegen --save-storage=auth.json <site>`
   *
   * Per `docs/goals.md` non-goals, we never collect or handle the user's
   * credentials directly; this is the user's escape hatch for sites that
   * require authentication.
   */
  storageStatePath: z.string().min(1).optional(),
});

const raw = {
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
  outputDir: process.env.OUTPUT_DIR,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  llmModel: process.env.LLM_MODEL,
  llmPlannerModel: process.env.LLM_PLANNER_MODEL,
  llmDeciderModel: process.env.LLM_DECIDER_MODEL,
  llmReconModel: process.env.LLM_RECON_MODEL,
  maxReplans: process.env.MAX_REPLANS ? Number(process.env.MAX_REPLANS) : undefined,
  llmJudgeModel: process.env.LLM_JUDGE_MODEL,
  directorHardBudgetMult: process.env.DIRECTOR_HARD_BUDGET_MULT
    ? Number(process.env.DIRECTOR_HARD_BUDGET_MULT)
    : undefined,
  typingPreMinMs: process.env.TYPING_PRE_MIN_MS
    ? Number(process.env.TYPING_PRE_MIN_MS)
    : undefined,
  typingPreMaxMs: process.env.TYPING_PRE_MAX_MS
    ? Number(process.env.TYPING_PRE_MAX_MS)
    : undefined,
  typingKeystrokeMinMs: process.env.TYPING_KEYSTROKE_MIN_MS
    ? Number(process.env.TYPING_KEYSTROKE_MIN_MS)
    : undefined,
  typingKeystrokeMaxMs: process.env.TYPING_KEYSTROKE_MAX_MS
    ? Number(process.env.TYPING_KEYSTROKE_MAX_MS)
    : undefined,
  scrollTailMinMs: process.env.SCROLL_TAIL_MIN_MS
    ? Number(process.env.SCROLL_TAIL_MIN_MS)
    : undefined,
  scrollTailMaxMs: process.env.SCROLL_TAIL_MAX_MS
    ? Number(process.env.SCROLL_TAIL_MAX_MS)
    : undefined,
  viewport: {
    width: process.env.VIEWPORT_WIDTH ? Number(process.env.VIEWPORT_WIDTH) : undefined,
    height: process.env.VIEWPORT_HEIGHT ? Number(process.env.VIEWPORT_HEIGHT) : undefined,
  },
  browserChannel: process.env.BROWSER_CHANNEL,
  storageStatePath: process.env.STORAGE_STATE_PATH,
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
  // Resolved planner model: explicit `LLM_PLANNER_MODEL` if set, else fall
  // back to `LLM_MODEL` for backwards compat. Adapters should read
  // `config.llmPlannerModelResolved`, never `data.llmPlannerModel` directly.
  llmPlannerModelResolved: data.llmPlannerModel ?? data.llmModel,
  llmReconModelResolved: data.llmReconModel ?? data.llmPlannerModel ?? data.llmModel,
  isDev: data.nodeEnv === 'development',
  isProd: data.nodeEnv === 'production',
} as const;

export type Config = typeof config;
