# Evaluating three adjacent projects — can they replace web-recorder, or improve it?

**Date:** 2026-05-12. Triggered by: user spotted three similar-looking OSS projects
and asked whether they can replace this project (whole or in part), or whether they
diverge from our north star.

Projects under review:

- `browser-use/browser-harness` — <https://github.com/browser-use/browser-harness>
- `microsoft/playwright-cli` — <https://github.com/microsoft/playwright-cli>
- `microsoft/playwright-mcp` — <https://github.com/microsoft/playwright-mcp>

**TL;DR.** None can replace the core. All three are "let an LLM drive a browser to
*get a task done*" tools; web-recorder is a *two-phase* system (off-camera
recon + rehearsal → deterministic on-camera paced playback) whose product is a
recording that **looks like a human used the page** — cursor trails, anticipatory
pauses, scroll inertia, naturalness grading. None of the three touch that, and an
LLM driving a browser *live* would produce a robotic recording (LLM tail latency =
stalls, teleporting clicks, no cursor path) — the exact failure mode `docs/goals.md`
non-negotiables #1 and #2 exist to prevent. The only thing worth taking is **one
technique** from the playwright-mcp lineage (accessibility-tree-based target
resolution), and it's a self-contained change inside the Stagehand adapter, not a
dependency. Detail below.

---

## What each project actually is

| Project | What it is | Maintained | Does it do video / cursor synth / naturalness? |
|---|---|---|---|
| `browser-use/browser-harness` | A ~1000-LOC "thin, editable CDP harness" — connects an agent directly to Chrome over CDP, **self-heals** (the agent writes missing helper code at runtime), ships community **domain-skills** (per-site selector/flow playbooks: GitHub, LinkedIn, Amazon…), optional Browser Use Cloud (stealth, headless, captcha-solving). Python. | Yes | No. Not mentioned at all. |
| `microsoft/playwright-cli` | A CLI for Playwright aimed at **coding agents** — token-efficient ("does not force page data into the LLM"), navigate/click/type/screenshot/cookies/uploads, persistent profiles, a live dashboard, **trace + video recording**, network/console inspection. Installs as a Claude Code / Copilot skill. Active (v0.1.13, May 2026, ~10k★). | Yes | Has video + trace recording (for debugging), but no cursor synthesis / human-motion simulation. |
| `microsoft/playwright-mcp` | An **MCP server** exposing 40+ browser tools to interactive LLM agents, built on Playwright's **accessibility tree** rather than pixels ("no vision models needed, operates purely on structured data"); opt-in: network mocking, storage, **video + trace recording**, PDF, DevTools highlight/annotate, coordinate-based vision interactions. | Yes | Video/trace recording (debugging), no cursor synthesis; interactions are deterministic, not human-simulated. |

Microsoft positions playwright-cli and playwright-mcp as a pair: the CLI optimises
*token efficiency* for coding agents; the MCP server optimises *persistent state +
rich introspection* for exploratory automation. Neither audience is ours (a headless
deterministic recording pipeline).

---

## Verdict per project

### `browser-use/browser-harness` — ❌ not a fit, nothing to borrow

- As an `IPageSession` replacement: it's Python; our codebase is TS. The value it
  adds ("live agent self-improves at runtime") is **orthogonal** to our model — we
  recon *once* off-camera, then replay deterministically. We don't want the agent
  improvising while the camera rolls.
- Its **domain-skills** (pre-stored per-site selectors/flows) collide with
  `docs/goals.md` non-goal #1 (open-ended — we will never know which site the user
  records) and the project's "no hardcoded heuristics / no point-fixes" rule
  ([[no-hardcoded-logic]]). A curated selector library for GitHub/LinkedIn is the
  opposite of "ask the LLM at the moment it sees the page" (goal #6).
- Self-healing-at-runtime is interesting but is an *agent-loop* idea, not a
  *recording-pipeline* idea. No.

### `microsoft/playwright-cli` — ❌ not relevant

- It's a developer / coding-agent CLI, not an embeddable library layer. There's no
  "swap it in for the Stagehand adapter" story.
- Its video recording isn't better for us — we already do Playwright `recordVideo` +
  ffmpeg trim, and we need to post-process a cursor overlay on top, which a generic
  recorder doesn't help with.
- "Don't force page data into the LLM" / token efficiency is a sound principle, but
  Stagehand's `observe()` is already targeted; the marginal win is ~zero.
- *One minor borrow noted below: trace recording as a debugging aid.*

### `microsoft/playwright-mcp` — ⚠️ don't adopt the project; do borrow one technique

- Adopting the MCP server itself would be a **regression in paradigm**: MCP is a
  protocol for interactive agents that converse turn-by-turn. Our pipeline is
  deterministic and headless; we'd be wrapping a chatty protocol around a
  straight-line process for no benefit.
- But the **"resolve targets via the accessibility tree, not pixels"** idea is real,
  it's *cheap and deterministic*, and it lands squarely on a known open gap
  (finding 6 — target resolution / disambiguation; see
  `2026-05-11-robustness-sweep-1.md` and `2026-05-11-prophet-first-integration.md`).
  We don't need playwright-mcp for it — Stagehand hands us a real Playwright `Page`,
  and `CLAUDE.md` explicitly allows using raw Playwright primitives inside the
  Stagehand adapter. We need the *technique* (`page.accessibility.snapshot()` /
  `getByRole` / accessible-name + nearest-landmark), not the package.

---

## Why the core can't be replaced (the architectural moat)

`docs/goals.md` non-negotiable #1: *"Looks human, not scripted… No teleports. No
sudden jumps… Pauses are anticipatory, not LLM tail latency."* #2: *"Fluid, no
visible stalls… LLM thinking is hidden under animation. Setup time happens BEFORE
recording — not in the deliverable."*

All three projects are "LLM acts → page reacts → LLM acts again", on-camera, in real
time. That produces:

- multi-second frozen frames while the LLM thinks (we've measured ~30–50 s of dead
  air from a *single* on-camera re-plan — `2026-05-11-prophet-first-integration.md`);
- teleporting clicks (`page.click(selector)` jumps the cursor — no approach, no
  dwell);
- no cursor trail at all (none of them synthesize one — `ICursorSynthesizer` is our
  ⏳ layer).

Our answer is the **prophet pipeline**: do all the thinking off-camera (recon → a
rehearsal walk against the live page that re-resolves targets at the right scroll
position, rewrites `expectAfter` to observed state, reconverges on divergence), then
on-camera replay a *pre-resolved, paced* `Performance` deterministically. That two-
phase split *is* the product. No "agent that drives a browser" can substitute for it
without becoming it.

So: not a replacement for `core/`, not for the reconnoiterer, not for the director.
And — separately — there's no reason to swap the `IPageSession` adapter right now:
Stagehand's `observe`/`act`/`extract` + self-healing still fit; swapping to
browser-harness (wrong language) or playwright-mcp (wrong paradigm) is a lateral move
at best.

---

## The one thing worth doing: accessibility-tree-assisted target resolution

### Where it plugs in

Today (`src/adapters/agent/stagehand-session.ts`):

```
resolveTargetCandidates(desc)
  └─ stagehand.observe(desc)                 ← always an LLM call (~3–8 s, $)
       └─ for each match: elementMetaOfSelector()   ← bbox + interactive?
            └─ rankCandidates()              ← only: dedup by bbox position;
                                                interactive elements before wrappers
resolveTarget(desc) = resolveTargetCandidates(desc)[0]
```

- `rankCandidates` (`stagehand-session.ts:68-78`) has **no semantic ranking**: when
  `observe()` returns several same-text "Felidae" links it can only dedup by
  position — it can't tell "the link inside the taxobox table" from "the link in the
  article body" from "the one in the nav". That's the root of the Wikipedia
  Cat→Felidae gap (`CLAUDE.md` "Known remaining recon-plan-quality gap").
- We *already* have half the machinery unused: `quickFindInViewport` /
  `candidateLocators` (`stagehand-session.ts:563-626`) use `getByRole('link'|'button',
  {name})` + `getByText` — but only the **Director** uses them, at playback time.
  `resolveTargetCandidates` never touches them; it always pays for `observe()`.
- `elementMetaOfSelector` (`stagehand-session.ts:1486-1512`) already reads
  `getAttribute('role')` — it's one step from also reading the accessible name and
  the nearest landmark.

Consumers that would use the extra context:

- the rehearsal walk's dead-click sweep `sweepResolveCandidates`
  (`src/adapters/recon/rehearsal.ts:285-322`) — currently blind-clicks every
  candidate in turn; with landmark context it can prefer candidates *not* in the same
  landmark as the one that just failed;
- the LLM `reconverge` callback (`src/adapters/recon/llm-reconnoiterer.ts:113-164`) —
  the observed list it hands the LLM could annotate each element `(role=link, in:
  infobox table)` so the LLM picks a *different* one on a real basis.

Domain types touched: `ObservedElement` (`src/ports/page-session.ts:310`) gains
optional `role?` / `accessibleName?` / `landmark?`. `ResolvedTarget`
(`src/domain/performance.ts:32-49`) unchanged (still `{selector, bbox, description}`)
— the accessibility context is a resolution-time aid, not part of the persisted plan.

### Three increments — recommend A, optionally B, **not** C

**A — small, AI-first, do this first.** Attach accessibility context to candidates;
don't rank by it in code; pass it through to the two consumers above so the *LLM*
(and the cheap sweep) can use it.
- `elementMetaOfSelector` also reads accessible name + walks up to the nearest
  `<nav>/<main>/<aside>/<header>/<footer>` or `role=*` landmark or enclosing
  table/section + its heading.
- `ObservedElement` carries it; `rankCandidates` is unchanged (ranking by "is this in
  a nav vs main" *in code* would be exactly the hardcoded-heuristic we don't do —
  [[no-hardcoded-logic]], goal #6; surfacing it to the LLM keeps it AI-first).
- `sweepResolveCandidates` prefers candidates whose `landmark` differs from the dead
  one's before falling back to "try them all".
- `reconverge`'s observed list annotates each element with its role + landmark.
- Footprint: all inside the Stagehand adapter + one optional port field. Nothing in
  `core/`.

**B — medium, optional, after A ships and the regression suite is green.**
Deterministic-first short-circuit in `resolveTargetCandidates`: when the target
description looks like literal visible text (short, no descriptive adjectives), try
`getByRole`/`getByText` first; **unique** hit → return it, *skipping the `observe()`
LLM call entirely* (a `docs/goals.md` #5 "cheap to run" win — `observe()` is ~3–8 s
+ tokens, and `resolveSteps` does N of them); ≥2 hits or 0 hits → fall back to
`stagehand.observe()` exactly as today.
- Risk: deterministic matchers are brittle (text must be ~exact); Stagehand's
  `observe()` handles fuzzy descriptions ("the blue signup button", "the language
  switcher") — so the short-circuit must only fire on description shapes that look
  literal, and the `observe()` fallback must stay. Note P2 in `2026-05-11-robustness-
  sweep-1.md`: the recon-LLM's descriptions are often verbose paraphrases ("Link to
  23 comments for the first post …"), which is precisely *why* we're forced onto
  `observe()` today — B helps the canonical "click 简体中文" case, not the verbose-
  paraphrase case (that one wants a *cleaned* description, which is finding 6's
  "C and beyond").

**C — large, not now.** A new `resolveTargetWithContext` port method threading the
step's position-in-plan / prior-text context into resolution. Over-engineered for the
current stage; A already gets most of the disambiguation value with a fraction of the
surface area.

### Open questions before implementing A

- "Nearest landmark" for an element with no enclosing landmark (a bare `<a>` in a
  flat `<body>`) — fall back to nearest preceding heading text? nearest sibling text?
  Decide a deterministic, cheap rule (don't over-invest — it's a hint, not ground
  truth).
- Accessible name: `getByRole` exposes it; reading it for an *arbitrary already-
  resolved selector* needs either `locator.getAttribute('aria-label')` ∥ text content
  (cheap, approximate) or a full a11y-tree lookup (`page.accessibility.snapshot({root})`
  — heavier). Start with the cheap approximation; only reach for the full snapshot if
  it proves insufficient.
- This is A-ranked here but it's the *same* "finding 6" bucket the robustness sweep
  already partly addressed (interactive-first ranking, dead-click sweep, reconverge
  hard-check). Slot it as the next increment of finding 6, not a new workstream.

---

## Minor borrow (unrelated to the three projects' core, but both MS tools ship it)

Both playwright-cli and playwright-mcp bundle Playwright **trace recording**
(`trace.zip` — DOM snapshots + screenshots + network + console, replayable in
`npx playwright show-trace`). We only have `recordVideo` + ffmpeg trim today. Worth
considering: optionally `context.tracing.start()` **during the off-camera recon +
rehearsal phase** (Stagehand gives us the real Playwright `Page`/context) so when a
recording goes wrong we can replay exactly what recon saw and clicked. Not a product
feature — a dev-experience aid. Low effort, low priority; flagged so it's on record.

---

## Decision

- Do **not** adopt any of the three projects as a layer/adapter replacement.
- Treat playwright-mcp's "accessibility-tree, not pixels" as a *technique* and fold
  increment **A** (accessibility context on candidates → surfaced to the LLM + the
  dead-click sweep) into finding 6's next pass. **B** (deterministic-first short-
  circuit) after A is green. **C** deferred.
- Park "trace during recon" as a low-priority dev-experience follow-up.
- No code changed in this pass — this is the research record. When A is picked up,
  open it under finding 6 (and an ADR only if a port shape actually changes — adding
  an *optional* `ObservedElement` field probably doesn't warrant one; confirm at
  implementation time).
