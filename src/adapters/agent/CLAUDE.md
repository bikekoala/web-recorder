# `src/adapters/agent/` — Stagehand / Playwright / cloakbrowser adapter

This is **the** IPageSession implementation. It's the only place in the codebase that's allowed to import Stagehand, Playwright primitives, or cloakbrowser. Everything else goes through `IPageSession` (`src/ports/page-session.ts`).

## Files

- **`stagehand-session.ts`** (~1850 lines) — the adapter itself. **Large file** — section guide below.
- **`aria-helpers.ts`** — pure helpers around `pruneAriaSnapshot` (drop generic/text wrapper noise from Playwright's ai-mode tree). Used by `ariaSnapshot()`.

## `stagehand-session.ts` section guide

Approximate line ranges (drift with edits; trust the headers / function names over the numbers):

| Range | What lives here |
|---|---|
| ~1-200 | Module imports, top-level pure helpers: `__webRecorder` init script (page-visible scroll easing), `waitForVisualStability` core impl (quiet-timer + deadline race). |
| **class StagehandPageSession** ||
| ~248-430 | **`start()`** — the launch sequence. mkdir output, mkdtemp user-data-dir, **`cloakEnsureBinary`** (fetches the ~150 MB stealth Chromium on first run), pick the Playwright `devices[...]` preset for desktop/mobile/tablet, **`launchPersistentContext`** (with cloakbrowser's `executablePath` + `getDefaultStealthArgs()`), inject the init script, resolve CDP URL, hand the CDP socket to Stagehand. Phase-timing comments in here — keep them; the wall-clock investigation hinged on them. |
| ~432-525 | **`stop()`** — close stagehand, capture `recording-raw.webm`, copy + trim, build `SessionArtifacts`. |
| ~527-585 | Navigation + sensing primitives: `goto`, `waitForVisualStability`, `currentUrl`, `screenshot`, `pageTitle`, `focusedValue`, `historyDepth`, `scrollY`, `scrollableHeight`. |
| ~586-630 | **`ariaSnapshot()`** — the recon planner's only structured view of the page. Calls `page.ariaSnapshot({mode:'ai'})`, then `pruneAriaSnapshot`. If the result is over `ARIA_SNAPSHOT_MAX_CHARS`, re-snapshot scoped to `<main>`; still over → truncate at a line boundary with a `... [snapshot truncated]` marker. The truncation is the signal `unresolvedTargets` annotates as "page tree too large to analyze in full". |
| ~631-660 | **`resolveAriaRef(ref)`** — turns a planner-emitted `ref=eN` into a durable `{selector,bbox,description}`. Deterministic, no LLM. The hot path for click/type targets. |
| ~660-770 | The fallback resolve chain: `observeAll`, `resolveTarget`, `resolveTargetCandidates` (Stagehand `observe()` fuzzy), `resolveByVisibleText` (deterministic role/text Playwright lookup — works on giant pages where `observe()` overflows). Order matters: §0038 chain is `resolveAriaRef → resolveByVisibleText → resolveTargetCandidates → drop`. |
| further down | `clickSelector`, `clickAt` (cloakbrowser Bezier `humanMove` integration), `clickByDescription`, `scroll`, `wait`, `type`, `pressKey`, `goBack`, `pageDiagnostic`, `quickFindInViewport`, `quickFindOnPage`, action-log appenders. |

## Local conventions

1. **`stagehand.page.*` fall-through is allowed here, nowhere else.** When a primitive isn't on Stagehand's surface (scroll easing, mouse path, raw CDP), reach `this.page` directly. Outside this dir, all access goes through `IPageSession`.
2. **All Playwright/Stagehand exceptions are translated into `DomainError` at the boundary** (Hard Rule 3). Look for `ElementNotFoundError`, `PageDiagnosticError` wrappers — never re-throw raw Playwright errors past this file.
3. **`ariaSnapshot()` vs `observe()`** — prefer the snapshot. The §0036 work made the snapshot the planner's primary input. `observe()` (LLM-driven enumeration) is the *fallback* for `resolveTargetCandidates`. Don't reintroduce it as a primary path.
4. **CloakBrowser's `humanize` wrapper is NOT used.** We took the Bezier mouse curve (`humanMove`) only; everything else (typing rhythm, scroll easing, dwell timing) is owned by `src/prompts/reconnoiterer.ts` (§0031 + §0039 + §0040). See `docs/findings/2026-05-15-humanize-bake-off.md` for why.
5. **Phase-timing logs in `start()`** are load-bearing diagnostics — they pinpointed the 18-second-launch misattribution (it was the page-goto, not cloakbrowser). Don't strip them in a "cleanup" pass.

## When picking up a task here

- Recon planner asks for something the page session doesn't expose → add a method to `IPageSession`, implement here, add a fake in `tests/fakes/fake-page-session.ts`.
- A click chain falls through too often → instrument `resolveAriaRef`'s null branch + the visible-text branch's hit rate, **don't** add another fuzzy fallback step.
- A new stealth requirement → think first whether cloakbrowser already covers it (canvas / WebGL / audio / fonts / GPU / WebRTC are all done at the C++ layer). Only add init-script patches for things cloakbrowser explicitly leaves to the integrator.

## See also

- ADR §0036 (ariaSnapshot resolution), §0038 (giant-page chain), §0043 (HTTP API + device parameter) in `docs/decisions.md`.
- `docs/findings/2026-05-15-humanize-bake-off.md` — humanize bake-off rationale.
- `src/ports/page-session.ts` — the interface contract this file must keep.
