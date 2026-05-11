# Rehearsing Reconnoiterer — design (§0034 follow-up, Task #21)

**Status:** approved 2026-05-11. Sub-project of the "prophet recording" direction.

## Context

§0034 moved all reasoning off-camera: `IReconnoiterer.recon()` produces a
fully pre-resolved paced `Performance`, and `PerformanceDirector` plays it back
deterministically on-camera, with one gated re-plan checkpoint + graceful
degradation as the recovery path.

The first integration run (`docs/findings/2026-05-11-prophet-first-integration.md`)
showed the architecture's central risk materialising: `recon()` plans purely
from a screenshot + `observeAll()` list and calls `session.resolveTarget(desc)`
per click target — but never *checks* that the resolved element does what the
description says. On the canonical "click 简体中文, slow scroll" scenario,
`resolveTarget("简体中文")` came back with a wrong element (a deep React `<div>`,
not the README language link). The on-camera click did nothing → graceful
degradation closed the recording incomplete (`intentSatisfaction: partial`).

Verdict went `robotic` → `probably_synthetic` (the dead-air problem was the §0034
"B fix"), but recon-plan quality is now the bottleneck. The user's framing all
along — "先收集到所有的信息，执行的时候精准无误的就做了，像一位先知一样" — calls for a recon
that *rehearses*: walks its draft against the live page off-camera, sees what
really happens, fixes the plan, then performs the *verified* sequence on-camera.

This spec covers that: the **rehearsing reconnoiterer**.

## Goal

`recon()` walks its draft `Performance` against the live page **off-camera**
(before `beginRecording()`), replaces each action step's guessed `expectAfter`
with the *observed* post-action state, reconverges (capped) where the draft
diverges from reality, resets the page to the start URL, and returns a
**verified** `Performance`. On-camera playback then rarely diverges.

## Architecture & boundaries

- All changes land inside `LlmReconnoiterer.recon()` + the recon prompt + small
  additions to `src/domain/performance.ts` and `src/infra/config.ts`. **The
  `IReconnoiterer` port signature is unchanged** (`recon(input, session): Promise<Performance>`
  — `session` is already a parameter).
- New adapter-internal component **`RehearsalWalker`** (`src/adapters/recon/rehearsal.ts`):
  input = a draft `Performance` (targets already resolved) + an `IPageSession` +
  a `reconverge` callback; output = a verified `Performance` + a `RehearsalTrace`.
  `recon()` orchestrates: `plan → resolve targets → RehearsalWalker.walk() →
  reset → return`.
- New config knobs (`src/infra/config.ts`, all defaults sensible):
  - `reconRehearse` — boolean, **default `true`**. `RECON_REHEARSE=false` skips
    the walk (recon falls back to today's behaviour: resolve targets, return the
    LLM's plan, `rehearsal` field omitted).
  - `reconRehearsalBudgetMs` — number, default `30000`. Wall-clock cap on the
    whole walk. Exceeded ⇒ truncate at the current step + graceful tail.
  - `reconReconvergeMax` — number, default `2`. Cap on reconverge LLM calls
    during a walk.

`RehearsalWalker` depends only on the `IPageSession` port (all needed methods
already exist: `scroll`, `clickSelector`, `type`, `pressKey`, `goBack`,
`currentUrl`, `observeAll`, `quickFindOnPage`, `screenshot`, `goto`,
`waitForVisualStability`) plus a `reconverge` callback the caller supplies. No
port changes.

## The walk algorithm (graduated)

For each step of the draft, in order:

- **`scroll`** → `session.scroll(deltaPx, { durationMs: <instant> })` — jump,
  no animation, no `dwellAfter`. (`<instant>` = `1` ms, or a 0-safe path in the
  scroll helper; the *plan's* `durationMs`/`easing`/`dwellAfterMs` are kept
  unchanged for the on-camera render — the walk just doesn't render them.)
- **`dwell`** → skip (no wait). Plan's `durationMs` kept for the on-camera render.
- **`click` / `type` / `key` / `back`** → execute it (click: `clickSelector`
  on the already-resolved selector; type: `clickSelector` then `type`; etc.),
  then **observe**: read `currentUrl`, `observeAll()` / `pageDiagnostic()`, and
  `quickFindOnPage()` for each item the LLM put in `expectAfter.visibleText`.
  Decide **diverged** if ANY of:
  1. the step carried an `expectAfter` and it is now not satisfied;
  2. URL is `about:blank`;
  3. (click/type only) the page is **unchanged** after the action — URL didn't
     change AND the page diagnostic / observed-element signature didn't change —
     i.e. a dead element was clicked (this is the §0034 failure we must catch);
  4. `clickSelector` threw (element absent / not actionable).
  - **Not diverged** → **rewrite the step's `expectAfter`** to the *observed*
    state: `urlContains` = a stable substring of the new URL (if it changed);
    `visibleText` = 1–2 stable, visible anchor strings from the new page. This
    is the "prophet" core — on-camera the `expectAfter` is measured, not guessed.
    (If the action genuinely changes nothing observable and that's expected —
    rare for clicks, possible for some `type` — leave `expectAfter` empty.)
  - **Diverged** →
    - If reconverge budget remains AND wall-clock budget remains: call the
      `reconverge` callback — "step N (description) intended X, actually Y
      happened; here is the current page (screenshot + observed list); give me
      the remaining plan from here." Resolve the new steps' targets (drop
      unresolvable ones, as today), replace the draft's tail from this point,
      continue the walk from the replacement point. Increment `reconverges`.
    - Else (reconverge cap hit, or wall-clock budget exhausted): **truncate** —
      drop the remaining steps, append a graceful tail (one gentle `scroll` +
      a short `dwell` + `done`), end the walk. Set `truncated` (and `timedOut`
      if it was the wall-clock cap).

After the walk (completed, truncated, or timed out): `session.goto(input.url)`
+ `session.waitForVisualStability()` — reset the page so the on-camera run
reproduces the start state.

## The returned `Performance`

- `steps` = the steps the walk executed (with their `expectAfter` rewritten to
  observed values; `scroll`/`dwell` keep their original animation/dwell params),
  plus any reconverge-spliced or truncation-tail steps.
- `src/domain/performance.ts` gains an optional `rehearsal` field on
  `PerformanceSchema`:
  ```ts
  rehearsal: z.object({
    walkedSteps: z.number().int().nonnegative(),
    divergences: z.number().int().nonnegative(),
    reconverges: z.number().int().nonnegative(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
  }).optional()
  ```
  This is the operator canary (analogous to §0034's `replanCount`): a high
  `divergences` / `truncated: true` means the LLM's first-draft planning is
  weak for that site.
- `RunMetrics` (in `src/core/record-job-runner.ts`) surfaces the rehearsal
  trace (e.g. `rehearsalDivergences`, `rehearsalTruncated`, or just the whole
  object).
- `reconRehearse=false` ⇒ no walk, no `rehearsal` field, behaviour as today.

## Action log

The walk runs entirely before `beginRecording()`, so it is **not** recorded in
the action log (which only spans the recording window). The walk's outcome goes
into `RunMetrics` + an `info` log line from `LlmReconnoiterer`. No action-log
schema change.

## Error handling & edge cases

| Situation | Behaviour |
|---|---|
| Unexpected throw mid-walk (not a known "click failed" — the session genuinely broke) | Throw `ReconError` — recon as a whole fails, surfaced to the caller (same as today's recon failures). |
| `goto(startUrl)` reset fails / lands on a different page (redirect, walk left site logged-in) | Not fatal: log a warning, still return the verified `Performance`. The on-camera §0034 gated re-plan + graceful degradation is the backstop. |
| Wall-clock budget (`reconRehearsalBudgetMs`) exceeded | Truncate at the current step + graceful tail; `timedOut: true`. |
| Reconverge cap (`reconReconvergeMax`) hit on a divergence | Truncate at the current step + graceful tail; `truncated: true`. |
| Reconverge LLM call itself throws | Treat as cap-hit: truncate + graceful tail (log the error). |
| Non-idempotent page state (walk logged in / added to cart / submitted a form) | Known limitation — documented. The project's target sites (public browsing) generally don't hit this. (Mitigation via a fresh browser context is out of scope — too heavy.) |
| `scroll(deltaPx, { durationMs: 0 })` math (`smoothScrollTo` divide-by-zero) | The walker uses a safe instant scroll (1 ms duration, or a guarded 0 in the helper) — pick whichever is cleaner when implementing; either is fine. |

## Testing

- **`RehearsalWalker` unit tests** (with `FakePageSession`, scripting the
  per-step `currentUrl` / `observeAll` / `clickSelector` outcomes):
  - no divergence → returned steps' `expectAfter` rewritten to the fake's
    observed values; `scroll`/`dwell` params untouched.
  - a dead click (fake: page unchanged after click) → diverged → `reconverge`
    callback invoked → tail replaced with the reconverger's steps.
  - reconverge cap hit → truncated at the divergence + graceful tail
    (`truncated: true`, `done` present).
  - wall-clock budget exceeded → truncated (`timedOut: true`).
  - `reconRehearse` plumbing: when off, `walk()` isn't called and recon returns
    the un-walked plan with no `rehearsal` field.
- **`LlmReconnoiterer` unit tests**: extend the existing mock-based tests to
  cover the `plan → resolve → walk → reset` orchestration order, and that the
  reset calls `goto(input.url)` + `waitForVisualStability`.
- **`Performance` schema test**: `rehearsal` optional field round-trips; absent
  is valid.
- **Integration** (`npm run prototype:stagehand` on the canonical scenario):
  expect `intentSatisfaction: complete` (the 简体中文 target is resolved+verified,
  or reconverged to the right one), `replanCount: 0` on-camera, and the §0030
  judge's `pacing` ≠ `fail`. Update `CLAUDE.md`'s measured-performance block,
  `docs/decisions.md` §0034 (note the rehearsal addition), and the findings doc
  with the result.

## Preserves

- The `IReconnoiterer` / `IDirector` / `IPageSession` port signatures.
- `PerformanceDirector`'s on-camera gated re-plan (`replanMinRemainingMs`) +
  graceful degradation — unchanged; it's the backstop for when reset doesn't
  reproduce the start state.
- The `intentSatisfaction` metric, the §0030 judge, the §0031 rendering knobs,
  the regression suite, the action-log + trim pipeline.
- `reconRehearse=false` gives back exactly today's recon behaviour (an escape
  hatch for fast dev iteration / debugging).

## Out of scope (separate task)

The scroll-renders-"fast & linear" finding from the §0034 judge run — a
rendering / pacing issue (video fps over a short scroll? `smoothScrollTo`
easing? recon not translating "slow scroll" into slow/chunked scrolling?).
Investigate and fix in its own small task, decoupled from the rehearsal.

## Open risks

- **Walk cost.** Even "graduated" (instant scrolls, skipped dwells), walking a
  20-step multi-page plan + 1–2 reconverge calls adds ~10–30 s to an already
  ~40–60 s recon. Off-camera, so it doesn't touch the deliverable — but it
  slows dev iteration. `reconRehearse=false` is the escape hatch; the canary
  (`divergences`/`truncated` in `RunMetrics`) tells us how often it earns its keep.
- **Reset fidelity.** `goto(startUrl)` + stability is a best-effort reset; sites
  with sticky state or A/B routing may not reproduce. Mitigation is the §0034
  backstop; if this proves common, a fresh-context reset is a future option.
- **Reconverge can loop.** A site that diverges every step would burn the
  reconverge cap immediately and truncate — which is the correct, bounded
  failure (a short-but-smooth incomplete recording), not a hang.
