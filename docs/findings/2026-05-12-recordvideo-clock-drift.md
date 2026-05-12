# recordVideo's frame timeline drifts from the action-log wall clock

**Status:** addressed by ADR §0037 (2026-05-12). Surfaced by `npm run eval` (the
§0036-era self-eval tool) on 2026-05-12 — a canonical Recordly run got
`trimmed-video duration 8.8 s (target 10 s, −12 %)` → FAIL on the goals.md eval
#2 bright-line, while the recording *window* (from action-log timestamps) was
10.9 s (+9 %); other runs went the other way (+24 % window, recon over-packing).
Two causes — the recon over-packing the window AND the trim using wall-clock
timestamps against a video whose clock lags. **Fix shipped** (§0037): the recon
trims/pads its own plan to fit `durationMs` (`fitPlanToBudget`, off-camera after
the rehearsal walk; `sumDurations` now models the post-click settle +
per-step overhead), and `RecordJobRunner` trims by **video-relative time** —
scaling the wall-clock window by `f = rawVideoMs / sessionWallMs` when that
ratio shows real drift (`videoRelativeTrimWindow`). After §0037 the canonical run
lands ~+4…+8 % over repeated `npm run eval` runs, judge still `looks_human`.
The notes below are the original analysis; the "Fix options" list is kept for the
deeper levers not taken (closed-loop Director soft-alignment; CDP screencast).

## What's happening

The action log timestamps actions with `Date.now() − startedAt` (wall clock).
Playwright's `recordVideo` timestamps frames with the browser compositor's
clock, which **lags** real time — on this run, the raw video was `Duration:
00:00:38.76` while the action-log clock ran to ~40.9 s, a ~2.1 s gap over a ~40 s
session (the lag is partly the startup window before the first frame is captured,
partly dropped frames under page jank). So `recording_start` at wall‑t = 29 984
ms is **not** 29 984 ms into the video.

`RecordJobRunner` trims `[recording.startedAtMs, recording.endedAtMs]` =
`[29 984, 40 902]` ms — wall-clock numbers — out of a video whose timeline only
reaches ~38.76 s. Result: the trim keeps `[29 984, 38 760]` ≈ **8.78 s** — it
cuts ~2 s of valid content off the *start* (everything before video‑t 29 984
that was actually after wall‑t 27 984), and there's nothing past 38.76 s to keep
at the end. So the deliverable is genuinely ~8.8 s, not 10 s. `videoDurationMs`
reports it correctly (the `Duration:` header on a `recordVideo` webm is the real
captured length). The drift is **variable** — earlier runs landed at 10.6 s
(+6 %, inside ±10 %); this one didn't.

## Why it matters

goals.md #2 / eval #2: "trimmed-video duration within ±10 % of `durationMs`" is
a bright-line. The drift makes it intermittently violated, and worse — the
*content* near the start of the recording window can be lost (the trim's start
edge is offset into the future relative to the video). Pre-existing — predates
the prophet pipeline; just never measured until `npm run eval`.

## Fix options (not done)

- **Trim by video-relative time.** Capture "how many ms of video have elapsed" at
  `beginRecording()` and trim from there. Playwright doesn't expose the current
  video timestamp directly; a proxy is "wall time from page-create (≈ first
  frame) to `beginRecording()`" — but the compositor clock still drifts from wall
  clock *during* the session, so this only corrects the start offset, not the
  rate drift. Better than nothing.
- **Pad the recording.** Have the Director hold the last frame (a gentle closing
  scroll/dwell loop) until the *video* clock — not the wall clock — reaches
  `durationMs`. Needs a way to read the video clock; same problem.
- **Switch the recording layer.** goals.md #4 anticipates `recordVideo →
  CDP screencast → xvfb+ffmpeg`. A CDP screencast (frames with explicit
  timestamps) or xvfb+ffmpeg (real-time capture) would not have this drift. Big
  change; the cleanest long-term answer.
- **At minimum**: `RunMetrics` should surface the recording-*window* duration
  (`endedAtMs − startedAtMs`) alongside `trimmedVideoMs`, so the discrepancy is
  visible without re-deriving it from the action log. `npm run eval` could then
  flag "window vs probed duration disagree by N s → trim offset" explicitly.
