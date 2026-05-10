import type { Viewport } from './action-log.js';
import type { DirectorAction } from './director-action.js';

/**
 * Where a briefing-hint's anchor element sits relative to the CURRENT
 * viewport. Surfaced to the LLM so it knows that requesting `click` on an
 * off-fold target will work — clickByDescription scrolls the target into
 * view internally as part of the discovery choreography.
 */
export interface BriefingHintForState {
  /** Natural-language description of the click target (in user's language). */
  description: string;
  /** Where the hint sits right now. */
  position: 'in_view' | 'above' | 'below';
  /**
   * Signed px to scroll to bring the hint into view (negative = up,
   * positive = down, 0 = already visible). Approximate — for prompt only.
   */
  scrollToReveal: number;
}

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
  /**
   * ALL briefing hints (not filtered to viewport). Each entry includes the
   * hint's current position relative to the viewport, so the LLM knows which
   * targets are in view, above, or below — and can request `click` for any
   * of them (the executor will scroll-to-target as part of the click).
   *
   * Empty array when the planner couldn't extract specific click targets.
   */
  briefingHints: BriefingHintForState[];
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
