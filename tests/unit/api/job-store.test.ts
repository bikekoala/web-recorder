import { describe, expect, it } from 'vitest';

import { JobStore } from '../../../src/api/job-store.js';
import type { RecordRequest } from '../../../src/api/request.js';

const req: RecordRequest = {
  prompt: 'browse',
  durationMs: 10000,
  width: 1280,
  height: 720,
  format: 'mp4',
  crf: 18,
  audio: false,
  device: 'desktop',
};

describe('JobStore', () => {
  it('enqueues a job in `queued` state with a stable runId and pre-built URL pointers', () => {
    const s = new JobStore();
    const a = s.enqueue(req);
    const b = s.enqueue(req);
    expect(a.runId).not.toBe(b.runId);
    expect(a.status).toBe('queued');
    expect(a.statusUrl).toBe(`/api/v1/recordings/${a.runId}`);
    expect(a.videoUrl).toBe(`/api/v1/recordings/${a.runId}/video`);
    expect(a.runJsonUrl).toBe(`/api/v1/recordings/${a.runId}/run.json`);
    expect(s.get(a.runId)).toEqual(a);
  });

  it('updates status and timestamps the right transitions', () => {
    const s = new JobStore();
    const job = s.enqueue(req);
    const running = s.update(job.runId, { status: 'running' });
    expect(running.startedAt).toBeDefined();
    expect(running.completedAt).toBeUndefined();
    const done = s.update(job.runId, {
      status: 'succeeded',
      result: {
        runDir: '/o',
        runJsonPath: '/o/run.json',
        videoPath: '/o/recording.mp4',
        videoUrl: `/api/v1/recordings/${job.runId}/video`,
        runJsonUrl: `/api/v1/recordings/${job.runId}/run.json`,
        urlResolution: { url: 'https://example.com/', reasoning: 'inline URL' },
      },
    });
    expect(done.completedAt).toBeDefined();
    expect(done.startedAt).toBe(running.startedAt);
    expect(done.result?.videoPath).toBe('/o/recording.mp4');
  });

  it('records error on `failed`', () => {
    const s = new JobStore();
    const job = s.enqueue(req);
    s.update(job.runId, { status: 'running' });
    const failed = s.update(job.runId, { status: 'failed', error: { code: 'BOOM', message: 'kaboom' } });
    expect(failed.error).toEqual({ code: 'BOOM', message: 'kaboom' });
  });

  it('throws when updating an unknown runId', () => {
    const s = new JobStore();
    expect(() => s.update('does-not-exist', { status: 'running' })).toThrow(/unknown runId/);
  });

  it('counts jobs by status', () => {
    const s = new JobStore();
    const a = s.enqueue(req);
    const b = s.enqueue(req);
    s.enqueue(req);
    expect(s.countByStatus('queued')).toBe(3);
    s.update(a.runId, { status: 'running' });
    s.update(b.runId, { status: 'succeeded' });
    expect(s.countByStatus('queued')).toBe(1);
    expect(s.countByStatus('running')).toBe(1);
    expect(s.countByStatus('succeeded')).toBe(1);
  });

  it('all() returns jobs newest-first', () => {
    const s = new JobStore();
    const a = s.enqueue(req);
    // Ensure different createdAt values (ISO strings tick at ms resolution).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return sleep(5).then(() => {
      const b = s.enqueue(req);
      const list = s.all();
      expect(list[0]!.runId).toBe(b.runId);
      expect(list[1]!.runId).toBe(a.runId);
    });
  });
});
