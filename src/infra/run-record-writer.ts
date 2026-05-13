import { writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';
import { logger as rootLogger } from './logger.js';
import {
  RUN_RECORD_SCHEMA_VERSION,
  RunRecordSchema,
  type RunConfigSnapshot,
  type RunRecord,
} from '../domain/run-record.js';
import { RecordingJudgeReportSchema } from '../domain/recording-judgment.js';
import type { RecordingJudgeReport } from '../domain/recording-judgment.js';

const log = rootLogger.child({ component: 'RunRecordWriter' });

/**
 * Keys on the public `config` that are NEVER persisted into `run.json`'s
 * config snapshot — secrets, credentials, anything the user wouldn't want
 * leaked into a shared run record. Add to this set when you add any
 * secret-bearing config field. Filtered out by name (not by type) on the
 * write side; the Zod schema for `run.json` is permissive (`Record<string,
 * unknown>`) and won't enforce this.
 */
const REDACTED_CONFIG_KEYS = new Set<string>([
  'openrouterApiKey',
]);

/**
 * Snapshot the public config for repro. Strips secrets (see
 * {@link REDACTED_CONFIG_KEYS}). Everything else is dumped verbatim — adding
 * a new config knob automatically shows up in `run.json` without any change
 * here, so the snapshot stays in lockstep with `config.ts`.
 */
export function captureConfigSnapshot(): RunConfigSnapshot {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (REDACTED_CONFIG_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Write `run.json` to the run's output directory. The record is Zod-validated
 * before write — a malformed record is a bug in the runner, not a runtime
 * condition, so we throw rather than silently truncate. Pretty-printed with
 * 2-space indent because the file is meant to be read by humans + future AI
 * sessions (see docs/output-layout.md).
 */
export async function writeRunRecord(outputDir: string, record: unknown): Promise<string> {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`run.json record failed schema: ${parsed.error.message.slice(0, 400)}`);
  }
  const path = resolve(outputDir, 'run.json');
  await writeFile(path, JSON.stringify(parsed.data, null, 2), 'utf8');
  log.info({ path, schemaVersion: parsed.data.schemaVersion }, 'wrote run.json');
  return path;
}

/**
 * Write `judgment.json` to the run's output directory. Validated against
 * {@link RecordingJudgeReportSchema} before write — same reasoning as
 * {@link writeRunRecord}.
 */
export async function writeJudgmentReport(outputDir: string, report: RecordingJudgeReport): Promise<string> {
  const parsed = RecordingJudgeReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`judgment.json record failed schema: ${parsed.error.message.slice(0, 400)}`);
  }
  const path = resolve(outputDir, 'judgment.json');
  await writeFile(path, JSON.stringify(parsed.data, null, 2), 'utf8');
  log.info({ path }, 'wrote judgment.json');
  return path;
}

/**
 * Rename Playwright's raw `recordVideo` output (lands at the run dir as
 * `page@<hash>.webm`) to a stable, descriptive name. Returns the new path.
 *
 *  - If `trimmedExists` is true, the raw video is kept alongside as
 *    `recording-raw.webm` (debug artifact for clock-drift / trim
 *    investigation).
 *  - If `trimmedExists` is false, the raw video IS the deliverable, so it's
 *    renamed straight to `recording.webm`.
 *
 * No-ops (returns the input path) if the source path doesn't match the
 * `page@*.webm` pattern — keeps the function safe to call defensively.
 */
export async function renameRawVideo(
  rawPath: string,
  trimmedExists: boolean,
): Promise<string> {
  // Only rename Playwright's own output. If the source is already named
  // something else (e.g. a future Stagehand version that picks its own name),
  // leave it alone — naming is the writer's contract, not a global rule.
  const base = rawPath.split('/').pop() ?? '';
  if (!base.startsWith('page@') || !base.endsWith('.webm')) return rawPath;

  const dir = dirname(rawPath);
  const newName = trimmedExists ? 'recording-raw.webm' : 'recording.webm';
  const newPath = resolve(dir, newName);
  if (newPath === rawPath) return rawPath;
  await rename(rawPath, newPath);
  log.info({ from: rawPath, to: newPath }, 'renamed raw recordVideo output');
  return newPath;
}

// Re-export the schema version for callers that build a record.
export const RUN_JSON_SCHEMA_VERSION = RUN_RECORD_SCHEMA_VERSION;

export type { RunRecord };
