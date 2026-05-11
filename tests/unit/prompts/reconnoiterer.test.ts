import { describe, expect, it } from 'vitest';
import { buildReconvergeUserText } from '../../../src/prompts/index.js';
import type { PerformanceStep } from '../../../src/domain/performance.js';

describe('buildReconvergeUserText', () => {
  it('mentions the intent, the diverged step, the observed URL, an observed element, and asks for remaining steps', () => {
    const divergedStep: PerformanceStep = {
      kind: 'click',
      target: { selector: 's', bbox: { x: 0, y: 0, width: 1, height: 1 }, description: 'the 简体中文 link' },
      anticipationMs: 200,
      reasoning: 'switch language',
    };
    const observed = [{ selector: 'a#real', description: 'Simplified Chinese' }];
    const text = buildReconvergeUserText({
      intent: 'click 简体中文, slow scroll',
      divergedStep,
      observedUrl: 'https://example.com/x',
      observed,
    });
    expect(text).toContain('click 简体中文, slow scroll');
    expect(text).toContain('the 简体中文 link');
    expect(text).toContain('https://example.com/x');
    expect(text).toContain('Simplified Chinese');
    expect(text.toLowerCase()).toContain('steps');
  });
});
