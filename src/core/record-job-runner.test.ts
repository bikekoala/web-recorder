import { describe, expect, it } from 'vitest';

import type { ActionLogEntry, RecordingWindow } from '../domain/action-log.js';
import { computeIntentSatisfaction } from './record-job-runner.js';

const VIEWPORT = { width: 1280, height: 720 };
const WINDOW: RecordingWindow = { startedAtMs: 1000, endedAtMs: 11000 };

const click = (t: number): ActionLogEntry => ({
  t,
  type: 'click',
  selector: 'xpath=//foo',
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

describe('computeIntentSatisfaction', () => {
  it('returns "complete" when all hints clicked AND a scroll happened', () => {
    const r = computeIntentSatisfaction(1, [click(5000), scroll(7000)], WINDOW);
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1);
    expect(r.scrollsExecuted).toBe(1);
    expect(r.hintsResolvedPreRecording).toBe(1);
  });

  it('returns "partial" when click happened but no scroll', () => {
    const r = computeIntentSatisfaction(1, [click(5000)], WINDOW);
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/no scrolling/i);
  });

  it('returns "partial" when only some click hints were executed', () => {
    const r = computeIntentSatisfaction(3, [click(5000), scroll(6000)], WINDOW);
    expect(r.level).toBe('partial');
    expect(r.note).toMatch(/1\/3/);
  });

  it('returns "unmet" when no clicks executed but hints were expected', () => {
    const r = computeIntentSatisfaction(2, [scroll(5000)], WINDOW);
    expect(r.level).toBe('unmet');
    expect(r.note).toMatch(/0\/2/);
  });

  it('returns "unknown" for vague prompts (zero hints) when SOMETHING happened', () => {
    const r = computeIntentSatisfaction(0, [scroll(5000), scroll(7000)], WINDOW);
    expect(r.level).toBe('unknown');
    expect(r.scrollsExecuted).toBe(2);
  });

  it('returns "unmet" when no hints AND nothing happened', () => {
    const r = computeIntentSatisfaction(0, [], WINDOW);
    expect(r.level).toBe('unmet');
  });

  it('excludes setup-phase clicks (before recording window)', () => {
    // BlockerPrelude clicks at t=500 (before WINDOW.startedAtMs=1000).
    const setupClick = click(500);
    const recordingClick = click(5000);
    const r = computeIntentSatisfaction(1, [setupClick, recordingClick, scroll(7000)], WINDOW);
    expect(r.level).toBe('complete');
    expect(r.clicksExecuted).toBe(1); // setupClick excluded
  });

  it('excludes post-recording entries (after recording window)', () => {
    const r = computeIntentSatisfaction(
      1,
      [click(5000), scroll(7000), click(15_000)], // last click is past endedAtMs
      WINDOW,
    );
    expect(r.clicksExecuted).toBe(1);
    expect(r.level).toBe('complete');
  });

  it('counts everything when no recording window is set', () => {
    const r = computeIntentSatisfaction(1, [click(500), scroll(700)], null);
    expect(r.clicksExecuted).toBe(1);
    expect(r.scrollsExecuted).toBe(1);
    expect(r.level).toBe('complete');
  });
});
