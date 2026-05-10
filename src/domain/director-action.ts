import { z } from 'zod';

/**
 * Director action vocabulary — what the FastDecider can choose.
 *
 * Designed to be small (4 primitives) so the LLM has minimal cognitive
 * load and produces fast, accurate decisions. The executor renders each
 * primitive into the full natural choreography (approach scroll +
 * anticipation + click for `click`, multi-stage scroll for far targets,
 * etc.) — see `docs/decisions.md` §0017 / §0018.
 *
 * All bounds are deliberate:
 * - `scroll.deltaPx` excludes [−99, 99] (jitter) and |x|>1500 (disorienting).
 * - `dwell.durationMs` is [200, 3000] (shorter is invisible, longer is dead air).
 */

export const ScrollSpeed = z.enum(['slow', 'normal', 'fast']);
export type ScrollSpeed = z.infer<typeof ScrollSpeed>;

const ClickAction = z.object({
  kind: z.literal('click'),
  target: z.string().min(1),
  reasoning: z.string().min(1),
});

const ScrollAction = z.object({
  kind: z.literal('scroll'),
  deltaPx: z.number().int().refine(
    (v) => (v >= 100 && v <= 1500) || (v <= -100 && v >= -1500),
    { message: 'deltaPx must be in [-1500, -100] ∪ [100, 1500]' },
  ),
  speed: ScrollSpeed,
  reasoning: z.string().min(1),
});

const DwellAction = z.object({
  kind: z.literal('dwell'),
  durationMs: z.number().int().min(200).max(3000),
  reasoning: z.string().min(1),
});

const DoneAction = z.object({
  kind: z.literal('done'),
  reasoning: z.string().min(1),
});

export const DirectorAction = z.discriminatedUnion('kind', [
  ClickAction,
  ScrollAction,
  DwellAction,
  DoneAction,
]);
export type DirectorAction = z.infer<typeof DirectorAction>;

/**
 * Speed → (px/s, easing) map. Single source of truth for the
 * `scroll(deltaPx, speed)` executor mapping. See `docs/decisions.md` §0018.
 */
export const SCROLL_SPEED_PROFILES: Record<
  ScrollSpeed,
  { pxPerSec: number; easing: 'outQuart' | 'outExpo' }
> = {
  slow:   { pxPerSec: 250, easing: 'outQuart' },
  normal: { pxPerSec: 450, easing: 'outQuart' },
  fast:   { pxPerSec: 800, easing: 'outExpo' },
};
