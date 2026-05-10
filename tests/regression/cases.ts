/**
 * Regression case library — pure data, no I/O.
 *
 * The library is deliberately SMALL but each case exercises multiple action
 * types in one recording (a real human doesn't do exactly one thing per
 * session). Every case ships with 2 prompt variants — natural-conversational
 * and distracting/embellished — to verify behaviour holds across phrasings.
 *
 * Per `docs/goals.md` Hard rule #6 (AI-first, not magic-numbers):
 *   - NO mechanical thresholds (dwell counts, mismatch counts).
 *   - Categorical signals only (recording produced, no crash).
 *   - Naturalness is judged by humans reviewing the videos.
 *
 * Hexagonal note: this file MUST stay free of I/O. The vitest test consumes
 * it; nothing else depends on it.
 */

export interface RegressionCase {
  /** Stable kebab-case id; used in test names + output dir names. */
  id: string;
  url: string;
  /**
   * Target recording length. The Director enforces durationMs × 1.05 hard
   * cap; the suite does not assert specific durations beyond "non-zero".
   */
  durationMs: number;
  /** One-line summary printed in test output. */
  description: string;
  /** Multi-line: which capability axes does this case exercise. */
  coverageNotes: string;
  /**
   * 2-3 phrasings of the SAME intent. Tests behaviour stability across
   * how a real human might describe the task — terse vs verbose, neat vs
   * with extraneous chatter.
   */
  prompts: ReadonlyArray<PromptVariant>;
}

export interface PromptVariant {
  /**
   * `natural` — how a regular user would phrase it conversationally.
   * `distracting` — natural phrasing PLUS some unrelated chatter ("by
   *   the way…", "I'm bored, let me…") to verify the planner isolates
   *   intent from social filler.
   * Each case picks the labels that make sense for it; not every case
   *   needs every variant.
   */
  label: 'natural' | 'distracting' | 'concise';
  text: string;
}

export const REGRESSION_CASES: ReadonlyArray<RegressionCase> = [
  // ────────────────────────────────────────────────────────────────────────
  // 1. GitHub multi-step navigation. Single prompt covers four discrete
  //    actions: language switch, back-nav, folder browse, file inspection.
  //    Tests the agent's ability to chain — most prior runs only attempted
  //    one click before budget exhausted.
  // ────────────────────────────────────────────────────────────────────────
  {
    id: 'github-multistep',
    url: 'https://github.com/webadderallorg/Recordly',
    durationMs: 30_000,
    description: 'GitHub: 简中 → back → folder → file source (multi-step nav)',
    coverageNotes: [
      '- Multi-action chain in one recording (4 distinct user verbs)',
      '- CJK-quoted phrase the planner must paraphrase',
      '- Below-fold first target (briefing-hint surfacing)',
      '- Turbo-frame nav (URL stable, content swaps)',
      '- Browser-back semantics (LLM must understand "回首页")',
      '- Directory-tree navigation (clickable folder names)',
      '- File-source view (final destination in the file viewer)',
    ].join('\n'),
    prompts: [
      {
        label: 'natural',
        text: '去看看 Recordly 这个项目，先把页面切换成中文版，然后回到项目首页，进 build 目录看看，最后打开 package.json 查看源码',
      },
      {
        label: 'distracting',
        text: '听说 Recordly 是个录屏工具，看着挺有意思。我想先看看中文版的 README 怎么样，对了项目结构是怎么组织的呢，build 目录里有什么东西？最后能看一眼 package.json 吗，我对它的依赖项好奇',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // 2. YouTube creator browsing. Tests open-ended navigation: from a logged-
  //    out homepage (which shows the "search to start" minimal state) the
  //    agent must search, pick a creator, open their channel, and scroll
  //    through recent works.
  // ────────────────────────────────────────────────────────────────────────
  {
    id: 'youtube-creator',
    url: 'https://www.youtube.com',
    durationMs: 25_000,
    description: 'YouTube: search → creator channel → browse recent works',
    coverageNotes: [
      '- Logged-out empty homepage (search-only blocker signal)',
      '- Implicit search step (no specific button mentioned)',
      "- Creator name as the click target across search results",
      '- Channel page navigation (URL change to /@handle or /channel/...)',
      '- Recent-videos section reveal (scroll on channel page)',
      '- No specific "click play" required (browsing thumbnails, not playing)',
    ].join('\n'),
    prompts: [
      {
        label: 'natural',
        text: '在 YouTube 上找到 MrBeast 的频道，看看他最近发了什么视频',
      },
      {
        label: 'distracting',
        text: '今天有点无聊，YouTube 上 MrBeast 最近的视频我还没看过，能帮我打开他的频道页面看看最新作品吗',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // 3. Google Maps search-only. The interesting test is what the agent does
  //    NOT do: the prompt explicitly asks to NOT move the canvas. Maps is
  //    full of click-and-drag affordances; the agent has no drag primitive
  //    so it can't drag, but it could waste budget clicking inappropriate
  //    elements (street view, layer toggles, etc.). The case verifies the
  //    agent stays focused on the search → results path.
  // ────────────────────────────────────────────────────────────────────────
  {
    id: 'gmaps-search-stay',
    url: 'https://www.google.com/maps',
    durationMs: 15_000,
    description: 'Google Maps: search "New York" then JUST observe (no canvas drag)',
    coverageNotes: [
      '- Cookie consent dialog (Google EU compliance often shows it)',
      '- Search input field (text entry inside a complex page)',
      '- Result panel reveal (sidebar slides in)',
      '- Negative test: agent must NOT pan/zoom the map (no drag primitive,',
      '  but should not waste budget on irrelevant controls either)',
      '- Canvas-heavy page (testing scroll behavior on non-document scroller)',
    ].join('\n'),
    prompts: [
      {
        label: 'natural',
        text: '在 Google Maps 上搜一下纽约，等结果出来后看看就行，不要去拖动地图',
      },
      {
        label: 'distracting',
        text: '我想去纽约玩，先在地图上搜一下看看大致位置，结果出来看一眼就好，地图本身不用动它',
      },
    ],
  },
];
