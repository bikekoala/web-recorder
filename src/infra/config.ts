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
   * Fallback model for `llmReconModelResolved`. The recon model is resolved
   * as: `llmReconModel` (LLM_RECON_MODEL) if set, else this
   * (LLM_PLANNER_MODEL), else `llmModel` (LLM_MODEL). In other words, set
   * this to a strong vision+planning model (e.g. `google/gemini-3.1-pro-preview`
   * or `anthropic/claude-sonnet-4.6`) to use it for reconnaissance when
   * `LLM_RECON_MODEL` isn't set. Optional. (Vestigial name — it fed the
   * old streaming planner's brief() call; that's gone, only the recon
   * fallback role remains.)
   */
  llmPlannerModel: z.string().min(1).optional(),

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
   * Mid-recording re-plan (a full recon call, ~30–50 s) is only worth doing
   * when at least this much recording budget remains. Below it,
   * PerformanceDirector degrades gracefully (drops the stale tail, appends a
   * short filler scroll, ends) rather than freezing the frame for the
   * duration of a recon call. Default 60 s ⇒ effectively no mid-recording
   * re-plan for recordings shorter than ~1 min. Override with
   * REPLAN_MIN_REMAINING_MS.
   */
  replanMinRemainingMs: z.number().int().min(0).default(60000),

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

  /**
   * LOCAL DEV ONLY — has no effect when `headless: true`. Top-left pixel
   * coords for the Chromium window, as `{ x, y }`. On macOS with an
   * extended display the secondary monitor occupies a coordinate region
   * offset from the primary (e.g. `{ x: 1920, y: 0 }` if it's to the
   * right of a 1920-wide primary; `x` may be negative if it's to the
   * left). Set `BROWSER_WINDOW_POSITION="x,y"` once to keep headless:false
   * runs off your primary display. When set, the adapter also pins
   * `--window-size` to the viewport so the position is meaningful.
   */
  browserWindowPosition: z
    .string()
    .regex(/^-?\d+,-?\d+$/, 'BROWSER_WINDOW_POSITION must be "x,y" e.g. "1920,40"')
    .transform((s) => {
      const [x, y] = s.split(',').map(Number) as [number, number];
      return { x, y };
    })
    .optional(),

  /**
   * LOCAL DEV ONLY — macOS + `headless: false` only. Name of a macOS
   * application (your terminal) to re-activate after Chromium launches,
   * so keyboard focus returns to you. There is no reliable Chromium flag
   * for "launch without stealing focus"; an `osascript ... activate` is
   * the pragmatic mitigation. Set `BROWSER_RETURN_FOCUS_TO="iTerm2"`
   * (or `"Terminal"` / `"Ghostty"` / ...). If unset, we derive it from
   * `TERM_PROGRAM` when we can map it cleanly (see below).
   */
  browserReturnFocusToApp: z.string().min(1).optional(),
});

/**
 * Best-effort mapping from the `TERM_PROGRAM` env var (set by most macOS
 * terminals) to the application name AppleScript's `activate` expects.
 * Only return a value for terminals we can map confidently; otherwise the
 * user must set `BROWSER_RETURN_FOCUS_TO` explicitly.
 */
function appNameFromTermProgram(termProgram: string | undefined): string | undefined {
  switch (termProgram) {
    case 'iTerm.app':
      return 'iTerm2';
    case 'Apple_Terminal':
      return 'Terminal';
    case 'ghostty':
    case 'Ghostty':
      return 'Ghostty';
    default:
      return undefined;
  }
}

const raw = {
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
  outputDir: process.env.OUTPUT_DIR,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  llmModel: process.env.LLM_MODEL,
  llmPlannerModel: process.env.LLM_PLANNER_MODEL,
  llmReconModel: process.env.LLM_RECON_MODEL,
  maxReplans: process.env.MAX_REPLANS ? Number(process.env.MAX_REPLANS) : undefined,
  replanMinRemainingMs: process.env.REPLAN_MIN_REMAINING_MS
    ? Number(process.env.REPLAN_MIN_REMAINING_MS)
    : undefined,
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
  browserWindowPosition: process.env.BROWSER_WINDOW_POSITION,
  // Explicit env var wins; otherwise try to derive from TERM_PROGRAM.
  browserReturnFocusToApp:
    process.env.BROWSER_RETURN_FOCUS_TO ?? appNameFromTermProgram(process.env.TERM_PROGRAM),
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
