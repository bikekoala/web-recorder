# Github-multistep white-screen at t=19s

**Source**: surfaced by the §0030 LLM video judge on
`output/2026-05-11/11-14-38-regression-github-multistep-natural`. Judge
flagged `visualCoherence: fail @ 18.0s — screen turns completely white and
remains until end`. No code-side metric noticed; `intentSatisfaction`
reported `complete`.

## Visual confirmation

Frame extraction at 1s intervals around the boundary:

| Time | Frame size | Content |
|---|---|---|
| t=18s | 352 KB | English Recordly README, fully rendered |
| t=19s | 4.3 KB | Solid white (`about:blank`) |
| t=22s | 4.3 KB | Solid white |
| t=25s | 4.3 KB | Solid white |
| t=31s (end) | 4.3 KB | Solid white |

PNG file size collapsed from ~350 KB (real content) to ~4 KB (uniform color
compressed by zlib) — a 100x drop, confirming the page is genuinely blank.

## Root cause from action log

Three relevant actions in the recording window (timestamps absolute since
session.start; recording window starts at 23402ms):

```
29512ms  click  "the simplified Chinese language switcher link"  urlBefore=recordly  urlAfter=recordly
38804ms  click  "the Chinese language option"                    urlBefore=recordly  urlAfter=recordly
41712ms  back                                                    urlBefore=recordly  urlAfter=about:blank
```

Both clicks resolved to the **same XPath**:
`...turbo-frame[1]/div[1]/react-app[1]/.../article[1]/p[1]`

It's a `<p>` inside the README article — a *paragraph* of text, not an
actual language link. Neither click navigated. URL stable.

Then the LLM called `back()` to "return to the project homepage" (the
user prompt said `回到项目首页` after the language switch). The browser's
history stack at this point was `[about:blank, recordly]` (about:blank
comes from how Playwright opens a fresh context; `goto(recordly)`
pushes the project page on top of it). Since none of the clicks
navigated, the stack still has only 2 entries — `back()` pops to
`about:blank`.

After that, no decisions changed the URL (the agent continued to call
`click(...)` actions on the now-blank page, all of which failed via
Stagehand `ElementNotFoundError`). Hit budget at t=31.5s. Recording
ended on the blank page.

## Why neither §0027 verifier nor §0028 retry-cap caught this

The two clicks succeeded *as far as Playwright was concerned* — a `<p>`
was clicked. The §0027 click verifier was wired but evidently approved
both clicks (the AI verifier defaults to `matched: true` on uncertainty,
and a paragraph inside a README block looks like plausible text content
"changed" between an English layout and where the agent expects Chinese
to be). The §0028 retry-cap never fired because the clicks weren't
flagged as failures.

`intentSatisfaction` reported `complete` because the
fuzzy `descriptionsMatch` matched the click descriptions ("Chinese
language switcher", "Chinese language option") to the planner's hint
("the 简体中文 link") on shared token `language` — and then 3 hints
counted as resolved despite literally one wrong target hit twice.
(That over-count bug is its own write-up: see
[2026-05-11-intent-satisfaction-overcount.md](./2026-05-11-intent-satisfaction-overcount.md).)

## Fix candidates

### A. Prevent `back()` to about:blank (recovery)

After every `back()` action, check `urlAfter`. If it's `about:blank`,
the back was a no-op-of-history — undo it with `goto(originalUrl)` and
log a failure entry the decider sees on its next call.

- **Pros**: catches any path into about:blank, not just this one. Cheap.
- **Cons**: doesn't prevent the decision to back from a non-navigated
  state in the first place. Subsequent decisions still waste budget
  reasoning from a wrong premise.

### B. Pop about:blank off history before recording opens (root)

After `goto(url)` and before `beginRecording()`, run a JS-side history
clean: `history.replaceState({}, '', location.href)` followed by a tiny
no-op navigation to ensure there's no `about:blank` predecessor. Or
have the runner navigate to `about:blank` first, then `goto(url, { replace: true })`
equivalent (Playwright doesn't expose `replace` directly — would need a
content-side workaround).

- **Pros**: eliminates the root cause for ALL future runs across all
  cases. about:blank never reachable via back.
- **Cons**: history shaping has cross-browser subtleties. May not be
  worth it if (A) covers the symptom adequately.

### C. Tell the decider when back() would land on blank (transparency)

Surface in `DirectorState` a new field `historyDepth: number` (1 = only
goto, can't back; ≥2 = can back). The decider's system prompt then has
a rule: `if historyDepth === 1, the "back" action will leave the page
blank — do NOT use it; instead try to find a "Home" link or click the
site logo`.

- **Pros**: keeps the decision in the LLM (goals.md #6 AI-first). The
  LLM learns "back is contextual" naturally.
- **Cons**: adds prompt complexity. The LLM may still pick back
  occasionally; needs (A) as a backstop.

### D. Make click verifier stricter about "did the click navigate?"

If the verifier sees `urlChanged=false` AND `titleChanged=false` AND
the target description implied navigation ("link", "go to", "switch
to"), require visual evidence of state change. Don't default to
`matched=true` on this combination.

- **Pros**: catches "clicked a paragraph that looks like a link"
  upstream.
- **Cons**: deciding when a description "implies navigation" is itself
  fuzzy. Risk: false-positive failures on legitimate SPA clicks (which
  also have urlChanged=false).

## Recommendation

The cleanest hybrid: **C (transparency) + A (recovery backstop)**. C is
the AI-first solution; A protects against the LLM still picking the
wrong action despite C. Skip B unless C+A proves insufficient — history
shaping isn't worth its subtlety budget yet. Skip D — too coupled to
intent classification, better handled when we revisit the verifier.

Both C and A together: ~30 lines + a new prompt rule.
