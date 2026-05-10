import { z } from 'zod';

/**
 * The record of what happened during a recording session.
 *
 * The action log is the **only** input to the cursor-synthesis layer. It must
 * therefore contain everything the synth needs:
 * - exact timestamps (ms relative to session start)
 * - viewport-relative target coordinates (NOT page-absolute)
 * - page state at action time (scrollY, viewport size) so the synth can map
 *   between recorded video frames and synthesized cursor positions.
 *
 * Schema-first: persisted/serialized ActionLogs go through `ActionLog.parse(...)`
 * before use. Never trust a hand-rolled object.
 */

export const Bbox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Bbox = z.infer<typeof Bbox>;

export const Viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof Viewport>;

/**
 * PageDiagnostic — coarse page-health snapshot returned by
 * `IPageSession.pageDiagnostic()`. Same shape as the body of the
 * `page_diagnostic` ActionLogEntry variant, minus `t`/`scrollY`/`viewport`
 * which are filled in by the caller when (and if) the snapshot is logged.
 *
 * Used by the BlockerPrelude (pre-recording) to decide whether any visual
 * blockers (cookie consent, login modal, paused-video play overlay, etc.)
 * need dismissing before the recording window opens. Also captured as a
 * `page_diagnostic` ActionLogEntry at recording_start by the session.
 *
 * Heuristic-only — false positives/negatives are expected.
 */
export const PageDiagnostic = z.object({
  url: z.string(),
  title: z.string(),
  /**
   * Approximate count of clickable / focusable elements on the page —
   * `button`, `a`, `input`, `[role=button]`, `[role=link]`, `[tabindex]`.
   * A surprisingly low number on a content-rich page is a strong signal
   * the page didn't load as expected.
   */
  interactiveElementCount: z.number().int().nonnegative(),
  /** First few visible h1/h2/h3 texts to anchor what's on screen. */
  visibleHeadings: z.array(z.string()),
  /**
   * Heuristic blocker detection. Each entry is one of:
   *   `consent_dialog` | `auth_modal` | `play_overlay` | `region_gate`
   *   `search_only` (page is essentially just a search box, e.g. logged-out
   *   YouTube)
   */
  blockerSignals: z.array(z.string()),
});
export type PageDiagnostic = z.infer<typeof PageDiagnostic>;

/**
 * Discriminated union of action types. When adding a new type:
 * 1. Add a new variant here.
 * 2. Update IPageSession to record it (or expose appendEntry()).
 * 3. Update ICursorSynthesizer to handle it (if visual).
 * 4. Add an entry to docs/glossary.md if it introduces new vocabulary.
 *
 * Variants come in three families:
 * - VISUAL ACTIONS (goto/act/click/scroll/wait) — what the browser did.
 *   These are what the cursor synth + post-prod layers consume.
 * - LIFECYCLE (recording_start, visual_stable, observe) — context.
 * - INTROSPECTION (decision, decision_failure, page_diagnostic) — why the
 *   system did what it did. Cheap to write, invaluable when reviewing a
 *   run after the fact ("did the LLM see the page correctly? what did it
 *   choose, and why? did the page even load right?"). Skipped by the
 *   cursor synth — they have no visual effect.
 */
export const ActionLogEntry = z.discriminatedUnion('type', [
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('goto'),
    url: z.string().url(),
    scrollY: z.number().default(0),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('act'),
    instruction: z.string(),
    /** Resolved target if the agent located one. Optional for failed/skipped acts. */
    target: z.object({ selector: z.string(), bbox: Bbox }).optional(),
    scrollY: z.number(),
    viewport: Viewport,
    /**
     * URL right BEFORE the action started — useful when an act causes
     * navigation. Combined with `urlAfter` we can detect navigation events
     * without sniffing network or DOM events.
     */
    urlBefore: z.string().optional(),
    urlAfter: z.string().optional(),
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('click'),
    selector: z.string(),
    description: z.string().optional(),
    bbox: Bbox.optional(),
    scrollY: z.number(),
    viewport: Viewport,
    urlBefore: z.string().optional(),
    urlAfter: z.string().optional(),
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('visual_stable'),
    /** How long we waited for DOM mutations to quiet down. */
    waitedMs: z.number().nonnegative(),
    /** Whether the deadline was hit before quiet was reached. */
    timedOut: z.boolean(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('recording_start'),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('observe'),
    instruction: z.string(),
    matches: z.array(z.object({ selector: z.string(), description: z.string() })),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('scroll'),
    deltaY: z.number(),
    fromScrollY: z.number(),
    toScrollY: z.number(),
    durationMs: z.number().nonnegative(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('wait'),
    durationMs: z.number().nonnegative(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('type'),
    /** Truncated to 200 chars per the schema in director-action.ts. */
    text: z.string(),
    /** Wall-clock duration of the typing animation (per-keystroke delay × len). */
    durationMs: z.number().nonnegative(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('key'),
    /** Named key that was pressed (Enter, Escape, etc.). */
    key: z.string(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('back'),
    /** URL right before navigation. */
    urlBefore: z.string().optional(),
    /** URL after the back navigation completes. */
    urlAfter: z.string().optional(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  /**
   * `decision` — written every time the FastDecider returns a response.
   * Captures the inputs the LLM saw (page state) and what it chose, so a
   * run can be reviewed without re-running the LLM. The screenshot the LLM
   * actually saw is implicitly captured by the recorded video at this `t`.
   */
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('decision'),
    /**
     * Sequence number for cross-referencing.
     *
     * Positive ids (1, 2, …) belong to the Director's recording-window
     * decisions. NEGATIVE ids (−1, −2, …) belong to the BlockerPrelude
     * (see §0021) — the sign distinguishes which phase the decision came
     * from at a glance. Either is valid; the schema accepts any integer.
     */
    decisionId: z.number().int(),
    /** Model id reported by the FastDecider (e.g., `openai/gpt-4o-mini`). */
    modelId: z.string().min(1),
    /** End-to-end latency of the LLM call, in ms. */
    latencyMs: z.number().nonnegative(),
    /** Actions the LLM chose to enqueue, in order. */
    actions: z.array(
      z.object({
        kind: z.enum(['click', 'scroll', 'dwell', 'done', 'type', 'key', 'back']),
        /** First action's reasoning is the most useful, but we keep all. */
        reasoning: z.string(),
        /** A short human-readable summary so the log is grep-able. */
        brief: z.string(),
      }),
    ),
    expectAfter: z
      .object({
        urlContains: z.string().optional(),
        visibleText: z.array(z.string()).optional(),
      })
      .optional(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  /**
   * `decision_failure` — something the LLM-driven loop tried didn't work
   * the way the system expected. The `reason` field is the audit hook —
   * each value tells the operator whether this is a system bug
   * (`schema_validation`, `llm_call_failed`) or a page-vs-LLM mismatch
   * (`expect_after_mismatch`, `click_failed`) that may be recoverable.
   */
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('decision_failure'),
    /** See `decision.decisionId` doc — accepts negative for prelude phase. */
    decisionId: z.number().int().optional(),
    reason: z.enum([
      'schema_validation',
      'expect_after_mismatch',
      'llm_call_failed',
      'click_failed',
      'budget_exceeded',
    ]),
    /** Free-form one-liner. Truncated to 500 chars on write to keep logs lean. */
    details: z.string(),
    scrollY: z.number(),
    viewport: Viewport,
  }),
  /**
   * `page_diagnostic` — written at the moment the recording window opens
   * (and optionally after major navigations). Captures coarse page-health
   * signals so the operator can tell at a glance whether the page loaded
   * with real content or hit a "blank-ish" anomaly (geo block, login wall,
   * bot-detection lite).
   */
  z.object({
    t: z.number().nonnegative(),
    type: z.literal('page_diagnostic'),
    url: z.string(),
    title: z.string(),
    /**
     * Approximate count of clickable / focusable elements on the page —
     * `button`, `a`, `input`, `[role=button]`, `[role=link]`, `[tabindex]`.
     * A surprisingly low number (e.g. < 5 on a page that should be content-
     * rich) is a strong signal the page didn't load as expected.
     */
    interactiveElementCount: z.number().int().nonnegative(),
    /** First few visible h1/h2/h3 texts to anchor what's on screen. */
    visibleHeadings: z.array(z.string()),
    /**
     * Heuristic blocker detection. Each entry is one of:
     *   `consent_dialog` | `auth_modal` | `play_overlay` | `region_gate`
     *   `search_only` (page is essentially just a search box, e.g. logged-out
     *   YouTube)
     */
    blockerSignals: z.array(z.string()),
    scrollY: z.number(),
    viewport: Viewport,
  }),
]);
export type ActionLogEntry = z.infer<typeof ActionLogEntry>;

/**
 * Recording window meta. Both timestamps are ms relative to the session start
 * (the same clock as ActionLogEntry.t), so cursor synth + video trim layers
 * have one consistent timeline.
 *
 * `null` means recording was never explicitly started — every frame from
 * session start onward is "recording" content.
 */
export const RecordingWindow = z.object({
  /** Session-relative ms when `beginRecording()` was called. */
  startedAtMs: z.number().nonnegative(),
  /** Session-relative ms when the session ended. */
  endedAtMs: z.number().nonnegative(),
});
export type RecordingWindow = z.infer<typeof RecordingWindow>;

export const ActionLog = z.object({
  /** Schema version. Bump when ActionLogEntry shape changes incompatibly. */
  version: z.literal(1),
  startedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  /** Subset of [0, durationMs] that is "useful" recording content. */
  recording: RecordingWindow.nullable(),
  entries: z.array(ActionLogEntry),
});
export type ActionLog = z.infer<typeof ActionLog>;
