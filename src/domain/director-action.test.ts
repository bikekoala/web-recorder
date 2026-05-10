import { describe, expect, it } from 'vitest';

import { DirectorAction } from './director-action.js';

/**
 * Schema sanity for DirectorAction. We trust TypeScript+Zod for shape; the
 * tests below only guard the NON-OBVIOUS refinements (the ones a future
 * developer might delete by mistake).
 */
describe('DirectorAction schema — refinements', () => {
  it('scroll deltaPx must be in [100, 1500] absolute, sign preserved', () => {
    expect(DirectorAction.safeParse({ kind: 'scroll', deltaPx: 600, speed: 'slow', reasoning: 'ok' }).success).toBe(true);
    expect(DirectorAction.safeParse({ kind: 'scroll', deltaPx: -500, speed: 'normal', reasoning: 'up' }).success).toBe(true);
    expect(DirectorAction.safeParse({ kind: 'scroll', deltaPx: 50, speed: 'slow', reasoning: 'jitter' }).success).toBe(false);
    expect(DirectorAction.safeParse({ kind: 'scroll', deltaPx: 2000, speed: 'fast', reasoning: 'huge' }).success).toBe(false);
    expect(DirectorAction.safeParse({ kind: 'scroll', deltaPx: 0, speed: 'slow', reasoning: 'noop' }).success).toBe(false);
  });

  it('dwell durationMs must be in [200, 3000]', () => {
    expect(DirectorAction.safeParse({ kind: 'dwell', durationMs: 600, reasoning: 'ok' }).success).toBe(true);
    expect(DirectorAction.safeParse({ kind: 'dwell', durationMs: 100, reasoning: 'tiny' }).success).toBe(false);
    expect(DirectorAction.safeParse({ kind: 'dwell', durationMs: 5000, reasoning: 'huge' }).success).toBe(false);
  });
});
