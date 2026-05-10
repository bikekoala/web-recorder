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
