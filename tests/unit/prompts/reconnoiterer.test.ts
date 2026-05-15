import { describe, expect, it } from 'vitest';
import { buildReconUserText, buildReconvergeUserText, reconnoitererSystemPrompt } from '../../../src/prompts/index.js';
import type { PerformanceStep } from '../../../src/domain/performance.js';

const divergedStep: PerformanceStep = {
  kind: 'click',
  target: { selector: 's', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'the 简体中文 link' },
  anticipationMs: 200,
  reasoning: 'switch language',
};

describe('buildReconUserText', () => {
  it('embeds the aria snapshot tree and tells the LLM to pick targets by ref + targetDescription', () => {
    const text = buildReconUserText(
      { url: 'https://example.com/', prompt: 'click 简体中文', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      '- navigation:\n  - link "简体中文" [ref=e42]',
    );
    expect(text).toContain('[ref=e42]');
    expect(text).toContain('简体中文');
    expect(text.toLowerCase()).toContain('"ref"');
    expect(text.toLowerCase()).toContain('targetdescription');
    expect(text.toLowerCase()).toContain('targettext');
    expect(text).toContain('https://example.com/');
  });

  it('falls back gracefully when the snapshot is empty', () => {
    const text = buildReconUserText(
      { url: 'u', prompt: 'p', durationMs: 1000, viewport: { width: 1, height: 1 }, screenshot: null },
      '',
    );
    expect(text.toLowerCase()).toContain('snapshot failed');
  });

  it('renders the pageScrollableHeight signal (raw px + viewport-heights multiplier) so the LLM sizes the scroll plan to the real page (HN short-page fix, 2026-05-15)', () => {
    const text = buildReconUserText(
      {
        url: 'https://news.ycombinator.com/',
        prompt: 'browse the top stories',
        durationMs: 10000,
        viewport: { width: 1280, height: 720 },
        screenshot: null,
        pageScrollableHeight: 494,
      },
      '- main\n  - link "first story" [ref=e1]',
    );
    expect(text).toContain('494px');
    // 494 / 720 ≈ 0.7 viewport-heights
    expect(text).toMatch(/0\.7\s*viewport-heights/);
    // Make sure the rationale (no-op past the bottom → dead air) is conveyed,
    // so the LLM understands WHY the number matters.
    expect(text.toLowerCase()).toContain('past the bottom');
    expect(text.toLowerCase()).toContain('dead air');
  });

  it('omits the pageScrollableHeight line when the caller did not supply it (legacy / pre-2026-05-15 fixtures)', () => {
    const text = buildReconUserText(
      {
        url: 'https://example.com/',
        prompt: 'p',
        durationMs: 1000,
        viewport: { width: 1280, height: 720 },
        screenshot: null,
      },
      '- main [ref=e1]',
    );
    expect(text.toLowerCase()).not.toContain('scrollable height');
    expect(text.toLowerCase()).not.toContain('viewport-heights');
  });
});

describe('buildReconvergeUserText', () => {
  it('mentions the intent, the diverged step, the observed URL, the aria tree, and asks for remaining steps', () => {
    const text = buildReconvergeUserText({
      intent: 'click 简体中文, slow scroll',
      divergedStep,
      observedUrl: 'https://example.com/x',
      snapshot: '- link "Simplified Chinese" [ref=e9]',
    });
    expect(text).toContain('click 简体中文, slow scroll');
    expect(text).toContain('the 简体中文 link');
    expect(text).toContain('https://example.com/x');
    expect(text).toContain('[ref=e9]');
    expect(text).toContain('Simplified Chinese');
    expect(text.toLowerCase()).toContain('steps');
  });

  it('does NOT tell the LLM to abandon the goal — it tells it to try a different approach to the same outcome', () => {
    const text = buildReconvergeUserText({
      intent: 'click 简体中文, slow scroll',
      divergedStep,
      observedUrl: 'https://example.com/x',
      snapshot: '- link "Simplified Chinese" [ref=e9]',
    });
    const lower = text.toLowerCase();
    // Positively tells it to try another way to the same goal.
    expect(lower).toContain('different');
    expect(lower).toContain('same outcome');
    expect(lower).toContain('goal still matters');
    // And does NOT just say "skip it" / "do not repeat the failed step".
    expect(lower).not.toContain('do not repeat the failed step');
    expect(lower).not.toContain('skip the failed step');
  });
});

describe('reconnoitererSystemPrompt — F1 DURATION & SCOPE section', () => {
  it('contains a DURATION & SCOPE section that names durationMs as a hard constraint', () => {
    expect(reconnoitererSystemPrompt).toContain('DURATION & SCOPE');
    expect(reconnoitererSystemPrompt).toMatch(/hard constraint/i);
    expect(reconnoitererSystemPrompt).toMatch(/totalEstimatedMs.*within.*10%/i);
  });

  it('tells the LLM to identify prohibitions itself (we do not regex the prompt)', () => {
    // The whole point of F1 is no hardcoded prohibition detection. A's job.
    expect(reconnoitererSystemPrompt).toMatch(/prohib|forbid/i);
    expect(reconnoitererSystemPrompt).toMatch(/your call|you judge|你判断/i);
  });

  it('forbids mechanical generic scroll/dwell filler when under budget', () => {
    expect(reconnoitererSystemPrompt).toMatch(/(do not|don't).*(mechanical|generic).*(scroll|filler|pad)/i);
  });

  it('says irreconcilable prompt/duration mismatch goes into `rationale` (not a failure)', () => {
    expect(reconnoitererSystemPrompt).toMatch(/rationale/i);
    expect(reconnoitererSystemPrompt).toMatch(/underfilled/i);
  });
});

describe('reconnoitererSystemPrompt — READING RHYTHM + END-OF-CONTENT (wild-prompts sweep follow-up)', () => {
  it('contains a READING RHYTHM section that names the scroll→DWELL pattern', () => {
    expect(reconnoitererSystemPrompt).toContain('READING RHYTHM');
    expect(reconnoitererSystemPrompt).toMatch(/scroll\s*→\s*DWELL/);
    expect(reconnoitererSystemPrompt).toMatch(/1800-(3500|5000)/); // reading-dwell range (widened for variance — round-1 overnight finding)
  });

  it('flags metronomic uniform scrolls as the anti-pattern (Wikipedia run #4 finding)', () => {
    expect(reconnoitererSystemPrompt).toMatch(/metronomic/i);
    expect(reconnoitererSystemPrompt).toMatch(/robot scanning|judge flags it/i);
  });

  it('distinguishes dwellAfterMs (eye-landing) from a separate DWELL step (reading)', () => {
    // The Wikipedia failure was conflating these. The prompt must explicitly
    // call out that dwellAfterMs is NOT reading time.
    expect(reconnoitererSystemPrompt).toMatch(/dwellAfterMs.*NOT reading|NOT reading time/i);
  });

  it('contains an END-OF-CONTENT section that forbids the multi-second static stare', () => {
    expect(reconnoitererSystemPrompt).toContain('END-OF-CONTENT');
    expect(reconnoitererSystemPrompt).toMatch(/DO NOT.*(static|motionless).*dwell.*bottom/i);
    expect(reconnoitererSystemPrompt).toMatch(/(end|done|click into).*interesting/i);
  });
});

describe('reconnoitererSystemPrompt — `goto` step kind (ADR §0041)', () => {
  it('lists `goto` in the action vocabulary', () => {
    expect(reconnoitererSystemPrompt).toMatch(/"kind":\s*"goto"/);
    expect(reconnoitererSystemPrompt).toMatch(/"url":/);
    expect(reconnoitererSystemPrompt).toMatch(/"anticipationMs":/);
  });

  it('explains when to prefer goto over click (URL known, no click path in budget)', () => {
    expect(reconnoitererSystemPrompt).toContain('WHEN TO USE');
    expect(reconnoitererSystemPrompt).toMatch(/Prefer\s+`?click`?.*over.*`?goto`?/i);
  });

  it('imposes a same-host hard constraint and warns cross-host gotos get dropped', () => {
    expect(reconnoitererSystemPrompt).toMatch(/same-host/i);
    expect(reconnoitererSystemPrompt).toMatch(/hostname MUST equal/i);
    expect(reconnoitererSystemPrompt).toMatch(/dropped by the runner/i);
  });

  it('includes goto in the DURATION & SCOPE estimator (anticipationMs + ~1500ms)', () => {
    expect(reconnoitererSystemPrompt).toMatch(/click\s*\/\s*goto/);
  });
});

describe('buildReconvergeUserText — F1 remaining-budget hint', () => {
  it('mentions the remaining durationMs budget when given one', () => {
    const text = buildReconvergeUserText({
      intent: 'click X',
      divergedStep: { kind: 'dwell', durationMs: 500, reasoning: 'r' },
      observedUrl: 'https://example.com',
      snapshot: '- link "X" [ref=e1]',
      remainingDurationMs: 6500,
    });
    expect(text).toMatch(/remaining.*6500|6500.*remaining/i);
  });

  it('omits the remaining-budget hint when not provided', () => {
    const text = buildReconvergeUserText({
      intent: 'click X',
      divergedStep: { kind: 'dwell', durationMs: 500, reasoning: 'r' },
      observedUrl: 'https://example.com',
      snapshot: '- link "X" [ref=e1]',
    });
    expect(text).not.toMatch(/remaining.*durationMs/i);
  });
});

describe('reconnoitererSystemPrompt', () => {
  it('includes scroll-to-target discipline (no overshoot, viewport-heights, screenfuls)', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('overshoot');
    expect(lower).toContain('viewport-height');
    expect(lower).toContain('screenful');
  });

  it('explains the accessibility tree + that click/type steps carry a ref and a targetDescription fallback', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('accessibility tree');
    expect(lower).toContain('[ref=');
    expect(lower).toContain('"ref"');
    expect(lower).toContain('targetdescription');
    expect(lower).toContain('safety net');
  });

  it('tells the planner to give `targetText` (exact visible text) on click steps as the strongest fallback', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('targettext');
    expect(lower).toContain('exact visible text');
    // and the click step shape lists it
    expect(reconnoitererSystemPrompt).toMatch(/"kind": "click"[^}]*"targetText"\?/);
  });

  it('makes accomplishing the goal priority #1 (a step per requested action)', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('accomplish the goal');
    expect(lower).toContain('priority #1');
    // it should tell the planner to verify there's a step for each requested action
    expect(lower).toMatch(/step for each requested action|click.*step.*names? x|re-read the user intent/);
  });
});
