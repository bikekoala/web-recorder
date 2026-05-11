# Naturalness Catalog

A complete inventory of behaviors that determine how "human" the recorded
video looks. Each row is a single observable trait; the goal is to keep
this list small and known rather than discover gaps by user complaint.

Status legend:

- ✅ done    — implemented and exercised by the test scenario
- ⚠️ partial — scaffolding exists, but quality / coverage is incomplete
- ❌ todo    — known gap, not yet implemented
- N/A       — out of scope for current product (kept here for completeness)

## A. Page motion (scrolling)

| ID | Behavior | Status | Notes |
|---|---|---|---|
| A1 | Animated scroll (not snap) | ⚠️ | `requestAnimationFrame` loop — but the §0034 video judge read the canonical-run scroll as "fast & linear" (possible causes: low video fps over a short ~2.4s scroll, the `smoothScrollTo` easing, lazy React content popping in). Scroll-rendering investigation = Task #21. |
| A2 | Easing curve options | ✅ | `inOutQuad / outQuart / outExpo / linear`; recon picks per `scroll` step (§0034) |
| A3 | Distance-adaptive choreography | ✅ | short / medium / long bands |
| A4 | Two-stage long scroll (fling → micro-pause → slow approach) | ✅ | for distances > 2500px |
| A5 | Reading-pace exploration scrolls (≤ 350 px/s) | ⚠️ | recon-emitted `scroll.durationPx`/`durationMs` decide pace; no executor enforcement, and §0034's first run shows recon ignores pacing adjectives ("slow scroll" → 2.4s/600px·s⁻¹) — Task #21 |
| A6 | Inter-scroll micro-pause (50-200ms between consecutive scrolls) | ✅ | `dwellAfterMs` field on each recon-emitted `scroll` `PerformanceStep` (§0034; was a StreamingDirector tail wait in §0031). `StagehandPageSession.scroll()` still applies the `SCROLL_TAIL_*` config range as a default; the per-step value overrides it. |
| A7 | Inertia / momentum after a fling (decay-then-stop motion) | ❌ | the easing approximates this; no real inertia model |
| A8 | Overshoot + correction (rare scroll-too-far + scroll-back) | ❌ | very natural touch but easily abused; behind a feature flag when added |
| A9 | Direction-mixed scrolls (look back up after scrolling down) | ❌ | depends on planner generating reversal steps |
| A10 | Variable scroll length within a phase (not uniform 300px chunks) | ⚠️ | planner controls; no enforcement |

## B. Cursor (currently invisible in the recording)

> All B-items require a cursor synth layer. None implemented yet — see
> `docs/decisions.md` §0001 (Architecture B chose post-process overlay).

| ID | Behavior | Status |
|---|---|---|
| B1 | Visible cursor sprite | ❌ |
| B2 | Bezier-curve path between targets (not straight line) | ❌ |
| B3 | Velocity profile: bell-curve (accel → cruise → decel) | ❌ |
| B4 | Micro-tremor (~1px stddev gaussian jitter per frame) | ❌ |
| B5 | Approach overshoot + correction (2-5px past, then back) | ❌ |
| B6 | Pre-click hover hesitation (small dwell at the target) | ❌ |
| B7 | Cursor type changes: arrow → I-beam over text → pointer over links | ❌ |
| B8 | Click ripple / depression animation | ❌ |
| B9 | Cursor anchoring on text-selection drag | ❌ |
| B10 | Cursor magnetization (subtle pull toward clickable elements when nearby) | ❌ |
| B11 | Idle drift during pauses (cursor wanders 2-5px during waits) | ❌ |

## C. Timing & rhythm

| ID | Behavior | Status |
|---|---|---|
| C1 | Pre-click anticipation pause (500-800ms randomized) | ✅ |
| C2 | Post-click stable wait (DOM-mutation observer) | ✅ |
| C3 | Long-scroll micro-pause (fling → 150-250ms → slow approach) | ✅ |
| C4 | Opening hold ("context absorption" at recording start) | ⚠️ | No longer a hard-coded Director wait (the StreamingDirector + `OPENING_HOLD_*` config knobs are gone, §0034). Now the *reconnoiterer* is expected to emit a `dwell` as the first `PerformanceStep` — a planned, model-decided "look at the page" beat. Works in practice (the §0034 integration run produced ~1.1s of opening hold: 400ms + 700ms), but whether the recon *reliably* emits it is recon-prompt quality — Task #21. |
| C5 | Reading pauses (longer dwell after navigating to a content-rich page) | ❌ |
| C6 | Inter-action variability (no two consecutive durations are identical) | ⚠️ partial via random anticipation |
| C7 | Decision pauses (longer for ambiguous targets) | ❌ |
| C8 | "Boredom" speed-up (when pages 2-3 of similar content) | ❌ low priority |

## D. Click behavior

| ID | Behavior | Status |
|---|---|---|
| D1 | Discovery approach (smooth-scroll target into reading position) | ✅ |
| D2 | Native browser click event (real OS-level dispatch) | ✅ Playwright `page.click()` |
| D3 | Hover state firing (CSS `:hover` triggers in recorded frames) | ❌ requires Architecture A (xdotool / real OS cursor) |
| D4 | Variable click delay across runs | ✅ via random anticipation |
| D5 | Click bbox center vs random within-bbox offset | ❌ currently always element center |
| D6 | Double-click / right-click variants | N/A not yet a target use case |

## E. Text interaction (not in V1 scope)

| ID | Behavior | Status |
|---|---|---|
| E1 | Text selection (drag from word start to word end) | ❌ |
| E2 | Selection animation visible in video | ❌ |
| E3 | Highlight overlay on selected text | ❌ |
| E4 | Triple-click to select paragraph | ❌ |

## F. Form / keyboard (future)

| ID | Behavior | Status |
|---|---|---|
| F1 | Tab between fields (not click) | ❌ |
| F2 | Variable typing speed (50-300ms between keys) | ✅ partial — pre-typing 200-400ms pause + per-call 60-140ms keystroke delay (§0031) |
| F3 | Occasional typo + backspace | ❌ |
| F4 | Pause at punctuation / sentence ends | ❌ |

## G. Page-level ambient

| ID | Behavior | Status |
|---|---|---|
| G1 | Browser window already in foreground (no minimization frames) | ✅ Playwright handles |
| G2 | No autofill / extension popups | ✅ persistent context with empty profile |
| G3 | Real OS cursor visible (with native trail / shadow) | ❌ Architecture B intentionally omits |
| G4 | Keyboard scroll alternatives (PageDown / Space) | ❌ |
| G5 | Wheel vs trackpad scroll feel difference | ❌ all our scrolls are programmatic-smooth |

## H. Post-process aesthetics (Recordly-style polish)

| ID | Behavior | Status |
|---|---|---|
| H1 | Auto-zoom on dwell (camera pushes in around clicks) | ❌ |
| H2 | Stylized cursor sprite (macOS-pretty, not gritty OS cursor) | ❌ |
| H3 | Click ripple in compositing layer | ❌ depends on B1 |
| H4 | Background gradient + rounded corners + drop shadow | ❌ |
| H5 | Speed up boring sections (dynamic time remap) | ❌ |
| H6 | Captions / annotations layer | ❌ |

---

## What "natural" actually requires

If I had to pick the **smallest set** of items that takes the recording from
"obviously a robot" to "could be a human" for a typical 10-second blog/video
demo, it's:

```
Tier 1 — strictly required to not look mechanical (~3-5 days work):
   A2, A3, A4       ✅ done — the foundation
   A1               ⚠️ animated scroll exists but reads "fast & linear" to the §0034 judge — Task #21
   D1, D2           ✅ done — discovery click
   C1, C2, C3       ✅ done — timing rhythm
   C4               ⚠️ opening hold is now a recon-emitted `dwell` (§0034) — works in practice, depends on recon-prompt quality
   B1, B2, B3       ❌ visible cursor with path + velocity profile

Tier 2 — pushes from "passable" to "convincing" (~1-2 weeks):
   B4, B5, B6       ❌ tremor + overshoot + hover hesitation
   B7, B8           ❌ cursor type + click ripple
   A6               ✅ inter-scroll micro-pause (recon `scroll.dwellAfterMs`, §0034)
   C6               ❌ variability across runs
   H2               ❌ stylized cursor (not OS default)

Tier 3 — only matters for "would fool a careful reviewer":
   D3               ❌ real hover firing (Architecture A)
   B11              ❌ idle drift
   A8, A9           ❌ overshoot, look-back
   H1, H3, H4       ❌ Recordly-style polish
```

## Recommended next milestone

**Tier 1 completion** = ship cursor synth (B1, B2, B3) + firm up scroll rendering (A1, Task #21).

That single milestone moves us from "the page scrolls weirdly nicely" to
"this looks like a real person navigating." Everything beyond is polish that
viewers will appreciate but not consciously notice missing.

Cursor synth has a clear shape:

1. New port `ICursorSynthesizer` with `synthesize(actionLog) → cursorFrames[]`
   in `src/ports/`.
2. New adapter `WindMouseSynth` in `src/adapters/cursor/`. Implements
   WindMouse (or simple bezier + bell-curve velocity + jitter).
3. New port `IComposer` with `compose(video, cursorFrames) → mp4`.
4. New adapter `FfmpegComposer` that overlays a cursor sprite on the video
   using ffmpeg's `overlay` filter driven by per-frame x/y from the synth.
5. Runner adds a final phase: `compose` after `trim`.

The action log already carries everything `WindMouseSynth` needs — bbox of
each click, scroll start/end positions, viewport-relative coordinates,
timestamps. No further data plumbing needed.

## How this catalog stays useful

- **Every new "natural" behavior** added to the codebase gets a row here. The
  diff for a new feature should include a status flip (❌ → ✅).
- When a user complaint reveals a missing item, **add the row** — even if
  not implemented — so future me knows it's a known gap, not an oversight.
- Status flips are the project's progress signal more than commit count.
