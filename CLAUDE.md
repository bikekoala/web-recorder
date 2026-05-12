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
| `IReconnoiterer` + LlmReconnoiterer (recon draft → resolved `Performance`; reused as re-planner) | ✅ |
| ref-tagged a11y snapshot target resolution (§0036) — recon sees a deterministic `IPageSession.ariaSnapshot()` tree (`page.ariaSnapshot({mode:'ai'})`, native in Playwright 1.59; replaced the `observeAll()` LLM enumeration); the LLM picks each click/type target by `ref` **+ a `targetDescription`** (the fallback if it picks a wrong/stale ref out of a huge tree — playwright-mcp's `target`+`element` pattern); `ReconDraftSchema` (recon output finally Zod-parsed — Hard Rule 2); `resolveAriaRef(ref)` → durable `{selector,bbox,description}`, deterministic, no LLM; on a ref miss → `resolveTargetCandidates(targetDescription)` fuzzy fallback. Roots out the wrong-element bug (robustness-sweep P2/finding 6) — fuzzy match is a fallback now, not the hot path. Validated: canonical Recordly run = `intentSatisfaction: complete`, judge `LOOKS_HUMAN`, recon ~24 s (was ~49 s) | ✅ |
| Rehearsing reconnoiterer — `recon()` walks its draft against the live page off-camera, rewrites `expectAfter` to observed state, reconverges (with a fresh aria snapshot) on divergence, resets to start URL (`RECON_REHEARSE`, default on; §0034 / §0036; no more per-step `observe()` re-resolve) | ✅ |
| Recon prompt: PRIORITY #1 (a step per requested action, re-check before emit) + scroll-to-target discipline + "pick targets by ref from the tree"; reconverge keeps the goal (different ref / scroll first, not blind retry) | ✅ |
| `IBlockerDismisser` + LlmBlockerDismisser — off-camera probe→detect(vision LLM)→click→re-probe loop that clears cookie/consent banners + X-to-close modals before recon plans & before recording (gated on `pageDiagnostic.blockerSignals`; `BLOCKER_DISMISS`, default on; capped 3 rounds/10s; `RunMetrics.blockerDismissal`; §0035 / Task #20) | ✅ |
| `resolveTargetCandidates` — all sized `observe()` matches, interactive elements ranked ahead of wrappers, deduped; the rehearsal walk's dead-click *recovery* sweep tries the other candidates before the LLM reconverge; reconverge prompt hard-checks the requested click survives (finding 6 — now a recovery path; the primary resolution is the §0036 aria-ref one) | ✅ |
| `IDirector` + PerformanceDirector (deterministic `Performance` playback + re-plan checkpoint, §0034) | ✅ |
| PerformanceDirector graceful degradation — drops stale tail + gentle closing scroll when an `expectAfter` mismatch can't be re-planned (§0034) | ✅ |
| `replanMinRemainingMs` gate (default 60s) — mid-recording re-plan only when enough budget remains; short recordings degrade instead (§0034) | ✅ |
| `Performance` domain type (pre-resolved, paced action sequence) | ✅ |
| Centralized prompts in `src/prompts/` — only `reconnoiterer` (+ `recording-judge`) remain | ✅ |
| Two model knobs that matter: `LLM_MODEL` (Stagehand internals) / `LLM_RECON_MODEL` (recon+re-plan) | ✅ |
| `RecordJobRunner` (orchestrates setup → recon → director → trim) | ✅ |
| Natural-language entry point (`url, prompt, durationMs`) | ✅ |
| Vitest unit tests (127 passing) | ✅ |
| Action vocabulary: 7 primitives (click / scroll / dwell / type / key / back / done) | ✅ |
| `IRecordingJudge` + LlmVisionJudge — automated 5-dim rubric naturalness grading via Gemini 3.1 Pro (§0030) | ✅ |
| Naturalness rendering bundle — pre-typing pause, slower keystroke delay, inter-scroll micro-pause (§0031) | ✅ |
| `intentSatisfaction` 1-to-1 bipartite matching — no more single-token UI-noun bridges over-crediting hints (§0033) | ✅ |
| Regression suite — 3 sites × 2 human-prompt variants, categorical asserts only; wired to the prophet pipeline + blocker dismisser (`tests/regression/`) | ✅ |
| Operation log: `replan` / `page_diagnostic` entries (`decision` / `decision_failure` kept as legacy) | ✅ |
| `intentSatisfaction` metric (transparent "did we do what user asked?") | ✅ |
| Bot-detection mitigations (chrome flags + UA + optional storageState) | ✅ |
| Cursor trajectory synth (`ICursorSynthesizer`) | ⏳ |
| HTTP API | ⏳ |

Architectural decisions live in [`docs/decisions.md`](./docs/decisions.md). Update it whenever a decision is made or revised.

The **naturalness catalog** in [`docs/naturalness-catalog.md`](./docs/naturalness-catalog.md) tracks every observable behavior that contributes to "this looks like a human, not a robot." Every new natural-feeling feature (or gap) flips a status row there.

### Measured performance (Recordly README, "click 简中, slow scroll, 10s")

Post-**§0036** (ref-tagged a11y snapshot target resolution), single integration run on macOS + OpenRouter (recon on `anthropic/claude-sonnet-4.6`, headless), `npm run prototype:stagehand` + `npm run judge`:

| Metric | Value |
|---|---|
| Pipeline | Prophet (§0034 + Task #21 + §0036): blocker-dismiss → `ariaSnapshot()` ref-tagged tree → LLM picks a draft (targets by `ref` + `targetDescription`) → resolve refs (deterministic; fuzzy fallback on a ref miss) → off-camera rehearsal walk → deterministic paced playback |
| Trimmed video duration | 10.6 s (target 10 s, +6%) |
| Reconnaissance (off-camera, incl. the rehearsal walk) | ~24 s (was ~49 s — the per-target `observe()` calls are gone; on this run the LLM picked a wrong `ref` for the 简中 link → one `resolveTargetCandidates` fallback call, then the rehearsal walk clicked it for real off-camera) |
| Rehearsal trace | `{walkedSteps: 10, divergences: 0, reconverges: 0, truncated: false, timedOut: false}` |
| On-camera recording | 10.6 s — no dead air |
| Re-plans (on-camera) | 0 |
| `intentSatisfaction` | **complete** — 1 click (简中, verified off-camera) + 3 scrolls |
| Video judge verdict (Gemini 3.1 Pro) | **`LOOKS_HUMAN`** — motionQuality / pacing / intentExecution / recovery / visualCoherence all `pass` |
| Total wall-clock | ~42 s (was ~72 s) |

Note on goal #5: the aria tree is the recon prompt's big input now (~1450 lines / ~23 k tokens for a GitHub repo page; a Wikipedia featured article is ~775 KB even `mode:'ai'`-pruned). `ariaSnapshot()` caps it — over `ARIA_SNAPSHOT_MAX_CHARS` (~100 KB) it re-snapshots scoped to `<main>` and, if still over, truncates to the top of the tree (line-boundary + a "scroll for more" note). `ARIA_SNAPSHOT_DEPTH=25` is the other cap.

Known remaining recon-plan-quality gap: the recon LLM is **not great at picking the right `ref` out of a thousand-line tree** (it picked a wrong one for the 简中 link on the canonical run — the `targetDescription` fallback caught it; on Wikipedia "Cat → Felidae" both the ref and the `observe()` fallback miss → `intentSatisfaction: unknown`). Giant pages (Wikipedia featured articles) are the open case — the tree is too big to navigate one-shot and `stagehand.observe()` can't ingest it either; needs a dedicated pass (smarter region pick / a non-`observe()` fallback / accept `unknown`). See [`docs/findings/2026-05-11-robustness-sweep-1.md`](./docs/findings/2026-05-11-robustness-sweep-1.md). `RECON_REHEARSE=false` skips the walk (fast dev iteration).

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

# Grade a finished recording.webm against the 5-dimension naturalness rubric.
# Writes judgment.json next to the video. See ADR §0030.
npm run judge -- <video-path> "<user-prompt>" --duration-ms 10000

# Verify the recording pipeline alone (no LLM, no Stagehand)
npm run smoke:recording
```

## Environment

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). See [`docs/decisions.md`](./docs/decisions.md) §0009 for why OpenRouter is the only supported provider.

```bash
cp .env.example .env
# OPENROUTER_API_KEY=sk-or-v1-...
# (optional) LLM_MODEL=google/gemini-2.5-pro    # any OpenRouter model id
```

Local dev tip — if Playwright's bundled Chromium download is flaky, set `BROWSER_CHANNEL=chrome` to use the system Google Chrome ([`docs/decisions.md`](./docs/decisions.md) §0007).

Local dev tip — `npm run prototype:stagehand` is visible by default (`PROTOTYPE_HEADLESS=true` for no window). On a multi-monitor macOS setup, `BROWSER_WINDOW_POSITION="x,y"` places the Chromium window on a specific display (no-op when headless or off-macOS). The browser briefly takes keyboard focus when it launches — that's a macOS behavior for any newly-launched GUI app and there's no clean way around it; just click back to your terminal.

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
