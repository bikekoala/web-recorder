---
name: run-eval
description: Interpret `bun run eval` canary output — what each row means, when to fix-in-place vs file a follow-up task, which env knobs override the scenario
---

# `bun run eval` — canary interpretation

Single-scenario regression check before declaring a change done. `bun run regression` is the multi-site sweep. This skill is what to *do* with `bun run eval`'s output.

## Invocation

```bash
# Default: canonical Recordly README "click 简体中文 + slow scroll", 10s.
bun run eval

# Override (any combination):
EVAL_PROMPT="去 https://news.ycombinator.com/ 看看头条故事"  \
EVAL_DURATION_MS=10000                                       \
EVAL_DEVICE=desktop                                          \
EVAL_HEADLESS=false                                          \
bun run eval
```

`EVAL_HEADLESS` defaults to `process.platform !== 'darwin'`, so:
- on macOS the browser appears on screen (good for visual sanity-check)
- on Linux/CI it stays headless

Override with `EVAL_HEADLESS=true` only when you have a reason — e.g. running on macOS but capturing video for a remote session.

## Output anatomy

The script prints a table of rows, each with `✓ / ⚠ / ✗` status. Then a verdict line:

- **`PASS`** — every row is ✓.
- **`CONCERNS`** — at least one ⚠ but bright-line specs are intact. Exit 0.
- **`FAIL`** — a bright-line spec violated. Exit 1.

### Bright-line specs (hard-fail)

| Row | Spec | Hard-fail when |
|---|---|---|
| `trimmed-video duration` | ±10% of `EVAL_DURATION_MS` (goals.md #2) | `\|pct\| > 10` |
| `total wall-clock` | < 60s (goals.md #5) | overshoot |
| `trimmed-video size` | < 100 MB (goals.md #2) | overshoot |

### Quality / robustness rows (CONCERNS, advisory)

| Row | Meaning | When to act |
|---|---|---|
| `intentSatisfaction` | `complete` / `partial` / `unmet` / `unknown` from §0033 bipartite matching against the prompt | `unmet`/`partial` may be the v1-contract success path (§0042) when content truly isn't reachable. Treat as a bug only if the missed target IS on the page. |
| `planDurationFit` | `ok` / `compressed-hard` / `underfilled` from `fitPlanToBudget` (§0040). The eval line also prints `A claimed Xs` — A's self-reported total before B's recomputation. | `compressed-hard` ⇒ A planned over-budget by >20%. Check the gap between `A claimed` and `est`: large gap (>3s) = A's arithmetic is broken (recon-prompt fix); small gap = A knowingly over-planned (recon-judgement fix). `underfilled` ⇒ A didn't fill the budget; check `rationale` for irreconcilability flag. |
| `on-camera re-plans` | should be 0 for a healthy run | >0 means the Director hit an `expectAfter` mismatch mid-recording — open the action-log. |
| `director endReason` | `done` / `budget` are healthy | anything else = degraded run; inspect. |
| `recon time` | recon LLM wall-clock | grows on heavy pages or with truncated aria trees — usually site, not us. |
| `recon LLM cost` | $ per run vs goals.md #5 $0.01 target | currently ~2.5× over; tracked in F2 ADRs. Not a per-run gate. |
| `judge verdict` | Gemini 3.1 Pro 5-dim verdict — `looks_human` / `probably_human` / `probably_synthetic` / `robotic` | the visual ground-truth signal. `probably_synthetic` + a passing intentSatisfaction usually means pacing/metronomic-motion regressed. |
| `rehearsal walk` | `walkedSteps / divergences / reconverges` | divergences > 0 ⇒ A's first draft hit a stale page state; reconverges > 0 ⇒ recon LLM was called again mid-walk. Both are fine in moderation; clusters suggest a prompt-discipline regression. |
| `blocker dismissal` | rounds it took to clear cookie/consent overlays | 0 is normal on familiar sites; if a new site needs >3 rounds the dismisser may need a hint. |

## Diagnosis playbook

### "trimmed-video duration FAIL ±X%"

1. Is `planDurationFit.status` `ok`? If yes, the miss is downstream — `Director.endReason`, `recon time` blowing the wall-clock, or video-relative trim drift. Check `directorReport.totalMs`.
2. If `compressed-hard`: A is over-planning. Compare `A claimed` vs `est` (see plan-cost diagnosis row above).
3. If `underfilled`: A under-planned. Check the rationale for "irreconcilable" — that's §0042 v1-contract success.

### "judge verdict probably_synthetic / robotic"

The 5 dimensions (motionQuality / pacing / intentExecution / recovery / visualCoherence) come with per-dim explanations. Open `judgment.json` in the run dir; the per-dim `note` names the time-stamped artifact ("@2s: cursor jumps with no easing"). Usually one dim is the offender.

### "intentSatisfaction unknown"

Means the metric couldn't match the prompt to verifiable actions — typically because the plan has 0 verifiable click/type steps. Open the plan's `steps[]`. If 0 acting steps were planned, that's a recon-judgement issue (A chose pure scroll-and-read on a short prompt). If acting steps were planned but dropped to `unresolvedTargets`, that's the §0042 graceful path.

## When to fix-in-place vs file a follow-up task

| Symptom | Action |
|---|---|
| Bright-line FAIL on a change you just made | Fix in this commit. Don't ship the regression. |
| CONCERNS on a row your change is unrelated to | File a follow-up task; don't bundle. |
| Same CONCERNS row warns across 2+ unrelated runs | Promote to a finding under `docs/findings/` if the pattern is hard to re-derive from code. |
| `judge verdict` flips between runs (variance, not a step-change) | Re-run once or twice; the judge has natural noise on edge cases. Don't chase. |

## Outputs

Every eval writes to `output/<YYYY-MM-DD>/<HH-MM-SS>-eval/`. Canonical entry is `run.json`; see `docs/output-layout.md` for the file map. The video is `recording.mp4` (or `.webm` on the VP8-only ffmpeg fallback path).

## Related skills + docs

- `docs/goals.md` — the canary's bright-line specs come from here.
- ADR §0040 (`docs/decisions.md`) — `planDurationFit` semantics.
- ADR §0042 — graceful unmet contract.
- `docs/findings/README.md` — overnight sweeps with the canonical patterns.
