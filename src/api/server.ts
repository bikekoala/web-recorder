/**
 * HTTP API for web-recorder. Self-hosted single-process service per goals.md.
 *
 * Endpoints:
 *   POST   /record               body: RecordRequest → 202 { runId, statusUrl }
 *   GET    /record/:runId        → JobState (queued / running / succeeded / failed)
 *   GET    /record/:runId/video  → trimmed webm stream (only on succeeded)
 *   GET    /record/:runId/run.json → run.json contents (only on succeeded)
 *   GET    /health               → { ok: true, runningJobId?: string, queueDepth: number }
 *
 * Concurrency: one job at a time (JobQueue). Subsequent requests stay
 * `queued` until the running one finishes. Matches the single-Browser-instance
 * reality of the recording stack at v1 scale.
 *
 * Persistence: jobs only live in-memory; on process restart they're gone. The
 * authoritative record of every completed run is the run.json on disk
 * (docs/output-layout.md).
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
import { JobQueue, JobStore } from './job-store.js';
import { RecordRequestSchema, type RecordRequest } from './request.js';

const logger = rootLogger.child({ component: 'ApiServer' });

/**
 * Factory the server invokes for each accepted job. Returns a "run one job"
 * promise — the server owns the JobStore + JobQueue and feeds the factory the
 * parsed request + a pre-built `outputDir` it should write all artifacts into;
 * the factory wires up adapters and calls RecordJobRunner.run. Decoupled so
 * the server file has zero adapter imports — `scripts/serve.ts` is where
 * Stagehand / LLM clients get instantiated.
 */
export interface JobFactory {
  (request: RecordRequest, opts: { runId: string; outputDir: string }): Promise<RunResult>;
}

export interface ApiServerOpts {
  port: number;
  jobFactory: JobFactory;
  /** Override for tests. */
  store?: JobStore;
  queue?: JobQueue;
}

export function createApiServer(opts: ApiServerOpts): { server: Server; store: JobStore } {
  const store = opts.store ?? new JobStore();
  const queue = opts.queue ?? new JobQueue();

  const server = createHttpServer((req, res) => {
    void route(req, res, store, queue, opts.jobFactory).catch((err: unknown) => {
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
  queue: JobQueue,
  jobFactory: JobFactory,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GET /health
  if (method === 'GET' && path === '/health') {
    const running = store.all().find((j) => j.status === 'running');
    return respondJson(res, 200, {
      ok: true,
      runningJobId: running?.runId,
      queueDepth: queue.pendingCount(),
    });
  }

  // POST /record
  if (method === 'POST' && path === '/record') {
    return handleCreateRecord(req, res, store, queue, jobFactory);
  }

  // /record/:runId[/video|/run.json]
  const m = /^\/record\/([0-9a-f-]{36})(\/video|\/run\.json)?$/.exec(path);
  if (m && method === 'GET') {
    const runId = m[1]!;
    const sub = m[2];
    const state = store.get(runId);
    if (!state) return respondJson(res, 404, { error: { code: 'JOB_NOT_FOUND', message: `no job with runId ${runId}` } });
    if (!sub) return respondJson(res, 200, state);
    if (state.status !== 'succeeded' || !state.result) {
      return respondJson(res, 409, { error: { code: 'JOB_NOT_READY', message: `job is in state ${state.status}` } });
    }
    if (sub === '/video') return streamFile(res, state.result.videoPath, 'video/webm');
    if (sub === '/run.json') return streamFile(res, state.result.runJsonPath, 'application/json');
  }

  respondJson(res, 404, { error: { code: 'NOT_FOUND', message: `${method} ${path}` } });
}

async function handleCreateRecord(
  req: IncomingMessage,
  res: ServerResponse,
  store: JobStore,
  queue: JobQueue,
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

  const state = store.enqueue(parsed.data);
  logger.info({ runId: state.runId, request: parsed.data }, 'enqueued recording job');

  // Fire-and-forget — the server immediately returns 202 with the runId so the
  // client can poll. The job runs through the JobQueue (concurrency=1).
  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'api', sub: state.runId });
  void queue.run(async () => {
    store.update(state.runId, { status: 'running' });
    try {
      const result = await jobFactory(parsed.data, { runId: state.runId, outputDir });
      store.update(state.runId, {
        status: 'succeeded',
        result: {
          runDir: outputDir,
          runJsonPath: resolvePath(outputDir, 'run.json'),
          videoPath: result.videoPath,
        },
      });
      logger.info({ runId: state.runId, outputDir }, 'recording job succeeded');
    } catch (err) {
      const code = err instanceof DomainError ? err.code : 'INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      store.update(state.runId, { status: 'failed', error: { code, message } });
      logger.warn({ runId: state.runId, err }, 'recording job failed');
    }
  });

  respondJson(res, 202, {
    runId: state.runId,
    statusUrl: `/record/${state.runId}`,
    status: state.status,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 100 * 1024; // 100 KB — request body cap (well above any realistic RecordRequest).
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
      // Small files — just read into memory + respond.
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

// Re-export for the entry script.
export type { RunResult };
