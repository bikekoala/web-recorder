# Findings — index

Each file here captures an investigation: what we saw, what we tried, what we
learned. Most feed into an ADR in `../decisions.md` once the fix is chosen;
some are pure observations.

**Read these top-down by status.** Start with active findings — they describe
the current state of open quality questions. Historical findings remain as
project memory: the ADRs reference them and they record decisions that have
been overridden.

## Active (informs current behavior)

- [`2026-05-15-claude-code-large-codebase-analysis.md`](./2026-05-15-claude-code-large-codebase-analysis.md)
  — analysis of the Anthropic "Claude Code in large codebases" article against
  this repo. Slimmed CLAUDE.md, added a stop-hook for end-of-session cleanup,
  added skills + adapter-local CLAUDE.md. The proposals + their rationale.
- [`2026-05-15-humanize-bake-off.md`](./2026-05-15-humanize-bake-off.md) — A/B
  vs cloakbrowser's `humanize` wrapper. 12-cell judge bake-off shows their
  full stack regresses pacing+intentExecution (typing blows the per-step
  budget) but their Bezier mouse curve is a genuine motionQuality win. Decided
  to fold just `humanMove` into our `clickAt`; strategy switch deleted.
- [`2026-05-13-overnight-sweep.md`](./2026-05-13-overnight-sweep.md) — **the
  canonical current-state findings doc.** 31 evals across 24 distinct
  scenarios. Patterns P1–P18 classified into v1-contract graceful-degrade
  (P6, P9, P15, P16, etc.) and in-scope bugs (P7+P11+P14 fixed; P13
  partially fixed via §0042). Has a `MORNING TL;DR` at the top — read that
  first.
- [`2026-05-13-wild-prompts-sweep.md`](./2026-05-13-wild-prompts-sweep.md) —
  the predecessor sweep (4 cases × 4 prompt shapes) that surfaced patterns
  P1–P6 and seeded ADR §0041 (`goto` step kind). The morning-after
  validation re-frames P6 as architectural.
- [`2026-05-13-plan-duration-fit.md`](./2026-05-13-plan-duration-fit.md) —
  the analysis that became ADR §0040 (F1: plan/duration fit). Why the
  prompt-side gets the natural-filler responsibility and `fitPlanToBudget`
  becomes a tight ±20 % corrector.
- [`2026-05-12-similar-projects-eval.md`](./2026-05-12-similar-projects-eval.md)
  — competitor / adjacent-project scan. Not a bug doc; a "what's out there
  / could we use any of it" reference.

## Historical (the fix landed; kept for context)

These describe issues that have since been addressed. The ADR cited in
each is the canonical record of what we did; the finding remains because
its specific evidence (which run on which page produced which artifact)
is the why the ADR exists.

- [`2026-05-12-recordvideo-clock-drift.md`](./2026-05-12-recordvideo-clock-drift.md)
  — recordVideo's frame timeline lagged the action-log clock. **Addressed
  by ADR §0037** (video-relative trim window).
- [`2026-05-11-robustness-sweep-1.md`](./2026-05-11-robustness-sweep-1.md)
  — first robustness sweep on the prophet pipeline (§0034). **Largely
  superseded by `2026-05-13-overnight-sweep.md`**, which re-runs the same
  shape of investigation against the post-§0040/§0041 pipeline.
- [`2026-05-11-prophet-first-integration.md`](./2026-05-11-prophet-first-integration.md)
  — first prophet integration run; flagged architecture validity questions
  that were resolved by the final §0034 design + the §0036 ariaSnapshot
  resolution model.
- [`2026-05-11-judge-first-batch.md`](./2026-05-11-judge-first-batch.md)
  / [`2026-05-11-judge-second-batch.md`](./2026-05-11-judge-second-batch.md)
  — the two judge-regression batches that fed into ADRs §0030
  (`IRecordingJudge`), §0031 (naturalness rendering bundle), and §0033
  (1-to-1 bipartite intent-matching).
- [`2026-05-11-intent-satisfaction-overcount.md`](./2026-05-11-intent-satisfaction-overcount.md)
  — the github-multistep over-counting failure (a single click satisfied
  3 hints via a shared "link" token). **Addressed by ADR §0033** (1-to-1
  bipartite assignment).
- [`2026-05-11-github-whitescreen.md`](./2026-05-11-github-whitescreen.md)
  — the github white-screen episode that the §0030 video judge surfaced.
  Specific recording-pipeline glitch, kept for the artifact even though
  no longer reproducible against the current stack.

## When to add a new finding

A finding earns its place if it (a) describes a reproducible artifact and
(b) is hard to re-derive from the code. Bug fixes are NOT findings — they
go straight into the commit message. Findings are for the "why did the
recording look like that?" investigations that turn into ADRs.

A finding earns its place HERE (not elsewhere) if the evidence will help
a future reader understand a choice. Otherwise the chat / PR comment is
the right place.
