import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DomainError } from '../domain/errors.js';
import { logger as rootLogger } from './logger.js';

/**
 * Tiny wrapper around an ffmpeg binary.
 *
 * Resolution order (preferred → fallback):
 *   1. process.env.FFMPEG_PATH (explicit override)
 *   2. System ffmpeg on $PATH (full build — includes libx264 for mp4 output)
 *   3. Playwright's bundled ffmpeg (VP8-only — works for webm trims only)
 *
 * mp4 output needs a full ffmpeg (Playwright's stripped build has VP8 only).
 * On macOS dev: `brew install ffmpeg`. On Docker: install ffmpeg in the image.
 * If neither is available and mp4 is requested, the runner falls back to webm
 * and the API client gets the format they actually got back.
 */

const logger = rootLogger.child({ component: 'ffmpeg' });

export class FfmpegError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('FFMPEG_FAILED', message, cause);
  }
}

interface FfmpegBinary {
  path: string;
  /** Whether this binary supports the libx264 encoder (needed for mp4). */
  hasH264: boolean;
}

let cachedBinary: FfmpegBinary | null = null;

export async function findFfmpeg(): Promise<string> {
  return (await resolveFfmpeg()).path;
}

/**
 * Like {@link findFfmpeg} but also tells us whether the binary can produce mp4.
 * Lets the caller make a `mp4 → fall back to webm` decision when no libx264
 * encoder is available.
 */
export async function resolveFfmpeg(): Promise<FfmpegBinary> {
  if (cachedBinary) return cachedBinary;

  const explicit = process.env.FFMPEG_PATH;
  if (explicit) {
    await assertExists(explicit);
    cachedBinary = { path: explicit, hasH264: await probeH264(explicit) };
    return cachedBinary;
  }

  // System ffmpeg on $PATH (full build) — preferred for mp4 output.
  const sysPath = await whichFfmpeg();
  if (sysPath) {
    cachedBinary = { path: sysPath, hasH264: await probeH264(sysPath) };
    return cachedBinary;
  }

  // Playwright's bundled ffmpeg (VP8-only).
  const cacheDir = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    throw new FfmpegError(
      `No ffmpeg on $PATH and could not list Playwright cache at ${cacheDir}. Install one: "brew install ffmpeg" or "bunx playwright install ffmpeg".`,
    );
  }

  // Playwright's ffmpeg dir is usually `ffmpeg-N`, but on older macOS it ships
  // under `ffmpeg_mac12_special-N`. Match both prefixes; the binary name is the
  // same set below.
  const dir = entries.find((e) => /^ffmpeg[-_]/.test(e));
  if (!dir) {
    throw new FfmpegError(
      `No ffmpeg on $PATH and no ffmpeg-* / ffmpeg_* directory under ${cacheDir}. Run "npx playwright install ffmpeg" or "brew install ffmpeg".`,
    );
  }

  const candidates = ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win.exe'];
  for (const name of candidates) {
    const p = join(cacheDir, dir, name);
    if (await fileExists(p)) {
      cachedBinary = { path: p, hasH264: await probeH264(p) };
      return cachedBinary;
    }
  }
  throw new FfmpegError(
    `Found ${dir} but no ffmpeg binary inside (looked for ${candidates.join(', ')}).`,
  );
}

async function whichFfmpeg(): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn('sh', ['-c', 'command -v ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.on('close', (code) => resolveP(code === 0 && out.trim() ? out.trim() : null));
    proc.on('error', () => resolveP(null));
  });
}

async function probeH264(path: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const proc = spawn(path, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.on('close', () => resolveP(/\blibx264\b/.test(out)));
    proc.on('error', () => resolveP(false));
  });
}

export interface TrimVideoOpts {
  /** Output container. `mp4` requires libx264 (system ffmpeg or FFMPEG_PATH). */
  format?: 'mp4' | 'webm';
  /** H.264 CRF for mp4 output. Ignored for webm. 0=lossless, 18≈visually lossless, 23=default. */
  crf?: number;
}

export interface TrimVideoResult {
  /** Actual output path (may differ from the input if format fell back). */
  outputPath: string;
  /** The format actually produced — caller may need this when mp4 → webm fallback fires. */
  format: 'mp4' | 'webm';
}

/**
 * Trim a video to the window [startMs, endMs], frame-accurate.
 *
 * Re-encodes (not stream-copy) because Playwright-recorded WebM has very sparse
 * keyframes — input-seek lands on frame 0 and effectively does no trim. `-ss`
 * AFTER `-i` does an output-seek (decode from frame 0 to startSec and discard),
 * which is slower but frame-accurate.
 *
 * Output codec:
 *   - format='mp4' (default per the v1 API spec) → H.264 + yuv420p at the given
 *     CRF (default 18 ≈ visually lossless). Needs system ffmpeg / FFMPEG_PATH
 *     with libx264 — falls back to VP8/webm if not available, and updates the
 *     returned `outputPath` to a `.webm` sibling.
 *   - format='webm' → VP8 at 1 Mbps (fast realtime preset). Always works with
 *     Playwright's bundled ffmpeg.
 *
 * Audio is dropped (`-an`) — Playwright's recordVideo has no audio track. The
 * full ffmpeg + virtual audio device pipeline is tracked under ADR §0043.
 */
export async function trimVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs?: number,
  opts: TrimVideoOpts = {},
): Promise<TrimVideoResult> {
  const requestedFormat = opts.format ?? 'mp4';
  const crf = opts.crf ?? 18;

  const bin = await resolveFfmpeg();
  let format: 'mp4' | 'webm' = requestedFormat;
  let actualOutput = outputPath;
  if (format === 'mp4' && !bin.hasH264) {
    logger.warn(
      { ffmpegPath: bin.path, requested: 'mp4', fallback: 'webm' },
      'ffmpeg has no libx264 encoder — falling back to webm; install a full ffmpeg (e.g. brew install ffmpeg) for mp4 output',
    );
    format = 'webm';
    actualOutput = outputPath.replace(/\.mp4$/i, '.webm');
    if (!/\.webm$/i.test(actualOutput)) actualOutput = `${actualOutput}.webm`;
  }

  const startSec = (startMs / 1000).toFixed(3);
  const args = ['-y', '-loglevel', 'error', '-i', inputPath, '-ss', startSec];
  if (endMs !== undefined) {
    const durationSec = ((endMs - startMs) / 1000).toFixed(3);
    args.push('-t', durationSec);
  }
  if (format === 'mp4') {
    // H.264 + yuv420p (so every player handles it: QuickTime, browsers, social).
    // `-preset fast` is a sane wall-clock/quality tradeoff for 10–30 s clips.
    // `+faststart` puts the moov atom at the head — clients can play before
    // download finishes.
    args.push(
      '-c:v', 'libx264',
      '-crf', String(crf),
      // `ultrafast` over `fast`: for ~10–30 s clips at crf 18 the file-size
      // tax is small (~10-15% bigger) and we save 2-3 s of wall-clock per
      // trim. Eval canary measures trimMs; this lever is reversible.
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      actualOutput,
    );
  } else {
    args.push(
      '-c:v', 'libvpx',
      '-b:v', '1M',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-an',
      actualOutput,
    );
  }

  await runFfmpeg(bin.path, args);
  logger.debug({ inputPath, outputPath: actualOutput, startMs, endMs, format, crf }, 'video trimmed');
  return { outputPath: actualOutput, format };
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

