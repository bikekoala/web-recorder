import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DomainError } from '../domain/errors.js';
import { logger as rootLogger } from './logger.js';

/**
 * Tiny wrapper around the ffmpeg binary that ships with Playwright.
 *
 * We deliberately do not require the user to `brew install ffmpeg` — Playwright
 * already downloaded a known-good ffmpeg as part of `npm run playwright:install`,
 * and we reuse it.
 *
 * If the bundled binary moves or the user has set FFMPEG_PATH, we honor that.
 */

const logger = rootLogger.child({ component: 'ffmpeg' });

export class FfmpegError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('FFMPEG_FAILED', message, cause);
  }
}

let cachedPath: string | null = null;

/**
 * Locate the ffmpeg binary. Resolution order:
 *   1. process.env.FFMPEG_PATH (explicit override)
 *   2. Playwright's bundled ffmpeg under ~/Library/Caches/ms-playwright/ffmpeg-*\/ffmpeg-{mac,linux,win.exe}
 *
 * Result is cached for the lifetime of the process — ffmpeg locations don't
 * change mid-process.
 */
export async function findFfmpeg(): Promise<string> {
  if (cachedPath) return cachedPath;

  const explicit = process.env.FFMPEG_PATH;
  if (explicit) {
    await assertExists(explicit);
    cachedPath = explicit;
    return explicit;
  }

  const cacheDir = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    throw new FfmpegError(
      `Could not list Playwright cache at ${cacheDir}. Run "npm run playwright:install".`,
    );
  }

  const dir = entries.find((e) => e.startsWith('ffmpeg-'));
  if (!dir) {
    throw new FfmpegError(
      `No ffmpeg-* directory under ${cacheDir}. Run "npx playwright install ffmpeg".`,
    );
  }

  // Bundled binary names by platform (Playwright convention).
  const candidates = ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win.exe'];
  for (const name of candidates) {
    const p = join(cacheDir, dir, name);
    if (await fileExists(p)) {
      cachedPath = p;
      return p;
    }
  }
  throw new FfmpegError(
    `Found ${dir} but no ffmpeg binary inside (looked for ${candidates.join(', ')}).`,
  );
}

/**
 * Trim a video to the window [startMs, endMs], frame-accurate.
 *
 * We re-encode with libvpx (VP8) for frame-accurate cuts. Stream-copy trims
 * (`-c copy`) were tried first but failed on Playwright-recorded WebM — the
 * source has very sparse keyframes (often just one at frame 0), so input-seek
 * lands at frame 0 and effectively does no trim.
 *
 * Re-encoding cost: ~0.5-2s for a 10s 720p clip. Quality at `-b:v 1M` is
 * visually indistinguishable from the source for scrolling UI footage.
 *
 * Why not MP4/H.264: Playwright's bundled ffmpeg is a stripped build with
 * only VP8 encoders. Adding system ffmpeg as a dep can come later if the
 * user needs MP4 output for upload to social platforms.
 *
 * @param inputPath  Source video (.webm).
 * @param outputPath Destination .webm.
 * @param startMs    Trim start in milliseconds (>= 0).
 * @param endMs      Trim end in milliseconds (> startMs). If undefined, trim runs to EOF.
 */
export async function trimVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs?: number,
): Promise<void> {
  const ffmpeg = await findFfmpeg();
  const startSec = (startMs / 1000).toFixed(3);

  // `-ss` AFTER `-i` does an output-seek: ffmpeg decodes from frame 0 to
  // startSec and discards. Slower than input-seek but frame-accurate
  // regardless of keyframe placement — required for our sparse-keyframe
  // source.
  const args = [
    '-y',
    '-loglevel', 'error',
    '-i', inputPath,
    '-ss', startSec,
  ];
  if (endMs !== undefined) {
    const durationSec = ((endMs - startMs) / 1000).toFixed(3);
    args.push('-t', durationSec);
  }
  args.push(
    '-c:v', 'libvpx',
    '-b:v', '1M',
    '-deadline', 'realtime',    // fastest VP8 encode preset
    '-cpu-used', '8',           // max speed (VP8 0=best, 16=fastest)
    '-an',                       // drop audio (Playwright recordings are silent)
    outputPath,
  );

  await runFfmpeg(ffmpeg, args);
  logger.debug({ inputPath, outputPath, startMs, endMs }, 'video trimmed');
}

/**
 * Probe a video's duration in milliseconds, parsing the `Duration:` header
 * ffmpeg prints during input probing (`-f null -` errors on Playwright's
 * stripped build — no `null` muxer — but the header is printed first, so the
 * regex still finds it). For `recordVideo` webm this is the matroska Duration
 * element = the actual length of captured video — which can run *seconds short*
 * of the session's wall-clock (the compositor's frame timeline lags real time:
 * a ~2 s gap on a ~40 s session has been observed). So this is the deliverable's
 * real length, not a probe artifact. RecordJobRunner uses this lag (raw video
 * length ÷ session wall time) to trim the recording by video-relative time
 * rather than wall-clock time — see `videoRelativeTrimWindow` + docs/findings
 * (recordVideo clock drift). On a full ffmpeg the trailing `time=…` from a real
 * `-f null -` decode is preferred.
 * Imprecise (~50 ms) — fine for logging / sanity checks.
 */
export async function videoDurationMs(inputPath: string): Promise<number | null> {
  const ffmpeg = await findFfmpeg();
  const stderr = await captureStderr(ffmpeg, ['-i', inputPath, '-f', 'null', '-']);
  const hmsToMs = (h: string, m: string, s: string): number =>
    Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
  const times = [...stderr.matchAll(/time=\s*(\d+):(\d+):([\d.]+)/g)];
  const last = times[times.length - 1];
  if (last) return hmsToMs(last[1]!, last[2]!, last[3]!);
  const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  return m ? hmsToMs(m[1]!, m[2]!, m[3]!) : null;
}

// --- internals ----------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function assertExists(p: string): Promise<void> {
  if (!(await fileExists(p))) {
    throw new FfmpegError(`FFMPEG_PATH points to non-existent file: ${p}`);
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => rejectP(new FfmpegError(`ffmpeg spawn failed`, err)));
    proc.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new FfmpegError(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function captureStderr(bin: string, args: string[]): Promise<string> {
  return new Promise((resolveP) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('close', () => resolveP(stderr));
    proc.on('error', () => resolveP(stderr));
  });
}

/** Convenience: resolve to absolute paths consistently. */
export function asAbsolute(p: string): string {
  return resolve(p);
}
