import { describe, expect, it } from 'vitest';

import { buildRunDir } from '../../../src/infra/run-dir.js';

describe('buildRunDir', () => {
  // Use a fixed Date so the assertion is deterministic.
  const now = new Date(2026, 4, 10, 19, 30, 45); // 2026-05-10 19:30:45 LOCAL

  it('builds <root>/<YYYY-MM-DD>/<HH-mm-ss>-<kind>', () => {
    const dir = buildRunDir({ outputRoot: '/tmp/out', kind: 'prototype', now });
    expect(dir).toMatch(/\/tmp\/out\/2026-05-10\/19-30-45-prototype$/);
  });

  it('appends sub when present', () => {
    const dir = buildRunDir({
      outputRoot: '/tmp/out',
      kind: 'regression',
      sub: 'github-multistep-natural',
      now,
    });
    expect(dir).toMatch(/\/2026-05-10\/19-30-45-regression-github-multistep-natural$/);
  });

  it('zero-pads month, day, hour, minute, second', () => {
    const early = new Date(2026, 0, 3, 4, 5, 6); // Jan 3, 04:05:06
    const dir = buildRunDir({ outputRoot: '/tmp/out', kind: 'k', now: early });
    expect(dir).toMatch(/\/2026-01-03\/04-05-06-k$/);
  });
});
