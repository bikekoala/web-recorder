# web-recorder

AI-driven service that turns `(URL, natural-language instruction)` into a recorded video of a browser session — eventually with synthesized human-like cursor trails and post-production polish.

This is an **exploratory project**. The underlying tech stack is expected to evolve (Stagehand → other agent SDKs, Playwright recordVideo → CDP screencast → xvfb+ffmpeg, etc.). The architecture is built so swapping a layer does not ripple into the rest of the codebase.

## Hard rules

These are non-negotiable across iterations. Read [`docs/goals.md`](./docs/goals.md) FIRST every session — it's the north star, and any change that doesn't serve a goal there does not ship. Then [`docs/architecture.md`](./docs/architecture.md) before adding code.

1. **Ports & Adapters (Hexagonal)**. Business logic lives in `src/core/` and depends only on interfaces defined in `src/ports/`. Concrete tech (Stagehand, Playwright, ffmpeg, OpenAI) lives in `src/adapters/`. Never import an adapter from `core/` directly.
2. **Schema-first**. Anything crossing a boundary (LLM output, HTTP request, project file, persisted action log) is defined as a Zod schema in `src/domain/`. Parse before use.
3. **Errors are typed**. Domain errors extend `DomainError` (`src/domain/errors.ts`) and carry a stable `code`. Adapters translate library exceptions into domain errors at the boundary.
4. **Side effects are owned**. Every `Browser`, `BrowserContext`, child process, file handle, or temp directory has a clear owner with a `try/finally` cleanup. No reliance on GC.
5. **Pure where possible**. Trajectory math, planning, coordinate transforms = pure functions. Adapters are the only impure code.
6. **Config, not magic numbers**. Tunables (fps, viewport, timeouts, easing curves, model names, concurrency) live in `src/infra/config.ts` and can be overridden via env vars.
7. **Structured logs from day 1**. All logging goes through `src/infra/logger.ts` (pino). Each job carries a `traceId`.

When a feature seems to need a port broken, **say so explicitly** in the response and wait for a decision — do not silently leak adapter concerns into core.

## Current state

| Layer | Status |
|---|---|
| Project scaffolding | ✅ |
| `IPageSession` + Stagehand adapter | ✅ |
| Playwright video recording + ffmpeg trim | ✅ |
| `IPlanner` + LlmPlanner adapter (now `brief()` only) | ✅ |
| `IDirector` + StreamingDirector (streaming LLM-in-the-loop) | ✅ |
| `IFastDecider` + LlmFastDecider (gpt-4o-mini default; Gemini Flash Lite preview too slow) | ✅ |
| Centralized prompts in `src/prompts/` — Sonnet 4.6 + Gemini Pro both viable as planner | ✅ |
| Cold-start hidden via pre-fired Decision 1 during prelude | ✅ |
| Three independent model knobs (`LLM_MODEL` / `LLM_PLANNER_MODEL` / `LLM_DECIDER_MODEL`) | ✅ |
| `RecordJobRunner` (orchestrates plan → prelude → pre-fire → director → trim) | ✅ |
| Natural-language entry point (`url, prompt, durationMs`) | ✅ |
| Vitest unit tests (66 passing — pruned schema-only redundancy) | ✅ |
| Action vocabulary: 7 primitives (click / scroll / dwell / type / key / back / done) | ✅ |
| ActionEvidence per-action — LLM verifies last action via URL/title/focused-value (§0026) | ✅ |
| `DirectorBriefing.draftSequence` — planner pre-plans, Director seeds queue (§0026) | ✅ |
| `IClickVerifier` — AI screenshot check after each click; failed click clears queue (§0027) | ✅ |
| Retry cap — per-target rejection counter; after N=2 failures the target is filtered + LLM is told it's unreachable (§0028) | ✅ |
| Regression suite — 3 sites × 2 human-prompt variants, categorical asserts only | ✅ |
| Operation log: `decision` / `decision_failure` / `page_diagnostic` entries | ✅ |
| Visual-blocker prompt rules (auto-clicks paused-video play overlays etc.) | ✅ |
| Pre-recording `BlockerPrelude` (probe → dismiss loop, NOT in deliverable) | ✅ |
| `intentSatisfaction` metric (transparent "did we do what user asked?") | ✅ |
| Bot-detection mitigations (chrome flags + UA + optional storageState) | ✅ |
| Cursor trajectory synth (`ICursorSynthesizer`) | ⏳ |
| HTTP API | ⏳ |

Architectural decisions live in [`docs/decisions.md`](./docs/decisions.md). Update it whenever a decision is made or revised.

The **naturalness catalog** in [`docs/naturalness-catalog.md`](./docs/naturalness-catalog.md) tracks every observable behavior that contributes to "this looks like a human, not a robot." Every new natural-feeling feature (or gap) flips a status row there.

### Measured performance (Recordly README, "click 简中, slow scroll, 10s")

After §0019 (streaming Director), single integration run on macOS + OpenRouter `openai/gpt-4o-mini`:

| Metric | Value |
|---|---|
| Trimmed video duration | 10640 ms (target 10000, +6.4%) |
| Implicit dwells (LLM tail latency hidden as natural pauses) | 5 (~1.0s total) |
| Resolved click hints | 1 (planner pre-resolved 简体中文) |
| FastDecider calls during recording | 2 |
| Director end reason | `budget` (hit 1.05× cap) |
| Total wall-clock incl. setup + brief + trim | ~49s |

## Common commands

```bash
# Install dependencies + Chromium + ffmpeg
npm install
npm run playwright:install
npx playwright install ffmpeg     # bundled trim binary

# Type-check (strict, no emit)
npm run typecheck

# Run the natural-language driven prototype
# Defaults to GitHub Recordly README + the "click 简中, slow scroll" 10s test.
# Override with PROTOTYPE_URL / PROTOTYPE_PROMPT / PROTOTYPE_DURATION_MS env vars.
npm run prototype:stagehand

# Verify the recording pipeline alone (no LLM, no Stagehand)
npm run smoke:recording

# Just the planner — produce a plan without recording
npm run test:planner
```

## Environment

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). See [`docs/decisions.md`](./docs/decisions.md) §0009 for why OpenRouter is the only supported provider.

```bash
cp .env.example .env
# OPENROUTER_API_KEY=sk-or-v1-...
# (optional) LLM_MODEL=google/gemini-2.5-pro    # any OpenRouter model id
```

Local dev tip — if Playwright's bundled Chromium download is flaky, set `BROWSER_CHANNEL=chrome` to use the system Google Chrome ([`docs/decisions.md`](./docs/decisions.md) §0007).

## Important context for future iterations

- **macOS-first development, Docker target for production.** Develop locally with `headless: false` to watch Stagehand work; verify Docker parity before considering a feature done.
- **Architecture B was chosen for V1**: pure headless + post-process cursor overlay. See [`docs/decisions.md`](./docs/decisions.md) §0001.
- **Coordinate system care**: action-log coordinates are **viewport-relative at the moment of action**, not page-absolute. The synth layer needs `scrollY` at each timestamp to render correctly.
- **Stagehand provides Playwright's `Page` directly.** When we need primitives Stagehand doesn't expose (custom scroll easing, mouse path control, raw CDP), we fall through to `stagehand.page.*` which is a real Playwright Page. This is allowed inside the Stagehand adapter, not elsewhere.

## When updating this project

If you add/change/remove a feature:

1. Update **this file** (`Current state` table, any new commands).
2. Update **`docs/decisions.md`** if a non-obvious choice was made.
3. Update **`docs/architecture.md`** if a new layer/port/adapter was introduced.
4. Update **`docs/glossary.md`** if a new domain term was introduced.

Stale docs are worse than no docs. Touch them in the same commit as the code.
