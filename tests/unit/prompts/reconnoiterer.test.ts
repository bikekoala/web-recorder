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
