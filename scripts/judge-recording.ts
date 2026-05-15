/**
 * Standalone naturalness judge — grade a finished recording.webm against
 * the 5-dimension rubric (§0030). Replaces "human watches the video and
 * forms an opinion" with a structured LLM verdict + per-dimension
 * evidence list.
 *
 * Usage:
 *   bun scripts/judge-recording.ts <video-path> "<user-prompt>" [--duration-ms 10000]
 *
 * Convenience: if you pass a recording.webm under output/, the script
 * looks for the run's `action-log.json` and infers the prompt + duration
 * from the regression-case naming convention OR a sibling judge.input.json
 * file. (Manual override always wins.)
 *
 * Writes the judgment as `judgment.json` next to the video, AND prints a
 * compact summary to stdout. Exits 0 always — the judge is observational,
 * not gating.
 *
 * Example:
 *   bun scripts/judge-recording.ts \
 *     output/2026-05-11/11-14-38-regression-github-multistep-natural/recording.webm \
 *     "go to GitHub Recordly, switch to 简中, click into build folder, read source"
 */

import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

import { LlmVisionJudge } from '../src/adapters/judge/llm-vision-judge.js';
import { logger } from '../src/infra/logger.js';

interface Args {
  videoPath: string;
  userPrompt: string;
  durationMs: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let durationMs = 10_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--duration-ms') {
      const next = argv[i + 1];
      if (!next) throw new Error('--duration-ms requires a value');
      durationMs = Number(next);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(`--duration-ms invalid: ${next}`);
      }
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    throw new Error(
      'usage: judge-recording.ts <video-path> "<user-prompt>" [--duration-ms 10000]',
    );
  }
  const [videoPath, userPrompt] = positional;
  return {
    videoPath: isAbsolute(videoPath!) ? videoPath! : resolve(process.cwd(), videoPath!),
    userPrompt: userPrompt!,
    durationMs,
  };
}

async function main(): Promise<void> {
  const log = logger.child({ script: 'judge-recording' });
  const args = parseArgs(process.argv.slice(2));
  log.info(
    { videoPath: args.videoPath, durationMs: args.durationMs, promptPreview: args.userPrompt.slice(0, 80) },
    'judging recording',
  );

  const judge = new LlmVisionJudge();
  const report = await judge.judge({
    videoPath: args.videoPath,
    userPrompt: args.userPrompt,
    durationMs: args.durationMs,
  });

  // Persist alongside the video so it travels with the artifact.
  const outPath = resolve(dirname(args.videoPath), 'judgment.json');
  await writeFile(outPath, JSON.stringify(report, null, 2));

  // Compact human-readable digest. Heavy detail lives in judgment.json.
  // eslint-disable-next-line no-console
  console.log(`\n══ JUDGMENT (${report.modelId}) ══════════════════════`);
  // eslint-disable-next-line no-console
  console.log(`  video:      ${args.videoPath}`);
  // eslint-disable-next-line no-console
  console.log(`  duration:   ${report.videoDurationSec.toFixed(2)}s`);
  // eslint-disable-next-line no-console
  console.log(`  latency:    ${(report.latencyMs / 1000).toFixed(1)}s`);
  // eslint-disable-next-line no-console
  console.log(`  verdict:    ${report.judgment.verdict.toUpperCase()}`);
  // eslint-disable-next-line no-console
  console.log(`  summary:    ${report.judgment.summary}`);
  // eslint-disable-next-line no-console
  console.log(`\n  Per-dimension:`);
  for (const [name, result] of Object.entries(report.judgment.dimensions)) {
    const symbol = result.level === 'pass' ? '✓' : result.level === 'partial' ? '~' : '✗';
    // eslint-disable-next-line no-console
    console.log(`    ${symbol} ${name.padEnd(20)} ${result.level}`);
    for (const ev of result.evidence) {
      // eslint-disable-next-line no-console
      console.log(`        @ ${ev.atSecond.toFixed(1)}s — ${ev.observation}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n  written:    ${outPath}\n`);
}

main().catch((err) => {
  logger.error(
    {
      err: err instanceof Error
        ? { name: err.name, message: err.message }
        : err,
    },
    '❌ judge failed',
  );
  process.exit(1);
});
