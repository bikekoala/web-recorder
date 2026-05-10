import { describe, expect, it } from 'vitest';

import { DirectorAction, ScrollSpeed } from './director-action.js';

describe('DirectorAction schema', () => {
  it('accepts a valid click action', () => {
    const result = DirectorAction.safeParse({
      kind: 'click',
      target: 'the 简体中文 link',
      reasoning: 'user requested it',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid scroll action', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 600,
      speed: 'slow',
      reasoning: 'browse content',
    });
    expect(result.success).toBe(true);
  });

  it('accepts negative scroll deltaPx (scroll up)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: -500,
      speed: 'normal',
      reasoning: 'look back',
    });
    expect(result.success).toBe(true);
  });

  it('rejects scroll deltaPx below 100 absolute (jitter range)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 50,
      speed: 'slow',
      reasoning: 'too small',
    });
    expect(result.success).toBe(false);
  });

  it('rejects scroll deltaPx above 1500 absolute (disorient range)', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 2000,
      speed: 'fast',
      reasoning: 'too big',
    });
    expect(result.success).toBe(false);
  });

  it('rejects scroll deltaPx of 0', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 0,
      speed: 'slow',
      reasoning: 'no-op',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown speed', () => {
    const result = DirectorAction.safeParse({
      kind: 'scroll',
      deltaPx: 600,
      speed: 'instant',
      reasoning: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('accepts dwell within range', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 600,
      reasoning: 'pause',
    });
    expect(result.success).toBe(true);
  });

  it('rejects dwell below 200ms (too short to read)', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 100,
      reasoning: 'too short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects dwell above 3000ms (too long, dead air)', () => {
    const result = DirectorAction.safeParse({
      kind: 'dwell',
      durationMs: 5000,
      reasoning: 'too long',
    });
    expect(result.success).toBe(false);
  });

  it('accepts done', () => {
    const result = DirectorAction.safeParse({
      kind: 'done',
      reasoning: 'recording complete',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing reasoning', () => {
    const result = DirectorAction.safeParse({
      kind: 'click',
      target: 'something',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = DirectorAction.safeParse({
      kind: 'teleport',
      reasoning: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('exports ScrollSpeed enum values', () => {
    expect(ScrollSpeed.options).toEqual(['slow', 'normal', 'fast']);
  });
});
