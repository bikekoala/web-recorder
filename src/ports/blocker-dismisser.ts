import type { BlockerDismissalReport } from '../domain/performance.js';
import type { IPageSession } from './page-session.js';

export type { BlockerDismissalReport };

/**
 * Off-camera blocker dismisser (Task #20 / spec 2026-05-12). Clears
 * dismissable overlays — cookie/consent banners, X-to-close modals — from a
 * page before the Performance is planned / played. NOT region/age gates,
 * NOT paywalls. Best-effort: `dismiss()` never throws; on any failure it
 * returns a report with `stillBlocked: true` and the caller proceeds (the
 * §0034 on-camera gated re-plan + graceful degradation are the backstop).
 */
export interface IBlockerDismisser {
  dismiss(session: IPageSession): Promise<BlockerDismissalReport>;
}
