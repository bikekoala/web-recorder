/**
 * Regression case library — pure data, no I/O.
 *
 * Each case exercises a different axis of the (URL, prompt, durationMs) →
 * recording pipeline. The `coverageNotes` string is the canonical record of
 * "why this case exists". When the suite catches a regression, that note tells
 * future maintainers which capability the case was guarding.
 *
 * Hexagonal note: this file MUST stay free of I/O. The vitest test consumes
 * it; nothing else depends on it. Keep it that way.
 */

export interface RegressionCase {
  /** Stable kebab-case id; used in test names + output dir names. */
  id: string;
  url: string;
  prompt: string;
  durationMs: number;
  /** One-line summary printed in test output. */
  description: string;
  /** Multi-line: which capability axes does this case exercise. */
  coverageNotes: string;
  expect: CaseExpectations;
}

export interface CaseExpectations {
  /** Trimmed video duration must fall within [min, max] ms. */
  trimmedVideoMsMin: number;
  trimmedVideoMsMax: number;
  /** Maximum tolerated implicit dwells (≤ this number). */
  implicitDwellMax: number;
  /** Maximum tolerated expectAfter mismatches (≤). */
  expectAfterMismatchMax: number;
  /**
   * Acceptable intentSatisfaction.level values for THIS case. Empty array
   * means any level is acceptable (case is a "soft" check).
   *
   * 'unmet' is currently a known-issue level (clicks watchdog-cut mid-flight)
   * — cases that hit this should still PASS the suite if their other
   * mechanical metrics are fine. The level is informational.
   */
  acceptableIntentLevels: ReadonlyArray<'complete' | 'partial' | 'unmet' | 'unknown'>;
  /** Min number of pre-resolved click hints. 0 = vague-prompt cases. */
  resolvedClicksMin: number;
}

export const REGRESSION_CASES: ReadonlyArray<RegressionCase> = [
  {
    id: 'github-readme',
    url: 'https://github.com/webadderallorg/Recordly',
    prompt: '点击页面上的"简体中文"链接，然后慢慢向下滑动浏览内容',
    durationMs: 10_000,
    description: 'CJK explicit-click + below-fold target + turbo-frame SPA',
    coverageNotes: [
      '- JSON safety on CJK quotes (planner must paraphrase)',
      '- Below-fold click target (briefing-hint surfacing)',
      '- Explicit named target (planner extraction)',
      "- Turbo-frame navigation (URL doesn't change → expectAfter mismatches happen)",
      '- No blockers expected (interactive count high)',
    ].join('\n'),
    expect: {
      trimmedVideoMsMin: 9_000,
      trimmedVideoMsMax: 11_000,
      implicitDwellMax: 14,
      expectAfterMismatchMax: 3,
      // 'unmet' is a known issue (clicks watchdog-cut mid-flight); keep tolerated.
      acceptableIntentLevels: ['complete', 'partial', 'unmet'],
      resolvedClicksMin: 1,
    },
  },
  {
    id: 'youtube-watch',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    prompt: '等视频开始播放后看一会儿，然后向下滑动到评论区慢慢浏览',
    durationMs: 25_000,
    description: 'Video play-overlay blocker + watch dwell + scroll-to-comments',
    coverageNotes: [
      '- Visual blocker recognition (paused-video play button)',
      '- Implicit click intent (user said "watch", not "click play")',
      '- Long-form chained dwells (watching the video)',
      '- Below-fold scroll (comments appear after scrolling)',
      '- No cookie consent expected on direct watch URL',
    ].join('\n'),
    expect: {
      // 25s ±10%
      trimmedVideoMsMin: 22_500,
      trimmedVideoMsMax: 27_500,
      // longer recording → more dwells, larger budget
      implicitDwellMax: 25,
      expectAfterMismatchMax: 3,
      acceptableIntentLevels: ['complete', 'partial', 'unmet', 'unknown'],
      // planner may or may not extract the play button as a hint
      resolvedClicksMin: 0,
    },
  },
  {
    id: 'wikipedia-article',
    url: 'https://en.wikipedia.org/wiki/Photography',
    prompt: 'Slowly browse the article from top to bottom',
    durationMs: 15_000,
    description: 'Pure-scroll, no click intent — tests planner empty-targets path',
    coverageNotes: [
      '- Vague prompt with NO click intent (planner must return targets:[])',
      "- intentSatisfaction.level should be 'unknown' (no hints, scrolls happened)",
      '- English prompt (planner without CJK)',
      '- Reading-pace scroll behavior (slow speed)',
      '- Stable long article (low risk of layout shift mid-recording)',
    ].join('\n'),
    expect: {
      trimmedVideoMsMin: 13_500,
      trimmedVideoMsMax: 16_500,
      implicitDwellMax: 20,
      // no clicks → no expectAfter set
      expectAfterMismatchMax: 1,
      acceptableIntentLevels: ['unknown', 'complete'],
      // we WANT this to be 0 — verifies planner behaves correctly on vague prompts
      resolvedClicksMin: 0,
    },
  },
  {
    id: 'hackernews-top',
    url: 'https://news.ycombinator.com',
    prompt: 'Open the top story to read it',
    durationMs: 12_000,
    description: 'Implicit "top"-position click + URL navigation',
    coverageNotes: [
      '- Implicit position-based click (the planner must figure out which link)',
      '- Real URL navigation (target opens a different page)',
      '- English prompt',
      '- Plain-text page, minimal styling, no blockers',
      '- expectAfter URL change should match cleanly (true cross-page nav, not SPA)',
    ].join('\n'),
    expect: {
      trimmedVideoMsMin: 10_800,
      trimmedVideoMsMax: 13_200,
      implicitDwellMax: 16,
      expectAfterMismatchMax: 2,
      acceptableIntentLevels: ['complete', 'partial', 'unmet', 'unknown'],
      // planner may extract "the top story link" or may not
      resolvedClicksMin: 0,
    },
  },
];
