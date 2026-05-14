# Architecture

## Pattern: Ports & Adapters (Hexagonal)

```
                   ┌──────────────────────────────┐
                   │           api/               │  HTTP / CLI entry points
                   └──────────────┬───────────────┘
                                  │ depends on
                   ┌──────────────▼───────────────┐
                   │           core/              │  job orchestration, business rules
                   │  (depends only on ports/)    │
                   └──────────────┬───────────────┘
                                  │ depends on
                   ┌──────────────▼───────────────┐
                   │          ports/              │  interfaces — no implementations
                   └──────────────▲───────────────┘
                                  │ implemented by
                   ┌──────────────┴───────────────┐
                   │         adapters/            │  Stagehand, Playwright, ffmpeg, LLM clients
                   └──────────────────────────────┘
```

The dependency arrows point **inward**. `adapters/` knows about `ports/` and `domain/`, but never the other way around.

## Module map

```
src/
  domain/           # Pure types, schemas, error classes. No I/O. No external deps except zod.
    action-log.ts
    performance.ts        # the pre-resolved, paced action sequence (§0034)
    errors.ts
  ports/            # Interface definitions. No I/O. No external deps.
    page-session.ts       # IPageSession
    reconnoiterer.ts      # IReconnoiterer  — recon → Performance (also re-planner)
    director.ts           # IDirector       — plays back a Performance
    recording-judge.ts    # IRecordingJudge — automated naturalness grading
    url-resolver.ts       # IUrlResolver    — natural-language prompt → start URL (§0043)
  adapters/         # Concrete implementations. Talks to libraries / external services.
    agent/
      stagehand-session.ts   # IPageSession via Stagehand+Playwright
    recon/
      llm-reconnoiterer.ts   # IReconnoiterer via OpenRouter (vision + planning)
    director/
      performance-director.ts # IDirector — deterministic playback + re-plan checkpoint
    judge/
      llm-vision-judge.ts    # IRecordingJudge via Gemini (native video input)
    url-resolver/
      llm-url-resolver.ts    # IUrlResolver via OpenRouter (cheap LLM — Haiku 4.5 default)
  core/             # Orchestration. Imports only domain/ + ports/ + infra/.
    record-job-runner.ts   # setup → recon → director → trim
  api/              # HTTP entry points. Imports core/ + adapters via a factory.
    server.ts              # /api/v1/recordings/* + /health (concurrent execution — no JobQueue; §0043)
    job-store.ts           # In-memory job state
    request.ts             # Zod schemas for request/state (Hard Rule 2)
  prompts/          # LLM prompts (content, not code): reconnoiterer.ts, recording-judge.ts
  infra/            # Cross-cutting: config, logger, ffmpeg, IDs.
    config.ts
    logger.ts
scripts/            # One-off entry points (prototypes, smoke tests). Compose adapters directly.
```

## Why this layout

- **Swap-friendly**: replacing Stagehand with browser-use is "write a new adapter under `adapters/agent/`, change DI wiring." `core/` does not change.
- **Testable**: `core/` can be unit-tested with fake adapters. Math (trajectory, coordinate transforms) lives in pure modules with no I/O.
- **Reviewable**: an import statement reaching from `core/` into a vendor library is a code-review red flag. Boundary violations are mechanically detectable.

## Naming conventions

- **Ports** are interfaces named `I<Capability>` (e.g. `IPageSession`, `IReconnoiterer`, `IDirector`, `IRecordingJudge`).
- **Adapters** are concrete classes named `<Tech><Capability>` (e.g. `StagehandPageSession`).
- **Domain types** are POJOs validated by Zod schemas. Schema and type are co-located: `export const ActionLogEntry = z.object({...}); export type ActionLogEntry = z.infer<typeof ActionLogEntry>;`
- **Errors** end in `Error` and extend `DomainError`. They carry a stable string `code`.

## Lifecycle of a recording job ("prophet" pipeline, ADR §0034)

```
(HTTP POST /api/v1/recordings — body: { prompt, durationMs, … })
   │
   ▼
core/record-job-runner.run({ prompt, durationMs, outputDir, format?, crf? })
   │
   ├── IUrlResolver.resolve(prompt)              → starting URL (§0043 — explicit URL inline,
   │                                              well-known name, or pure intent → search)
   ├── IPageSession.start() / goto(url)         → Browser + page + recordVideo on
   ├── IReconnoiterer.recon(req, session)       → Performance (OFF-CAMERA: dismiss
   │                                              blockers, IPageSession.ariaSnapshot()
   │                                              (ref-tagged a11y tree), LLM picks a
   │                                              draft (click targets by `ref` + `targetText`),
   │                                              resolveAriaRef → on miss resolveByVisibleText
   │                                              → on miss resolveTargetCandidates → drop
   │                                              (dropped → Performance.unresolvedTargets);
   │                                              rehearsal walk, set expectAfter, fitPlanToBudget
   │                                              — §0036/§0037/§0038)
   ├── IDirector.run(performance, session)       → ON-CAMERA: deterministic playback.
   │                                              At most config.maxReplans re-plan
   │                                              checkpoints, each delegating back to
   │                                              IReconnoiterer.recon (now used as a
   │                                              re-planner from the diverged step).
   ├── IPageSession.stop()                       → raw video path + action log
   ├── ffmpeg trim raw → recording.mp4           (§0043 — H.264 + crf, defaults: crf=18.
   │                                              Falls back to .webm if only Playwright's
   │                                              bundled VP8-only ffmpeg is available)
   │  (later: ICursorSynthesizer / IComposer for cursor overlay; IMediaRecorder for audio)
   │
   ▼
return { videoPath, rawVideoPath, actionLogPath, urlResolution, performance, metrics, directorReport }
```

Today `IPageSession`, `IReconnoiterer`, `IDirector`, `IRecordingJudge`, `IUrlResolver` exist.
Cursor synth + audio capture (via `IMediaRecorder`) are scheduled.

## Boundary checklist for adding a feature

When you propose code that does I/O or talks to a library, ask:

1. Does this belong in `core/` (pure orchestration), `adapters/` (I/O), or `infra/` (cross-cutting)?
2. If it's a new external dependency, does it warrant a new port? Or does it extend an existing one?
3. Are inputs/outputs validated by Zod schemas in `domain/`?
4. Are failure modes mapped to typed `DomainError` subclasses?
5. Is every spawned resource (browser, file, child proc) cleaned up in a `finally`?

If you cannot answer "yes" to all five, the code is not ready to land.
