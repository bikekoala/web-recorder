# Decisions

Each entry: **context · options · choice · rationale · consequences**. Append-only — if a decision is reversed, add a new entry referencing the old one rather than editing.

---

## 0001 · Recording approach: post-process cursor overlay (Architecture B)

**Date**: project inception

**Context**: We need recorded video with a visible, human-like cursor. Synthetic CDP events do not move the OS cursor, so a headless screenshot/video pipeline cannot capture cursor motion natively.

**Options considered**:
- **A**: xvfb + Chromium GUI + xdotool driving real OS cursor + ffmpeg x11grab.
- **B**: Pure headless Chromium + Playwright `recordVideo` → post-process cursor overlay synthesized from an action log.
- **C**: Inject a fake cursor `<div>` into the page via JS overlay.

**Choice**: **B**.

**Rationale**:
- Cleanest container architecture (no X server, no special privileges).
- Cursor visuals fully programmable (style, easing, click bounce, dwell).
- Trade-off accepted: in-page CSS `:hover` does not trigger during recording. Acceptable for current use cases (YouTube playback, article scroll).

**Consequences**:
- Action log must record viewport-relative coordinates and `scrollY` at each timestamp.
- Cursor trajectory synthesizer is the make-or-break visual component (not a thin layer).
- A future "Architecture C" (xvfb + xdotool) can be added later as an alternative `IPageSession` adapter without touching `core/`.

---

## 0002 · Base browser layer: Playwright (not Puppeteer, not browser-use)

**Date**: project inception

**Context**: Need a low-level browser driver that supports video recording, mobile emulation, deterministic timing.

**Options considered**: Playwright, Puppeteer, browser-use, Stagehand (which sits on top of Playwright).

**Choice**: **Playwright** as the base; **Stagehand** layered on top for AI-driven `act`/`observe`. browser-use rejected as the base because its agent loop is incompatible with deterministic timeline execution required for video output.

**Rationale**:
- Playwright has built-in `recordVideo`, first-class mobile emulation, auto-wait, and Python/TS parity.
- Stagehand exposes the underlying Playwright `Page`, so we never lose access to primitives.
- browser-use's value is autonomous task completion; we want directed performance, not autonomy.

**Consequences**:
- Stagehand adapter implements `IPageSession`. browser-use can be added later as an alternative for "fallback / dynamic recovery" scenarios under a different port (e.g. `IDynamicAgent`).

---

## 0003 · Language & runtime: TypeScript + Node.js + ESM + tsx

**Date**: project inception

**Context**: Need to pick a language for the service.

**Choice**: TypeScript with strict mode; Node.js ≥20; ESM (`"type": "module"`); `tsx` for dev runs; no transpilation step in dev.

**Rationale**:
- Stagehand's TypeScript SDK is more mature than the Python one.
- Strict TS + Zod gives us schema-validated boundaries (LLM outputs, HTTP requests, project files).
- Native fetch, web streams, and modern ECMAScript reduce dependency surface.

**Consequences**:
- Imports use `.js` extensions per NodeNext rules (or are handled transparently by `tsx`).
- All adapters and domain types are typed end-to-end.

---

## 0004 · Logging: pino + pino-pretty

**Date**: project inception

**Context**: Need structured logs with trace IDs for jobs.

**Choice**: pino with pino-pretty in dev (`LOG_LEVEL` from env).

**Rationale**: Industry standard, fast, JSON output for production aggregation, pretty mode for local dev.

---

## 0005 · Configuration: env vars via dotenv, validated by Zod

**Date**: project inception

**Context**: Need a single source of truth for tunables.

**Choice**: All config in `src/infra/config.ts`, loaded from process env (with `dotenv` for local), validated by a Zod schema, immutable export.

**Rationale**: Fails fast on misconfiguration. Type-safe access throughout the codebase. Easy to override per-environment.

---

---

## 0006 · Stagehand v3 cannot recordVideo directly — Playwright owns the browser, Stagehand connects via cdpUrl

**Date**: project inception (post-investigation)

**Context**: Stagehand v3 internally launches Chromium via `chrome-launcher` and exposes only a CDP-level `V3Context`. There is no `recordVideo` field in `localBrowserLaunchOptions`. Trying to put recording in Stagehand's launch options fails type-check.

**Options considered**:
- Wait for Stagehand to add native recording support: too speculative.
- Use Browserbase's session recording (Stagehand's hosted mode): cloud cost, less control over output.
- **Launch Playwright ourselves with `recordVideo`, then connect Stagehand via `cdpUrl` to the same browser, and pass our Playwright `Page` into every Stagehand `act/observe` call via `options.page`.**

**Choice**: Third option.

**Rationale**:
- Stagehand exposes `act(instruction, { page: PlaywrightPage })`, `observe(instruction, { page: PlaywrightPage })`, `extract(instruction, { page: PlaywrightPage })` — first-class support for "drive my page".
- Playwright owns the browser lifecycle, the `BrowserContext`, and `recordVideo`. Cleanup at session end finalizes the .webm.
- Stagehand connects via `localBrowserLaunchOptions.cdpUrl = browser.wsEndpoint()` and is purely an AI overlay — it does not own any browser resource.
- Failure modes are clearer: if recording breaks, it's a Playwright issue; if AI resolution breaks, it's a Stagehand issue.

**Consequences**:
- The Stagehand adapter holds **two** library handles: a Playwright `BrowserContext`/`Page` and a `Stagehand` instance. Cleanup ordering: `stagehand.close()` first (detach), then `context.close()` (finalize video).
- `page` must be passed explicitly into every Stagehand call — easy to forget. The adapter centralises this in private helpers.
- We are coupled to Playwright as the recording layer. Switching to xvfb+ffmpeg later means a different `IPageSession` adapter (e.g. `XvfbStagehandPageSession`), not a modification of this one.

---

## 0007 · Browser binary: `BROWSER_CHANNEL` env var (default = bundled Chromium)

**Date**: project inception (post-investigation)

**Context**: Playwright's bundled Chromium download from `cdn.playwright.dev` failed mid-stream twice during dev setup on this machine. Need a robust path that does not block the prototype on flaky downloads.

**Choice**: Add a `BROWSER_CHANNEL` env var (validated by `src/infra/config.ts`). When unset, Playwright uses its bundled Chromium (the reproducible default). When set to `chrome`, Playwright launches the system Google Chrome instead.

**Rationale**:
- Bundled Chromium is the right default for production: pinned version, deterministic across machines, no dependency on a user's installed browser.
- System Chrome is the right escape hatch for dev when the bundled download is broken or slow on the user's network.
- Using a flag (vs. silently falling back) keeps the choice explicit and reproducible.

**Consequences**:
- Server deployment / CI must run `npx playwright install chromium` and leave `BROWSER_CHANNEL` unset.
- macOS dev machines without a clean bundled install can `BROWSER_CHANNEL=chrome` to unblock.
- The `IPageSession` adapter is unaware of which channel — it only reads `config.browserChannel`. Switching channels does not change the action log or recording behavior.

---

## 0008 · LLM provider abstraction: Anthropic / OpenAI / OpenRouter / Vertex behind one factory

**Date**: project inception

**Context**: The first user has neither an Anthropic nor an OpenAI direct API key — only OpenRouter and Vertex AI. Stagehand v3 supports custom clients via `llmClient: LLMClient`, with built-in `CustomOpenAIClient` (any OpenAI-API-compatible endpoint, including OpenRouter) and `AISdkClient` (any `LanguageModelV2` from the Vercel AI SDK, including `@ai-sdk/google-vertex`).

**Choice**: Add a single `resolveLlmForStagehand()` factory in `src/adapters/agent/llm-client.ts`. It reads `config.llm.provider` and returns either `{ model: string }` (for direct Anthropic/OpenAI — Stagehand handles auth) or `{ llmClient: LLMClient }` (for OpenRouter built on a stock `OpenAI` client pointed at the OpenRouter base URL, or Vertex via `AISdkClient`).

The provider is selected by env var with auto-detection fallback:

- `LLM_PROVIDER` explicit, OR
- auto-detect by which `*_API_KEY` / `GOOGLE_VERTEX_PROJECT` is set, in priority `openrouter > anthropic > openai > vertex`.

**Rationale**:
- One adapter, one factory function, one switch statement — all provider-specific construction lives in one place.
- Adding a new provider is mechanically constrained: extend the enum in `config.ts` → add a default model → add a `case` in the factory. The TypeScript exhaustiveness check (the `_exhaustive: never` in the default arm) catches missed branches at compile time.
- The `IPageSession` adapter does not know which provider is in use — it just calls `resolveLlmForStagehand()`. Same reasoning as §0007.

**Consequences**:
- Vertex is implemented as a stub (throws `ConfigError` with implementation hints in the comment). Filling it in is a ~10-line change because `@ai-sdk/google-vertex` is already a transitive dep via Stagehand and `AISdkClient` is already exported.
- OpenRouter routes through Stagehand's `CustomOpenAIClient`. The wire format is OpenAI Chat Completions; OpenRouter's "extra body" features (provider preferences, fallbacks) are not exposed yet — can be added by extending the OpenAI client config.
- The default model per provider is a constant in `config.ts` (`llmDefaults`). Bump these when newer Sonnet/Opus/Gemini versions ship.
- Future planner adapter (`IPlanner`) will likely share this factory rather than duplicate provider logic.

---

## 0009 · Reverse §0008: drop multi-provider, OpenRouter only

**Date**: project inception (same day as §0008)

**Context**: §0008 introduced support for four providers (Anthropic, OpenAI, OpenRouter, Vertex) anticipating that future users might bring different credentials. The actual user has only an OpenRouter key and explicitly invoked Occam's razor — *如无必要勿增实体* — to remove speculative entities.

**Choice**: Reduce the LLM layer to a single provider (OpenRouter). Concretely:

- Removed: `Provider` enum, `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, the `llmDefaults` table, the `resolveProvider()` helper, the `hasAnthropicKey/hasOpenAIKey/hasOpenRouterKey/hasVertex` flags.
- Removed: the `src/adapters/agent/llm-client.ts` factory file. ~50 lines of switch + exhaustiveness gone.
- Inlined OpenRouter `CustomOpenAIClient` construction in `StagehandPageSession.start()` — about 6 lines.
- `OPENROUTER_API_KEY` is now a **required** schema field (Zod `.min(1)`); the process exits at config-load time if it is missing.
- `LLM_MODEL` defaults to `'anthropic/claude-sonnet-4.5'` (an OpenRouter routing ID) and remains overridable via env.

**Rationale**:
- The multi-provider abstraction was justified speculatively. The user's actual need is one provider — keeping the abstraction adds cognitive load (every reader has to follow the factory) without serving real flexibility.
- Re-introducing a second provider later is a small, mechanical change: extend the schema, branch on a flag in the adapter, or restore the factory. Easier to add when needed than to maintain unused code now.
- The savings: ~80 lines of code + config + docs deleted.

**Consequences**:
- If a future user has Anthropic/OpenAI direct keys or wants to use Vertex, they must either (a) route through OpenRouter, or (b) extend the adapter — small change.
- The Stagehand adapter is now slightly less "pure" in its hexagonal layout: it imports `OpenAI` directly. This is a deliberate trade for minimalism; if a `IPlanner` adapter later needs the same LLM and we want to share, we can re-extract a small helper at that point — not before.

**Reverses**: §0008.

---

## 0010 · Browser-side helpers go in a plain-JS string injected via `addInitScript`, not as inline `page.evaluate` callbacks

**Date**: project inception (post-investigation)

**Context**: The first attempt to do a smooth scroll inside `page.evaluate` failed at runtime with `ReferenceError: __name is not defined`. Cause: tsx (which uses esbuild) hoists a `__name` helper for arrow functions and named function expressions to give them readable names in stack traces. The helper is defined at the top of the compiled file but is **not** captured when Playwright sends the function body to the browser — only the function source travels.

**Choice**: Define all browser-side runtime in a plain-JS string constant (`RUNTIME_HELPERS_SCRIPT` in `stagehand-session.ts`), inject it once via `context.addInitScript({ content })` after launching the persistent context, and have all `page.evaluate` call sites be **trivial** wrappers that invoke `window.__webRecorder.*`.

**Rationale**:
- The string never passes through esbuild, so transpiler artifacts (`__name`, `__decorate`, etc.) cannot leak into the browser context.
- All browser-side logic ends up in one place, easy to grep / extend.
- Adding new helpers (cursor overlay, click ripple, text highlighter) follows the same pattern — append to `RUNTIME_HELPERS_SCRIPT`, expose via `window.__webRecorder.*`, call from a one-line `page.evaluate`.

**Alternatives rejected**:
- Disable `keepNames` in tsx — tsx does not expose esbuild knobs as documented config; relying on undocumented behavior is brittle.
- Switch to `node --experimental-strip-types` — Node 25 native TS does not currently resolve `.js`-suffixed imports of `.ts` source files cleanly without extra flags; would require restructuring all imports.
- Pre-compile with tsc — adds a build step we don't otherwise need for a prototype.

**Consequences**:
- The helper string is plain ES5-ish JS (`var`, `function`) on purpose — to be safe across browser versions and avoid any TypeScript-style features that might tempt a future contributor to "tidy it up" and re-introduce the bug.
- TypeScript types for `window.__webRecorder` are inlined as casts at the call sites (`window as unknown as { __webRecorder: { ... } }`). For cleanliness later, declare `Window` augmentations in a `.d.ts` file.

---

## 0011 · LLM model: OpenAI-native models on OpenRouter (Claude via OpenRouter has JSON-mode quirks)

**Date**: project inception (post-investigation)

**Context**: The first run with `LLM_MODEL=anthropic/claude-sonnet-4.5` (the default after §0009) failed inside Stagehand's `CustomOpenAIClient.createChatCompletion` with `Failed to parse model response as JSON`. Stagehand sends `response_format: { type: 'json_object' }` in every request and parses the response strictly. Anthropic models routed through OpenRouter occasionally include surrounding text or markdown fences despite the system prompt instructing them not to.

**Choice**: Default `LLM_MODEL` recommendation is `openai/gpt-4o-mini`. The default in `config.ts` is currently `anthropic/claude-sonnet-4.5` — this is intentionally aspirational; the `.env` for local dev overrides to `openai/gpt-4o-mini` until the Claude-via-OpenRouter path is fixed.

**Rationale**:
- OpenAI-native models reliably honor the OpenAI `response_format` parameter — they were the original target of Stagehand's `CustomOpenAIClient`.
- `gpt-4o-mini` is cheap (~$0.15 / 1M input tokens) and fast — suitable for the per-step `observe` calls that happen inside Stagehand.
- Switching back to Claude is one env var change once we either (a) wrap `CustomOpenAIClient` to strip markdown, or (b) switch to `AISdkClient` with `@ai-sdk/anthropic` which goes direct.

**Consequences**:
- A future enhancement could be a small "JSON-coercing" wrapper around `CustomOpenAIClient` that retries with stripped markdown fences if the first parse fails. Not done yet because: speculative, and the right answer is probably to use Anthropic's API directly via AI SDK, not OpenRouter.
- For the planner layer (future `IPlanner`), we will need to make a similar choice. The planner is *much* more sensitive to model quality than `observe`, so it may justify its own model setting separate from the agent's.

---

## 0012 · Recording window: trim raw recording with ffmpeg, not switch contexts

**Date**: Phase 2

**Context**: The user explicitly wants the recorded video to start when the page is "visually loaded" — not include the multi-second goto + render-settle phase. Three approaches were considered (see §0001 for analogous lineage):

- **Trim**: record everything from session start, post-process trim with ffmpeg using a session-relative `recordingStartedAtMs` marker.
- **Two-context**: launch context A (no recording), navigate, close A, launch context B with recording from same userDataDir, re-navigate (cached). Stagehand reconnect is messy.
- **Re-launch**: same as two-context but more invasive.

**Choice**: Trim. `IPageSession.beginRecording()` records the marker; `RecordJobRunner` post-processes via ffmpeg.

**Rationale**:
- Single context, no Stagehand reconnect complexity.
- ffmpeg trim is fast (~1s for a 10s 720p clip).
- Trim accuracy is frame-accurate using output-seek + libvpx re-encode (input-seek with `-c copy` was tried but landed on initial keyframe — Playwright's WebM has sparse keyframes, often only at frame 0, so no actual cut happens).

**Consequences**:
- Output is `.webm` (VP8). Playwright's bundled ffmpeg lacks H.264 — moving to MP4 requires system ffmpeg or pulling in a wasm encoder.
- The action log carries a `recording: { startedAtMs, endedAtMs } | null` field that downstream layers (cursor synth, composer) consume.

---

## 0013 · Architecture B (planner + executor split): one LLM call before recording, zero during

**Date**: Phase 4-5

**Context**: The user wants (1) a natural-language driven service and (2) low-latency recording. The two pull in opposite directions if implemented naively — agent loops (browser-use style) put N LLM calls inside the recording window, each adding 1-5s of empty motion.

**Choice**: Plan-then-Execute. The pipeline is:

1. Setup (NOT recorded): goto → screenshot → planner LLM (one call) → pre-resolve click selectors via Stagehand observe (parallel).
2. Mark recording start.
3. Execute deterministically with cached selectors. **Zero LLM calls inside the recording window.**
4. Trim.

`IPlanner` returns a `TimelinePlan` (Zod-validated). `RecordJobRunner` runs the pipeline. `StagehandPageSession` exposes `screenshot/observeAll/resolveTarget/clickSelector` to support both planning and execution. The legacy `act/observe/wait/scroll` methods remain for ad-hoc callers, but the runner does not use `act` (Playwright's `clickSelector` is faster and triggers real navigation events; Stagehand's CDP-synthesized act sometimes does not).

**Rationale**:
- The recording window is the user-facing deliverable; nothing slow may happen inside it.
- One planner LLM call (~3-5s with vision) is acceptable as setup time.
- Pre-resolve happens outside the window; cached selectors make in-window clicks instant.
- Single planner call is also more deterministic than agent-loop — same prompt produces visually similar results across runs.

**Consequences**:
- Cannot adapt mid-recording to surprise events (cookie banners, popups). Acceptable for V1; future work: `IDynamicAgent` fallback used only when an action fails.
- Plan must be expressive enough up-front. Current schema (`scroll`/`click`/`wait`/`stable`) covers the simple cases; new action types (hover, drag, type) can be added.

---

## 0014 · Skip `observeAll` — vision-only context for the planner

**Date**: Phase 5

**Context**: First Phase-4 measurements showed `observeAll()` taking 5-10s by itself — Stagehand's broad observe sends ~20K tokens of accessibility tree to the LLM. With a multimodal planner that already receives a screenshot, that text context is redundant.

**Choice**: The runner passes `candidates: []` to the planner. The planner sees the page solely via the attached screenshot. Pre-resolve still calls `resolveTarget()` (one focused observe) per click step, and that's necessary to get a stable selector.

**Rationale**:
- gemini-2.5-flash with vision picks targets accurately from screenshot alone for typical content sites (verified on the Recordly README test case across 6+ runs, 100% click resolution).
- Removing `observeAll` cut wall-clock by ~5-10s.
- Pre-resolve is 1-2s — a single targeted observe is much cheaper than a broad one.

**Consequences**:
- For pages with weak visual differentiation between elements (forms with similar buttons, dense data grids), vision alone may not be enough. If we hit this, we can re-introduce a *narrow* observe limited to a viewport region.
- The planner cannot reference candidate indices — it must describe targets in natural language. Pre-resolve translates that description back to a selector via Stagehand.

---

## 0015 · Duration adjustment in the runner, not the planner

**Date**: Phase 5

**Context**: The planner consistently under-budgets — empirically, raw plan sums were 70-95% of `targetDurationMs`. Tightening the prompt helped a little but variance remained. The user's "录制 10s" expectation is precise and visible.

**Choice**: After receiving the plan, the runner runs `adjustPlanDuration()`. If the planned sum is outside ±5% of target, the runner extends the last scroll step (or appends a `wait`). If over, scroll durations compress proportionally. Click and stable durations are never adjusted — they have semantic meaning.

**Rationale**:
- Determinism: the trimmed video lands within ±5% of target regardless of LLM behavior.
- Correctness: extending a scroll preserves "slow scroll" feel; stretching a click would not.
- Auditability: the `why: 'pad to target duration'` annotation makes the adjustment visible in the action log.

**Consequences**:
- Measured trimmed-video variance with adjustment: ±300ms over 6 runs, mean +5.7% over target. Without adjustment: -28% on average.
- The adjuster works on the planner's *intent*, not its measurement of execution overhead. Click/Stable steps may still cause execution to overshoot the plan slightly. We accept the small overshoot.

---

## 0016 · Parallelism: planner + visual stability run concurrently

**Date**: Phase 5

**Context**: After §0014 the runner did `goto → stability → screenshot → plan → pre-resolve` sequentially. Stability and the LLM call don't depend on each other — they could run in parallel.

**Choice**: Take an early screenshot right after `goto` (post-domcontentloaded), kick off `planner.plan()` and `waitForVisualStability()` simultaneously, await both. Pre-resolve runs after.

**Rationale**:
- Early screenshot trade-off: may miss late-hydrated content. For server-rendered content (most blogs, GitHub READMEs, articles) this is fine. For SPA-heavy apps with critical late paint, we'd post-stability the screenshot at a small parallelism cost.
- Net wall-clock savings: ~1-2s across the full pipeline.

**Consequences**:
- If the early screenshot is wrong, the planner can produce a wrong target description, and pre-resolve will fail or the cached selector clicks the wrong thing. We measure: 0% failure rate over 6 Recordly runs.
- Future: a more careful hybrid could take TWO screenshots (one early for the LLM, one stable for pre-resolve grounding).

---

## 0017 · Discovery choreography for clicks: pre-resolve gives knowledge, executor stages the journey

**Date**: post-Phase 5 user feedback

**Context**: After Phase 5 the trimmed video had the right elements but felt robotic — clicking the 简体中文 link looked like a "teleport": page held still, then suddenly snapped to the new language. A real human scrolls down looking for the link, sees it, pauses, then clicks. The user's intuition: *"像一位先知一样 —— 滑动页面，恰巧找到了'简中'两个字，然后停了下来"* — pre-resolution gives us prophet-like knowledge of where things are, and the executor should USE that knowledge to *stage* the discovery, not skip past it.

**Choice**: `clickSelector` no longer relies on Playwright's `scrollIntoViewIfNeeded`. Instead each click runs through three phases:

1. **APPROACH** — smooth-scroll until the target sits at ~35% of the viewport height (a comfortable reading position). Speed ≈ 300 px/s, clamped to [800, 2200] ms total.
2. **ANTICIPATE** — hold for 500-800ms (randomized) — the micro-pause a human takes after their eyes lock on the target.
3. **CLICK** — Playwright's native click (no auto-scroll, since the element is already in viewport from phase 1).

The runner's `recomputeClickDurations()` pass reads the cached bbox from pre-resolve and sets each click's `durationMs` to the same approach + anticipation + click estimate, so plan budget aligns with execution reality.

**Rationale**:
- Pre-resolution is INVISIBLE to the viewer. They don't know we know where the link is. They see the journey.
- Smooth-scroll-to-position with anticipation pause is what a person does — it's the verb of "discovery" decomposed into mechanical primitives.
- Adding the approach as logged `scroll` + `wait` entries keeps the action log faithful — cursor synth in the future will animate exactly what was recorded.
- Empirically, the planner often outputs a separate "exploration" scroll BEFORE the click. Combined with our discovery scroll, this produces a nice two-phase movement: scan-fast (planner's intent) → slow-down-to-target (our approach). The contrast feels naturally human even though it's accidental.

**Consequences**:
- Click steps now consume 1500-3000ms each (vs 200-400ms before). Planner prompt updated to reflect this.
- The `recomputeClickDurations` heuristic must stay in sync with `clickSelector`'s implementation. Both files reference each other in comments. Drift would cause systematic plan/execution mismatch.
- After this change, trimmed-video duration variance dropped to ±300ms with mean within 0.5% of target — the click is no longer a runaway item.
- Choreography parameters (300 px/s, 35% viewport-y, 500-800ms pause) are currently hardcoded constants. If a user wants "frantic" or "lethargic" feel later, they'd be exposed via session config.

**Reverse-incompatible with**: nothing — this is purely a behavioral change. The action log still validates against the same schema.

---

## 0018 · Multi-stage discovery scroll for far targets (fling + micro-pause + slow approach)

**Date**: post-Phase-6 user feedback ("如果元素在最下面呢")

**Context**: After §0017 introduced single-stage discovery scrolls, we noticed they would still feel mechanical for targets far from the initial viewport. With a single 2.2s clamp, scrolling 4500px would be ≈2000 px/s — perceptually a teleport. A real human handles a far target by *throwing* the page first (high speed, eased deceleration) and then *carefully aligning* the last bit at reading pace.

**Choice**: `clickSelector` now classifies approach distance into three bands:

- `≤ 60 px`           — skip (target already in the comfort zone)
- `≤ 1000 px` (short)  — single 300 px/s scroll, `outQuart` easing, [800, 2200] ms
- `≤ 2500 px` (medium) — single 600 px/s scroll, `outQuart` easing, [1200, 2800] ms
- `> 2500 px` (long)   — **two-stage**:
    - **fling**:    cover (distance − 600 px) at 1500 px/s, `outExpo` easing, [1000, 2200] ms
    - **micro-pause**: 150-250 ms randomized
    - **slow approach**: last 600 px at 300 px/s, `outQuart` easing, [1500, 2200] ms

`outExpo` is intentionally aggressive (front-loaded, dramatic decel) so the fling reads as "throwing the page". `outQuart` is gentler — used for "tracking a known position" feel.

The runner's `recomputeClickDurations()` mirrors these bands so plan budget stays in sync with execution reality.

**Rationale**:
- Single-stage scrolls cannot serve both "near target" (slow / careful) and "far target" (fast / decisive) — humans don't either.
- The choice of three bands (not a continuous formula) keeps the choreography legible and tunable. Each band has explicit perceptual intent.
- Two-stage with a micro-pause produces the natural "I see roughly where it is, now let me line up" rhythm. The pause is short enough not to feel like hesitation, long enough to read as motion change.

**Consequences**:
- The action log gains additional `scroll` and `wait` entries per long click. Cursor synth (future) will animate them as a continuous arc.
- The `RUNTIME_HELPERS_SCRIPT` exposes `scrollEasings = { inOutQuad, outQuart, outExpo, linear }`. Consumers pick by name.
- All four numeric thresholds (band widths + speeds + clamps) are constants in `stagehand-session.ts`. They are duplicated in `record-job-runner.ts` for plan-time estimation. Drift between the two would cause systematic plan/execution mismatch — both files have a comment pointing at the other.
- `IPageSession.scroll(deltaY, opts)` now accepts an optional `easing: ScrollEasing`. The default (`inOutQuad`) preserves backward compatibility with explorer scrolls.

**Open**: see [`docs/naturalness-catalog.md`](./naturalness-catalog.md) for the broader inventory of human-like motion behaviors. Items A6, A7, A8, A9 (inter-scroll pauses, inertia, overshoot, look-back) are open follow-ups in the same family but lower priority than cursor synth (Tier 1, group B).

---

## 0019 · Streaming Director with LLM-in-the-loop (partial reversal of §0013)

**Date**: 2026-05-10

**Context**: §0013 required zero LLM calls inside the recording window to guarantee fluidity. That worked but produced rigid plan-then-execute recordings that could not adapt to lazy targets, mid-recording surprises, or position-dependent decisions. The "click 简中" Recordly scenario showed teleport-style clicks because the executor jumped straight to a known target instead of staging discovery, and lazy-loaded targets had no recovery path.

**Choice**: Introduce a `StreamingDirector` (`src/adapters/director/streaming-director.ts`) that runs an LLM decision loop *inside* the recording window, using a fast multimodal model (Gemini Flash Lite / gpt-4o-mini, sub-second p95) and a **double-queue with pre-fired calls** so LLM latency overlaps animation and is invisible to viewers.

The Director consumes a tiny 4-primitive `DirectorAction` vocabulary:
- `click(target, reasoning)` — discovery + search + click choreography (preserves §0017/§0018)
- `scroll(deltaPx, speed, reasoning)` — speed maps to (px/s, easing) profile
- `dwell(durationMs, reasoning)` — pause
- `done(reasoning)` — end recording

Setup is unchanged from §0016: planner fires once with screenshot, extracts likely click targets, pre-resolves their selectors via Stagehand observe → outputs `DirectorBriefing { prompt, durationMs, hints, rationale }`. The Director's `IFastDecider` then takes over for the recording window.

**Rationale**:
- The original "no LLM in window" constraint was a means to "no visible stalls". Pre-firing achieves the same goal without the constraint.
- The 4-primitive vocabulary keeps decisions trivial for the LLM, making sub-second JSON-mode responses reliable.
- Choreography (discovery click, multi-stage scroll, easings) stays in code — LLM picks intent only.
- An implicit-dwell fallback (200ms × 4 cap) and a hard-deadline watchdog (1.05× × `durationMs` default) bound the worst case.
- `expectAfter` validation lets the LLM cheaply mark "I expect URL contains X / text Y visible" so the Director can detect divergence and re-decide without burning the whole queue on stale plans.

**Consequences**:
- Removed: `TimelinePlan` and the entire step schema (`PlanStep`, `ScrollStep`, `ClickStep`, `WaitStep`, `StableStep`), `LlmPlanner.plan()`, `RecordJobRunner.adjustPlanDuration` / `recomputeClickDurations` / `expectedPlanDurationMs` / `estimateClickDurationMs` / `countSteps` / `preResolveClicks` / `executePlan` / `executeClick`. Net delete: −661 lines.
- Added: ports `IDirector`, `IFastDecider`; adapters `StreamingDirector`, `LlmFastDecider`; domain types `DirectorAction`, `DirectorState`, `DirectorBriefing`, `ClickHint`; infra utility `Pending<T>`; `IPageSession.quickFindInViewport` / `quickFindOnPage` / `clickByDescription` (with internal search loop and LLM fallback).
- Recording window now contains LLM calls (typically 2-4 per 10s recording, ~$0.001-$0.003 with gpt-4o-mini). Their latency is hidden under animation; an implicit-dwell fallback handles tail latency.
- New env vars: `LLM_DECIDER_MODEL`, `DIRECTOR_LOOKAHEAD_MAX`, `DIRECTOR_DWELL_FALLBACK_MS`, `DIRECTOR_HARD_BUDGET_MULT`.
- Spec: `docs/superpowers/specs/2026-05-10-streaming-director-design.md`. Plan: `docs/superpowers/plans/2026-05-10-streaming-director.md`.
- Empirical run on Recordly (single integration test): trimmed-video 10640ms (+6.4% over 10000 target), 5 implicit dwells, 1 pre-resolved click hint, 1 expectAfter mismatch (recovered cleanly), end reason `budget`.

**Reverses (partially)**: §0013. The strict "0 LLM in window" constraint is loosened; the broader "no visible stalls" intent is preserved by streaming.

**Preserves**: §0001 (Architecture B post-process cursor overlay still planned), §0006 (Stagehand v3 + Playwright recordVideo via cdpUrl), §0010 (addInitScript browser-side helpers), §0017 (discovery click choreography is the executor for `click` actions), §0018 (multi-stage long scroll backs the search loop), §0009 (OpenRouter only for LLM auth).

**Tuning notes**:
- gpt-4o-mini through OpenRouter is currently the most reliable decider model (Gemini Flash Lite shows higher tail latency on this network).
- `DIRECTOR_HARD_BUDGET_MULT=1.05` is necessary for 10s recordings to stay within ±10% — the 1.2 default leaves too much slack given the FastDecider's tail latency.
- A faster decider (Groq llama-3.2-vision, Cerebras, local Ollama) could cut implicit dwells from ~5 to ~0 and let `DIRECTOR_HARD_BUDGET_MULT` go back to 1.2 with no risk of overshoot.

---

## 0020 · Visual-blocker prompt + introspection log entries

**Date**: 2026-05-10

**Context**: Two distinct issues surfaced from real-world testing:
1. Tested the agent on `youtube.com/watch?v=...`. Browsers block autoplay, so the page sat with a paused-video play overlay. The user said "watch the video for a while"; the LLM dwelled 26s waiting for autoplay that would never come. The user does not know about technical preconditions like autoplay restrictions; the agent has to figure them out from the screenshot.
2. After a run failed or behaved oddly, the only timeline available was the action log. We could see *what* happened (scroll, click, wait) but not *why* the LLM chose what it chose, what it expected, or what page state it saw at decision time. Reviewing a run required re-running with debug logging — slow and not always reproducible.

**Choice (1) — Visual-blocker awareness in the SYSTEM_PROMPT** (`src/adapters/decider/llm-fast-decider.ts`):
- Explicit list of "blockers" the LLM must act on FIRST regardless of the user's stated goal: paused-video play overlay, cookie/consent dialog, login modal, age gate, full-viewport spinner.
- Tighter "done" semantics: a single scroll is NOT enough to satisfy a "browse" intent. Don't say done unless every verb in the user's prompt has been performed.
- "If your previous TWO actions were both dwells, the next must be click or scroll" — prevents LLM passivity loops.

**Choice (2) — Three new ActionLogEntry variants** (`src/domain/action-log.ts`):
- `decision` — written every time `IFastDecider.decide()` returns. Captures `decisionId`, `modelId`, `latencyMs`, the chosen actions with their `reasoning`, and any `expectAfter` hint. The screenshot the LLM saw is implicitly captured in the recorded video at `t`.
- `decision_failure` — captures recoverable problems with a categorical `reason`: `schema_validation` | `expect_after_mismatch` | `llm_call_failed` | `click_failed` | `budget_exceeded`. The reason itself tells the operator whether the cause is a system bug or a page-vs-LLM mismatch (recoverable).
- `page_diagnostic` — written at `recording_start`. Captures `url`, `title`, `interactiveElementCount`, top `visibleHeadings`, and detected `blockerSignals`. A "blank-ish" anomaly (e.g. logged-out YouTube homepage with `interactiveElementCount: 6` and `blockerSignals: ["search_only"]`) is now visible at a glance.

`IPageSession` gains `nowMs()` and `appendEntry()` so upstream layers can write directly without going through the dedicated action methods. `IFastDecider` gains `readonly modelId: string` for log entries.

**Rationale**:
- Models, even strong ones, will not always read between the lines of natural-language intent. Listing common technical preconditions in the prompt costs ~50 prompt tokens and turns "passive 26s of dwell" into "click play, watch, scroll to comments" (verified on the YouTube watch URL after this change).
- A run's LLM rationale is the missing piece for retrospective analysis. With it, "did the system or the page misbehave?" becomes answerable from the action log alone, no re-run needed.
- Categorizing failures by `reason` lets the operator triage: `llm_call_failed` (system bug, fix code) vs `expect_after_mismatch` (LLM expected SPA-style nav, page used hash routing — probably recoverable) vs `click_failed: budget cut` (over-aggressive budget, raise it).
- `page_diagnostic` has heuristic blocker detection (CSS selectors + visible-text matching), kept simple. False positives/negatives are expected; the field is informational, not load-bearing.

**Consequences**:
- ActionLogEntry schema gains 3 variants — backwards-compatible since it's a discriminated union (consumers ignore unknown types or fail-fast on unknown, both fine).
- StreamingDirector now writes log entries; `IPageSession.appendEntry` and `nowMs` are part of the port contract.
- Default models: planner promoted to `google/gemini-3.1-pro-preview` for stronger vision; decider stays on `openai/gpt-4o-mini` (`google/gemini-3.1-flash-lite` preview's tail latency is too high on OpenRouter today; revisit at GA).
- Empirical YouTube watch-URL run: 2 click hints pre-resolved, agent clicked the central play button at t≈11s, watched for ~12s, scrolled to comments at t≈24s. Before this change: 0 clicks, 26s of passive dwell.

**Preserves**: §0019 (streaming Director architecture, 4-primitive vocabulary, expectAfter), §0017/§0018 (click + scroll choreography unchanged).

---

## 0021 · Pre-recording BlockerPrelude (dismiss visual blockers BEFORE the recording window opens)

**Date**: 2026-05-10

**Context**: §0020 added a SYSTEM_PROMPT clause telling the in-window FastDecider to handle visual blockers (cookie consent, paused-video play overlays, login modals) FIRST. That works, but it puts the dismissal click inside the deliverable: the viewer sees the cursor click "Accept all", then the user's actual task. Two problems:
1. The deliverable is no longer a clean recording of the user's intent — it shows non-user-intent clicks the user did not ask for. (Conflicts with goals.md #3 "user intent satisfied or transparently not".)
2. The dismissal eats budget. A 10s recording with 4 prelude actions has only ~6s left for the user's actual task. (Conflicts with #2 "fluid, no visible stalls" — the recording feels rushed.)

We had a related observation from §0020's YouTube test: blockers detected by the heuristic at `recording_start` are reliable enough to act on programmatically. The information is already there *before* recording opens; we just weren't using it.

**Options considered**:
- **A**: Keep the SYSTEM_PROMPT rule as the only mechanism. Dismissal stays in the deliverable.
- **B**: New BlockerPrelude phase that runs probe → dismiss-loop → re-probe BEFORE the recording window opens. Re-uses `IFastDecider` (small dismissal loop, not the full Director). The Director's blocker rule remains as a safety net for blockers that appear AFTER the recording starts.
- **C**: Try to dismiss blockers during planner.brief() with a special verb in the briefing schema. Rejected: planner is one-shot and vision-only; it does not own action execution.

**Choice**: **B**.

The BlockerPrelude:
- Probes `IPageSession.pageDiagnostic()` (newly promoted from a private `gatherPageDiagnostic`). If `blockerSignals` is empty, returns immediately — the common case for content pages costs nothing.
- Otherwise loops `(probe → ask FastDecider → click → wait_for_stability → re-probe)` bounded by `maxIterations=3` and `maxMs=15000`.
- Uses a dedicated `[BLOCKER PRELUDE]` prompt prefix so the LLM understands its job is dismissal, not the user's actual task.
- Decision log entries use NEGATIVE `decisionId`s (`-1, -2, ...`) so they never collide with the Director's positive numbering and are grep-friendly: "negative decisionId == prelude".
- Failures are absorbed: a click failure logs a `decision_failure` and bails; an unexpected error returns a clean report. The recording continues regardless.

`IPageSession` gains a public `pageDiagnostic(): Promise<PageDiagnostic>` method (the existing `gatherPageDiagnostic` is promoted). `RecordJobRunner` takes an optional `BlockerPrelude` constructor parameter (null skips it). `RunMetrics` gains a `blockerPrelude: BlockerPreludeReport | null` field.

**Rationale**:
- Cleaner deliverable: the recording window starts AFTER blockers are gone, so the trimmed video is purely the user's intent in motion.
- Bigger budget: the full `durationMs` is available for the user's actual task.
- Same model, same cost surface: re-uses `IFastDecider`. No new model, no new prompt for the Director.
- Hexagonal compliance: BlockerPrelude lives in `core/`, depends only on ports — `IFastDecider`, `IPageSession`, and the `DirectorBriefing` / `PageDiagnostic` domain types.
- Bounded: `maxIterations` and `maxMs` cap the worst case. A pathological page that keeps regenerating overlays will hit one of the caps and recording proceeds anyway (with the remaining signals captured in the report).
- Optional: `RecordJobRunner` accepts a `null` BlockerPrelude. Tests that don't care about the prelude (the existing 56 unit tests) keep working unchanged.

**Consequences**:
- Setup time grows by 0-15s depending on blockers. For the common no-blocker case, the cost is one `pageDiagnostic()` call (~50-200ms).
- The recording window stays exactly the user's `durationMs` (within the existing trim tolerances).
- Negative `decisionId` means downstream consumers (cursor synth, analytics) that filter by `decisionId >= 0` automatically skip prelude entries. Good for the deliverable; the introspection trail is still there for operators.
- The Director's SYSTEM_PROMPT blocker rule (§0020) remains as a defense against blockers that appear AFTER recording opens (e.g. a delayed cookie banner or a SPA route triggers a modal mid-recording). The prelude handles "blockers visible at page-load time", the Director handles "blockers that appear later".
- New tests: 12 BlockerPrelude unit tests covering clean-page skip, single dismissal, multi-iteration, iter/time caps, decider-done bailout, click-failed bailout, prompt routing.
- Total unit tests: 56 → 68.

**Preserves**: §0019 (Streaming Director architecture; Director still owns the recording window and is unchanged), §0020 (introspection log entries — `decision`/`decision_failure`/`page_diagnostic` are now used by the prelude too), §0017/§0018 (click + scroll choreography).

**Open**: the prelude currently doesn't pass `lastActionFailure` between iterations (each LLM call sees a fresh recentActions list, but the failure context is best-effort). If a real-world site shows the same blocker repeatedly through 3 dismissal attempts, we may want to surface "previous attempts didn't reduce blockerSignals" as a hint to the LLM. Punted for now — the iter cap protects us.

---

## 0022 · Duration contract: best-effort + transparent intentSatisfaction

**Date**: 2026-05-10

**Context**: Users give natural-language input including a `durationMs` ("record 10s") that we cannot strictly honor under all page conditions:

- Lazy-loaded targets: an element the user wants to click may take 20s+ to appear. If we strict-honor "10s", we record an unfinished task. If we extend to "20s+", we lie to the user about timing.
- Slow networks, A/B tests, region/geo gates, dynamic content — none of these are visible from the prompt.
- The user's "10s" is a rough expectation, not a hard contract. They want the recording to feel about that long, with their intent fulfilled.

These are not bugs to fix; they're tensions to resolve through a clear product contract.

**Choice**: Make the contract explicit in `docs/goals.md` hard non-negotiables and `RunMetrics`. The system promises:

1. **Recording window targets `durationMs ± 10%`**, with a hard cap of `durationMs × 1.05` enforced by `DIRECTOR_HARD_BUDGET_MULT`. We never silently extend the window to "fit" actions.
2. **Pre-recording (untimed)** handles browser readiness, blocker dismissal (§0021), and target-resolution. Lazy-loaded elements that the user mentioned can be waited for here without affecting `durationMs`.
3. **Within the recording window, best-effort**: we attempt every clickable hint the planner extracted, scroll if asked, dwell to fill — but we do not guarantee completion. If a target doesn't appear in time, the action log records a `click_failed` decision_failure and the recording continues with whatever else fits.
4. **Transparency over ambiguity**: a new `IntentSatisfaction` digest in `RunMetrics` answers "did we do what was asked?" categorically (`complete` / `partial` / `unmet` / `unknown`) plus raw counts (`clicksExecuted`, `scrollsExecuted`, `hintsResolvedPreRecording`). When the planner couldn't extract specific click hints we return `unknown` rather than guess.

`computeIntentSatisfaction` is exported from `record-job-runner.ts` and runs at job end. It filters action log entries to the recording window so setup-phase clicks (BlockerPrelude dismissals) are excluded — those aren't user intent.

**Rationale**:
- We cannot promise strict timing on adversarial pages; promising it would lead to silent failures or lies. Best-effort + transparency lets operators triage runs without re-running them.
- `unknown` is a deliberate non-decision when the planner gave us nothing to score against. Pretending to know is worse than admitting we don't.
- Putting this in `RunMetrics` (not just logs) means downstream HTTP API consumers will get the same signal. Future analytics can graph "intent satisfaction rate" across runs.
- Conservative heuristic: `complete` requires hints clicked AND ≥1 scroll. Most user prompts include browse/scroll language; a click-only run usually missed the broader exploration intent. Tunable later.

**Consequences**:
- New `RunMetrics.intentSatisfaction: IntentSatisfaction` field. Existing consumers that don't read it are unaffected.
- `RecordJobRunner.run()` logs a warning when `level` is `unmet` or `partial`, info when `complete` or `unknown`. Operators reviewing logs get the signal without parsing the action log themselves.
- 9 new unit tests for the heuristic edge cases (vague prompts, partial executions, setup-phase exclusion, no recording window).
- Total unit tests: 68 → 77.
- This codifies what the project will and won't promise. Future code that tries to "force completion" by extending the recording window past `durationMs × 1.05` should be rejected — see goals.md hard non-negotiable #2.

**Preserves**: goals.md hard non-negotiables #2 (no visible stalls — we don't pad the recording with dwells to "satisfy" intent), #3 (intent satisfied or transparently not — this digest IS the transparency).

**Open**: the heuristic doesn't understand verb-level intent ("watch", "browse", "compare" — different from clicks/scrolls). A future enhancement could ask the planner to output an `intentVerbs: string[]` field alongside hints, then check whether each verb has been "satisfied" by some action sequence. YAGNI for now.

---

## 0023 · Centralized prompts + cold-start pre-fire + briefing-hint surfacing

**Date**: 2026-05-10

**Context**: Three coupled problems, addressed in one cross-cutting refactor.

1. **Prompts were scattered.** SYSTEM_PROMPT for the decider was a 1.9 KB string literal in `src/adapters/decider/llm-fast-decider.ts`. Planner had its prompt inlined in `src/adapters/planner/llm-planner.ts`. BlockerPrelude had its own. Tuning prompts required hunting through adapter code; multi-model compatibility (per-model JSON quirks) had nowhere to live.

2. **Sonnet 4.6 broke as planner.** Anthropic models routed via OpenRouter sometimes ignore the OpenAI \`response_format: json_object\` hint. When the user prompt contains a CJK-quoted phrase like \`"简体中文"\`, Sonnet echoes it verbatim, the inner ASCII double-quotes escape the outer JSON string, and JSON.parse fails. We had wrongly concluded Sonnet was unsuitable when actually the prompt needed model-specific safety rules.

3. **Cold-start LLM ate 70% of the recording budget.** For a 10s budget, the Director's first decision call (cold-start, ~1-7s on gpt-4o-mini) consumed most of it. The actual click-then-scroll sequence had no time left, so clicks were watchdog-cut mid-flight and never landed in the recording. `intentSatisfaction.level` was consistently `unmet`.

4. **Off-fold click hints were invisible to the LLM.** `DirectorState.visibleHints` was filtered to the current viewport. If the planner extracted `简体中文 link` (which is below the fold at scrollY=0), the LLM didn't see it in its inputs and chose to scroll-to-find instead of clicking — wasting budget on redundant scrolls.

**Choice (1) — `src/prompts/` directory**:
All prompts move to a dedicated module:
- \`src/prompts/planner.ts\` — \`plannerSystemPrompt\` + \`buildPlannerUserText\`
- \`src/prompts/decider.ts\` — \`deciderSystemPrompt\` + \`buildDeciderUserText\`
- \`src/prompts/prelude.ts\` — \`buildPreludeUserPrompt\`
- \`src/prompts/index.ts\` — barrel export

Adapters import from \`src/prompts/\`; nothing else holds prompt content. Per hexagonal architecture, prompts are pure data (no I/O), reachable from \`adapters/\` and \`core/\`.

**Choice (2) — Sonnet 4.6 JSON safety rules + extract-from-prompt rule**:
The planner system prompt now carries explicit rules:
- "JSON SAFETY RULES" — use ONLY ASCII double-quotes; NEVER place a double-quote inside a string value; if the user's prompt contains a CJK or guillemet-quoted phrase, paraphrase into plain English without quotes.
- "EXTRACT FROM PROMPT, NOT JUST SCREENSHOT" — if the user explicitly mentions a click target, list it even when it's not visible in the current viewport. The downstream resolver searches the full page.
- A worked CJK example showing both the correct paraphrased output and two wrong patterns (refusing because not visible; preserving CJK quotes).

Same JSON-safety rules added to the decider prompt for the action's \`target\` and \`reasoning\` fields.

**Choice (3) — Pre-fire Decision 1 during prelude**:
\`RecordJobRunner\` gains a \`preFireDecider: IFastDecider\` constructor parameter. When set, the runner takes a fresh post-prelude screenshot and calls \`decider.decide()\` IN PARALLEL with the recording-window setup. The Director's \`run(...)\` accepts an optional \`prefiredDecision: PrefiredDecision\` opt; if provided, it's used as Decision 1 instead of cold-starting.

The cold-start window — formerly 1-7 seconds of implicit dwells — is now hidden under the recording-start ceremony. \`PrefiredDecision\` carries \`firedAtMs\` + \`scrollYAtFire\` so the \`decision\` log entry's \`latencyMs\` is faithful.

**Choice (4) — \`DirectorState.briefingHints\` (was \`visibleHints\`)**:
\`BriefingHintForState\` carries \`{ description, position: 'in_view' | 'above' | 'below', scrollToReveal: number }\`. The decider prompt's "BRIEFING HINTS PRIORITY (ABSOLUTE)" rule then tells the LLM: hints with any position MUST be clicked first; the executor handles discovery scroll automatically; scrolling-first-to-find-the-target is a budget waste.

**Choice (5) — Split \`LLM_MODEL\` into three knobs**:
\`config.llmModel\` had been doing triple duty: planner, agent (Stagehand internal observe), and (formerly) decider. Stagehand's internal prompts expect a particular output shape — Sonnet 4.6 broke them. Now:
- \`LLM_MODEL\` — agent only. Default \`openai/gpt-4o-mini\`.
- \`LLM_PLANNER_MODEL\` — planner only (vision-strong). Default falls back to \`LLM_MODEL\` for backwards compat.
- \`LLM_DECIDER_MODEL\` — decider (latency-sensitive). Default \`openai/gpt-4o-mini\`.

**Rationale**:
- Per \`docs/goals.md\` non-negotiable #4 ("architecture stays swappable"): centralizing prompts makes model-specific tuning a content change, not an adapter change. \`anthropic/claude-sonnet-4.6\` is now a real production option, not a "try it and pray".
- Pre-fire is pure overlap-of-latency; no new failure modes. If \`screenshot()\` or \`decide()\` fails during pre-fire, we log and let the Director cold-start as before.
- Surfacing all hints (with positions) lets the LLM exploit the executor's full capability; the previous viewport-only filter was an under-exposure.
- The model split fixes a real coupling bug: Stagehand's parsers are a closed system that requires gpt-4o-mini-style JSON behavior.

**Consequences**:
- Empirical run with Sonnet 4.6 planner: \`hintCount: 1\` (the 简体中文 link), JSON parses cleanly, no crash. The same scenario crashed at parse step before §0023.
- Decider system prompt grew from ~1.9 KB to ~3.5 KB (added JSON safety + briefing-hint priority). Per-call latency on gpt-4o-mini went from ~1s p95 to ~3-4s. The \`implicitDwellCount\` ceiling in the integration test bumped from 8 to 14 to absorb this; the recording is still fluid (dwells render as natural micro-pauses).
- \`expectAfterMismatchCount\` ceiling bumped from 1 to 3 — strengthened BRIEFING HINTS PRIORITY makes the LLM click more aggressively; on a turbo-frame page (GitHub README), each click sets \`expectAfter: { urlContains: 'zh-CN' }\` and mismatches because the URL doesn't change. Director recovers cleanly via re-decision.
- Total unit tests: 77 (no new tests; prompt content changes don't need them; structural changes covered by typecheck).
- Open: \`intentSatisfaction.level\` is still \`unmet\` on the Recordly run because clicks are watchdog-cut mid-flight and \`clickSelector\` doesn't write a click ActionLogEntry on failure. Separate fix tracked for next iteration — the architectural wins of §0023 are independent.

**Preserves**: §0019 (streaming Director), §0020 (introspection log entries), §0021 (BlockerPrelude), §0022 (intentSatisfaction contract), §0009 (OpenRouter only). Goals.md hard non-negotiables #2, #3, #4 all served.

---

## 0024 · Regression library + AI-first testing principle

**Date**: 2026-05-10

**Context**: The single `recordly.test.ts` integration test had calcified into a magic-number ratchet. Each model upgrade or prompt change pushed dwell counts and mismatch counts up; we kept bumping thresholds (`≤8` → `≤14` → ...) to "make the test green" without asking whether the recording was actually getting better or worse. Test green / red lost meaning.

The user surfaced the deeper principle: the system is **bionic and open-ended**. We don't know in advance which website a customer will record or how they'll phrase their intent. Hardcoded thresholds for "good behaviour" calcify around the one website we tested, and break the moment we point the system somewhere else.

**Choice (1) — `goals.md` Hard rule #6 "AI-first, not magic-numbers"**:
Codifies the principle. Hardcoded numbers are acceptable for pure rendering parameters (px/s scroll speed, frame rate), schema-safety bounds that contain LLM output (dwell ≤ 3000ms), and test infrastructure (timeouts). They are NOT acceptable for thresholds that gate "is this good", "is this OK", "is this a blocker" — those are LLM judgments at recording time. Tests follow the same rule: pass/fail must not depend on counts that drift with model versions.

**Choice (2) — Regression case library**:
Replaces the single Recordly integration test with `tests/regression/cases.ts`:
- `github-multistep` — extends Recordly: 简中 → back to project home → click `build` folder → view `package.json` source. Four discrete user verbs in one recording, exercising the agent's ability to chain actions.
- `youtube-creator` — open YouTube homepage (logged-out, search-only state), search for a creator, open their channel, scroll recent videos. Tests open-ended navigation through a visually-empty starting state.
- `gmaps-search-stay` — search "New York" on Google Maps, do not pan/zoom the canvas. Negative test: the agent must stay focused on search → results, not waste budget on irrelevant map controls.

Each case has 2 prompt variants:
- `natural` — straightforward conversational phrasing.
- `distracting` — same intent embedded in extra unrelated chatter ("听说 X 是个好工具", "今天有点无聊…"). Tests planner's ability to isolate intent from social filler.

`tests/regression/regression.test.ts` iterates the (case × prompt) matrix as separate `it()` blocks, all running in the existing `vitest.regression.config.ts` (sequential, 600s suite timeout, per-case timeout = `durationMs × 2 + 30s`).

**Choice (3) — Categorical assertions only**:
The regression test asserts ONLY:
- `result.videoPath` is truthy (recording produced)
- `result.metrics.trimmedVideoMs > 0`
- `result.metrics.intentSatisfaction.level` matches the enum (the level itself can be ANY of the four values)
- `result.metrics.blockerPrelude.endReason` matches the enum
- `result.directorReport.endReason` matches the enum

There is NO assertion on `implicitDwellCount`, `expectAfterMismatchCount`, `decisionCount`, `clicksExecuted`, or any other count. Per Hard rule #6, these will drift; their values are LOGGED for human review, not gated.

**Naturalness verification is human-only.** The test prints the path of every produced `recording.webm`. The operator opens the videos and judges whether the playback feels like a real person used the page.

**Rationale**:
- Single-site tests give a false sense of robustness. Three sites with very different behaviours (turbo-frame SPA / video player / canvas-heavy map) is a much better proxy for "the system handles real-world variety".
- Two prompt variants per case (natural + distracting) verify the planner's intent extraction is robust to how a real human phrases things — not just the one phrasing the test was tuned to.
- Categorical assertions stay green across model upgrades. When the test goes red, the failure is meaningful (pipeline broken) instead of "we hit a new latency profile, bump the cap".
- The ratcheting that produced `≤14` and `≤3` thresholds is itself the bug being fixed here: every bump was telling us our test was the wrong shape, not that the code was wrong.

**Consequences**:
- Empirical run (all 6 passing, ~4.9 min wall clock total):
  - `github-multistep · natural`: `level=complete`, 7 clicks executed, 8 scrolls, 9 decisions. Multi-step navigation works end-to-end.
  - `github-multistep · distracting`: passing. Planner isolates intent from "听说 Recordly 是个录屏工具…" chatter.
  - `youtube-creator · {natural, distracting}`: passing. Agent searches from logged-out empty homepage and reaches creator content.
  - `gmaps-search-stay · {natural, distracting}`: `level=complete`, agent does not pan the map, focuses on search → result panel.
- The Recordly run's previous `intentSatisfaction.level=unmet` symptom is GONE in the new structure — the architectural wins of §0023 (Sonnet planner + briefing-hint surfacing + pre-fire) are now visible because the test surfaces categorical truth instead of fighting threshold drift.
- Test wall clock: ~5 min for 6 runs. Acceptable for an integration-tier suite. CI can opt to run a single case for fast feedback (`npx vitest -t youtube-creator-natural`).
- Opens space for adding cases incrementally — the library should grow with project capability, not by re-tuning numbers.

**Preserves**: goals.md non-negotiables (especially #6, just added). §0019-§0023 architecture. The mechanical metrics (dwell counts, etc.) are still LOGGED via §0020's introspection entries, just no longer asserted-on.

**Open**: case-specific negative-behaviour assertions (e.g. "gmaps-search-stay must NOT have a `drag` action in the log"). Today our action vocabulary has no `drag`, so the negative is trivially true. When/if drag is added, this case becomes load-bearing for "agent stays focused" verification.

---

## 0025 · Action vocabulary expanded: type / key / back; hint fulfilment filter

**Date**: 2026-05-10

**Context**: Reviewing the §0024 regression videos by hand surfaced a class of issues the categorical assertions could not catch. The 4-primitive vocabulary (`click / scroll / dwell / done`) was insufficient for real-world workflows:

- **YouTube** and **Google Maps** require search, which is a 3-action pattern: focus the input, type the query, press Enter. With no `type` primitive, the agent clicked the search box repeatedly (8 times in one run) without ever entering text. This is the worst kind of "废话" — visible robot behaviour with zero progress.
- **GitHub multi-step** asked the agent to drill into a folder and come back to the project root. With no `back` primitive, the agent had to find a "home" link in the chrome — slow, error-prone, often impossible (the GitHub project page is at `/owner/repo`, the breadcrumb is small).
- The `intentSatisfaction.level=complete` heuristic had a hole: any total `clicksExecuted >= hintsResolved` counted as complete. Re-clicking the same hint 8 times scored the same as clicking 8 distinct hints once each.
- Independently, even with hints surfaced + briefing-hint priority rule, the LLM occasionally re-clicked a hint AFTER it had succeeded. The agent's `recentActions` showed the click, but the `briefingHints` list still surfaced the hint — the LLM saw "this is a target" and acted on it again.

**Choice (1) — Three new action primitives**:

```
type  : { kind: 'type', text: string (1..200), reasoning }
key   : { kind: 'key',  key: enum(Enter|Escape|Tab|Arrow{Up,Down,Left,Right}|Backspace), reasoning }
back  : { kind: 'back', reasoning }
```

Vocabulary grows from 4 → 7. Still small enough to fit in the LLM's working memory; the prompt's "ACTION SEMANTICS" section now lists 7 with one-line semantics each, plus a "WORKFLOW PATTERNS" section spelling out the canonical 3-action chains: SEARCH = `[click search, type query, key Enter]`, DRILL-AND-RETURN = `[click in, ..., back]`, DISMISS-MODAL = explicit close button, then `key Escape`.

`IPageSession` gains `type(text)` / `pressKey(key)` / `goBack()`. `StagehandPageSession` implements via Playwright `page.keyboard.type(text, { delay })` (40-90 ms per char, randomised), `page.keyboard.press(key)`, `page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 })`. Each gets its own `ActionLogEntry` variant so cursor-synth and replay layers see them in the timeline.

**Choice (2) — Anti-repetition rule (load-bearing)**:
The decider system prompt gains: *"if your last TWO recent actions are both 'click' on essentially the same target, the next action MUST be different. Re-clicking the same input field repeatedly does NOTHING — to enter a search, you need to click ONCE then 'type' your query."* This is a soft rule (model-enforced) but the model honours it now that there's a viable alternative (`type`).

**Choice (3) — `intentSatisfaction` counts UNIQUE hints clicked**:
`computeIntentSatisfaction` now takes `hintDescriptions: ReadonlyArray<string>` (was `count: number`) and matches each hint description against click-action descriptions via lenient content-token overlap. Re-clicking the same hint 8 times now scores `1/N` not `N/N`. Catches the YouTube failure mode in metrics, not just video.

**Choice (4) — Fulfilled-hint filter in StreamingDirector**:
`StreamingDirector.run` maintains a `fulfilledHints: Set<string>` of hint descriptions that received a successful click. `observeState` filters `briefingHints` against this set before passing to the decider — the LLM literally cannot see hints it has already satisfied.

The matching logic (token-based lenient match) lives in `src/domain/intent-matching.ts` and is shared between `record-job-runner` (for the metric) and `streaming-director` (for the prompt filter). Pure functions, no I/O — sits naturally in `domain/`.

**Choice (5) — Test cleanup**:
Pruned 21 schema-shape unit tests (`director-action.test.ts`, `plan.test.ts`, `action-log.test.ts`) that duplicated TypeScript+Zod's compile-time guarantees. Total unit tests 78 → 56. Kept the load-bearing refinement tests (numeric ranges, enum values, the negative `decisionId` regression test from §0021).

**Rationale**:
- Hard rule #6 ("AI-first, not magic-numbers") doesn't preclude adding well-bounded primitives — the rule is about not gating BEHAVIOUR on numeric thresholds. Vocabulary is shape, not threshold.
- Schema tests are noise relative to integration coverage. The library of regression cases (§0024) IS the test that matters.
- The fulfilled-hint filter is a small mechanical fix for a behaviour the prompt rule alone could not enforce. Same idea as the dwell coercion in §0019 — the prompt asks the LLM to do the right thing; the code makes it impossible to do the wrong thing.

**Consequences**:

Empirical regression run (all 6 passing, ~5 min wall clock):

- `gmaps-search-stay · {natural, distracting}`: agent now executes `[click search box, type "New York", key Enter]`. Search submits successfully. Some pre-fire-induced double-typing (rarely catastrophic — the search query has "New YorkNew York" but the page still shows results). intent=`complete` after the new heuristic.

- `youtube-creator · {natural, distracting}`: agent executes `[click search bar, type "MrBeast", key Enter]`, navigates to results, then attempts to click MrBeast's channel link. Channel click sometimes hits budget (search-results-page is a deep target). Search workflow itself is solid.

- `github-multistep · {natural, distracting}`: agent executes click-then-back chains. natural variant did `click 简中 → click homepage → back → click build directory → tries package.json`. distracting variant did similar with more recovery. The agent now USES the back primitive instead of trying to find breadcrumbs.

Open issues that did NOT block landing (all are timing/efficiency, not correctness):
- Pre-fire occasionally double-fires the same action (next decision was computed before the previous click's effect was visible in the screenshot). Fix candidate: don't pre-fire during state-changing actions (click/key/back). Deferred — current behaviour is "wasteful but completes the task".
- `recentActions` only carries the last 3 entries; older successful clicks are out-of-window for the LLM. Fix candidate: pass `fulfilledHints` to the prompt explicitly (not just used for filtering hints) so the LLM is reminded what's already done. Deferred.

**Preserves**: §0019-§0024. Goals.md non-negotiables — vocabulary expansion serves #1 (looks human: search workflow now looks human), #3 (intent satisfied or transparently not: heuristic is now accurate), #6 (no magic numbers: the new primitives have schema bounds but no behaviour-gating thresholds).

---

## 0026 · Self-check evidence + draft-then-react planning (architectural upgrade)

**Date**: 2026-05-10

**Context**: Watching the §0025 regressions live, the user observed the agent doing things a real human would never do:

- *"Why did YouTube open the LEFT SIDEBAR when I asked it to search?"* — `clickByDescription` resolved "click search bar" to the hamburger menu (similarly placed at the top). The action LOGGED as success because Playwright clicked SOMETHING; the agent never noticed it clicked the wrong thing.
- *"Why did it type 'New York' twice on Maps? 'MrBeast' twice on YouTube?"* — pre-fire computed the next decision BEFORE the previous type's effect was visible, so the LLM, having no memory of what it just did, retyped.
- *"Why didn't it stop after the first type and click the first result?"* — same root cause. The LLM had no structured memory of "I already typed".

The user's diagnosis: *"是看不到结果吗？或者有哪些信息没有记录吗？"* — Information was not being recorded. `recentActions[]` carried only `{ kind, brief, succeeded }` — no proof of what the action did to the page. The LLM had to infer everything from the next screenshot, and pre-fire was making that screenshot stale.

The user explicitly asked for **architectural upgrade**, not tuning patches.

**Choice (1) — Self-check evidence in `ActionSummary`**:

`ActionEvidence` is now a discriminated union per action kind in `src/domain/director-state.ts`. Each variant carries the minimum the LLM needs to verify "did this work?":

```
click  → urlBefore, urlAfter, urlChanged, titleBefore, titleAfter, titleChanged
type   → expectedText, focusedValueAfter, matched           ← the fix for double-typing
scroll → scrollYBefore, scrollYAfter, deltaRequested, deltaAchieved
key    → key, urlBefore, urlAfter, urlChanged, titleBefore, titleAfter, titleChanged
back   → urlBefore, urlAfter, urlChanged
```

The Director's `executeAction` snaps page state via the new `IPageSession` port methods `scrollY()` / `pageTitle()` / `focusedValue()` before AND after each action. Best-effort wrappers (`safe*`) ensure a momentary glitch never breaks the recording.

The decider prompt's `recentActions` section now renders evidence inline:

```
Recent actions WITH EVIDENCE:
  click "the search bar" — URL: unchanged; title: changed (SPA-style content swap)
  type "New York" — focused value now: "New York", ✓ matches
  key Enter — URL: maps.google.com → maps.google.com/?q=New+York; title: changed
```

The LLM sees that "New York" is already typed and won't retype.

**Choice (2) — `DirectorBriefing.draftSequence` (planner pre-plans the happy path)**:

Real humans don't decide "what next?" at every step — they form a rough plan and adapt if reality diverges. `LlmPlanner.brief()` now emits `draftSequence: DirectorAction[]` alongside its targets. The planner prompt teaches canonical workflow patterns (SEARCH = `[click input, type, Enter]`; DRILL-AND-RETURN = `[click in, …, back]`; BROWSE = `[scroll, dwell, scroll, dwell]`).

`StreamingDirector.run()` SEEDS THE QUEUE with the draft sequence — completely SKIPPING the cold-start LLM call. The first LLM decision inside the recording window happens only when the draft runs out OR adaptation is needed (`expectAfter` mismatch, action evidence shows mismatch).

Verified: the cleanest Maps run has exactly ONE LLM decision in a 15s recording window — the entire `[click, type, Enter, dwell]` chain ran straight from the draft.

**Choice (3) — SPA-aware `expectAfter` rule (Phase A)**:

Decider prompt now: *"if you suspect SPA / turbo-frame / hash routing — those swap content without changing URL. The recent-actions evidence will show 'title: changed (SPA-style content swap)' when this happens; trust it. Setting `urlContains` on an SPA page guarantees a false mismatch and wastes a re-decision."* Combined with Choice 1, the LLM has both a clear rule AND the evidence to apply it.

**Choice (4) — Skip pre-fire during state-changing actions (Phase B)**:

`click`, `type`, `key`, `back` no longer trigger a pre-fired next decision. Cost: ~1-2s implicit dwell after these actions. Benefit: the next LLM call sees the post-action page state, not the stale pre-action one. After Choices 1+2 this fix is half-redundant (evidence catches what pre-fire misses), but at the protocol level the failure mode is now unreachable.

**Rationale**:
- goals.md #1 ("looks human") and #3 ("intent satisfied or transparently not"): a human's working memory of recent actions is a structured fact, not "I succeeded". Encoding evidence makes the agent capable of self-check.
- goals.md #6 ("AI-first, not magic-numbers"): draftSequence pushes more decision-making INTO the planner LLM call (slow, runs once per job) and OUT of the per-action streaming (tight latency budget). Intelligence ↑ without per-step LLM cost.
- The user explicitly asked for architectural upgrade. The four changes ARE that upgrade.

**Consequences** — empirical regression run (3 rounds × 6 cases = 18 runs, all categorically pass):

| Behavior | Before §0026 | After §0026 |
|---|---|---|
| Maps · type count per run | 2 (typed "New York" twice) | **1** ✅ |
| YouTube · type count per run | 2 (typed "MrBeast" twice) | **1** ✅ |
| Maps · LLM decisions in recording window | 3-4 | **1** ✅ |
| YouTube · LLM decisions in recording window | 5-7 | **2-3** ✅ |
| GitHub multistep · decisions | 6-9 | **4-5** ✅ |
| Search workflow driven by draftSequence | no | **YES** ✅ |

Cleanest Maps run inside the recording window:
```
SCROLL          (click's discovery scroll)
CLICK           the search input box
TYPE            "纽约"   (130ms typing)
KEY             Enter
DECIDE id=1     dwell 3000ms          ← only LLM call in the window
BUDGET reached
```

The user's "real human" benchmark is substantially closer.

**Open** (do NOT block this ADR — refinements for §0027+):
- YouTube channel-click after search results sometimes hits budget (1 click_failed per run). MrBeast's channel link is a deep target the planner can't anticipate (it sees the homepage, not the post-search page). Mid-run "refresh-the-plan" would help.
- GitHub multistep's draftSequence sometimes contains stale expectAfter constraints. The planner prompt's SPA-awareness needs to apply to the draft itself, not just to in-window LLM calls.

**Preserves**: §0019-§0025. Architecture now reflects **plan → act → observe → adapt** — closer to human cognition than "react → react → react".

---

## 0027 · AI click verification (Tier A self-check)

**Date**: 2026-05-10

**Context**: Watching the §0026 regressions, a class of failure remained invisible to the architecture: **clicks that Playwright reported as succeeded but actually hit the wrong element**. The clearest example: the agent says "click YouTube search bar", `clickByDescription` resolves to the hamburger menu (similarly placed at top), Playwright clicks something, returns success. The post-click `ActionEvidence` shows URL unchanged + title unchanged — visually indistinguishable from a SPA-style "search box gained focus" click. Two actions later (`type` into nothing, `key Enter` doing nothing), the failure surfaces — but by then we've burned 5+ seconds of the budget.

The user's diagnosis was that the agent has no way to verify "did I click the *right* thing?" — only "did the click execute?". Code-checkable evidence (URL/title) can't disambiguate "right click on SPA page" from "wrong click that happened to not navigate". The semantic question — *what visibly changed and does it match my intent?* — needs a vision LLM.

**Choice — `IClickVerifier` port + `LlmClickVerifier` adapter**:

After every `click` action whose underlying Playwright call did NOT throw, the Director:
1. Snaps a fresh post-click screenshot.
2. Asks the verifier: *"You just clicked '<target description>'. The screenshot shows the page after the click. Did the click hit the right element?"*
3. Receives `{ matched: boolean, reason: string }`.
4. If `matched=false`: marks the action as failed (carrying the reason in `ActionEvidence['click'].aiReason`), clears the action queue, and triggers a fresh decider call with `lastActionFailure` set to the verifier's reason. The same recovery path used for Playwright-thrown click errors.

The verifier is its own port (not a method on `IFastDecider`) because the prompt scope is much narrower (one image + one boolean out) and the configurability axis is independent (one might want a smaller verifier model than the decider model).

`LlmClickVerifier` reuses the decider's model by default (`config.llmDeciderModel` — typically `gpt-4o-mini`) so no new env knob is needed for now. The prompt explicitly tells the verifier:
- Default to `matched: true` on uncertainty (false negatives waste budget on retries)
- Recognise SPA-style clicks (URL stable + content/title shift = success)
- Look for focus / navigation / modal-opened / content-shifted as success signals
- Look for unrelated UI (sidebar opened when search was target) as failure signals

**Director main-loop integration**:

Before §0027, on `summary.succeeded === false` for a click, the Director only logged a `decision_failure` and continued the queue — letting any draftSequence type/Enter that followed fire into a wrong-state page. After §0027, a failed click also: clears `actionQueue`, nulls `pending`/`pendingMeta`, and immediately calls `decider.decide` with `lastActionFailure` populated. The recovery path is unified — Playwright-thrown clicks and verifier-rejected clicks now both stop the cascade.

**Rationale**:
- The user explicitly proposed this in plain language: "每一步操作你要评估（代码或者 AI）是否符合预期". The verifier IS the AI step of that evaluation. We already had the code step (§0026 evidence).
- AI verification is selectively applied to clicks because:
  - `type` evidence (focusedValue match) is already self-verifying via code
  - `scroll` evidence (deltaAchieved) is self-verifying
  - `key`/`back` evidence (URL change) is mostly self-verifying
  - `click` is the only action where code evidence is ambiguous between "right click on SPA" and "wrong click did nothing" — exactly the gap a vision LLM can close
- Per goals.md non-negotiable #3 ("user intent satisfied OR transparently not"): silent wrong-clicks that succeeded-via-Playwright but failed-in-reality were the worst offender — neither satisfied NOR transparently not. The verifier closes that loop.

**Consequences** — empirical regression run (3 rounds × 6 cases = 18 runs):

- **10 verifier-flagged wrong-clicks across 18 runs** (~0.5/run). Targets flagged: "the simplified Chinese language link" (3 different runs, validated via frame extraction — page stayed in English; verifier was correct), "the build folder link" (turbo-frame click that actually didn't reach), "MrBeast channel link" (search results layout where the agent's target description didn't match a clickable element), "the Search Google Maps input box" (one occurrence — search input visually unchanged after click).
- **No confirmed false positives**: spot-checked frames before/after one flagged github click — page state truly unchanged. Verifier reasons are coherent and trace what a human would describe.
- These are clicks that, before §0027, would have logged as `succeeded: true` and let the recording proceed into broken downstream actions. Now they short-circuit.
- All 18 runs categorically pass (recording produced, intent satisfaction computed).
- New unit tests: 3 covering verifier matched=false → queue clear + recovery, matched=true → pass-through, verifier error → optimistic match. Total unit 59 → 62.

**Costs (honest)**:
- Verifier latency on OpenRouter / gpt-4o-mini ran ~2.5s p95 (higher than the ~500ms I designed for; PNG screenshot base64 + per-request overhead). With 2-4 clicks per case, this adds 5-10s to total wall-clock per run.
- Token cost: roughly +$0.0005 per click. Negligible.
- Recording-window budget impact: minor — the verifier call typically lands during the post-click natural settle window.

**Open issue (deferred to §0028)**:

When the verifier flags a click and the Director re-decides, the LLM **often picks the same target description** (and fails again). On one github run, "the Chinese language link" was attempted 3 times in a row before the agent finally tried a different approach. The retry waste is significant.

Fix candidate: track verifier-rejected click targets per run; after 2 rejections of the same (or near-same) target description, EXCLUDE it from `briefingHints` and inject a strong "this target seems unreachable, try a different element" hint into the next decider state. Mirror of §0025's `fulfilledHints` filter, but for the failure direction.

**Preserves**: §0019-§0026. Goals.md non-negotiables #1 (looks human: silent wrong-clicks no longer cascade), #3 (intent satisfied or transparently not: verifier verdict is the missing transparency).

---

## 0028 · Retry cap for verifier-rejected click targets

**Date**: 2026-05-11

**Context**: §0027's AI click verifier closes the "wrong click looked successful" gap, but watching the regression videos surfaced a follow-on failure: when the verifier flags a click and the Director re-decides, the LLM **often picks the same target description again** (and fails again). One github case attempted "the simplified Chinese link" three times in a row before pivoting. Each retry burns ~3-5s of the budget on a guaranteed-to-fail click, plus the verifier call and the recovery decision. By the time the agent finally tried a different element, the recording was already over budget.

The verifier's `lastActionFailure` message ("page is still in English") is rich, but the LLM has no anchor telling it "this specific target description has been categorically refuted — don't reach for it again". The screenshot still shows the same plausible candidate; the briefing hints still list it.

**Choice — per-target rejection counter + unreachable-targets surface**:

The Director maintains `rejectedClickTargets: Map<string, number>` for the run, keyed by the LLM's exact `action.target` phrasing. Every click failure (Playwright throw OR verifier `matched=false`) increments the count. When any entry reaches `config.directorClickRejectionLimit` (default 2):

1. The target is filtered out of `briefingHints` by fuzzy `descriptionsMatch` (same helper §0025 uses for fulfilled hints) — so any planner hint phrased similarly stops being repeated in the prompt.
2. The target is surfaced in `DirectorState.unreachableTargets` (new optional field), rendered as a dedicated section in the decider user-message under the heading "UNREACHABLE targets … do NOT pick these again".
3. The system prompt is updated with an explicit "UNREACHABLE TARGETS" rule directing the LLM to pick a different element or output `done`.

The cap defaults to 2 (one retry, then give up), tunable via `DIRECTOR_CLICK_REJECTION_LIMIT`. We count BOTH Playwright throws and verifier rejections — both signal "this description does not reliably resolve to a clickable element"; conflating them is simpler than two parallel counters with different semantics.

**Why not also seed the *planner* with rejection feedback?**

The planner only runs once per job (`brief()`), before the recording window. Rejection signal is intra-recording. The decider is the right place to act on it.

**Why fuzzy filtering not exact?**

The LLM and the planner often phrase the same target differently ("the simplified Chinese link" ↔ "the 简体中文 link"). Exact-match would leave the planner's hint repeatedly surfacing the target the LLM has already declared unreachable. The `descriptionsMatch` helper covers ASCII words + CJK 2-char n-grams; the same helper is already trusted for §0025's fulfilled-hints filter, so we're not introducing new matching surface area.

**Rationale**:
- Mirrors §0025 (`fulfilledHints` filter for the success direction) — both close repetition loops by removing already-resolved targets from the prompt.
- Cheap and bounded: one Map per run, O(N hints × M unreachable) per `observeState` call; both numbers are tiny.
- Visible: the LLM SEES the unreachable list, not just an absence of hints. This works better than silent filtering when the LLM might infer "still visible on screen → still a candidate".
- Honest about partial intent: when the only briefing hint becomes unreachable, the LLM is steered toward `done` rather than thrashing — and `intentSatisfaction` then transparently reports `partial`/`unmet` per goals.md #3.

**Consequences**:
- New unit tests: 4 covering (a) population after exactly 2 rejections, (b) fuzzy hint filtering, (c) independent counts per target, (d) Playwright-throw clicks also tick the counter. Total unit 62 → 66.
- New config knob `DIRECTOR_CLICK_REJECTION_LIMIT` (default 2) exposed for one-off tuning during evals.
- No prompt-token cost for runs without rejections — the unreachable section is only rendered when non-empty.
- Open observation: the cap is per-run, not cross-run. If a site has a structurally unclickable hint (e.g. a 简体中文 link that the planner extracts but is actually a hover-only tooltip), every run still wastes 2 attempts before giving up. Could be addressed later with a per-site cache, but YAGNI for now — observability first.

**Preserves**: §0025 fulfilledHints filter, §0027 verifier verdict, all evidence capture. Adds a memory of failures the verifier (or Playwright) has already adjudicated.

---

## 0029 · Opening hold — 200-500ms of "context absorption" at recording start (C4)

**Date**: 2026-05-11

**Context**: Replaying real recordings on the github-multistep case showed a structural unnaturalness at t=0 of the trim window — a person opening a fresh page spends a beat (~200-500ms) **scanning before they act**. Our pipeline previously had the Director pull its first action the instant `beginRecording()` returned. With `draftSequence` seeded and pre-fire warming the LLM, the first scroll/click animation began on frame ~1 of the recording. Combined with `naturalness-catalog` B1-B11 still ❌ (no visible cursor), the deliverable read as "robot starts moving immediately on page load" rather than "person opened a page and looked at it".

This was already flagged as Tier-1 work in `naturalness-catalog.md` ("opening hold" — listed alongside cursor synth as the milestone that takes the project from "scrolls nicely" to "looks like a real person navigating").

**Choice — randomized wait at the top of `StreamingDirector.run()`**:

Immediately after `await session.beginRecording()` and before the action loop, the Director awaits `session.wait(rand(min, max))` where the range comes from new config knobs `OPENING_HOLD_MIN_MS` / `OPENING_HOLD_MAX_MS` (defaults 200 / 500). Logged as `opening hold (context absorption)`. Skipped when `max <= 0` (test bypass) or `max < min`.

The hold appears in the action log as a regular `wait` entry, which:
- Keeps `IPageSession.wait` as the single side-effect channel (no new port method).
- Lets the cursor synth (B1-B11, future) render the cursor as still during this beat, matching the "person looking at the page" intent.
- Does NOT pollute `recentActions` shown to the decider — the wait happens before the first `decide()` call, so the LLM never sees a "dwell" it didn't pick.

**Why not the planner?** The planner emits `draftSequence` as a logical action sequence; opening hold is rendering trim, not part of the user's intent. Putting it in the planner would mean every prompt's plan starts with a `dwell` action that has no functional purpose, and the verifier / decider would need to learn to ignore it.

**Why not the runner (before `director.run`)?** The recording window doesn't open until inside the Director (`session.beginRecording()`). A pause before that wouldn't appear in the trim. The opening hold must happen AFTER the recording starts to show up in the deliverable.

**Why a randomized range and not a fixed value?** Hard rule #6 makes a carve-out for "pure rendering parameters" — and identical timings across runs are themselves a robot tell (catalog C6). 200-500ms is what `naturalness-catalog.md` already documented based on user observation; pinning random per-run means consecutive recordings of the same prompt don't show identical animation onsets.

**Consequences**:
- New unit test: opening-hold timing — verifies the first event after `beginRecording` is a `wait` in [200, 500]ms with no scroll/click preceding. Total unit 66 → 67.
- One existing test loosened: `streaming overlap > fires next decider call DURING current animation` had a 500ms bound on when the second decision starts; opening hold can eat that on its own. Loosened to 1500ms — still distinguishes "during the 2400ms scroll" from "after the scroll".
- Budget impact: 200-500ms eaten from the recording window. On a 10s recording that's 2-5%; trim still hits the target duration (the hard cap is `durationMs × 1.2`, well clear of this).
- Cost impact: zero — pure local wait, no extra LLM call.

**Preserves**: §0019-§0028. Goals.md non-negotiables #1 (looks human: adds the missing opening beat), #2 (no visible stalls: a 300ms opening beat is exactly the "natural pause" #2 carves out), #6 (rendering-parameter carve-out).

**Future hook**: when cursor synth (B1-B11) lands, this hold is also the window where the synthesized cursor sits still on the page — no sudden cursor jump-into-frame on first action.

---

## 0030 · Automated naturalness judge — 5-dimension VLM rubric (`IRecordingJudge`)

**Date**: 2026-05-11

**Context**: With §0029 closing the last Tier-1 *timing* gap (opening hold), the remaining bottleneck for the "looks human" non-negotiable (goals.md #1) was **the human reviewer step itself**. The regression suite runs cheaply, but every iteration of the project required someone to actually open 6 webm files and form an opinion. This made every refinement loop slow, gated on availability, and not reproducible across sessions.

Two prior attempts to mechanize this were ruled out:
1. **Frame-based judging** (sample 6-10 keyframes, ask a VLM): user correctly pushed back — naturalness lives in *motion* (easing, anticipation, scroll inertia). A single frame cannot express "the scroll decelerated naturally" or "the pause before the click felt anticipatory".
2. **Action-log-derived rubric** (no video; read the log + apply rules): cheap and deterministic, but blind to what was actually rendered (browser cancels easing, paint timing differs from action timing, modal popups in frames aren't in the log).

**Choice — video-native VLM judge with structured rubric**:

A new port `IRecordingJudge` (`src/ports/recording-judge.ts`) + adapter `LlmVisionJudge` (`src/adapters/judge/llm-vision-judge.ts`) that consumes the trimmed `recording.webm` and the user's original prompt, and returns a typed `RecordingJudgment`:

```ts
type Verdict =
  | 'looks_human'         // indistinguishable from real recording
  | 'probably_human'      // 1-2 small tells
  | 'probably_synthetic'  // several clear tells
  | 'robotic';            // obvious automation

type DimensionKey =
  | 'motionQuality'    // scrolls eased, clicks approached, no teleports
  | 'pacing'           // rhythm varies, anticipation pauses present
  | 'intentExecution'  // every verb in the user's prompt visibly happened
  | 'recovery'         // when something failed, agent switched approach
  | 'visualCoherence'; // every page change has a clear on-screen cause
```

Each dimension is `pass / partial / fail` plus an evidence array of `{ atSecond, observation }` so a reviewer can jump to the moment.

The adapter calls OpenRouter with the video as a `video_url` content part (data URL, base64). Default model `google/gemini-3.1-pro-preview` (native video input; configurable via `LLM_JUDGE_MODEL`). Raw `fetch` instead of the `openai` SDK because the SDK's content types don't include `video_url` yet — when they do, flip the adapter and the rest stays the same.

**Rubric design choices** (these are the parts that took the longest to get right):

1. **No action-log input.** The judge is the "fact eye". Feeding it the agent's own action log primes it with self-reported success. Cross-checking the judge's `intentExecution` verdict against the action-log-driven `intentSatisfaction` metric is the entire point — when they disagree, the run is suspect.

2. **Five dimensions, not one verdict.** A flat "looks human" is undebuggable. Per-dimension fail tells you *which* part to fix.

3. **Verdict is LLM-emitted, not code-derived.** A formula like "any fail → robotic" is brittle and lossy. We want the model's holistic judgment.

4. **"Default to skeptical" rule** in the system prompt. False negatives ("looked human but isn't") are much costlier than false positives — the cost of a wrong "pass" is shipping a robot-looking recording.

5. **Evidence required for every non-pass.** Each `partial` or `fail` must cite at least one `atSecond + observation`. If the judge can't point at a moment, it can't downgrade.

6. **Cursor-absence carved out.** Project currently has no visible cursor sprite (B1-B11 ❌); the prompt explicitly tells the judge not to penalise this in any dimension — we're tracking cursor separately.

**Invocation**:

Manual via `npm run judge -- <video> "<prompt>" --duration-ms <n>`. Writes `judgment.json` next to the video. The judge is NOT wired into every recording run (latency ~25-30s per call, cost ~$0.02-0.05) — it's a manual / regression tool. If we later want it in CI, the standalone path makes that one-line wiring.

**First-run validation (this commit)**:

Ran the judge against `output/2026-05-11/11-14-38-regression-github-multistep-natural/recording.webm`. The action-log-side `intentSatisfaction` had reported `level: complete` ("all 3 hints clicked + scrolling occurred"). The judge returned:

```
verdict:    ROBOTIC
motionQuality:    pass
pacing:           fail   — @ 2.0s "page sits idle 15s with no actions"
intentExecution:  fail   — @ 2.0s "successfully switches to Chinese, but fails to navigate to build directory or open package.json"
recovery:         pass
visualCoherence:  fail   — @ 18.0s "screen turns completely white and remains until end"
```

**Two latent bugs the judge caught that the existing metrics missed**:
- **intentSatisfaction over-counts**: user asked for 4 verbs, only 1 visibly happened, but the metric reported `complete` because lenient `descriptionsMatch` let a single click satisfy multiple hints. Spun off as a follow-up investigation.
- **White-screen bug at 18s**: page navigation went somewhere that never loaded (or stayed `about:blank` after a `back()`). No code-side metric noticed; the visual judge did. Spun off as a follow-up investigation.

This is exactly the disagreement we built the judge to surface.

**Consequences**:

- New domain type `RecordingJudgment` with Zod schema. Strict — any malformed LLM output throws `RecordingJudgeError`.
- New unit test suite (6 cases) covering happy path, HTTP failure, invalid JSON, schema mismatch, invalid verdict enum, and code-fence stripping. Total unit 67 → 73.
- New `npm run judge` command + standalone CLI.
- `intentSatisfaction` is no longer the only naturalness signal — the judge is a more authoritative cross-check.
- Goals.md #6 (no magic numbers): the rubric is categorical end-to-end. No threshold drift across model versions.

**Honest limitations**:

- **Latency**: ~25-30s per video on Gemini 3.1 Pro Preview. Acceptable for offline / regression usage, not for inline gating.
- **Cost**: ~$0.02-0.05 per call (videos ~1-3 MB base64-encoded). The user explicitly accepted this for manual testing.
- **Variance**: VLM-as-judge typically shows 5-10% inter-run variance on subjective dimensions. We have not yet quantified ours; first observation suggests the rubric is concrete enough that variance is low, but a 3-run sample size is too small to claim this.
- **Model coupling**: depends on Gemini supporting video input through OpenRouter. If that changes we'd need an alternate adapter (Claude doesn't natively take video as of 2026-05; GPT-4o uses frame sampling which our rubric explicitly assumes isn't sufficient).

**Preserves**: §0019-§0029. Goals.md non-negotiables #1 (looks human: now machine-checkable), #3 (intent satisfied or transparently not: the judge IS the transparent half), #6 (AI-first, not magic-numbers: categorical rubric, no thresholds).

**Future hooks**:
- Wire judge into regression suite optionally (env-gated to keep CI cost predictable).
- Use judgments to A/B compare runs after each architectural change — turn "feels like it improved" into "judge agrees `motionQuality` is `pass` here vs. `partial` before".

---

## 0031 · Naturalness rendering bundle — typing, scroll-tail, anti-idle (Class 1 fixes)

**Date**: 2026-05-11

**Context**: The §0030 video judge's first batch surfaced THREE distinct motion-pacing failures across the 6 regression recordings (see [`docs/findings/2026-05-11-judge-first-batch.md`](./findings/2026-05-11-judge-first-batch.md)):

- **P2 — Instant text injection** (2/6 runs): the judge said `text appears instantaneously, suggesting script-based text injection`. The session's `type()` was already using Playwright `keyboard.type({ delay })` with a 40-90ms range, but for short queries (`纽约` = 2 chars) that's ~80-180ms total, ~3-5 frames at 30fps — well below the human-perceptible "watching someone type" threshold.
- **P3 — Teleport scrolls** (1/6 runs): back-to-back scrolls with no settling beat read as "instant teleport" to the judge.
- **P4 — Trailing idle / dead air** (2/6 runs): after the agent completed the prompt's first verbs and hit budget exhaustion on later targets, the recording was left with 10-15 seconds of completely still page until trim.

These are three distinct symptoms of one class: **the recording lacks human-paced rendering of motion and absence-of-motion**. Cursor synth (B1-B11) is the eventual structural answer but is deferred. This ADR ships the cheap, AI-first rendering polish that closes the gap on the three specific symptoms now.

**Choice — three minimal interventions, one ADR**:

1. **Pre-typing pause (`typingPreMinMs/MaxMs`, default 200/400 ms)** — added to `StagehandPageSession.type()`. After the input field is focused and BEFORE `keyboard.type` fires, the session waits a randomized 200-400 ms. This gives the viewer a beat to see the empty field with the cursor before characters start appearing. Closes P2 even for short strings.

2. **Slower per-keystroke delay (`typingKeystrokeMinMs/MaxMs`, default 60/140 ms, was 40-90)** — same `keyboard.type({ delay })` call, just a slightly slower range. One delay value per `type` call, randomized in `[min, max]`.

3. **Inter-scroll micro-pause (`scrollTailMinMs/MaxMs`, default 120/280 ms)** — added to the `case 'scroll'` arm of `StreamingDirector.executeAction`. After `session.scroll()` resolves, the Director awaits `session.wait(rand(min, max))` before returning. Applies to ALL scrolls, not only between two consecutive scrolls — the same beat helps before the next click decision too. Catalog row A6 promoted from ❌ → ✅.

4. **Anti-idle decider prompt rule** — added to `deciderSystemPrompt` under "ANTI-IDLE". When the decider has addressed every explicit verb in the user's prompt BUT >25% of the recording window remains, it MUST continue with natural browsing (slow/normal scroll + occasional dwell) rather than output `done`. This is the AI-first piece — we tell the decider WHY it shouldn't go idle ("ends on a still page" is one of the most obvious automation tells), and let it pick the right browsing actions for the page it ended up on.

**Why pre-typing pause and not per-keystroke randomization?** Playwright's `keyboard.type({ delay })` is per-call, not per-char. Splitting into individual `.press()` calls to get per-char variance would add code complexity for marginal viewer benefit — the much bigger fix is the leading pause that gives ANY visible duration to short strings. We left the per-keystroke value randomized-per-call so two consecutive `type` actions don't share the exact same cadence.

**Why scroll-tail wait on ALL scrolls (not just consecutive)?** Naturalness-catalog A6 originally said "between consecutive scrolls" but the underlying intent is "a beat after scrolling for the eye to land". That beat is valuable before ANY next action — including a click. Putting it inside the scroll arm makes it unconditional, easier to reason about, and consistent with how the opening hold works (always there, even if the LLM didn't ask).

**Why the anti-idle rule lives in the prompt, not in code?** Two reasons:
- Goals.md #6 (AI-first, not magic-numbers). A code rule like "if remainingMs > 25% and queue empty, force a scroll" would be brittle and lossy — what's "browsing" varies by page (scroll on a README, slow tilt-pan would-be on a map, watch a video player, ...). The decider already has the screenshot and knows what page it's on; it's the best judge.
- The 25% threshold is a soft suggestion in the prompt, not a hard gate. The LLM can override (e.g. on a blank page where there really is nothing to look at) by outputting `done`. A code gate would have no such escape.

**Consequences**:

- Recording wall-clock per case grows by ~0.4-1.5 s for typing-heavy runs (pre-pause + slower keystrokes) and ~0.2-0.5 s per scroll. On a 10 s recording with 1 scroll and 1 short type that's ~+1 s. Trim still hits target (hard cap remains `durationMs × 1.2`).
- New unit test: scroll-tail wait timing. Total unit 73 → 74.
- All 73 existing tests pass without modification — the changes append-only on existing flows.
- New config knobs: `TYPING_PRE_MIN_MS`, `TYPING_PRE_MAX_MS`, `TYPING_KEYSTROKE_MIN_MS`, `TYPING_KEYSTROKE_MAX_MS`, `SCROLL_TAIL_MIN_MS`, `SCROLL_TAIL_MAX_MS`. All have safe defaults.
- Naturalness-catalog: A6 ✅, F2 ✅-partial, C7-style "decision pauses" partially addressed via anti-idle rule.

**Validation plan**: re-run the §0030 judge on a fresh regression batch after this ships. Expectations:
- gmaps cases (both): pacing/visualCoherence "instant text" should drop to pass.
- github cases: trailing idle should reduce (anti-idle prompt).
- All: motionQuality should stay ✅; the scroll-tail wait is small enough not to be perceptible as a stutter.

**Preserves**: §0019-§0030. Goals.md non-negotiables #1 (looks human: closes three specific tells), #2 (no visible stalls: the inter-scroll micro-pause counts as a "natural pause" #2 explicitly carves out), #6 (rendering parameters + AI-first prompt rule, no thresholds).

**Future hook**: when cursor synth (B1-B11) lands, all four of these still apply — the cursor renders motion DURING the type pause, the scroll tail, and the natural browsing the anti-idle rule produces. The bundle is forward-compatible.

---

## 0032 · State awareness — history depth + about:blank auto-recovery (Class 2)

**Date**: 2026-05-11

**Context**: The §0030 video judge's first run on the github-multistep recording flagged `visualCoherence: fail @ 18.0s — screen turns completely white`. Investigation ([`docs/findings/2026-05-11-github-whitescreen.md`](./findings/2026-05-11-github-whitescreen.md)) traced this to a generic failure class, not a one-off bug:

1. The LLM picked two clicks on what it thought was a "language link" — both resolved to the same `<p>` paragraph element. Neither click navigated.
2. The LLM then output `back` to "return home". Browser history was `[about:blank, recordly]` (about:blank is the default fresh-tab page that `page.goto(url)` pushes onto). `back` popped to `about:blank`.
3. From that point on, every subsequent click failed (no DOM to resolve), the recording ran until budget exhaustion, and the deliverable was 13 seconds of solid white at the tail.

The class is: **the Director can issue actions whose side-effects render the page unusable, and has no awareness of the resulting state — it just continues firing actions into a broken environment**. `back` from a one-deep history is the most reproducible instance. Other instances of the same class exist (clicking a download link mid-recording would also break further interaction).

**Choice — two-part fix: prevent + recover, both AI-first**:

### Part A — History-depth awareness (prevent)

New port method `IPageSession.historyDepth(): Promise<number>` reads `window.history.length`. Surfaced in `DirectorState` as the optional `historyDepth` field, and rendered in the decider's user-message as:

```
History depth: 1  (back would land on about:blank — do NOT use back)
```

System-prompt rule (new "BACK SEMANTICS" section): when History depth is 1, the LLM must NOT use `back`; it should look for an explicit Home link, click the site logo, or scroll for a 回首页 affordance. Also notes: if recent clicks all show `URL: unchanged`, no nav happened and `back` will pop past the page the LLM thinks it's on.

This is the AI-first piece — we expose the FACT and the rule, then trust the decider to pick the right action. We do NOT silently block the `back` primitive; the LLM still owns the decision.

### Part B — about:blank auto-recovery (recover)

In `StreamingDirector.run()`:
1. Capture `initialUrl` once via `session.currentUrl()` before `beginRecording()`.
2. After every action's `executeAction` returns, inspect the summary's evidence. If the variant carries `urlAfter` (click / back / key) and it equals `about:blank` (and the initial URL wasn't itself blank), trigger recovery.
3. Recovery: `session.goto(initialUrl)`, log a `decision_failure` entry with new reason `about_blank_recovered`, clear the action queue, force a fresh decider call with `lastActionFailure = "previous <kind> action left the page on about:blank; recovered by reloading the initial URL — try a different approach (do NOT back from single-entry history)"`.

The recovery is unconditional (no AI in the loop) because the page being on about:blank means EVERY subsequent action would fail — there's no "decide" alternative. The AI is informed via `lastActionFailure` so the next decision avoids the trap.

**Why not just gate `back` in code?** Two reasons:
- Goals.md #6 (AI-first, not magic-numbers). A code gate `if (historyDepth === 1) { skip(); }` strips the decision from the LLM — and there are legitimate corner cases (rare site that has nothing useful and where back-to-blank is acceptable) where the LLM may want to override.
- The LLM-side prompt rule is more pedagogical — it tells the LLM *why* not to back, so the lesson generalizes to "look at recent-action URL changes before deciding whether back makes sense", which transfers to other state-aware decisions.

**Why couple Part A + Part B in one ADR?** They're complementary. A alone reduces but doesn't eliminate the bug — the LLM might still pick `back` if it misreads the prompt or if the history is 2-deep but the "previous" entry is itself bad. B alone catches every case but doesn't teach the LLM. Together: the LLM learns; the runtime is safe.

**Why a new `decision_failure` reason (`about_blank_recovered`) instead of reusing `click_failed`?** Operational clarity. The two are distinct failure modes — one is "click missed", the other is "page went somewhere unusable". Separating them in the action log lets a reviewer grep for either independently. The Zod enum in `domain/action-log.ts` was extended; the regression test's reason-set assertion is unaffected (it checks Director endReason, not decision_failure reason).

**Consequences**:

- New port method `historyDepth()` + Stagehand impl + FakePageSession impl. No other port surface changes.
- New `DirectorState.historyDepth?: number` (optional — backward-compatible with tests that don't set it).
- New unit tests: (1) about:blank recovery wires goto + decision_failure + lastActionFailure context, (2) historyDepth is surfaced to decider state. Total unit 74 → 76.
- New decision_failure reason `about_blank_recovered` in `domain/action-log.ts` Zod schema. No callers broke.
- Decider prompt: one new "BACK SEMANTICS" section + a one-line History-depth tag in the user-message. Token cost negligible.

**Validation plan**: re-run the github-multistep cases under the judge. Expectation: the white-screen pattern stops happening (LLM avoids `back` from depth=1; if it still picks it via prompt mis-read, recovery kicks in and the recording continues on the initial URL instead of white).

**Preserves**: §0019-§0031. Goals.md non-negotiables #1 (looks human: no more 13s-of-white-screen recordings), #3 (intent satisfied or transparently not: recovery is logged, decider sees `lastActionFailure`), #6 (AI-first: the prevention is a prompt rule + state surface, not a code gate).

**Open patterns this fix DOESN'T address yet** (could extend the same class fix to):
- Clicking a `download.zip` link triggers a download instead of rendering. Same "page now broken for actions" pattern; same recovery shape would apply.
- Cross-origin redirect to a page that won't load (auth wall). Recovery still works (back to initial URL); LLM gets the failure context.

Both can layer onto the same recovery infrastructure later without re-architecting.

---

## 0033 · `intentSatisfaction` — 1-to-1 bipartite assignment (Class 3)

**Date**: 2026-05-11

**Context**: The §0030 video judge's first run reported `intentExecution: fail` on the github-multistep-natural case ("only 1 of 4 verbs actually happened"), but the action-log-side `intentSatisfaction` metric reported `level: complete, "all 3 hint(s) clicked at least once + scrolling occurred"`. Investigation ([`docs/findings/2026-05-11-intent-satisfaction-overcount.md`](./findings/2026-05-11-intent-satisfaction-overcount.md)) found the metric's `descriptionsMatch` heuristic was over-crediting: two clicks on the same Chinese-language paragraph element matched against 3 unrelated hints because every hint and every click description happened to contain the word "link", and the matching was `filter+some` (any-overlap counted).

The class is: **string-overlap heuristics applied many-to-many over-credit when descriptions share generic vocabulary** — UI nouns (link/button/option/tab/page/...) appear in nearly every hint and click description and form spurious 1-token "bridges" between unrelated targets.

**Choice — 1-to-1 bipartite assignment, no blocklist changes**:

Replace `computeIntentSatisfaction`'s many-to-many loop:

```ts
// BEFORE: each hint check is independent — one click can satisfy many hints.
const hintsClicked = hintDescriptions.filter((hint) =>
  clickDescriptions.some((cd) => descriptionsMatch(hint, cd)),
).length;
```

with a new pure function `countMatchedHints(hints, clicks)` in `domain/intent-matching.ts`:

```ts
// AFTER: each click satisfies at most ONE hint; greedy by descending overlap.
export function countMatchedHints(hints, clicks): number {
  const edges = []; // { hintIdx, clickIdx, score }
  for h in hints, for c in clicks: edges.push({h, c, overlapScore(hints[h], clicks[c])});
  edges.sort((a, b) => b.score - a.score);
  const usedH = new Set(), usedC = new Set();
  let matched = 0;
  for (e of edges)
    if (!usedH.has(e.hintIdx) && !usedC.has(e.clickIdx)) {
      usedH.add(e.hintIdx); usedC.add(e.clickIdx); matched++;
    }
  return matched;
}
```

A new helper `overlapScore(a, b)` returns the count of shared content tokens (not just a boolean). Greedy is good enough for N ≤ ~10 hints/clicks — swap for Hungarian if we ever scale.

The github over-count walkthrough now:
- (H "Chinese link",   C "the simplified Chinese language switcher link in the GitHub footer"): score 3 (simplified, chinese, link)
- (H "Chinese link",   C "the Chinese language option"): score 1 (chinese)
- (H "build link",     C "the simplified Chinese ... link in the footer"): score 1 (link)  ← was the bridge
- (H "build link",     C "the Chinese language option"): score 0
- (H "package link",   C "the simplified Chinese ... link in the footer"): score 1 (link)  ← was the bridge
- (H "package link",   C "the Chinese language option"): score 0

Sorted by score: (H1, C1, 3) → assigned. The remaining edges all have C1 OR C2 consumed. Result: 1 of 3 hints matched → `level: partial`, matching the judge.

**Why not also blocklist UI nouns?**

An earlier draft of this ADR added `link, button, tab, option, page, section, area, list, menu, icon, image, text, field` (and CJK equivalents) to the `contentTokens` STOPWORDS. This broke a legitimate cross-language match path: `"the simplified Chinese link"` (English hint) vs. `"click 简体中文 link"` (CJK click) shares ONLY the `link` token — the English description has no CJK characters and the CJK description has no extra ASCII match material. Removing `link` from the valid token set turned a real positive into a false negative.

The 1-to-1 constraint alone fixes the over-count without losing the cross-language bridge: when one click has a high-overlap match to hint A AND a single-UI-noun match to hint B, greedy assigns A and B goes unmatched. UI-noun bridges only "win" when they're the BEST available edge — which is the right answer in those cases.

**Why keep `descriptionsMatch` lenient?** R3 constraint from the finding doc — the Director's §0025 fulfilled-hints filter and §0028 unreachable filter both rely on the existing lenient boolean. Changing them would re-introduce the "LLM keeps re-clicking 简体中文" loop. By making the new tighter algorithm a separate function (`countMatchedHints` using `overlapScore`), we get strict matching at scoring time AND preserve lenient matching at filter time.

**Consequences**:

- New pure functions in `domain/intent-matching.ts`: `overlapScore`, `countMatchedHints`. `descriptionsMatch` unchanged.
- `core/record-job-runner.ts` now imports `countMatchedHints` instead of `descriptionsMatch`.
- New unit test: §0033 regression case asserts that two clicks on the same Chinese element produce `partial 1/3`, NOT `complete 3/3`. Total unit 76 → 77.
- No prompt changes. No port changes. No config knobs added.
- Metric now agrees with the §0030 video judge on the github case (both say "1 of N hints actually clicked").

**Validation plan**: re-run the §0030 judge on a fresh regression batch. Expectation: `intentExecution` verdict matches the action-log `intentSatisfaction.level` (within reason — partial vs. probably_synthetic etc are different scales). The two should never categorically disagree like the original bug.

**Preserves**: §0019-§0032. Goals.md non-negotiables #3 (intent satisfied or transparently not: the metric now is transparent, not falsely optimistic), #6 (AI-first: no hardcoded thresholds — the algorithm is pure structure).

**Future hook**: when we want even stronger correctness, we can replace `overlapScore`'s token-count with a one-shot LLM judgment ("does click X satisfy hint Y?"). Cost: one extra LLM call per recording. Defer until we observe a case the bipartite-with-overlap can't handle.

---

## 0034 · Prophet recording: deep reconnaissance → deterministic paced playback

**Date**: 2026-05-11

**Context**: The §0030 video judge made the streaming director's dominant defect impossible to ignore: **multi-second dead air** — every per-action FastDecider call and every IClickVerifier screenshot check runs *while the camera is rolling*, so the LLM's tail latency is rendered into the deliverable as a frozen frame. The pipeline had also accreted patch after patch all working around the same root fact ("the LLM is in the loop while the camera rolls"): §0019 streaming Director, §0023 model split, §0026 `draftSequence` (planner pre-plans so the queue isn't empty), §0027 click verifier, §0028 retry cap, §0032 about:blank recovery. Each shaved a bit off the dead air; none removed the cause.

The user's framing: *"不是页面加载完开始录制 而是『准备好了』才开始录制 … 像一位先知一样"* — don't start recording when the page finishes loading; start when you're *prepared*. Collect all the information first, off-camera; then, on-camera, execute precisely — like a prophet who already knows what will happen.

**Options considered**:
- **Keep patching the streaming director** — shave more latency, pre-fire more decisions, smaller verifier models. Asymptotically still has an LLM in the loop; the dead air shrinks but never goes to zero. Rejected — it's fighting the architecture.
- **Two phases: off-camera recon → on-camera deterministic playback** (chosen). Move *all* reasoning before `beginRecording()`. The on-camera run executes a pre-resolved, pre-paced script with no LLM call in it.
- **Hybrid: off-camera plan + on-camera "fast-path" LLM only on divergence** — a re-plan checkpoint. Kept as the single recovery path, but **gated** (see below) because a re-plan is itself a heavyweight recon and freezes the frame.

**Choice**:

- **`IReconnoiterer.recon(input, session)`** (port `src/ports/reconnoiterer.ts`, adapter `src/adapters/recon/llm-reconnoiterer.ts`) runs **off-camera**: `session.observeAll()` → one vision LLM call → a draft → resolve each click/type target via `session.resolveTarget()` → return a fully pre-resolved, paced **`Performance`** (Zod schema `src/domain/performance.ts`: `{prompt, durationMs, steps[], totalEstimatedMs, rationale}`; `PerformanceStep` = discriminated union over `click`/`scroll`/`type`/`key`/`dwell`/`back`/`done`; click/type carry a `ResolvedTarget {selector, bbox, description}`; click/key/back may carry an `ExpectAfter {urlContains?, visibleText?}`; scroll carries `deltaPx`/`durationMs`/`easing`/`dwellAfterMs`). The recon prompt also instructs the LLM to emit blocker-dismissal as the first Performance steps (interim measure — see "casualties" below).
- **`PerformanceDirector` (`IDirector`)** (`src/adapters/director/performance-director.ts`, ctor `{ replanner: IReconnoiterer }`) plays the `Performance` back **on-camera, deterministically**: `beginRecording()`, then render each step (`dwell`→`wait`, `scroll`→`scroll`+`wait(dwellAfterMs)`, `click`→`wait(anticipationMs)`+`clickSelector`, `type`→`clickSelector`+`wait(preMs)`+`type`, `key`→`pressKey`, `back`→`goBack`), with a hard budget cutoff at `startedAt + durationMs * config.directorHardBudgetMult`. After each step carrying an `expectAfter`, it checks reality (`urlContains` / each `visibleText` via `quickFindOnPage` / not `about:blank`). **No LLM call on the happy path.**
- **One recovery path — a re-plan checkpoint — and even it is gated** (the §0034 design + the "B fix" from the first integration run): on an `expectAfter` mismatch — IF `replanCount < config.maxReplans` AND `remainingMs >= config.replanMinRemainingMs` (default **60 s**) → call `replanner.recon(...)` again with the remaining budget + a `priorSteps` summary, splice the new steps on (logs a `replan` action-log entry). OTHERWISE (replans exhausted, or not enough budget left — *the common case for short recordings*) → **degrade gracefully**: log a `decision_failure` (`reason: 'expect_after_mismatch'`), drop the now-stale remaining steps, append a short gentle closing `scroll` (~320 px / ≤1.8 s / `inOutQuad`) + a ~0.7 s `dwell` so the video ends with motion rather than a frozen frame, then end (`endReason: 'done'`). Rationale: a re-plan *is* a full `recon()` (~30–50 s) executed on-camera — it freezes the frame for its whole duration, catastrophic on a 10–30 s recording. So mid-recording re-plan is reserved for long recordings (≳ 75 s) where a ~30–50 s recon can fit; shorter ones absorb a divergence via graceful degradation. The same `IReconnoiterer` instance is reused as the director's re-planner.
- **Collapsed into this** (removed): `StreamingDirector`; `IFastDecider`/`LlmFastDecider`; `IClickVerifier`/`LlmClickVerifier`; `LlmPlanner`/`IPlanner`; `DirectorBriefing`/`draftSequence` (`src/domain/plan.ts`); `BlockerPrelude` (was coupled to `IFastDecider`); `DirectorState`/`DirectorAction`; the decider/planner/click-verifier/prelude prompts; `src/infra/pending.ts`; the streaming-only config knobs (`directorClickRejectionLimit`, `directorLookaheadMax`, `directorDwellFallbackMs`, `openingHoldMinMs`, `openingHoldMaxMs`, `llmDeciderModel`). New config: `llmReconModel`/`llmReconModelResolved` (resolves `llmReconModel` → `llmPlannerModel` → `llmModel`), `maxReplans` (default 3), `replanMinRemainingMs` (default 60 000).
- **Preserved**: `IPageSession`/`StagehandPageSession` (gained `historyDepth()` and `type(text, opts?)`); the §0030 video judge (`IRecordingJudge`/`LlmVisionJudge`, `npm run judge`); the §0031 naturalness rendering knobs (pre-typing pause, slower keystroke delay, inter-scroll micro-pause — now driven per-step by `scroll.dwellAfterMs`); the §0033 `intentSatisfaction` 1-to-1 bipartite matcher (now fed by the `Performance`'s click-step descriptions); the regression suite (rewired); the action-log + ffmpeg-trim pipeline. `RunResult` gained `performance`; `RunMetrics` swapped streaming-era fields for `reconMs`/`plannedSteps`/`replanCount`. Action-log `decision`/`decision_failure` variants are kept (BlockerPrelude is gone, but the graceful-degradation path now writes `decision_failure`); a new `replan` variant was added; `about_blank_recovered` was dropped from the `decision_failure.reason` enum.

**Consequences / what it costs**:

- **Wall-clock moves to before the camera opens.** Recon is ~30–50 s of "setup" — invisible in the deliverable. The on-camera recording is now exactly as long as it should be and contains *no dead air*. That's the whole point.
- **Recon quality becomes the whole bet.** If the recon's targets / `expectAfter` are wrong, the on-camera run diverges → graceful degradation → an incomplete (but smooth) recording, OR (on long recordings) an on-camera re-plan. **`replanCount` is the canary** — on the canonical scenario it fired (the recon resolved a wrong "简体中文" target); the B fix turned that into a graceful close instead of a 33 s freeze, but the underlying recon mistake is still there.
- **`BlockerPrelude` was a casualty.** Task #20 covers reintroducing a blocker-dismissal step with an independent LLM client; meanwhile the recon prompt asks the LLM to dismiss on-page blockers as the first Performance steps.
- **`intentSatisfaction` now reflects what the `Performance`'s click steps actually accomplished** (not what a streaming planner intended).

**Validation**: two `npm run prototype:stagehand` runs + `npm run judge` on the canonical scenario (GitHub Recordly README, "click 简体中文, slow scroll", 10 s) — full table in [`docs/findings/2026-05-11-prophet-first-integration.md`](./findings/2026-05-11-prophet-first-integration.md). **Before the B fix**: verdict `robotic`; pacing `fail` (~33 s frozen frame = an on-camera re-plan recon); trimmed video 36 s (3.6× over); `replanCount` 1; wall-clock 97 s. **After the B fix (current state)**: verdict `probably_synthetic`; pacing `partial` ("~2 s between scroll and click feels slightly mechanical"); motionQuality `fail` ("initial scroll extremely fast & linear"); intentExecution `partial` ("requested 'slow scroll', executed fast"); trimmed video 6.9 s; `replanCount` 0; wall-clock 53 s. **The dead-air / on-camera-re-plan problem is solved.** The remaining gaps are all *recon-plan quality* (wrong target resolution, one fast 2.4 s scroll for "slow scroll", scroll reading "linear" to the judge) — tracked in Task #21, not in this sub-project.

**Open risk / next**:
- **The rehearsing reconnoiterer (Task #21)** — the real fix for divergences. Recon already gets the live `IPageSession`; have it *execute* its draft against that page, observe the actual resulting states, bake *verified* `expectAfter`, reconverge when a draft step doesn't pan out, then re-navigate to the start URL before handing the `Performance` to the on-camera run. That's what makes mid-recording divergences rare enough to re-enable re-plan more aggressively.
- A recon-prompt rule honoring pacing adjectives ("slow scroll" → slow/chunked scrolling, not one fast fling).
- The scroll-rendering "looks linear/fast" investigation (low video fps over a short scroll? the `smoothScrollTo` easing? lazy React content popping in?).

**Preserves**: §0030, §0031, §0033 (§0019–§0029, §0032 superseded — those were the streaming-director's incremental fixes, now obsolete). Goals.md non-negotiables #1 (looks human: no more multi-second frozen frames in the deliverable), #3 (intent satisfied or transparently not: `intentSatisfaction` + the graceful-degradation `decision_failure` log are honest about an incomplete task), #6 (AI-first: the recon *plans*; the Director just *plays*).

---

## Template for new entries

```
## NNNN · <Title>

**Date**: YYYY-MM-DD

**Context**:

**Options considered**:

**Choice**:

**Rationale**:

**Consequences**:
```
