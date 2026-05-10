import { resolve } from 'node:path';

/**
 * Build a deterministic output directory path for a single recording run.
 *
 * Layout (per user request, 2026-05-10):
 *   <outputRoot>/<YYYY-MM-DD>/<HH-mm-ss>-<kind>[-<sub>]
 *
 * Examples:
 *   output/2026-05-10/19-30-45-regression-github-multistep-natural
 *   output/2026-05-10/19-31-32-prototype
 *   output/2026-05-10/19-31-58-smoke
 *
 * Why this shape:
 *   - Top-level day folders make `ls output/` readable when there are
 *     hundreds of runs across days.
 *   - HH-mm-ss prefix sorts lexically the same as time, so within a day
 *     the most recent runs come last in `ls`.
 *   - Hyphens (not colons / underscores) so the path is fs-safe on every
 *     platform we care about.
 */
export function buildRunDir(opts: {
  /** Project-level output root, typically `config.outputDir`. */
  outputRoot: string;
  /** What kind of run this is — 'regression', 'prototype', 'smoke', etc. */
  kind: string;
  /** Optional sub-identifier appended after `kind` with a `-` separator. */
  sub?: string;
  /** Override the clock — only used by tests. Defaults to `new Date()`. */
  now?: Date;
}): string {
  const d = opts.now ?? new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  const tail = opts.sub ? `${opts.kind}-${opts.sub}` : opts.kind;
  return resolve(opts.outputRoot, date, `${time}-${tail}`);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
