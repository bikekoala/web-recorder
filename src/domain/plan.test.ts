import { describe, expect, it } from 'vitest';

import { ClickHint, DirectorBriefing } from './plan.js';

describe('DirectorBriefing schema', () => {
  it('accepts a minimal valid briefing with no hints', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click X then scroll',
      durationMs: 10_000,
      hints: [],
      rationale: 'click + scroll',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a briefing with hints', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click 简中',
      durationMs: 10_000,
      hints: [
        {
          description: 'the 简体中文 link',
          selector: 'xpath=/html/body/...',
          bboxAtRest: { x: 100, y: 200, width: 30, height: 19 },
        },
      ],
      rationale: 'one click target identified',
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative durationMs', () => {
    const result = DirectorBriefing.safeParse({
      prompt: 'click X',
      durationMs: -1,
      hints: [],
      rationale: 'bad duration',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty prompt', () => {
    const result = DirectorBriefing.safeParse({
      prompt: '',
      durationMs: 10_000,
      hints: [],
      rationale: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('ClickHint rejects empty description', () => {
    const result = ClickHint.safeParse({
      description: '',
      selector: 'xpath=...',
      bboxAtRest: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(result.success).toBe(false);
  });
});
