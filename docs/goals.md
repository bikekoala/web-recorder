# North Star

> Read this before every session. If a proposed change doesn't serve a goal here, it doesn't ship.

## Mission (one sentence)

**Turn `(URL, natural-language instruction, durationMs)` into a video that looks like a real person used the page** — fluid, anticipatory, devoid of robot tells, deliverable as a self-hosted Linux/Docker service.

## Hard non-negotiables

These are properties of the *output*, not the code. Code freedom is fine; output failures are not.

1. **Looks human, not scripted.** The viewer cannot distinguish the recording from one made by a real person. No teleports. No sudden jumps. No straight cursor lines. Pauses are anticipatory, not LLM tail latency. Scrolls have inertia. Clicks have approach + dwell + fire.

2. **Fluid, no visible stalls.** A "stall" is any frame interval ≥500ms where the page is static *and* the user would not naturally pause. LLM thinking is hidden under animation or short natural micro-pauses. Setup time happens BEFORE recording — not in the deliverable.

3. **User intent is satisfied or transparently not.** Every verb in the user's prompt either executes successfully (the deliverable shows it happen) or fails *visibly in the action log* with a categorical reason (`click_failed: target not found`, `target_not_loaded`, etc.). Silent "I gave up" is never acceptable.

4. **Architecture stays swappable.** Stagehand → other agent SDK. Playwright recordVideo → CDP screencast → xvfb+ffmpeg. gpt-4o-mini → Gemini 3.1 → local Llama. None of these swaps require touching `core/`. Concrete tech only lives in `adapters/`. (This is `CLAUDE.md` Hard Rule 1; restated here because it's load-bearing for longevity.)

5. **Cheap to run.** Per recording cost target: < $0.01 in LLM, < 60s wall-clock, < 100MB disk. We optimize for getting close to "free" so the service can run at scale.

## Non-goals

These keep the project from sprawling. **Don't build them unless this list is updated first.**

- ❌ Real-time/live streaming. Only post-hoc recordings.
- ❌ Multi-page workflows beyond what one prompt can describe. (Yes for "click X then scroll then click Y"; no for "log in, search, paginate, drill into result 3.")
- ❌ Per-pixel cursor sprite editing UI. We synthesize trajectories programmatically; we do not provide a visual editor.
- ❌ Browser fingerprint warfare. We add reasonable bot-detection mitigations (UA, AutomationControlled flag, optional storageState). We do not build a stealth research project.
- ❌ Chrome extension or in-browser companion. Server-side only.
- ❌ Account management (logging in for the user, storing passwords, OAuth). If a site requires auth, the user provides a `storageState.json`; we don't manage credentials.
- ❌ Native mobile recording. Web only — desktop viewports.

## Evaluation criteria

A change is "good" iff it improves at least one and harms none of these. The first three are bright-line; #4 is judgment.

1. **Naturalness score**: visually inspect 3-5 frames near every click and scroll. Does it look human? Track in `docs/naturalness-catalog.md`.

2. **Recording fidelity**: trimmed-video duration within ±10% of `durationMs`; zero stalls > 500ms inside the recording window; intent verbs executed.

3. **Cost & speed**: per-job LLM spend, wall-clock setup time, wall-clock total. Regressions need explicit justification in the commit message.

4. **Robustness**: does the change degrade gracefully on a flaky / slow / partially blocked page? "It works on Recordly" is not enough — also test something dynamic (YouTube, a SPA route, a cookie-walled site).

## What "human" actually means here

We've found these specific cells of behavior matter most. Keep this list short — it's a guide, not a spec.

- **Anticipation**: pause briefly *before* clicking, while looking at the target. (Not after — that's confusion.)
- **Discovery**: scroll the target into a comfortable viewport position (~35% from top), don't slam to it.
- **Inertia**: long scrolls have a fast-then-decelerating profile, not constant velocity.
- **Curiosity**: occasionally pause on something interesting even if it's not the target.
- **Recovery**: when something doesn't work, try a slightly different approach, not the same thing again.
- **Reading time**: text-heavy sections get held longer than image grids.

## When this document changes

Goals don't drift silently. Updating this file is a deliberate act:
1. Open a new ADR in `docs/decisions.md` describing what changed and why.
2. Update this file in the same commit.
3. Reference the ADR number from the bullet you changed.

Never edit goals "in passing" inside a feature commit. The goals file outlives any one feature.
