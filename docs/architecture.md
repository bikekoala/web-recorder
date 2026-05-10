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
    errors.ts
    (later: plan.ts, project.ts, ...)
  ports/            # Interface definitions. No I/O. No external deps.
    page-session.ts
    (later: planner.ts, recorder.ts, cursor-synth.ts, composer.ts, ...)
  adapters/         # Concrete implementations. Talks to libraries / external services.
    agent/
      stagehand-session.ts   # IPageSession via Stagehand+Playwright
    (later: planner/llm-planner.ts, composer/ffmpeg.ts, ...)
  core/             # Orchestration. Imports only domain/ + ports/. (Empty until V1 pipeline lands.)
  infra/            # Cross-cutting: config, logger, queue, IDs.
    config.ts
    logger.ts
scripts/            # One-off entry points (prototypes, smoke tests). Compose adapters directly.
```

## Why this layout

- **Swap-friendly**: replacing Stagehand with browser-use is "write a new adapter under `adapters/agent/`, change DI wiring." `core/` does not change.
- **Testable**: `core/` can be unit-tested with fake adapters. Math (trajectory, coordinate transforms) lives in pure modules with no I/O.
- **Reviewable**: an import statement reaching from `core/` into a vendor library is a code-review red flag. Boundary violations are mechanically detectable.

## Naming conventions

- **Ports** are interfaces named `I<Capability>` (e.g. `IPageSession`, `IPlanner`).
- **Adapters** are concrete classes named `<Tech><Capability>` (e.g. `StagehandPageSession`).
- **Domain types** are POJOs validated by Zod schemas. Schema and type are co-located: `export const ActionLogEntry = z.object({...}); export type ActionLogEntry = z.infer<typeof ActionLogEntry>;`
- **Errors** end in `Error` and extend `DomainError`. They carry a stable string `code`.

## Lifecycle of a recording job (target shape, not yet built)

```
HTTP POST /record
   │
   ▼
core/job-runner.run(input)
   │
   ├── IPlanner.plan(url, prompt)               → TimelinePlan (domain type)
   ├── IPageSession.start()                     → Browser + page + recordVideo on
   ├── core/runner.execute(session, plan)       → action log
   ├── IPageSession.stop()                      → raw video path + action log
   ├── ICursorSynthesizer.synthesize(actionLog) → cursor frames
   ├── IComposer.compose(video, cursorFrames)   → final mp4 path
   │
   ▼
return { videoUrl, actionLog }
```

Today only `IPageSession` exists. The rest are scheduled.

## Boundary checklist for adding a feature

When you propose code that does I/O or talks to a library, ask:

1. Does this belong in `core/` (pure orchestration), `adapters/` (I/O), or `infra/` (cross-cutting)?
2. If it's a new external dependency, does it warrant a new port? Or does it extend an existing one?
3. Are inputs/outputs validated by Zod schemas in `domain/`?
4. Are failure modes mapped to typed `DomainError` subclasses?
5. Is every spawned resource (browser, file, child proc) cleaned up in a `finally`?

If you cannot answer "yes" to all five, the code is not ready to land.
