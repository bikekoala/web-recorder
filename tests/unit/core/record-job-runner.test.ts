import { describe, expect, it } from 'vitest';

import type { ActionLogEntry, RecordingWindow } from '../../../src/domain/action-log.js';
import { computeIntentSatisfaction } from '../../../src/core/record-job-runner.js';

const VIEWPORT = { width: 1280, height: 720 };
const WINDOW: RecordingWindow = { startedAtMs: 1000, endedAtMs: 11000 };

const click = (t: number, description?: string): ActionLogEntry => ({
  t,
  type: 'click',
  selector: 'xpath=//foo',
  ...(description ? { description } : {}),
  scrollY: 0,
  viewport: VIEWPORT,
});

const scroll = (t: number): ActionLogEntry => ({
  t,
  type: 'scroll',
  deltaY: 300,
  fromScrollY: 0,
  toScrollY: 300,
  durationMs: 800,
  viewport: VIEWPORT,
});

describe('computeIntentSatisfaction — UNIQUE-hint matching', () => {
  it('returns "complete" when each hint is clicked at least once AND a scroll happened', () => {
    const r = computeIntentSatisfaction(
      ['the simplified Chinese link'],
      [click(5000, 'click the 简体中文 link'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1);
    expect(r.scrollsExecuted).toBe(1);
  });

  it('counts UNIQUE hints, not total clicks (catches the YouTube 8x click bug)', () => {
    // Same hint clicked 8 times — should be "partial" not "complete".
    // This is the regression test for the YouTube case where the agent
    // clicked the search bar 8 times without ever typing.
    const sameHint = 'click the search bar';
    const clicks = [
      click(5000, sameHint),
      click(5500, sameHint),
      click(6000, sameHint),
      click(6500, sameHint),
      click(7000, sameHint),
      click(7500, sameHint),
      click(8000, sameHint),
      click(8500, sameHint),
    ];
    // Two hints — but only one of them is matched by the click description.
    const r = computeIntentSatisfaction(
      ['the search bar', 'the MrBeast channel link'],
      [...clicks, scroll(9000)],
      WINDOW,
    );
    expect(r.level).toBe('partial');
    expect(r.clicksExecuted).toBe(8);
    expect(r.note).toMatch(/1\/2/);
  });

  it('lenient substring match: "build folder" matches "the build directory folder link"', () => {
    const r = computeIntentSatisfaction(
      ['the build directory folder link'],
      [click(5000, 'click the build folder'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
  });

  it('CJK content tokens count as match material', () => {
    const r = computeIntentSatisfaction(
      ['the 简体中文 link'],
      [click(5000, 'click 简体中文链接'), scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
  });

  it('returns "partial" when some hints are clicked but not all', () => {
    const r = computeIntentSatisfaction(
      ['the build folder', 'the package.json file', 'the simplified Chinese link'],
      [click(5000, 'click the build folder'), scroll(6000)],
      WINDOW,
    );
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/1\/3/);
  });

  it('returns "unmet" when zero hints are matched', () => {
    const r = computeIntentSatisfaction(['the search bar'], [scroll(5000)], WINDOW);
    expect(r.level).toBe('unmet');
  });

  it('returns "unknown" for vague prompts (zero hints) with some action', () => {
    const r = computeIntentSatisfaction([], [scroll(5000), scroll(7000)], WINDOW);
    expect(r.level).toBe('unknown');
  });

  it('excludes setup-phase clicks (before recording window)', () => {
    const setup = click(500, 'click the cookie accept button');
    const recording = click(5000, 'click the simplified Chinese link');
    const r = computeIntentSatisfaction(
      ['the simplified Chinese link'],
      [setup, recording, scroll(7000)],
      WINDOW,
    );
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1); // setupClick excluded from window
  });

  // §0033 — over-count regression. Models the exact github-multistep case
  // surfaced by the §0030 video judge: 3 hints, only 2 clicks (both on the
  // same Chinese-language element), and the old many-to-many matching
  // credited the lone "link" token toward all 3 hints. With 1-to-1
  // bipartite assignment, only the genuinely-clicked hint matches.
  it('(§0033) one click cannot satisfy multiple unrelated hints via a single shared UI noun', () => {
    const r = computeIntentSatisfaction(
      [
        'the simplified 简体中文 link',
        'the build directory link',
        'the package.json file link',
      ],
      [
        click(5000, 'the simplified Chinese language switcher link in the GitHub footer'),
        click(8000, 'the Chinese language option'),
        scroll(9000),
      ],
      WINDOW,
    );
    // Both clicks land on the Chinese hint — only 1/3 hints should count.
    // (Pre-§0033 this was reported "complete (all 3 hint(s) clicked)" because
    //  every other hint shared the lone "link" token with the click descs.)
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/1\/3/);
  });
});
