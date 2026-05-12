import { describe, expect, it } from 'vitest';
import { rankCandidates, type RankableCandidate } from '../../../../src/adapters/agent/stagehand-session.js';

const c = (selector: string, interactive: boolean, bbox = { x: 0, y: 0, width: 10, height: 10 }): RankableCandidate => ({
  selector,
  description: 'd',
  bbox,
  interactive,
});

describe('rankCandidates', () => {
  it('puts interactive elements ahead of wrappers, keeping order within each group', () => {
    const ranked = rankCandidates([
      c('wrapperDiv', false, { x: 0, y: 0, width: 100, height: 50 }),
      c('realLink', true, { x: 5, y: 5, width: 80, height: 20 }),
      c('anotherWrapper', false, { x: 0, y: 60, width: 100, height: 30 }),
      c('realButton', true, { x: 5, y: 65, width: 60, height: 24 }),
    ]);
    expect(ranked.map((r) => r.selector)).toEqual(['realLink', 'realButton', 'wrapperDiv', 'anotherWrapper']);
  });

  it('de-dups candidates that occupy the same position (observe sometimes returns the element twice)', () => {
    const ranked = rankCandidates([
      c('selA', true, { x: 10, y: 20, width: 40, height: 12 }),
      c('selB', true, { x: 10.2, y: 19.8, width: 40.1, height: 12 }), // same rounded box
      c('selC', false, { x: 100, y: 200, width: 30, height: 30 }),
    ]);
    expect(ranked.map((r) => r.selector)).toEqual(['selA', 'selC']);
  });

  it('returns [] for []', () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it('preserves order when all are interactive', () => {
    const ranked = rankCandidates([
      c('a', true, { x: 0, y: 0, width: 1, height: 1 }),
      c('b', true, { x: 10, y: 10, width: 1, height: 1 }),
      c('c', true, { x: 20, y: 20, width: 1, height: 1 }),
    ]);
    expect(ranked.map((r) => r.selector)).toEqual(['a', 'b', 'c']);
  });
});
