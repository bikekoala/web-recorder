# 2026-05-15 — Anthropic "Claude Code in large codebases" analysis

Source: <https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start>

This is a **diagnostic finding, not a change record**. It compares the
article's recommendations against the current state of this repo and surfaces
gaps. Concrete change proposals live at the bottom — they need user sign-off
before anything is applied (per the existing memory rule: AI-first decisions,
but propose-before-apply for setup/scaffolding changes).

## Article's 10 take-aways (verbatim where short)

1. **Lean & layered CLAUDE.md.** "Root file for the big picture, subdirectory
   files for local conventions." "The root file should be pointers and critical
   gotchas only; everything else drifts into noise."
2. **Maintenance cadence.** "Teams should expect to do a meaningful
   configuration review every three to six months." Workarounds written for
   weaker models become noise once a stronger model ships.
3. **Subagents split exploration from editing.** Read-only subagent maps a
   subsystem to a findings file; main agent edits with the full picture.
4. **Hooks for self-improvement, not just guardrails.** "A stop hook can
   reflect on what happened during a session and propose CLAUDE.md updates
   while the context is fresh." A start hook loads per-module context. Linting
   / formatting belongs in hooks, not in prompts.
5. **Skills via progressive disclosure.** Reusable expertise belongs in a
   `.claude/skills/` entry, scoped by path, loaded only when relevant — not in
   CLAUDE.md.
6. **Context limiting.** "Too much context loaded into every session degrades
   performance, while too little context leaves Claude to navigate blind."
   Monorepos: initialize in subdirectories, not at the repo root.
7. **Navigation aids.** Codebase-map markdown at root, layered to subdir maps
   in big trees. `@-mention` specific files. LSP for symbol search beats grep
   for string search. `.ignore` files to exclude generated artifacts.
8. *(No explicit guidance on breaking large changes.)*
9. **Subdirectory-scoped test/lint.** "Running the full suite when Claude
   changed one service causes timeouts and wastes context on irrelevant
   output." CLAUDE.md at the subdir level specifies its commands.
10. **Anti-patterns:** CLAUDE.md for reusable expertise (→ skills); prompts for
    things that should run automatically (→ hooks); loading everything into
    CLAUDE.md instead of skills; "letting good setups stay tribal" instead of
    plugins; configuration written for an old model staying after a new one
    arrives.

## How this repo stacks up

### Already aligned

- **Hexagonal split + `docs/architecture.md` module map** = the article's
  "scoped navigation" + "codebase map" recommendation, done well.
  `docs/goals.md` (73 lines) is the "pointers and critical gotchas" model —
  the user's standing rule "decide-from-goals-dont-overask" reinforces this.
- **`docs/findings/README.md`** is already an index, not a dump, with active/
  historical split. Matches the article's "lightweight markdown table of
  contents" pattern, scoped to investigations.
- **Schema-first / Hard Rules** in `CLAUDE.md` lines 7-17 = "non-negotiable
  constraints" — short, load-bearing.
- **Memory hygiene** — user's per-project memory at
  `~/.claude/projects/.../memory/` holds the durable rules
  (no-hardcoded-logic, decide-from-goals, no-ADR-for-infra-swaps,
  headless-by-platform, cleanup-scaffolding). Concise. Not in CLAUDE.md
  (correct).
- **Pure functions in `src/core/`** = the article's separation that lets
  Claude reason about a module without dragging in adapters.

### Gaps (anti-patterns the article calls out)

| Article rec | Repo state | Severity |
|---|---|---|
| Root CLAUDE.md = pointers + gotchas only | Lines 21-95 are a 75-line "Current state" feature log where every shipped item gets a verbose paragraph. Duplicative with `docs/decisions.md`. | **High** — exact "drifts into noise" anti-pattern. |
| Subdir CLAUDE.md for local conventions | None exist. `src/adapters/agent/stagehand-session.ts` is 1848 lines and `src/adapters/recon/llm-reconnoiterer.ts` is 750 — both heavy enough to deserve a local map. | Medium |
| Skills for reusable expertise | No `.claude/skills/`. Recurring tasks (run-and-interpret-`npm run eval`; recon-prompt iteration loop; commit-message style; "before I declare a task done, did I leave scaffolding?") would qualify. | Medium |
| Hooks for automation | No project hooks. The user-imposed "clean up scaffolding when phase ends" rule (memory) is exactly what a **stop hook** should automate — reflect on the session and propose memory/CLAUDE.md/findings updates while context is fresh. | High — directly relieves a user-articulated pain. |
| Subagent for read-only mapping | I do this informally (Explore agent). Not formalized. | Low |
| LSP integration | TypeScript LSP would be valuable; not configured. | Low |
| `.ignore` files | `.gitignore` only. No `.claude/.gitignore` style exclusions for `output/` (recordings are huge). | Medium — recordings can dominate context if grep ever wanders there. |
| Subdir-scoped test/lint | Single `npm run typecheck` + global vitest. Scope is fine because the codebase is one project. | Not applicable (yet). |
| Configuration review cadence | No schedule. ADRs and findings accumulate. The "Current state" table grows monotonically. | Medium — symptom is the bloated CLAUDE.md. |

### Cross-check vs existing user-memory rules

- **`cleanup-scaffolding`** ← directly served by a stop-hook proposing
  cleanup. Strong reason to add hooks.
- **`no-adr-for-infra-swaps`** ← in the same spirit as the article's
  "configuration review every 3-6 months" — cull noise periodically.
- **`decide-from-goals-dont-overask`** ← matches the article's "skills scoped
  per path; load only when relevant." Bind context to where it applies.
- **`headless-by-platform`** ← currently lives in user-memory only, not in any
  subdirectory CLAUDE.md. If `scripts/` got its own CLAUDE.md, this rule
  could move there (it's not user-personal, it's a project rule).
- **`language-preference`** (Chinese for suggestions) — user-personal,
  correctly in memory, not in CLAUDE.md.

### What I'm probably guilty of as the AI

- Treating CLAUDE.md "Current state" table as a feature log — every ADR /
  fix gets a row. The article says explicitly: that's noise.
- Adding rules to CLAUDE.md instead of skills when they describe a recurring
  workflow (e.g. "how to interpret `npm run eval` output" — that's a skill).
- Not proposing my own setup improvements proactively — the article positions
  hooks/skills as something a working team adds for itself.

## Proposed concrete changes (NEED SIGN-OFF)

Ranked by leverage. None applied yet.

1. **Slim the root CLAUDE.md "Current state" table to 5-7 bullets**, not 75
   lines. Move the feature log into `docs/decisions.md` (or delete; ADRs
   already cover it). Replace with a "what this codebase is + what's
   load-bearing" paragraph. **Highest signal-restoration leverage.**
2. **Add a stop-hook** at `.claude/hooks/stop.sh` that asks me to review:
   "did I leave temporary diagnostic code? did any rule discovered this
   session belong in memory or CLAUDE.md? does any finding need to be
   indexed?" — directly automates the user's `cleanup-scaffolding` rule.
3. **Add a `.claude/skills/run-eval.md` skill** describing the
   `npm run eval` canary semantics (status rows, what `compressed-hard`
   means, when to file a follow-up task vs. fix-in-place). Currently this
   lives partly in `scripts/self-eval.ts` comments and partly in my head.
4. **Add `src/adapters/agent/CLAUDE.md`** with the
   stagehand-session-specific conventions (when to use `observe()` vs
   `ariaSnapshot()`, why we own `humanMove` from cloakbrowser, the 1848-line
   file's section map). Same for `src/adapters/recon/` if value warrants.
5. **Add a `~/3-month-review` reminder in user memory or task list** —
   timestamp-driven configuration review per article rec 2.

(2) and (3) are independent leverage; (1) is the biggest one-shot win; (4)
helps only when adapter files start dwarfing context. (5) is a low-effort
guardrail.

## What I'm NOT proposing

- LSP setup — TypeScript inference + grep covers it for this codebase size.
- Subdir-scoped test/lint — single project, single test runner; not yet
  worth the splitting.
- Plugins / sharing skills externally — the team is one person.
- Removing the user-memory system in favor of project files — the user
  memories (language preference, work style) are correctly per-user not
  per-project.

## Recommendation

Start with **proposal 1 alone**. It's the highest-leverage change with the
clearest signal — slimming the root CLAUDE.md will recover context budget
for every future session. Then re-evaluate. Don't bundle.
