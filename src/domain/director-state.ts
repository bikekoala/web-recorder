import type { Viewport } from './action-log.js';
import type { DirectorAction } from './director-action.js';

/**
 * State snapshot the Director hands to the FastDecider on each call.
 *
 * Kept compact on purpose — the screenshot is the heavy field, every other
 * field is a small primitive. The screenshot is downscaled to ~768×432 by
 * the caller before construction so the prompt stays under ~5K tokens.
 */
export interface DirectorState {
  /** User's natural-language intent, verbatim from the briefing. */
  prompt: string;
  /** Time left in the recording window, ms. */
  remainingMs: number;
  /** Page scroll position right now (window.scrollY), px. */
  currentScrollY: number;
  /** Browser viewport size. */
  viewport: Viewport;
  /** PNG bytes, downscaled to ~768×432. */
  screenshot: Buffer;
  /** Description of each briefing-hint that is currently in viewport. */
  visibleHints: string[];
  /** Last 3 actions (oldest → newest). Empty on first call. */
  recentActions: ActionSummary[];
  /** Set when the previous action errored, surfaces context to the LLM. */
  lastActionFailure?: string;
}

export interface ActionSummary {
  kind: DirectorAction['kind'];
  /** Human-readable, ≤80 chars. e.g. "scroll +600 slow", "click 简中". */
  brief: string;
  succeeded: boolean;
}
