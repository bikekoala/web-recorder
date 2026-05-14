import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobStore } from '../../../src/api/job-store.js';
import { createApiServer, type JobFactory } from '../../../src/api/server.js';
import type { RunResult } from '../../../src/core/record-job-runner.js';

/** Build a fake RunResult whose paths point at a real temp file (so /video / /run.json can stream). */
function fakeResult(outputDir: string): RunResult {
  const videoPath = join(outputDir, 'recording.webm');
  const runJsonPath = join(outputDir, 'run.json');
  writeFileSync(videoPath, 'FAKE_VIDEO');
  writeFileSync(runJsonPath, JSON.stringify({ ok: true }));
  return {
    videoPath,
    rawVideoPath: videoPath,
    actionLogPath: join(outputDir, 'action-log.json'),
    // The server doesn't inspect these; just satisfy the interface.
    performance: { prompt: 'p', durationMs: 1000, steps: [{ kind: 'done', reasoning: 'fin' }], totalEstimatedMs: 0, rationale: 'r' } as RunResult['performance'],
    metrics: {} as RunResult['metrics'],
    directorReport: {} as RunResult['directorReport'],
  };
}

/** Boot the server on an OS-assigned port; returns the base URL + a close fn. */
async function startServer(jobFactory: JobFactory) {
  const store = new JobStore();
  const { server } = createApiServer({ port: 0, jobFactory, store });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    store,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Tiny waitFor — poll until predicate or timeout. */
async function waitFor<T>(predicate: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

describe('API server', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'web-recorder-api-test-')); });
  afterEach(() => { /* tmp dirs auto-clean on test process exit; we keep tests fast and not noisy */ });

  it('GET /health returns ok and a queueDepth', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; queueDepth: number };
      expect(body).toEqual({ ok: true, queueDepth: 0 });
    } finally { await s.close(); }
  });

  it('POST /record accepts a well-formed body and returns 202 with runId', async () => {
    const factory: JobFactory = async (_req, { outputDir }) => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const res = await fetch(`${s.baseUrl}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/', prompt: 'browse', durationMs: 10000 }),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as { runId: string; status: string; statusUrl: string };
      expect(body.status).toBe('queued');
      expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.statusUrl).toBe(`/record/${body.runId}`);
    } finally { await s.close(); }
  });

  it('POST /record rejects a malformed body (400 BAD_REQUEST)', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not a url' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
    } finally { await s.close(); }
  });

  it('POST /record rejects malformed JSON (400 BAD_JSON)', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BAD_JSON');
    } finally { await s.close(); }
  });

  it('GET /record/:runId returns 404 for unknown ids', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}/record/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    } finally { await s.close(); }
  });

  it('POST → GET → succeeded with result paths', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}/record`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/', prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      const final = await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}/record/${runId}`);
        const j = await r.json() as { status: string; result?: unknown };
        return j.status === 'succeeded' ? j : null;
      });
      expect(final).toMatchObject({ status: 'succeeded', result: { videoPath: expect.stringContaining('recording.webm') } });
    } finally { await s.close(); }
  });

  it('a factory error surfaces as failed with the DomainError code', async () => {
    const factory: JobFactory = async () => {
      const err = new Error('recon failed');
      // Mimic DomainError without importing the class (the server already imports it).
      Object.assign(err, { code: 'RECON_FAILED', name: 'ReconError' });
      throw err;
    };
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}/record`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/', prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      const failed = await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}/record/${runId}`);
        const j = await r.json() as { status: string; error?: unknown };
        return j.status === 'failed' ? j : null;
      });
      expect(failed).toMatchObject({ status: 'failed', error: { message: 'recon failed' } });
    } finally { await s.close(); }
  });

  it('GET /record/:runId/video returns the file bytes after success', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}/record`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/', prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}/record/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'succeeded' ? j : null;
      });
      const videoRes = await fetch(`${s.baseUrl}/record/${runId}/video`);
      expect(videoRes.status).toBe(200);
      expect(videoRes.headers.get('content-type')).toBe('video/webm');
      expect(await videoRes.text()).toBe('FAKE_VIDEO');
    } finally { await s.close(); }
  });

  it('GET /record/:runId/video returns 409 while still running', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => { release = r; });
    const factory: JobFactory = async () => { await blocker; return fakeResult(tmp); };
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}/record`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.test/', prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      // Wait for `running` status (the queue picked it up).
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}/record/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'running' ? j : null;
      });
      const earlyVideo = await fetch(`${s.baseUrl}/record/${runId}/video`);
      expect(earlyVideo.status).toBe(409);
      release();
    } finally { await s.close(); }
  });
});
