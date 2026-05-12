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
  it('embeds the aria snapshot tree and tells the LLM to pick targets by ref', () => {
    const text = buildReconUserText(
      { url: 'https://example.com/', prompt: 'click 简体中文', durationMs: 10000, viewport: { width: 1280, height: 720 }, screenshot: null },
      '- navigation:\n  - link "简体中文" [ref=e42]',
    );
    expect(text).toContain('[ref=e42]');
    expect(text).toContain('简体中文');
    expect(text.toLowerCase()).toContain('"ref"');
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

describe('reconnoitererSystemPrompt', () => {
  it('includes scroll-to-target discipline (no overshoot, viewport-heights, screenfuls)', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('overshoot');
    expect(lower).toContain('viewport-height');
    expect(lower).toContain('screenful');
  });

  it('explains the accessibility tree + that click/type steps carry a ref', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('accessibility tree');
    expect(lower).toContain('[ref=');
    expect(lower).toContain('"ref"');
  });

  it('makes accomplishing the goal priority #1 (a step per requested action)', () => {
    const lower = reconnoitererSystemPrompt.toLowerCase();
    expect(lower).toContain('accomplish the goal');
    expect(lower).toContain('priority #1');
    // it should tell the planner to verify there's a step for each requested action
    expect(lower).toMatch(/step for each requested action|click.*step.*names? x|re-read the user intent/);
  });
});
