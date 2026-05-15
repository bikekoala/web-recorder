# web-recorder

AI-driven service: `(natural-language prompt, durationMs)` → recorded video of a browser session that looks like a human did it.

**Exploratory project** — the stack (Stagehand, Playwright recordVideo, ffmpeg, OpenRouter) is expected to evolve. Architecture isolates each layer behind a port so swaps don't ripple.

## Read these first, in order

1. [`docs/goals.md`](./docs/goals.md) — the north star. Any change that doesn't serve a goal here does not ship.
2. [`docs/architecture.md`](./docs/architecture.md) — module map, dependency direction.
3. [`docs/decisions.md`](./docs/decisions.md) — every architectural decision (ADRs §0001-§0043+). The canonical "why is it like this?" record.
4. [`docs/findings/README.md`](./docs/findings/README.md) — investigations index (active vs historical). The 2026-05-13 overnight sweep is the current-state baseline.
5. [`docs/output-layout.md`](./docs/output-layout.md) — when inspecting a past recording, this names every file under `output/<date>/<run>/`. **Start at `run.json`.**

## Hard rules (non-negotiable)

1. **Ports & Adapters (hexagonal).** `src/core/` depends only on `src/ports/`. Concrete tech (Stagehand, Playwright, ffmpeg, LLMs) lives in `src/adapters/`. If a feature needs a port broken, **say so explicitly and wait for a decision** — never silently leak adapter concerns into core.
2. **Schema-first.** Anything crossing a boundary (LLM output, HTTP request, project file, persisted action log) is a Zod schema in `src/domain/`. Parse before use.
3. **Errors are typed.** Domain errors extend `DomainError` (`src/domain/errors.ts`) and carry a stable `code`. Adapters translate library exceptions at the boundary.
4. **Side effects are owned.** Every `Browser`, `BrowserContext`, child process, file handle, or temp dir has a clear owner with `try/finally`. No reliance on GC.
5. **Pure where possible.** Planning, trajectory math, coordinate transforms = pure functions. Adapters are the only impure code.
6. **Config, not magic numbers.** Tunables live in `src/infra/config.ts`, overridable via env vars. Behavior thresholds = AI judgement, not hardcoded heuristics.
7. **Structured logs from day 1.** All logging through `src/infra/logger.ts` (pino). Each job carries a `traceId`.

## Current state — load-bearing pieces

The full feature ledger is `docs/decisions.md` (§0001-§0043+). The pieces a future session needs to know exist:

- **Prophet pipeline** (§0034): off-camera recon (`IReconnoiterer`) emits a fully-paced `Performance`; on-camera `IDirector` plays it back deterministically with a re-plan checkpoint.
- **Ref-tagged a11y target resolution** (§0036, §0038): recon picks click/type targets by `ref` from a deterministic `ariaSnapshot()` tree + `targetDescription`/`targetText` fallbacks; resolve chain is `resolveAriaRef → resolveByVisibleText → resolveTargetCandidates → drop-and-surface-as-unresolvedTargets`.
- **Duration fidelity** (§0037 + §0039 + §0040 / F1): `durationMs` is a hard prompt constraint on A; `fitPlanToBudget` is a ±20% corrector that surfaces out-of-band misses; Director soft-aligns on-camera dwells; `RecordJobRunner` trims by video-relative time. A's plan cost uses a pairwise running-total to defeat 10-number mental-math errors.
- **v1 graceful-unmet contract** (§0042): when content isn't reachable, `intentSatisfaction: unmet`/`partial` naming what was missed **is the success path** — not a bug. Bugs are confined to wasted budget when content IS available.
- **HTTP API v1** (§0043): REST under `/api/v1/recordings`. Natural-language entry point (`prompt, durationMs`); `IUrlResolver` picks start URL via Haiku 4.5. Concurrent execution, no JobQueue. Service-mode is hard-coded headless.
- **Recording stack**: CloakBrowser stealth Chromium (replaces vanilla; canvas/WebGL/audio/fonts spoofed), Playwright `recordVideo`, ffmpeg trim → mp4 H.264 default. CloakBrowser's Bezier mouse curve folded into `clickAt`; `humanize` wrapper not used.
- **Vision judge** (§0030) + **`intentSatisfaction` 1-to-1 bipartite matching** (§0033) are the two automated quality signals; bright-line specs in `bun run eval` hard-fail, quality is CONCERNS.

`output/<date>/<run>/run.json` is the canonical record. `docs/naturalness-catalog.md` tracks every observable "looks human" behavior.

## Common commands

Runtime is **Bun ≥1.3** — Bun executes the `.ts` scripts directly, no separate TS runner needed. (Migrated from Node + tsx + npm on 2026-05-15; infra swap, no ADR per the standing rule.)

```bash
bun install
bunx playwright install ffmpeg  # only the bundled-ffmpeg fallback; no Chromium download — we ship one Chromium (CloakBrowser)
bun run cloakbrowser:install    # ~150 MB stealth Chromium; first-run download occasionally flaky — retry once

bun run typecheck               # tsc --noEmit (strict)
bun run prototype:stagehand     # manual driver; headed on macOS, headless on Linux
bun run eval                    # one-scenario canary (bright-line specs + judge); see .claude/skills/run-eval.md
bun run regression              # multi-site categorical sweep
bun run smoke:recording         # recording pipeline alone, no LLM
bun run judge -- <video> "<prompt>" --duration-ms 10000
bun run serve                   # HTTP API v1; PORT default 8787
```

## Environment

`cp .env.example .env`, then `OPENROUTER_API_KEY=sk-or-v1-...` ([openrouter.ai/keys](https://openrouter.ai/keys)). See ADR §0009 for why OpenRouter is the only supported provider.

Key env knobs (defaults in `src/infra/config.ts`):
- `LLM_RECON_MODEL` — recon planner (default `anthropic/claude-haiku-4.5`; `sonnet-4.6` escape hatch on flapping sites)
- `LLM_MODEL` — Stagehand internals
- `PROTOTYPE_HEADLESS` / `EVAL_HEADLESS` — overrides the platform default (macOS=headed, Linux=headless)
- `BROWSER_WINDOW_POSITION="x,y"` — multi-monitor macOS dev

## When updating this project

1. Update **`docs/decisions.md`** if a non-obvious choice is made or revised.
2. Update **`docs/architecture.md`** if a port/adapter/layer was added.
3. Update **`docs/glossary.md`** if a new domain term was introduced.
4. Update **`docs/naturalness-catalog.md`** if a "looks-human" behavior was added or regressed.
5. Update **this file** only if a *load-bearing* piece changed — not for every feature.

Stale docs are worse than no docs. Touch them in the same commit as the code.

## When picking up an unfamiliar area

- The recon side is the most active surface. `src/adapters/recon/llm-reconnoiterer.ts` (750 lines) + `src/prompts/reconnoiterer.ts` (the system prompt) are where most quality wins land.
- The page-driver side is `src/adapters/agent/stagehand-session.ts` (1848 lines — large; section comments lay out the cloakbrowser launch, ariaSnapshot, click chain, scroll, etc.).
- The orchestrator is `src/core/record-job-runner.ts`.
- Recurring workflows have their own setup under `.claude/`: skills (read-eval canary, recon-prompt iteration), hooks (end-of-session cleanup nudge).
