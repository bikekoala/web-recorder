import { describe, expect, it } from 'vitest';
import { blockerDismisserSystemPrompt, buildBlockerDismissUserText } from '../../../src/prompts/index.js';

describe('blockerDismisserSystemPrompt', () => {
  it('names the dismissable kinds, the preference order, and demands JSON only', () => {
    const lower = blockerDismisserSystemPrompt.toLowerCase();
    expect(lower).toContain('consent');
    expect(lower).toContain('accept all');
    expect(lower).toContain('paywall'); // explicitly NOT dismissable
    expect(lower).toContain('blocker'); // the output key
    expect(lower).toContain('json'); // JSON-only rule
  });
});

describe('buildBlockerDismissUserText', () => {
  it('lists the observed elements and asks for the JSON decision', () => {
    const text = buildBlockerDismissUserText([
      { selector: '#a', description: 'Accept all cookies button' },
      { selector: '#b', description: 'Reject all button' },
    ]);
    expect(text).toContain('Accept all cookies button');
    expect(text.toLowerCase()).toContain('json');
  });
  it('handles an empty observed list', () => {
    expect(buildBlockerDismissUserText([])).toContain('(none found)');
  });
});
