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
   * Despite the name, this is NOT the recon model. See `llmReconModel`.
   * (Historical note: these were one variable; we split when Anthropic
   * planners broke Stagehand's internal expectations — see §0023.)
   */
  llmModel: z.string().min(1).default('openai/gpt-4o-mini'),

  /**
   * Reconnaissance model — used once per recording (and again per re-plan)
   * to build the Performance. Needs strong vision + planning.
   *
   * **Default `anthropic/claude-haiku-4.5`** (2026-05-15 bake-off).
   * Validated: Recordly 10s click+scroll → `looks_human all-5`, $0.024;
   * Photosynthesis 25s read → `looks_human all-5`, $0.027. Equal-or-better
   * quality vs Sonnet 4.6, ~3× cheaper. Latency is comparable (both ~20–40 s
   * on 20 k input tokens — prefill-dominated, output is short).
   * The pre-2026-05-15 sweep R8 said Haiku regressed on long reads; the
   * subsequent prompt fixes (`1065a61` variance + closing-dwell discipline,
   * `bf178c7` lingering-dwell for ≥20 s reads) closed that gap.
   * Override with `LLM_RECON_MODEL=<model>` (e.g. switch back to Sonnet 4.6
   * for a tricky page where Haiku flaps); the explicit override beats the
   * planner-model fallback chain below.
   */
  llmReconModel: z.string().min(1).default('anthropic/claude-haiku-4.5'),

  /**
   * URL resolver model — turns a free-form prompt into the starting URL
   * the recording should goto first. Tiny LLM task (~200 tokens in, ~80
   * out), cheap-model territory. Defaults to Haiku 4.5 ($1/$5 per million
   * vs Sonnet's $3/$15). Override with LLM_URL_RESOLVER_MODEL.
   */
  llmUrlResolverModel: z.string().min(1).default('anthropic/claude-haiku-4.5'),

  /**
   * Per-recording cap on re-plan checkpoints. After this many, the
   * PerformanceDirector stops re-planning and plays out remaining steps
   * as-is (reality checks become advisory). Test/eval infra, not a
   * behaviour threshold (goals.md #6 carve-out). Override with MAX_REPLANS.
   */
  maxReplans: z.number().int().min(0).max(10).default(3),

  /**
   * Upper bound on a single recording's `durationMs`. Enforced by the HTTP API's
   * request schema; protects against accidental long-running jobs that would
   * tie up the single-concurrent-job server. 5 minutes is generous for v1 use
   * cases (demos, walkthroughs); raise with MAX_RECORDING_DURATION_MS if you
   * have a legit reason and the operator can afford the wall-clock + cost.
   */
  maxRecordingDurationMs: z.coerce.number().int().min(1000).default(300_000),

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
   * Rehearsing reconnoiterer (Task #21): the recon walks its draft against the
   * live page off-camera before recording, verifying targets and rewriting
   * expectAfter to observed state. `reconRehearse` is the master switch (off ⇒
   * recon falls back to plan-and-resolve, no walk). `reconRehearsalBudgetMs`
   * caps the whole walk's wall-clock; `reconReconvergeMax` caps the LLM
   * reconverge calls during a walk. Both overruns ⇒ truncate the walk + a
   * graceful tail. See the rehearsing-reconnoiterer spec.
   */
  reconRehearse: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('true'),
  // 45 s cap on the walk's wall-clock. The walk runs off-camera, but it still
  // counts against the project's ~60 s total-wall-clock target (goals.md #5) —
  // a 90 s walk on a heavy page (the sweep saw Guardian burn 90 s and still
  // truncate) is more than the whole budget. Truncate at 45 s instead.
  reconRehearsalBudgetMs: z.coerce.number().int().min(0).default(45000),
  // 1 reconverge per walk. A 2nd reconverge rarely succeeds when the 1st
  // didn't (it's handed the same hard-to-reach target), and each one is a full
  // vision LLM call (~30-50 s) — two of them alone blow the 45 s walk budget.
  // The §0034 on-camera gated re-plan + graceful degradation is the backstop.
  reconReconvergeMax: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * §0042 in-scope fix for P13 (sweep finding): when the initial `resolveDraftSteps`
   * drops one or more requested click/type targets because their refs / visible-text
   * / fuzzy fallback all missed on the live page, this flag triggers ONE more recon
   * LLM call — handing A the dropped descriptions and a fresh aria snapshot, and
   * asking for a re-plan that doesn't rely on those targets. Symmetric with the
   * mid-walk reconverge but fired BEFORE the rehearsal walk runs (the walk only
   * fires on divergences mid-step; a step dropped at parse-time never reaches the
   * walk). Adds one recon LLM call (~20-50 s) when drops happen. Off ⇒ legacy
   * residual-after-drops behavior (sweep showed this produces dwell-heavy plans
   * the judge flags as robotic).
   */
  reconReconvergeOnDrop: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('true'),

  /**
   * Depth cap for the recon planner's `IPageSession.ariaSnapshot()` tree
   * (ADR §0036). `mode: 'ai'` already prunes generic/text-only nodes; the depth
   * cap bounds the token cost on huge content sites. Override with
   * ARIA_SNAPSHOT_DEPTH. (Re-tune after a real run against the Recordly table.)
   */
  ariaSnapshotDepth: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * If the aria snapshot exceeds this many chars (≈ chars/4 tokens),
   * `ariaSnapshot()` scopes it to `<main>` / `[role=main]` and, if still over,
   * truncates to the top of the tree (line boundary + a "truncated" note) — so
   * the recon prompt stays in budget (goal #5) and the planner has a tree it can
   * actually navigate. ARIA_SNAPSHOT_MAX_CHARS.
   *
   * F2 tightening: lowered 100000 → 40000 chars (~10k tokens) after the
   * 2026-05-14 cost measurement showed input tokens dominate the bill
   * (Sonnet 4.6 on Wikipedia/Photosynthesis: 41k input → ~\$0.13/run vs
   * goal-#5 \$0.01 target). Verified looks_human all-5 holds on content
   * pages (Photosynthesis 25s) and clean SPAs (React docs click) at this
   * cap. Truncation marker + §0042 graceful-degrade carry pages that
   * genuinely don't fit. Clean SPAs are usually under the cap anyway.
   */
  ariaSnapshotMaxChars: z.coerce.number().int().min(1000).default(40000),

  /**
   * Off-camera blocker dismisser (Task #20). `blockerDismiss` is the master
   * switch (off ⇒ recon constructs no dismisser, behaviour as before).
   * `blockerDismissMaxRounds` caps the detect→click iterations;
   * `blockerDismissMaxMs` caps the whole dismiss() call's wall-clock.
   */
  blockerDismiss: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('true'),
  blockerDismissMaxRounds: z.coerce.number().int().min(0).default(3),
  blockerDismissMaxMs: z.coerce.number().int().min(0).default(10000),

  /**
   * Model for the blocker dismisser's detect call. Needs vision (it's shown a
   * screenshot) but the task is simple (yes/no + pick an element) — a fast
   * cheap model. Defaults to `llmModel` (openai/gpt-4o-mini). Override with
   * LLM_BLOCKER_MODEL. (Model names live in config — goals.md #6.)
   */
  llmBlockerModel: z.string().min(1).optional(),

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
   * Soft-alignment (closed-loop duration steering, §0039): as the
   * PerformanceDirector plays, it nudges each `dwell` step's length so the
   * recording tracks the proportional `durationMs` schedule — shorten when
   * playback is running over (the per-step settle/overhead ate into the
   * budget), lengthen when it's running under (capped). `directorDwellMinMs`
   * is the floor an adjusted dwell can be shortened to; `directorDwellStretchMaxMs`
   * caps how much one dwell can be lengthened beyond its planned duration (no
   * dwell ever pushes the recording past `durationMs` regardless). Pure pacing
   * parameters, goals.md #6 carve-out. Override with DIRECTOR_DWELL_MIN_MS /
   * DIRECTOR_DWELL_STRETCH_MAX_MS.
   */
  directorDwellMinMs: z.coerce.number().int().min(0).max(8000).default(100),
  directorDwellStretchMaxMs: z.coerce.number().int().min(0).max(8000).default(2000),

  /**
   * Estimated wall-clock a `click` / `key` / `back` step costs *beyond* its
   * own explicit pauses — i.e. the page-settle wait the PerformanceDirector
   * does afterwards (`waitForVisualStability`, up to ~2.5 s for a navigation,
   * near-zero for an inline toggle). Used by the reconnoiterer's `sumDurations`
   * self-estimate AND surfaced to the planner prompt, so the plan it packs to
   * fill `durationMs` matches what playback actually takes — without this the
   * old hard-coded 400 ms undercounted a navigation click by ~1 s and the
   * recording overran the requested duration. Pure pacing estimate, goals.md #6
   * carve-out. Override with PACING_SETTLE_EST_MS.
   */
  pacingSettleEstMs: z.coerce.number().int().min(0).max(10000).default(1500),

  /**
   * Estimated wall-clock overhead the Director incurs *per step* on top of the
   * step's own declared timings — mouse-move animations, Playwright
   * actionability waits before a `clickSelector`, the post-click `expectAfter`
   * probe, the recording-start `page_diagnostic`, scroll-animation overshoot,
   * etc. None of it is in the step schema, but it adds up (~1 s across a ~10-step
   * plan) and made recordings overrun `durationMs`. The reconnoiterer folds
   * `n_steps × this` into its `sumDurations` / `fitPlanToBudget` accounting so
   * the plan it packs to fill the window matches what playback actually takes.
   * Pure pacing estimate, goals.md #6 carve-out. Override with
   * PACING_STEP_OVERHEAD_MS. (~280 ms/step measured against the Recordly
   * scenario — the recording overran `durationMs` by ~1 s on a ~9-step plan
   * with this set to 150.)
   */
  pacingStepOverheadMs: z.coerce.number().int().min(0).max(2000).default(280),

  /**
   * `fitPlanToBudget`'s silent-correction window. When the LLM's plan is more
   * than this ratio off the target durationMs, fitPlanToBudget no longer
   * silently scales — it surfaces a structured `planDurationFit.status` of
   * `compressed-hard` (over) or `underfilled` (under) onto the Performance,
   * which `RunMetrics.planDurationFit` mirrors and the eval canary flags.
   *
   * Within the window, the existing scale-down compress still runs when the
   * plan is slightly over budget; mechanical scroll+dwell padding when under
   * was removed in F1 (only the recon LLM owns content invention now). Pure
   * pacing tolerance, goals.md #6 carve-out. Default 0.20 = ±20 %, deliberately
   * looser than the recon LLM's own ±10 % discipline so the surface mostly
   * fires only on systemic LLM mis-sizing, not on routine variance. Override
   * with PLAN_DURATION_FIT_TOLERANCE_RATIO.
   */
  planDurationFitToleranceRatio: z.coerce.number().min(0).max(1).default(0.20),

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
});

const raw = {
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL,
  outputDir: process.env.OUTPUT_DIR,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
  llmModel: process.env.LLM_MODEL,
  llmReconModel: process.env.LLM_RECON_MODEL,
  llmUrlResolverModel: process.env.LLM_URL_RESOLVER_MODEL,
  maxReplans: process.env.MAX_REPLANS ? Number(process.env.MAX_REPLANS) : undefined,
  maxRecordingDurationMs: process.env.MAX_RECORDING_DURATION_MS,
  replanMinRemainingMs: process.env.REPLAN_MIN_REMAINING_MS
    ? Number(process.env.REPLAN_MIN_REMAINING_MS)
    : undefined,
  reconRehearse: process.env.RECON_REHEARSE || undefined,
  reconRehearsalBudgetMs: process.env.RECON_REHEARSAL_BUDGET_MS,
  reconReconvergeMax: process.env.RECON_RECONVERGE_MAX,
  reconReconvergeOnDrop: process.env.RECON_RECONVERGE_ON_DROP || undefined,
  ariaSnapshotDepth: process.env.ARIA_SNAPSHOT_DEPTH,
  ariaSnapshotMaxChars: process.env.ARIA_SNAPSHOT_MAX_CHARS,
  blockerDismiss: process.env.BLOCKER_DISMISS || undefined,
  blockerDismissMaxRounds: process.env.BLOCKER_DISMISS_MAX_ROUNDS,
  blockerDismissMaxMs: process.env.BLOCKER_DISMISS_MAX_MS,
  llmBlockerModel: process.env.LLM_BLOCKER_MODEL,
  llmJudgeModel: process.env.LLM_JUDGE_MODEL,
  directorHardBudgetMult: process.env.DIRECTOR_HARD_BUDGET_MULT
    ? Number(process.env.DIRECTOR_HARD_BUDGET_MULT)
    : undefined,
  directorDwellMinMs: process.env.DIRECTOR_DWELL_MIN_MS,
  directorDwellStretchMaxMs: process.env.DIRECTOR_DWELL_STRETCH_MAX_MS,
  pacingSettleEstMs: process.env.PACING_SETTLE_EST_MS,
  pacingStepOverheadMs: process.env.PACING_STEP_OVERHEAD_MS,
  planDurationFitToleranceRatio: process.env.PLAN_DURATION_FIT_TOLERANCE_RATIO,
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
  storageStatePath: process.env.STORAGE_STATE_PATH,
  browserWindowPosition: process.env.BROWSER_WINDOW_POSITION,
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
  llmReconModelResolved: data.llmReconModel,
  llmBlockerModelResolved: data.llmBlockerModel ?? data.llmModel,
  isDev: data.nodeEnv === 'development',
  isProd: data.nodeEnv === 'production',
} as const;

export type Config = typeof config;
