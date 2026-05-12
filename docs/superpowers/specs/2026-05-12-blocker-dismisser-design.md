# Off-camera blocker dismisser — design (Task #20)

**Status:** approved 2026-05-12. Sub-project under the "robustness sweep"
direction (`docs/findings/2026-05-11-robustness-sweep-1.md`, finding "Task #20").

## Context

§0034 removed `BlockerPrelude` (it was coupled to the deleted `IFastDecider`).
The interim stopgap — "the recon prompt asks the LLM to plan an accept-cookies
click as the first `Performance` step" — failed in robustness sweep #1 on
`theguardian.com`: the recon planned a click on "the first headline" but never
a *dismiss-consent* step, so every click landed on the GDPR consent overlay,
didn't navigate, the rehearsal walk diverged, the reconverge picked another
headline (still behind the overlay), re-failed → truncate → `intentSatisfaction:
unknown`, a 6 s scroll-only recording. Likely the consent iframe loads *after*
the recon screenshot, and/or the recon LLM just doesn't reliably plan it.

A consent/dismissable overlay covering the page is extremely common on the open
web. Dismissing it **off-camera, before the `Performance` plays** — like the old
`BlockerPrelude` — is the right fix: free (not in the deliverable), and it lets
recon plan against the *real* page. Serves goals.md non-negotiables #2 (no
visible stalls — blocker-hunting isn't in the deliverable) and #3 (recording
starts on the page the user actually wants to see).

## Scope

Dismiss: **cookie/consent banners** (click "Accept all" — preferred over
"Reject"/"Manage") and **"X-to-close" modals** (newsletter signup, app-install
nag — click the close/X/skip). Do **not** touch: region/age gates (need a real
choice, and they're rare), paywalls / login-walls (can't be dismissed — leave
them; recon plans around what's visible).

## Architecture & boundaries

- New port **`IBlockerDismisser`** (`src/ports/blocker-dismisser.ts`):
  ```ts
  export interface IBlockerDismisser {
    dismiss(session: IPageSession): Promise<BlockerDismissalReport>;
  }
  export interface BlockerDismissalReport {
    rounds: number;        // how many detect→click iterations ran (0 = page was clean)
    dismissed: string[];   // descriptions of the elements we clicked, in order
    stillBlocked: boolean; // a blocker remained when we stopped (cap hit / error / LLM said it couldn't be dismissed)
  }
  ```
- New adapter **`LlmBlockerDismisser`** (`src/adapters/blocker/llm-blocker-dismisser.ts`),
  constructed `{ client, model }` (an OpenAI-shaped client pointed at OpenRouter
  + a model id) — the same pattern as `LlmReconnoiterer`. Depends only on the
  `IPageSession` port + the LLM client. No core imports, no Stagehand import.
- **`LlmReconnoiterer`** gains an optional ctor field `blockerDismisser?: IBlockerDismisser`.
  When present it calls `dismiss(session)`:
  1. at the top of `recon()`, once the page is at `input.url` (before
     `observeAll`/screenshot — so recon plans against a clean page);
  2. inside the rehearsal walk's page reset, right after `goto(input.url)` and
     before `waitForVisualStability` (the walk reloads the page, which brings
     the overlay back — the on-camera Director must see a clean page too).
  `null` ⇒ skipped entirely (today's behaviour). `IReconnoiterer.recon(input,
  session)` signature is **unchanged**.
- **`prototype-stagehand.ts`** + the regression suite construct
  `new LlmBlockerDismisser({ client, model: config.llmBlockerModel })` (reusing
  the OpenRouter client they already build) and pass it into `LlmReconnoiterer`.
- New config (`src/infra/config.ts`):
  - `blockerDismiss` — bool, default **`true`**. `BLOCKER_DISMISS=false` ⇒ recon
    constructs no dismisser, behaviour as today (the `RunMetrics` field is `null`).
  - `blockerDismissMaxRounds` — number, default `3`. Cap on detect→click iterations.
  - `blockerDismissMaxMs` — number, default `10000`. Wall-clock cap on the whole `dismiss()` call.
  - `llmBlockerModel` — string, default = `llmModel` (i.e. `openai/gpt-4o-mini`). Vision-capable, fast, cheap. (Model names live in config per goals.md #6.)
- **`RunMetrics`** (in `src/core/record-job-runner.ts`) gains `blockerDismissal: BlockerDismissalReport | null`. The dismissal runs before `beginRecording()`, so it is **not** in the action log (same as the rehearsal walk) — `RunMetrics` + one `info` log line from `LlmBlockerDismisser` is the whole surface. No action-log schema change.

## The dismiss algorithm (probe → detect → click → re-probe loop)

```
dismiss(session):
  rounds = 0; dismissed = []
  deadline = now + blockerDismissMaxMs

  signals = session.pageDiagnostic().blockerSignals      // catch null → []
  if signals is empty: return { rounds: 0, dismissed: [], stillBlocked: false }   // common case — zero LLM calls

  while rounds < blockerDismissMaxRounds and now < deadline:
    rounds++
    shot = session.screenshot()                          // catch null
    observed = session.observeAll()                      // catch [] — list includes "Accept all cookies" etc. as text
    decision = LLM(shot, observed):  // strict JSON
       { blocker: bool, dismissTargetDescription?: string, rationale?: string }
       prompt: "Is a cookie/consent banner OR a dismissable modal (newsletter,
                app-install) covering the page? If yes, return the description of
                the element that dismisses it — prefer 'Accept all' over
                'Reject'/'Manage'/'Customize', prefer a close/X/Skip. If there is
                no such overlay, or it's a paywall / login-wall you can't dismiss,
                return blocker:false."
    if decision parse fails: break (stillBlocked = true)
    if not decision.blocker: break (stillBlocked = false)   // page is clear (or undismissable)
    target = session.resolveTarget(decision.dismissTargetDescription)   // catch → null
    if not target: break (stillBlocked = true)              // can't find it — don't thrash
    try: click target (coord-click if its bbox is in the viewport, else clickSelector)
    except: break (stillBlocked = true)
    dismissed.push(decision.dismissTargetDescription)
    session.waitForVisualStability().catch(ignore)
    signals = session.pageDiagnostic().blockerSignals
    if signals is empty: break (stillBlocked = false)       // dismissed everything
    // else loop — a second overlay (cookie banner → then a subscribe modal)

  // loop exit by cap/deadline with signals still non-empty ⇒ stillBlocked = true
  return { rounds, dismissed, stillBlocked }
```

`stillBlocked: true` is informational, not fatal — recon proceeds. The §0034
backstops cover the remainder (see "Error handling").

## Error handling & edge cases

| Situation | Behaviour |
|---|---|
| `pageDiagnostic()` throws / returns null | Treat `blockerSignals` as `[]` ⇒ skip the loop, return clean. |
| LLM call throws / response unparseable | `break` the loop, `stillBlocked: true`, return. Log a warning. |
| LLM says `blocker: true` but gives no `dismissTargetDescription` | Treat as `blocker: false` (nothing to click) ⇒ break, `stillBlocked: false`. |
| `resolveTarget` returns null / throws | `break`, `stillBlocked: true`. (We won't blind-click.) |
| The click throws (element vanished / not actionable) | `break`, `stillBlocked: true`. |
| `screenshot()` returns null | Still make the LLM call with `observed` only (text-only); the model can usually decide from the element list + the fact `blockerSignals` fired. |
| Whole `dismiss()` throws unexpectedly (session genuinely broke) | `LlmReconnoiterer.recon()` catches it, logs a warning, proceeds without a dismissal — never fails recon over a best-effort prelude. `RunMetrics.blockerDismissal` = `{ rounds: 0, dismissed: [], stillBlocked: true }`. |
| A blocker appears *during* the recording (after `beginRecording()`) | Out of this component's reach. Handled by the §0034 backstops: the recon prompt keeps a (slimmed) DISMISS-MODAL rule, and the on-camera gated re-plan + graceful degradation. |
| Walk-reset re-dismiss vs. the recon-start dismiss | Both run; the second one usually has `blockerSignals` empty already (the page state from the first run mostly persists across the walk's `goto`, but cookies set by "Accept all" suppress the banner on reload) ⇒ a cheap no-op probe. |

## Preserves

- `IReconnoiterer` / `IDirector` / `IPageSession` port signatures.
- The recon prompt's DISMISS-MODAL rule (kept, slightly slimmed — now a backstop
  for mid-recording overlays, not the primary mechanism).
- `PerformanceDirector`'s on-camera gated re-plan + graceful degradation.
- `pageDiagnostic().blockerSignals` (already exists from the §0021 era — reused
  as the cheap "maybe a blocker?" gate, no new heuristic needed).
- `blockerDismiss=false` ⇒ exactly today's behaviour.

## Testing

- **`LlmBlockerDismisser` unit tests** (`FakePageSession` + a fake LLM client
  scripting per-round outcomes):
  - clean page (`pageDiagnostic().blockerSignals` empty) ⇒ `rounds: 0`,
    `stillBlocked: false`, **zero** LLM calls.
  - one consent banner: `blockerSignals` non-empty → LLM `{blocker:true,
    dismissTargetDescription:"Accept all cookies"}` → resolves+clicks → re-probe
    empty ⇒ `rounds: 1`, `dismissed: ["Accept all cookies"]`, `stillBlocked: false`.
  - banner then modal: round 1 clears the banner but re-probe still non-empty →
    round 2 clears the modal ⇒ `rounds: 2`, two `dismissed` entries.
  - `blockerDismissMaxRounds` hit (every re-probe still non-empty) ⇒ `rounds`
    capped, `stillBlocked: true`.
  - `blockerDismissMaxMs` hit ⇒ stops, `stillBlocked: true`.
  - LLM says `{blocker:false}` ⇒ `rounds: 1` (one detect call), `stillBlocked: false`.
  - `resolveTarget` returns null ⇒ `rounds: 1`, `stillBlocked: true`, no click.
  - LLM throws / returns garbage ⇒ caught, `stillBlocked: true`, never throws.
- **`LlmReconnoiterer` tests**: with a dismisser wired, `recon()` calls
  `dismiss()` before `observeAll`, and the rehearsal walk's reset calls it after
  `goto(input.url)`. With `blockerDismisser` = `undefined`, `dismiss()` is never
  called (today's path).
- **Schema/metrics test**: `RunMetrics.blockerDismissal` round-trips; `null` is valid.
- **Integration** (`PROTOTYPE_URL=https://www.theguardian.com`,
  `PROTOTYPE_PROMPT="浏览一下首页头条，点击第一条新闻打开它，然后慢慢往下读"`,
  18 s, `PROTOTYPE_HEADLESS=true`): expect `blockerDismissal.rounds ≥ 1` with a
  consent dismissal, and `intentSatisfaction` no longer `unknown` (a real
  headline click in the final `Performance`). Re-run the canonical Recordly case
  too — expect `blockerDismissal.rounds: 0` (no overlay) and no regression
  (`intentSatisfaction: complete`, judge unchanged). Update `CLAUDE.md` (state
  table + measured-perf), `docs/decisions.md` (a §0021-revival ADR or a §0034
  note), the robustness-sweep findings doc, `docs/glossary.md` ("blocker
  dismisser"), `docs/naturalness-catalog.md` (the blocker rows).

## Out of scope (separate task)

- Region/age gates (a real-choice dialog) — different problem, rarer.
- Off-camera dismissal of blockers that genuinely require navigation away (a
  full interstitial site you must click through) — current scope is single-page
  overlays only.
- The Wikipedia-class "click a target above the post-scroll position" recon-plan
  gap (robustness sweep finding 6) — its own task.
