/**
 * Intent matching — pure utilities for "did the user's intent for hint X
 * actually get acted upon?"
 *
 * Used in two places:
 *   - `record-job-runner.computeIntentSatisfaction` to score the final run.
 *   - `StreamingDirector.observeState` to FILTER hints that have already
 *     been clicked successfully so they aren't shown to the LLM again
 *     (preventing the "click the same hint 3 times" loop).
 *
 * The matching is intentionally LENIENT — the planner's hint description
 * and the LLM's click action description rarely match verbatim. Examples:
 *   "the simplified Chinese link"      ↔ "click 简体中文链接"        → match (CJK n-grams)
 *   "the build directory folder link"  ↔ "click the build folder"   → match ("build", "folder")
 *   "the search input box"             ↔ "the search bar"            → match ("search")
 *
 * Pure (no I/O, no time, no globals). Trivially testable.
 */

/**
 * True iff hint description and click description share at least one
 * meaningful content token. See {@link contentTokens} for tokenization.
 */
export function descriptionsMatch(a: string, b: string): boolean {
  const tokensA = contentTokens(a);
  const tokensB = contentTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  for (const t of tokensA) if (tokensB.has(t)) return true;
  return false;
}

/**
 * Reduce a description to its meaningful content tokens:
 *   - ASCII words ≥3 chars (drops noise like "the", "a", "of")
 *   - CJK 2-char n-grams over each contiguous CJK run (so "简体中文" ↔
 *     "简体中文链接" can match through their overlap "简体", "体中", "中文")
 *
 * A blocklist drops semantically-empty common words even at ≥3 chars.
 */
export function contentTokens(s: string): Set<string> {
  const lower = s.toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/[a-z]{3,}/g)) tokens.add(m[0]);
  for (const m of s.matchAll(/[一-鿿]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  for (const w of ['the', 'and', 'for', 'with', 'into', 'this', 'that', 'click']) {
    tokens.delete(w);
  }
  return tokens;
}
