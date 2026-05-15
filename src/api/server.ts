/**
 * HTTP API for web-recorder. REST-style, versioned under `/api/v1`.
 *
 * Endpoints:
 *   POST   /api/v1/recordings              create — body: RecordRequest → 202 {runId, status, statusUrl, videoUrl, runJsonUrl}
 *   GET    /api/v1/recordings              list  — newest-first JobState[]
 *   GET    /api/v1/recordings/:runId       status of one job (JobState)
 *   GET    /api/v1/recordings/:runId/video stream the recording (only on succeeded)
 *   GET    /api/v1/recordings/:runId/run.json structured run record (only on succeeded)
 *   GET    /health                         { ok, runningJobs, queueDepth }
 *
 * Concurrency: jobs run in parallel (no JobQueue). Each accepted POST kicks
 * off a `jobFactory` task immediately. The user explicitly asked for this
 * (`API 请求 支持 并发`); the recording stack opens a fresh browser per job.
 *
 * Persistence: jobs only live in-memory; on process restart they're gone. The
 * authoritative record of every completed run is the run.json on disk
 * (docs/output-layout.md).
 *
 * Decoupling: the server has zero adapter imports — it accepts a `JobFactory`
 * the entry script (scripts/serve.ts) provides. That's how core/api stays
 * independent of Stagehand / LLM clients.
 *
 * Built on Node's `http` module — zero new deps. The surface is small enough
 * that a framework would be over-engineering at v1.
 */

import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve as resolvePath } from 'node:path';

import { DomainError } from '../domain/errors.js';
import { config } from '../infra/config.js';
import { logger as rootLogger } from '../infra/logger.js';
import { buildRunDir } from '../infra/run-dir.js';
import type { RunResult } from '../core/record-job-runner.js';
import { JobStore } from './job-store.js';
import { RecordRequestSchema, type RecordRequest } from './request.js';

const logger = rootLogger.child({ component: 'ApiServer' });

const API_PREFIX = '/api/v1/recordings';

/**
 * Factory the server invokes for each accepted job. Returns a "run one job"
 * promise — the server owns the JobStore and feeds the factory the parsed
 * request + a pre-built `outputDir` it should write all artifacts into; the
 * factory wires up adapters and calls RecordJobRunner.run.
 */
export interface JobFactory {
  (request: RecordRequest, opts: { runId: string; outputDir: string }): Promise<RunResult>;
}

export interface ApiServerOpts {
  port: number;
  jobFactory: JobFactory;
  /** Override for tests. */
  store?: JobStore;
}

export function createApiServer(opts: ApiServerOpts): { server: Server; store: JobStore } {
  const store = opts.store ?? new JobStore();

  const server = createHttpServer((req, res) => {
    void route(req, res, store, opts.jobFactory).catch((err: unknown) => {
      logger.error({ err, url: req.url, method: req.method }, 'unhandled error in route');
      if (!res.headersSent) {
        respondJson(res, 500, { error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } });
      }
    });
  });

  return { server, store };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: JobStore,
  jobFactory: JobFactory,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GET /health
  if (method === 'GET' && path === '/health') {
    return respondJson(res, 200, {
      ok: true,
      runningJobs: store.countByStatus('running'),
      queueDepth: store.countByStatus('queued'),
    });
  }

  // POST /api/v1/recordings
  if (method === 'POST' && path === API_PREFIX) {
    return handleCreateRecording(req, res, store, jobFactory);
  }

  // GET /api/v1/recordings  (list)
  if (method === 'GET' && path === API_PREFIX) {
    return respondJson(res, 200, { recordings: store.all() });
  }

  // /api/v1/recordings/:runId[/video|/run.json]
  const m = new RegExp(`^${API_PREFIX}/([0-9a-f-]{36})(/video|/run\\.json)?$`).exec(path);
  if (m && method === 'GET') {
    const runId = m[1]!;
    const sub = m[2];
    const state = store.get(runId);
    if (!state) return respondJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: `no job with runId ${runId}` } });
    if (!sub) return respondJson(res, 200, state);
    if (state.status !== 'succeeded' || !state.result) {
      return respondJson(res, 409, { error: { code: 'JOB_NOT_READY', message: `job is in state ${state.status}` } });
    }
    if (sub === '/video') {
      const contentType = state.request?.format === 'webm' ? 'video/webm' : 'video/mp4';
      return streamFile(res, state.result.videoPath, contentType);
    }
    if (sub === '/run.json') return streamFile(res, state.result.runJsonPath, 'application/json');
  }

  respondJson(res, 404, { error: { code: 'NOT_FOUND', message: `${method} ${path}` } });
}

async function handleCreateRecording(
  req: IncomingMessage,
  res: ServerResponse,
  store: JobStore,
  jobFactory: JobFactory,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return respondJson(res, 400, { error: { code: 'BAD_JSON', message: err instanceof Error ? err.message : String(err) } });
  }
  const parsed = RecordRequestSchema.safeParse(body);
  if (!parsed.success) {
    return respondJson(res, 400, { error: { code: 'BAD_REQUEST', message: parsed.error.message.slice(0, 400) } });
  }

  // Audio is not implemented at v1 — the recording stack is Playwright's
  // `recordVideo`, which has no audio track support. The swap to an
  // ffmpeg-based recorder (xvfb+PulseAudio on Linux/Docker, avfoundation
  // on macOS dev) is a follow-up sub-project — ADR §0043.
  if (parsed.data.audio) {
    return respondJson(res, 501, {
      error: {
        code: 'AUDIO_NOT_IMPLEMENTED',
        message: 'audio recording is not available in v1 — see ADR §0043 (xvfb+ffmpeg / avfoundation pipeline). Retry with audio:false.',
      },
    });
  }

  const state = store.enqueue(parsed.data);
  logger.info({ runId: state.runId, request: parsed.data }, 'accepted recording job');

  // Fire-and-forget — the server immediately returns 202 with the runId so the
  // client can poll. No JobQueue: jobs run concurrently per the v1 spec.
  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'api', sub: state.runId });
  void runJob(store, jobFactory, state.runId, parsed.data, outputDir);

  respondJson(res, 202, {
    runId: state.runId,
    status: state.status,
    statusUrl: state.statusUrl,
    videoUrl: state.videoUrl,
    runJsonUrl: state.runJsonUrl,
  });
}

async function runJob(
  store: JobStore,
  jobFactory: JobFactory,
  runId: string,
  request: RecordRequest,
  outputDir: string,
): Promise<void> {
  store.update(runId, { status: 'running' });
  try {
    const result = await jobFactory(request, { runId, outputDir });
    store.update(runId, {
      status: 'succeeded',
      result: {
        runDir: outputDir,
        runJsonPath: resolvePath(outputDir, 'run.json'),
        videoPath: result.videoPath,
        videoUrl: `${API_PREFIX}/${runId}/video`,
        runJsonUrl: `${API_PREFIX}/${runId}/run.json`,
        urlResolution: result.urlResolution,
        // Caller-facing transparency channel — goals.md #3. Coarse signals
        // only; full diagnostic is reachable via runJsonUrl.
        meta: {
          intent: {
            level: result.metrics.intentSatisfaction.level,
            note: result.metrics.intentSatisfaction.note,
          },
          actualDurationMs: result.metrics.trimmedVideoMs,
        },
      },
    });
    logger.info({ runId, outputDir, urlResolution: result.urlResolution }, 'recording job succeeded');
  } catch (err) {
    const code = err instanceof DomainError ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    store.update(runId, { status: 'failed', error: { code, message } });
    logger.warn({ runId, err }, 'recording job failed');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 100 * 1024; // 100 KB — request body cap.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length) });
  res.end(buf);
}

async function streamFile(res: ServerResponse, path: string, contentType: string): Promise<void> {
  try {
    const stat = statSync(path);
    if (contentType === 'application/json') {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(stat.size) });
    createReadStream(path).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      respondJson(res, 500, { error: { code: 'FILE_READ', message: err instanceof Error ? err.message : String(err) } });
    }
  }
}

export type { RunResult };
