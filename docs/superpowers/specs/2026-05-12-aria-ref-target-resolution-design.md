# ref-tagged a11y snapshot target resolution — design

**Status:** approved 2026-05-12. Sub-project under the "robustness sweep"
direction (`docs/findings/2026-05-11-robustness-sweep-1.md` finding 6 — target
resolution / disambiguation). Supersedes the earlier "increment A" sketch in
`docs/findings/2026-05-12-similar-projects-eval.md` (that doc proposed merely
attaching `role/accessibleName/landmark` to `ObservedElement`; this goes
further — it removes the fuzzy re-match step entirely, which is the actual bug).

## Context

Today the recon LLM emits, per click/type step, a `target: { description }`
free-text string ("the sign-in link in the header"). `LlmReconnoiterer.resolveSteps`
then calls `session.resolveTarget(description)` → `stagehand.observe(description)`
→ a *second* fuzzy LLM match back to a selector + bbox. When the page has
several elements with the same visible text, or the description is a verbose
paraphrase, that second match picks the wrong element (or a 0×0 wrapper) → a
dead click → the rehearsal walk diverges → reconverge re-fails the same hard
target → truncated recording / `intentSatisfaction: unknown`. This is robustness
sweep P2/P3 and finding 6. The interactive-first ranking + dead-click sweep +
reconverge hard-check we added are *recovery* patches; they don't remove the
fuzzy re-match that causes it.

`microsoft/playwright-mcp` solved exactly this for the agent case: it never asks
the LLM to produce a re-matchable description. It gives the LLM a **deterministic
ref-tagged accessibility tree** (`- button "Submit" [ref=e2]`) and the LLM picks
a `ref`; the `ref → locator` resolution is deterministic (`page.locator('aria-ref=e2')`),
not a fuzzy match. The human-readable element description still travels alongside
the ref — but only for logging/permission, not for matching.

Playwright **1.59** (our installed `playwright-core`) ships this natively:
`page.ariaSnapshot({ mode: 'ai', depth })` returns the ref-tagged YAML tree
(including `<iframe>` contents) and `page.locator('aria-ref=eN')` resolves a ref
back to a locator. No private API, no re-implementing the ARIA accessible-name
algorithm.

**Goal alignment** (`docs/goals.md`): this serves #3 (intent satisfied — removes
the most common wrong-click failure mode) and #6 (AI-first, no hardcoded
heuristics — the fuzzy `resolveTargetCandidates` re-match in the hot path *is*
the heuristic; the LLM should plan, not re-match; recovery is "reconverge with a
fresh snapshot", not a fuzzy matcher), and a little of #2 (fewer dead clicks →
fewer stalls). It also nets out cheaper (#5): recon's LLM calls drop from "1×
`observeAll` + N× `resolveTarget` retries" to "1× recon (+ occasional
reconverge)". It does **not** serve #1 (cursor synthesis — parked).

## Scope

This is an internal refactor of the **recon draft → resolved `Performance`** leg.
- **New:** `IPageSession.ariaSnapshot()` + `IPageSession.resolveAriaRef(ref)`;
  `ReconDraftSchema` (the recon LLM's output, finally Zod-parsed — Hard Rule 2,
  currently violated via `as unknown as` casts).
- **Changed:** `LlmReconnoiterer.recon()` (uses `ariaSnapshot` not `observeAll`,
  parses `ReconDraftSchema`, resolves refs eagerly); the reconverge callback
  (fresh `ariaSnapshot` per reconverge, LLM re-picks refs); the reconnoiterer
  prompts; the rehearsal walk loses its `UNRESOLVED_SENTINEL`/`keepUnresolvable`
  branches (refs are resolved eagerly — nothing is deferred).
- **Unchanged:** `PerformanceSchema` / `PerformanceStep` / `ResolvedTargetSchema`
  / `ExpectAfterSchema`; `PerformanceDirector` (playback, re-plan checkpoint,
  graceful degradation, `replanMinRemainingMs`); `RecordJobRunner` / `RunMetrics`;
  the blocker dismisser; `clickResolvedTarget`'s coord-or-selector click logic;
  trim / judge. The on-camera `Performance` artifact is byte-for-byte the same
  shape — it just gets built more reliably.

Out of scope: replacing the recon screenshot input (kept — vision still helps for
"is this visually a banner", and we need bboxes anyway); a `resolveTargetWithContext`
port method (the "increment C" idea — not needed once resolution is deterministic);
making recon a full snapshot→act→snapshot agent (rejected — it blurs the §0034
recon/playback boundary, which is the architecture we want to keep).

## Architecture & boundaries

### New port surface — `IPageSession` (`src/ports/page-session.ts`)

```ts
/**
 * Ref-tagged accessibility snapshot of the page in its current state — Playwright
 * `mode: 'ai'`: every node carries `[ref=eN]`, `<iframe>` contents are inlined.
 * The refs are valid ONLY in the page state at snapshot time; a navigation or a
 * subsequent ariaSnapshot() invalidates them. Returns the YAML-ish tree as text.
 */
ariaSnapshot(opts?: { depth?: number }): Promise<string>;

/**
 * Resolve a ref from the most recent ariaSnapshot() into a *durable* target —
 * "durable" meaning a derived CSS/text selector that survives a page reset, not
 * the transient `aria-ref=eN`. Returns the same {selector, bbox, description}
 * shape as resolveTarget(). bbox is page-absolute (y includes scrollY), matching
 * the rehearsal walk's storage convention. Returns null if the ref is stale /
 * detached / unresolvable. Never throws.
 */
resolveAriaRef(ref: string): Promise<ResolvedTarget | null>;
```

Both implemented in `StagehandSession` (it owns the Playwright `Page` — Hard Rule
1 holds; same as `observeAll` today):
- `ariaSnapshot` → `page.ariaSnapshot({ mode: 'ai', depth: opts?.depth ?? config.ariaSnapshotDepth })`,
  wrapped so a thrown error → empty string (caller decides; mirrors `observeAll().catch(() => [])`).
- `resolveAriaRef(ref)` → `const loc = page.locator('aria-ref=' + ref)`; `await loc.boundingBox({ timeout: 1000 })`
  (→ null if no box); convert viewport-relative `y` to page-absolute via `+ await this.readScrollY()`;
  derive a durable selector via the existing `locatorSelectorFallback` machinery and a readable name
  via `elementMetaOfSelector`/the locator's accessible text; return `{ selector, bbox, description }`.
  Any failure → `null`, logged at debug. Never throws.

### `observeAll` / `resolveTarget` / `quickFind*` — fate

- `observeAll`, `resolveTarget` — **no longer used by recon or reconverge.** Decision
  (per YAGNI's converse — don't delete a port method you'll re-add): **keep them in
  the port**, mark with a doc-comment "not used by recon since the aria-ref refactor;
  retained for future consumers (cursor synth, HTTP API)". The `observeAll`
  implementation's `stagehand.observe()` call stays. *(If a reviewer wants them gone,
  removing them is a trivial follow-up — but not in this change.)*
- `resolveTargetCandidates` (interactive-first ranked list) — **kept and still used**:
  its sole live caller is the rehearsal walk's `sweepResolveCandidates` dead-click
  recovery (when a resolved step's selector dies at walk time, sweep the other
  candidates that fuzzy-match its accessible name). That's a *recovery* path; a fuzzy
  fallback there is acceptable.
- `quickFindInViewport` / `quickFindOnPage` — unchanged, untouched.

### New domain schema — `src/domain/recon-draft.ts`

The recon LLM's output, finally parsed (Hard Rule 2):

```ts
import { z } from 'zod';
import { ExpectAfterSchema, ScrollEasingSchema, PerformanceKeySchema } from './performance.js';

// scroll/key/dwell/back/done are identical in the draft and in Performance —
// share these so the two discriminated unions can't drift.
const ScrollStepShape = z.object({
  kind: z.literal('scroll'),
  deltaPx: z.number().int().refine((n) => Math.abs(n) >= 50 && Math.abs(n) <= 4000, 'deltaPx magnitude must be 50..4000'),
  durationMs: z.number().int().min(200).max(4000),
  easing: ScrollEasingSchema,
  dwellAfterMs: z.number().int().min(0).max(2000),
  reasoning: z.string().min(1),
});
const KeyStepShape = z.object({ kind: z.literal('key'), key: PerformanceKeySchema, reasoning: z.string().min(1), expectAfter: ExpectAfterSchema.optional() });
const DwellStepShape = z.object({ kind: z.literal('dwell'), durationMs: z.number().int().min(100).max(8000), reasoning: z.string().min(1) });
const BackStepShape = z.object({ kind: z.literal('back'), reasoning: z.string().min(1), expectAfter: ExpectAfterSchema.optional() });
const DoneStepShape = z.object({ kind: z.literal('done'), reasoning: z.string().min(1) });

export const ReconDraftStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    ref: z.string().min(1),
    anticipationMs: z.number().int().min(0).max(3000),
    reasoning: z.string().min(1),
    expectAfter: ExpectAfterSchema.optional(),
  }),
  z.object({
    kind: z.literal('type'),
    ref: z.string().min(1),
    text: z.string().min(1),
    preMs: z.number().int().min(0).max(2000),
    keystrokeMs: z.number().int().min(0).max(500),
    reasoning: z.string().min(1),
  }),
  ScrollStepShape, KeyStepShape, DwellStepShape, BackStepShape, DoneStepShape,
]);
export type ReconDraftStep = z.infer<typeof ReconDraftStepSchema>;

export const ReconDraftSchema = z.object({
  prompt: z.string().min(1),
  steps: z.array(ReconDraftStepSchema).min(1),
  totalEstimatedMs: z.number().int().nonnegative(),
  rationale: z.string().min(1),
});
export type ReconDraft = z.infer<typeof ReconDraftSchema>;
```

`performance.ts` is refactored to *export* `ScrollEasingSchema` / `PerformanceKeySchema`
(already exported) and to build its own scroll/key/dwell/back/done branches from the
same shared `z.object` constants (move them to `recon-draft.ts`? no — keep the shared
constants in `performance.ts`, since `Performance` is the more fundamental type, and
import them into `recon-draft.ts`). `UNRESOLVED_SENTINEL` is **removed** from
`performance.ts` (no longer used).

## Data flow — recon()

```
recon(input, session):
  blockerDismissal = await dismissBlockers(session)              # unchanged
  snapshot = await session.ariaSnapshot()                        # NEW (was: observeAll)
  userText = buildReconUserText(input, snapshot)                 # prompt: aria tree + "pick targets by ref" rules
  draftRaw = await callReconLlm([system, {text:userText, image:input.screenshot}])  # screenshot kept; wrapper-recovery + 1 retry unchanged
  draft   = ReconDraftSchema.parse(draftRaw)                     # NEW: real parse; failure (after retry) -> ReconError
  steps   = await resolveDraftSteps(draft.steps, session)        # ref -> ResolvedTarget (ms, no LLM); non-target kinds pass through; ref miss -> drop step + log
  if steps.length === 0: throw ReconError("zero usable steps after ref resolution")

  # rehearsal walk (config.reconRehearse) — see below
  finalSteps, rehearsalTrace = (walk over steps) or (steps, undefined)

  perf = { prompt: draft.prompt, durationMs: input.durationMs, steps: finalSteps,
           totalEstimatedMs: draft.totalEstimatedMs, rationale: draft.rationale,
           ...(rehearsalTrace ? {rehearsal: rehearsalTrace} : {}),
           ...(blockerDismissal ? {blockerDismissal} : {}) }
  return PerformanceSchema.parse(perf)                           # unchanged
```

`resolveDraftSteps(rawSteps, session)`:
- `kind` not `click`/`type` → push through unchanged (it's already a `PerformanceStep`).
- `click`/`type` → `r = await session.resolveAriaRef(step.ref)`; if `!r || !r.bbox` → log
  `{ ref, kind }` "recon ref did not resolve — step dropped", skip. Else build the
  `PerformanceStep`: `{ ...stepWithoutRef, target: ResolvedTargetSchema.parse({ selector: r.selector, bbox: r.bbox, description: r.description }) }`.
- No `keepUnresolvable` parameter, no sentinel. Refs are only valid right now — resolve now.

Why this is fine for below-the-fold targets: the aria tree covers the whole DOM (not
just the viewport), so most below-fold elements *are* in the snapshot. Truly lazy /
virtualized content isn't — but then the LLM picks the *nearest* ref + a `scroll` step;
if the resulting plan diverges at walk time, reconverge gets a *fresh* post-scroll
snapshot and re-picks. AI-first recovery, no fuzzy matcher.

## Data flow — rehearsal walk + reconverge

- **Walk body** (`src/adapters/recon/rehearsal.ts`): unchanged in spirit. It already
  re-`boundingBox()`s the resolved selector at the actual scroll position (the "stale
  deep XPath" recovery) — keep that. `sweepResolveCandidates` still calls
  `session.resolveTargetCandidates(step.target.description)` to find replacements when
  the primary selector dies — `description` is now the accessible name, which is good
  fuzzy-match fodder. **Remove** the `UNRESOLVED_SENTINEL` branches (no sentinel
  targets reach the walk anymore; the `step.target.selector === UNRESOLVED_SENTINEL`
  re-resolve-via-`resolveTarget(description)` path goes away).
- **Reconverge callback** (`LlmReconnoiterer.recon`'s inner `reconverge`): was
  `observeAll()` + a screenshot → now `ariaSnapshot()` + a screenshot. The diverged-
  state snapshot's refs are valid for *that* state. LLM emits a `ReconDraft` →
  `ReconDraftSchema.parse` → `resolveDraftSteps(parsed.steps, ctx.session)` (resolved
  immediately, at the diverged scroll position, refs still valid). The reconverge
  prompt keeps its "HARD CHECK: a reconverged plan must still contain a `click`/`key`
  step that does the requested action" line.

## Prompts (`src/prompts/reconnoiterer.ts`)

- `buildReconUserText(input, snapshot)` — was `(input, observed[])`. The "interactive
  elements" section becomes the aria tree verbatim, preceded by: *"Below is the page's
  accessibility tree. Every actionable node carries a stable id like `[ref=e7]`. For
  every `click` and `type` step you MUST set `"ref"` to the id of the node you want to
  act on — copy it exactly (`"e7"`, not `"ref=e7"`, not a description). Pick the most
  specific actionable node (a `link`/`button`, not a `generic` wrapper around it). If
  the node you want is not in the tree (lazy-loaded content), pick the nearest visible
  node and add a `scroll` step toward it — the rehearsal walk will recover."* PRIORITY
  #1 (a step per requested action, re-check before emit) and the scroll-to-target
  discipline lines stay.
- `buildReconvergeUserText({ intent, divergedStep, observedUrl, snapshot })` — `observed[]`
  → `snapshot` (same treatment). Keeps the HARD CHECK line and the "pick a DIFFERENT,
  more specific node than the one that failed" line.
- The two functions' old `observed`-list formatting helpers are deleted.

## Config (`src/infra/config.ts`)

Add `ariaSnapshotDepth: z.coerce.number().int().min(1).max(100).default(25)` (env
`ARIA_SNAPSHOT_DEPTH`). Raw block: `ariaSnapshotDepth: process.env.ARIA_SNAPSHOT_DEPTH`.
`.env.example`: add a line. (25 is a starting guess — bounds the tree on huge content
sites; `mode: 'ai'` already prunes `generic`/text-only nodes. Re-tune after the first
real run.)

## Error handling (Hard Rule 3 style)

- `session.ariaSnapshot()` internal throw → `StagehandSession` returns `''`; `recon()`
  proceeds with an empty tree (LLM works from the screenshot alone — degraded, not dead;
  same posture as `observeAll().catch(() => [])`).
- `ReconDraftSchema.parse` failure → caught, runs the existing wrapper-recovery + one
  emphatic-JSON retry; still failing → `ReconError('RECON_FAILED', …)`.
- `session.resolveAriaRef(ref)` never throws; `null` → that step is dropped + logged.
- Zero usable steps after resolution → `ReconError` (unchanged).
- `rehearse()` throw → `ReconError('rehearsal walk failed', err)` (unchanged).

## Testing

- `tests/unit/domain/recon-draft.test.ts` (new): `ReconDraftSchema` accepts a well-formed
  draft and every step kind; rejects a `click` with no `ref`, negative durations, an empty
  `steps` array, and a `click` step that carries a `target` field (draft ≠ Performance);
  `ReconDraftStepSchema` round-trips scroll/dwell/back/done identically to `PerformanceStepSchema`.
- `tests/fakes/fake-page-session.ts`: add `ariaSnapshotResult = ''` (settable) and
  `resolveAriaRefResults: Record<string, ResolvedTarget | null> = {}`; implement
  `ariaSnapshot()` → returns the field, `resolveAriaRef(ref)` → `this.resolveAriaRefResults[ref] ?? null`.
- `tests/unit/adapters/recon/llm-reconnoiterer.test.ts`: rework — mock LLM returns a
  draft with `ref`s; assert `ariaSnapshot` was called, `resolveAriaRef` was called per
  ref, a step whose ref maps to `null` is dropped, the resulting `Performance` is
  well-formed and carries `target`s built from the fake's `ResolvedTarget`s. Delete the
  `keepUnresolvable`/sentinel cases. Keep the `LlmReconnoiterer + blockerDismisser`
  describe (unchanged behavior). Keep `extractFirstJsonObject` tests.
- `tests/unit/adapters/recon/rehearsal.test.ts`: delete the `UNRESOLVED_SENTINEL` /
  "re-resolve a sentinel target" cases; keep the dead-click sweep cases (they use
  `resolveTargetCandidates`, still alive); keep bug-2 (SEARCH flow no spurious diverge)
  and bug-3 (unverifiable expectAfter cleared) cases. Reconverge-path cases: the fake's
  reconverge stub now returns a `ReconDraft`-shaped object.
- `tests/unit/prompts/reconnoiterer.test.ts`: assert `buildReconUserText` output contains
  the aria tree text and the "set `ref`" instruction; `buildReconvergeUserText` likewise +
  the HARD CHECK line.
- `tests/unit/infra/config.test.ts`: `ariaSnapshotDepth` default 25 / env override / bounds.
- `tests/unit/adapters/agent/stagehand-session.test.ts` (or wherever the adapter unit tests
  live): if `ariaSnapshot`/`resolveAriaRef` can be exercised with the existing fake-`Page`
  harness, add a case (`page.ariaSnapshot` returns a canned tree → `session.ariaSnapshot()`
  returns it; `page.locator('aria-ref=eN').boundingBox()` canned → `resolveAriaRef` returns
  the expected `ResolvedTarget`; locator throws → `null`). If the adapter has no such
  harness, skip — covered by the integration smoke.
- Regression suite (`tests/regression/`): no structural change; run it. The Wikipedia
  "Cat → Felidae" / HN "open a comment" cases should stop being dead-click flakes — but
  the asserts stay categorical (no exact-step asserts).
- After the unit suite is green: one real `npm run prototype:stagehand` (Recordly canonical
  + a multi-same-text-link site) → eyeball recon token count + wall-clock against the
  CLAUDE.md "Measured performance" table; update that table if it moved.

## Migration / commit shape

One feature branch... no — per the established mode, committed directly to `main` in
bite-sized commits (schema → port methods + fake → adapter impl → reconnoiterer rewrite →
prompts → walk cleanup → config → tests → docs). Each commit type-checks and the unit
suite passes. Docs touched in the same commits: `CLAUDE.md` (state table row for the
aria-ref refactor; bump test count), `docs/decisions.md` (new ADR §0036 — "ref-tagged
a11y snapshot target resolution; replaces the fuzzy `observe()` re-match"), `docs/glossary.md`
("aria-ref snapshot" / "recon draft"), `docs/findings/2026-05-11-robustness-sweep-1.md`
(finding 6 → resolved), `docs/architecture.md` (the recon leg description, new port methods).

## Open knobs (decided here, noted for the reviewer)

- `observeAll`/`resolveTarget` stay in the port (deprecated-by-comment, not removed) — see above.
- `ariaSnapshotDepth` default = 25, env-overridable — re-tune after the first real run.
