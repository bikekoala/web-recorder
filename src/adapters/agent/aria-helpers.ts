/**
 * Pure helpers for processing Playwright aria-snapshot output and ranking
 * observe()-match candidates. Extracted from `stagehand-session.ts` because
 * they have no Playwright dependency and are exercised by their own unit
 * tests (`tests/unit/adapters/agent/{rank-candidates,prune-aria-snapshot}.test.ts`).
 *
 * Pure (no I/O, no time, no globals). Both functions are agent-SDK-agnostic
 * — the Stagehand → other-SDK swap (CLAUDE.md hard rule 1) can reuse them.
 */

/** One observe()-match candidate, before it's pared down to an ObservedElement. */
export interface RankableCandidate {
  selector: string;
  description: string;
  bbox: { x: number; y: number; width: number; height: number };
  /** Is the element itself genuinely clickable (<a href>/<button>/[role=button|link]/…), vs a wrapper? */
  interactive: boolean;
}

/**
 * Rank observe()-match candidates best-first and de-dup by position:
 * genuinely interactive elements ahead of wrappers, original order preserved
 * within a group. (finding 6 / robustness-sweep-1.)
 */
export function rankCandidates(items: RankableCandidate[]): RankableCandidate[] {
  const seen = new Set<string>();
  const deduped = items.filter((c) => {
    const key = `${Math.round(c.bbox.x)},${Math.round(c.bbox.y)},${Math.round(c.bbox.width)},${Math.round(c.bbox.height)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Stable partition: interactive first, then non-interactive, each keeping order.
  return [...deduped.filter((c) => c.interactive), ...deduped.filter((c) => !c.interactive)];
}

/**
 * ARIA-tree node roles that carry no actionable / structural value for the recon
 * planner — wrappers, prose, inline formatting. Dropping their lines from a
 * `mode:'ai'` snapshot cuts a content page's tree several× (most of a page is
 * `generic` divs + `text`/`StaticText` content) without losing what the planner
 * needs: links, buttons, inputs, headings, landmarks, lists, tables/rows/cells
 * (Wikipedia infobox rows carry "Family: Felidae"-type names), dialogs, tabs, …
 */
const ARIA_PRUNE_DROP_ROLES = new Set([
  'generic', 'paragraph', 'text', 'StaticText', 'LineBreak', 'separator',
  'emphasis', 'strong', 'code', 'subscript', 'superscript', 'deletion',
  'insertion', 'mark', 'time', 'blockquote', 'caption', 'definition',
]);

/**
 * Prune content/wrapper noise from a Playwright `mode:'ai'` aria tree. Each line
 * is `<indent>- <role> "name" [attrs] [ref=eN]` (or a property line like
 * `<indent>- /url: …`); drop lines whose role is in `ARIA_PRUNE_DROP_ROLES`,
 * keep everything else (property lines like `/url:` are kept — no leading role
 * word — they tell the planner where a link goes). Kept lines retain their
 * original indentation; orphaned nesting is harmless (the LLM reads each
 * `- role "name" [ref=eN]` line on its own).
 */
export function pruneAriaSnapshot(snapshot: string): string {
  if (!snapshot) return snapshot;
  const out: string[] = [];
  for (const line of snapshot.split('\n')) {
    const m = /^\s*- ([A-Za-z]+)\b/.exec(line);
    if (m && ARIA_PRUNE_DROP_ROLES.has(m[1]!)) continue;
    out.push(line);
  }
  return out.join('\n');
}
