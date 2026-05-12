import { describe, expect, it } from 'vitest';
import { pruneAriaSnapshot } from '../../../../src/adapters/agent/stagehand-session.js';

describe('pruneAriaSnapshot', () => {
  it('drops generic / paragraph / text / StaticText lines, keeps actionable + structural ones', () => {
    const input = [
      '- banner [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - link "Sign in" [ref=e3]:',
      '      - /url: /login',
      '  - text: some inline text',
      '- main [ref=e4]:',
      '  - heading "Cats" [level=1] [ref=e5]',
      '  - paragraph [ref=e6]:',
      '    - text: The cat is a',
      '    - link "Felidae" [ref=e7]:',
      '      - /url: /wiki/Felidae',
      '  - table [ref=e8]:',
      '    - row "Family: Felidae" [ref=e9]:',
      '      - cell "Family:"',
      '      - cell [ref=e10]:',
      '        - link "Felidae" [ref=e11]',
      '  - StaticText: footer-ish',
    ].join('\n');
    const out = pruneAriaSnapshot(input);
    // kept
    expect(out).toContain('- banner [ref=e1]:');
    expect(out).toContain('- link "Sign in" [ref=e3]:');
    expect(out).toContain('  - /url: /login'); // property line — kept (no leading role word)
    expect(out).toContain('- main [ref=e4]:');
    expect(out).toContain('- heading "Cats" [level=1] [ref=e5]');
    expect(out).toContain('- link "Felidae" [ref=e7]:');
    expect(out).toContain('- row "Family: Felidae" [ref=e9]:');
    expect(out).toContain('- cell "Family:"');
    expect(out).toContain('- link "Felidae" [ref=e11]');
    // dropped
    expect(out).not.toContain('- generic');
    expect(out).not.toContain('- paragraph');
    expect(out).not.toContain('- text:');
    expect(out).not.toContain('- StaticText:');
    // and it actually got smaller
    expect(out.length).toBeLessThan(input.length);
  });

  it('is a no-op on an empty string', () => {
    expect(pruneAriaSnapshot('')).toBe('');
  });

  it('keeps every line when nothing is prunable', () => {
    const input = '- button "OK" [ref=e1]\n- link "Home" [ref=e2]\n- heading "Title" [ref=e3]';
    expect(pruneAriaSnapshot(input)).toBe(input);
  });

  it('does not drop a role that merely starts with a drop-role substring', () => {
    // "generictext" / "paragraphs" are not the role "generic" / "paragraph".
    const input = '- generictext "weird" [ref=e1]\n- paragraphs "list" [ref=e2]\n- generic [ref=e3]:';
    const out = pruneAriaSnapshot(input);
    expect(out).toContain('- generictext "weird" [ref=e1]');
    expect(out).toContain('- paragraphs "list" [ref=e2]');
    expect(out).not.toContain('- generic [ref=e3]');
  });
});
