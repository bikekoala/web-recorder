import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JobStore } from '../../../src/api/job-store.js';
import { createApiServer, type JobFactory } from '../../../src/api/server.js';
import type { RunResult } from '../../../src/core/record-job-runner.js';

const API = '/api/v1/recordings';

/** Build a fake RunResult whose paths point at a real temp file (so /video / /run.json can stream). */
function fakeResult(outputDir: string): RunResult {
  const videoPath = join(outputDir, 'recording.mp4');
  const runJsonPath = join(outputDir, 'run.json');
  writeFileSync(videoPath, 'FAKE_VIDEO');
  writeFileSync(runJsonPath, JSON.stringify({ ok: true }));
  return {
    videoPath,
    rawVideoPath: videoPath,
    actionLogPath: join(outputDir, 'action-log.json'),
    urlResolution: { url: 'https://x.test/', reasoning: 'inline URL' },
    performance: { prompt: 'p', durationMs: 1000, steps: [{ kind: 'done', reasoning: 'fin' }], totalEstimatedMs: 0, rationale: 'r' } as RunResult['performance'],
    metrics: {
      intentSatisfaction: { level: 'complete', note: 'all good', hintsResolvedPreRecording: 0, clicksExecuted: 0, scrollsExecuted: 0 },
      trimmedVideoMs: 1000,
    } as RunResult['metrics'],
    directorReport: {} as RunResult['directorReport'],
  };
}

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
  afterEach(() => { /* tmp dirs auto-clean */ });

  it('GET /health returns ok + counters', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; runningJobs: number; queueDepth: number };
      expect(body).toEqual({ ok: true, runningJobs: 0, queueDepth: 0 });
    } finally { await s.close(); }
  });

  it('POST /api/v1/recordings accepts a well-formed body and returns 202 with runId + URL pointers', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const res = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'browse https://x.test/', durationMs: 10000 }),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as { runId: string; status: string; statusUrl: string; videoUrl: string; runJsonUrl: string };
      expect(body.status).toBe('queued');
      expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.statusUrl).toBe(`${API}/${body.runId}`);
      expect(body.videoUrl).toBe(`${API}/${body.runId}/video`);
      expect(body.runJsonUrl).toBe(`${API}/${body.runId}/run.json`);
    } finally { await s.close(); }
  });

  it('POST rejects a malformed body (400 BAD_REQUEST) — empty prompt', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '', durationMs: 1000 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
    } finally { await s.close(); }
  });

  it('POST rejects malformed JSON (400 BAD_JSON)', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BAD_JSON');
    } finally { await s.close(); }
  });

  it('POST with device:"mobile" parses and forwards to the factory', async () => {
    let observed: { device?: string } | undefined;
    const factory: JobFactory = async (request) => { observed = request; return fakeResult(tmp); };
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 5000, device: 'mobile' }),
      });
      const { runId } = await post.json() as { runId: string };
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'succeeded' ? j : null;
      });
      expect(observed?.device).toBe('mobile');
    } finally { await s.close(); }
  });

  it('POST rejects an unknown device value (400)', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 5000, device: 'smart-tv' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
    } finally { await s.close(); }
  });

  it('POST with audio:true returns 501 AUDIO_NOT_IMPLEMENTED', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 5000, audio: true }),
      });
      expect(res.status).toBe(501);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('AUDIO_NOT_IMPLEMENTED');
      expect(body.error.message).toMatch(/ADR §0043|audio:false/i);
    } finally { await s.close(); }
  });

  it('GET /api/v1/recordings/:runId returns 404 for unknown ids', async () => {
    const noop: JobFactory = async () => { throw new Error('not reached'); };
    const s = await startServer(noop);
    try {
      const res = await fetch(`${s.baseUrl}${API}/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    } finally { await s.close(); }
  });

  it('POST → GET → succeeded with result paths + urlResolution', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      const final = await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string; result?: unknown };
        return j.status === 'succeeded' ? j : null;
      });
      expect(final).toMatchObject({
        status: 'succeeded',
        result: {
          videoPath: expect.stringContaining('recording.mp4'),
          videoUrl: `${API}/${runId}/video`,
          urlResolution: { url: 'https://x.test/', reasoning: 'inline URL' },
          // Caller-facing transparency channel (goals.md #3) — coarse signal only.
          meta: {
            intent: { level: 'complete', note: 'all good' },
            actualDurationMs: 1000,
          },
        },
      });
      // Defensive: confirm we are NOT exposing the full diagnostic surface here.
      // Power users go to runJsonUrl; this response stays small.
      const result = (final as { result: Record<string, unknown> }).result;
      expect(result).not.toHaveProperty('judge');
      expect(result).not.toHaveProperty('planDurationFit');
      expect(result).not.toHaveProperty('reconLlm');
    } finally { await s.close(); }
  });

  it('GET /api/v1/recordings lists jobs newest-first', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      for (let i = 0; i < 2; i++) {
        await fetch(`${s.baseUrl}${API}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: `p${i}`, durationMs: 10000 }),
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      const r = await fetch(`${s.baseUrl}${API}`);
      const body = await r.json() as { recordings: Array<{ runId: string; request?: { prompt: string } }> };
      expect(body.recordings.length).toBe(2);
      expect(body.recordings[0]!.request?.prompt).toBe('p1');
      expect(body.recordings[1]!.request?.prompt).toBe('p0');
    } finally { await s.close(); }
  });

  it('a factory error surfaces as failed with the DomainError code', async () => {
    const factory: JobFactory = async () => {
      const err = new Error('recon failed');
      Object.assign(err, { code: 'RECON_FAILED', name: 'ReconError' });
      throw err;
    };
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      const failed = await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string; error?: unknown };
        return j.status === 'failed' ? j : null;
      });
      expect(failed).toMatchObject({ status: 'failed', error: { message: 'recon failed' } });
    } finally { await s.close(); }
  });

  it('GET /api/v1/recordings/:runId/video returns the file bytes after success (Content-Type matches format)', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'succeeded' ? j : null;
      });
      const videoRes = await fetch(`${s.baseUrl}${API}/${runId}/video`);
      expect(videoRes.status).toBe(200);
      // Request defaulted to format=mp4 → Content-Type: video/mp4.
      expect(videoRes.headers.get('content-type')).toBe('video/mp4');
      expect(await videoRes.text()).toBe('FAKE_VIDEO');
    } finally { await s.close(); }
  });

  it('Content-Type follows the request format (webm)', async () => {
    const factory: JobFactory = async () => fakeResult(tmp);
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 10000, format: 'webm' }),
      });
      const { runId } = await post.json() as { runId: string };
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'succeeded' ? j : null;
      });
      const videoRes = await fetch(`${s.baseUrl}${API}/${runId}/video`);
      expect(videoRes.headers.get('content-type')).toBe('video/webm');
    } finally { await s.close(); }
  });

  it('GET /api/v1/recordings/:runId/video returns 409 while still running', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => { release = r; });
    const factory: JobFactory = async () => { await blocker; return fakeResult(tmp); };
    const s = await startServer(factory);
    try {
      const post = await fetch(`${s.baseUrl}${API}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', durationMs: 10000 }),
      });
      const { runId } = await post.json() as { runId: string };
      await waitFor(async () => {
        const r = await fetch(`${s.baseUrl}${API}/${runId}`);
        const j = await r.json() as { status: string };
        return j.status === 'running' ? j : null;
      });
      const earlyVideo = await fetch(`${s.baseUrl}${API}/${runId}/video`);
      expect(earlyVideo.status).toBe(409);
      release();
    } finally { await s.close(); }
  });

  it('concurrent jobs run in parallel (no JobQueue)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll: () => void = () => {};
    const allReleased = new Promise<void>((r) => { releaseAll = r; });
    const factory: JobFactory = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await allReleased;
      inFlight -= 1;
      return fakeResult(tmp);
    };
    const s = await startServer(factory);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${s.baseUrl}${API}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: `p${i}`, durationMs: 10000 }),
        });
        ids.push(((await r.json()) as { runId: string }).runId);
      }
      // Wait until all three are running concurrently.
      await waitFor(async () => (maxInFlight >= 3 ? true : null));
      expect(maxInFlight).toBe(3);
      releaseAll();
    } finally { await s.close(); }
  });
});
