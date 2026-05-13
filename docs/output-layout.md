# Output directory layout

Every run (eval, regression, prototype, future HTTP-served job) writes to a
self-contained directory under `output/`. The convention below is the contract
both humans (looking at a directory to review what happened) and AI sessions
(continuing work, debugging a regression) rely on. Keep it stable.

## Directory layout

```
output/
└── YYYY-MM-DD/
    └── HH-MM-SS-<kind>[-<sub>]/
        ├── action-log.json
        ├── judgment.json              (only when judge ran)
        ├── recording-raw.webm         (only when a trim ran; the pre-trim video)
        ├── recording.webm             (the deliverable)
        └── run.json
```

- **`YYYY-MM-DD/`** — date partition. Cheap rotation for `ls` / janitorial scripts.
- **`HH-MM-SS-<kind>[-<sub>]/`** — one run, one directory. `<kind>` is the run type
  (`eval` / `regression` / `prototype` / etc.); `<sub>` adds a case identifier when
  the kind produces many runs in one session (e.g. `regression-gmaps-search-stay-natural`).
- All filenames are **kebab-case**; no spaces, no underscores, no hash suffixes.

## File purposes

### `run.json` — the canonical entry point

The single structured record per run. Open this first to know what the run was
about and how it went. Schema lives at `src/domain/run-record.ts` (`RunRecord`).

Top-level shape (also see the schema for the authoritative form):

```jsonc
{
  "schemaVersion": 1,
  "request":       { "url", "prompt", "durationMs", "viewport", "headless" },
  "performance":   { ... },              // the full Performance A produced —
                                         // rationale, steps[].reasoning, rehearsal,
                                         // planDurationFit, unresolvedTargets,
                                         // blockerDismissal, totalEstimatedMs
  "metrics":       { ... },              // RunMetrics — total wall, recon ms,
                                         // intentSatisfaction, replanCount, …
  "directorReport":{ "totalMs", "stepsExecuted", "replanCount", "endReason" },
  "config":        { ... },              // public config snapshot (apiKey redacted)
  "timings":       { "startedAt", "endedAt" }
}
```

What you can answer just by reading `run.json`:

| Question | Path |
|---|---|
| What did the user ask for? | `request.prompt` + `request.url` + `request.durationMs` |
| What did A plan, and why? | `performance.rationale` (overall) + `performance.steps[].reasoning` (per step) |
| Did the rehearsal walk diverge? | `performance.rehearsal.divergences` / `reconverges` / `truncated` |
| Did any requested click get dropped? | `performance.unresolvedTargets` |
| Did F1's plan-duration fit hold? | `performance.planDurationFit.status` / `ratio` |
| Was the intent satisfied? | `metrics.intentSatisfaction.level` + `note` |
| How long did each phase take? | `metrics.setupMs` / `reconMs` / `recordingMs` / `trimMs` |
| Did the Director re-plan on camera? | `directorReport.replanCount` + `endReason` |
| Was a blocker dismissed first? | `performance.blockerDismissal.dismissed` |
| What config affected this run? | `config` (full public snapshot — useful for repro) |

### `action-log.json` — runtime event timeline

What actually happened during the recording window, in time order, with
timestamps and coordinates. Schema: `src/domain/action-log.ts`. Consumed by
the `intentSatisfaction` matcher (`src/core/record-job-runner.ts`),
`trimVideo` (`src/infra/ffmpeg.ts`), and `videoRelativeTrimWindow` (clock-drift
correction). Do not mix planning / config / metric data into this file —
they live in `run.json`.

### `judgment.json` — judge verdict

Present only when the run was graded (`npm run eval`, and any future
self-judging path). The full `RecordingJudgeReport` (see
`src/domain/recording-judge.ts`) — 5-dimension rubric, per-dimension
evidence, overall verdict.

### `recording.webm` — the deliverable

The final, trimmed video. This is what a user "gets back" from a job.

### `recording-raw.webm` — pre-trim raw video

The exact bytes Playwright's `recordVideo` produced before ffmpeg trim. Only
present when a trim ran (i.e. the session had a `recording` window). Useful
for debugging trim-window / clock-drift problems. When no trim ran, the raw
video is the deliverable and lands as `recording.webm` directly (no
`recording-raw.webm` is written in that case).

## Things that are intentionally NOT in the layout (yet)

- **`recon-snapshot.yaml`** — the ref-tagged accessibility tree A saw when
  planning. Useful for "why did A pick that stale ref?" type debugging.
  Skipped today because it requires extending the `IReconnoiterer` port and
  the existing `unresolvedTargets` channel + Performance step `reasoning`
  already covers most cases. Revisit if a real "I need to see A's tree"
  use-case shows up.
- **`recon-draft.json`** — the raw `ReconDraft` (pre-target-resolution).
  Same rationale — most of A's thinking is preserved on
  `performance.steps[].reasoning` after resolution.

## For future selves (AI continuing in a new session)

If you need to understand what a previous run did:

1. Read `run.json` — that's your map. The structured fields tell you 90% of
   what you need.
2. Open `recording.webm` only if you need to *see* what played (e.g. for
   naturalness review the judge can't articulate).
3. Open `action-log.json` only if you're debugging the timeline (a specific
   click landed wrong, a trim looks off).
4. `judgment.json` is the judge's structured verdict — read this instead of
   re-running the judge.

**Do not** parse the run directory name to learn what the run was; the name
is just a stable identifier. Parse `run.json.request` instead.
