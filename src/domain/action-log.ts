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
 * Discriminated union of action types. When adding a new type:
 * 1. Add a new variant here.
 * 2. Update IPageSession to record it.
 * 3. Update ICursorSynthesizer to handle it.
 * 4. Add an entry to docs/glossary.md if it introduces new vocabulary.
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
