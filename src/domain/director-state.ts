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
  /**
   * Click-target descriptions the Director has tried this run and judged
   * unreachable (failed N≥`directorClickRejectionLimit` times via verifier
   * rejection or Playwright throw). Surfaced verbatim to the LLM so it
   * stops re-picking the same target. See §0028.
   */
  unreachableTargets?: string[];
  /**
   * Length of the browser history stack from JS (`window.history.length`).
   * When this is 1, calling `back` lands on about:blank — surfaced to the
   * decider so it skips `back` from a single-entry history. See §0032.
   */
  historyDepth?: number;
}

export interface ActionSummary {
  kind: DirectorAction['kind'];
  /** Human-readable, ≤80 chars. e.g. "scroll +600 slow", "click 简中". */
  brief: string;
  succeeded: boolean;
  /**
   * Structured proof of what the action actually did to the page. Surfaced
   * to the LLM in `recentActions` so it can verify "did my last action
   * land?" without inferring everything from the screenshot. Catches the
   * "type the same text twice" / "click hit the wrong element" failure
   * modes — see ADR §0026.
   */
  evidence: ActionEvidence;
}

/**
 * Proof captured by the Director after each executed action. Each variant
 * carries the minimum the LLM needs to know "did this work?":
 *   - urlBefore/urlAfter   navigation evidence (click/key/back)
 *   - titleBefore/After     SPA / turbo-frame swap evidence (URL stable)
 *   - scrollY*              real scroll achieved (sometimes < deltaPx
 *                           because the page is at the bottom, etc.)
 *   - focusedValueAfter     verifies `type` actually landed
 *
 * The fields are deliberately a SUPERSET — kinds carry the bits relevant
 * to them and we render only those in the prompt. This keeps the type
 * system simple (one shape per action kind) and avoids elaborate runtime
 * dispatch in the prompt builder.
 */
export type ActionEvidence =
  | {
      kind: 'click';
      urlBefore: string;
      urlAfter: string;
      urlChanged: boolean;
      titleBefore: string;
      titleAfter: string;
      titleChanged: boolean;
      /**
       * AI verifier verdict (§0027). null when no verifier is configured
       * OR the verification call itself failed (treated as optimistic
       * "matched"). Non-null + false means the verifier saw the screenshot
       * AFTER the click and judged the click landed on the wrong element.
       */
      aiVerified: boolean | null;
      /** Verifier's brief explanation. null when aiVerified is null. */
      aiReason: string | null;
    }
  | {
      kind: 'type';
      expectedText: string;
      focusedValueAfter: string | null;
      /** True iff focusedValueAfter contains expectedText (case-sensitive). */
      matched: boolean;
    }
  | {
      kind: 'scroll';
      scrollYBefore: number;
      scrollYAfter: number;
      deltaRequested: number;
      deltaAchieved: number;
    }
  | {
      kind: 'key';
      key: string;
      urlBefore: string;
      urlAfter: string;
      urlChanged: boolean;
      titleBefore: string;
      titleAfter: string;
      titleChanged: boolean;
    }
  | {
      kind: 'back';
      urlBefore: string;
      urlAfter: string;
      urlChanged: boolean;
    }
  | { kind: 'dwell'; durationMs: number }
  | { kind: 'done' };
