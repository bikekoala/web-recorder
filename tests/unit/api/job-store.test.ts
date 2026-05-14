import { describe, expect, it } from 'vitest';

import { JobQueue, JobStore } from '../../../src/api/job-store.js';
import type { RecordRequest } from '../../../src/api/request.js';

const req: RecordRequest = { url: 'https://example.com', prompt: 'browse', durationMs: 10000, headless: true };

describe('JobStore', () => {
  it('enqueues a job in `queued` state with a stable runId', () => {
    const s = new JobStore();
    const a = s.enqueue(req);
    const b = s.enqueue(req);
    expect(a.runId).not.toBe(b.runId);
    expect(a.status).toBe('queued');
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
      result: { runDir: '/o', runJsonPath: '/o/run.json', videoPath: '/o/recording.webm' },
    });
    expect(done.completedAt).toBeDefined();
    expect(done.startedAt).toBe(running.startedAt); // preserved
    expect(done.result?.videoPath).toBe('/o/recording.webm');
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
});

describe('JobQueue', () => {
  it('runs jobs sequentially (never two at the same time)', async () => {
    const q = new JobQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const make = (delay: number) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delay));
      inFlight -= 1;
    };
    await Promise.all([q.run(make(20)), q.run(make(20)), q.run(make(20))]);
    expect(maxInFlight).toBe(1);
  });

  it('propagates a job error to the caller without freezing the queue', async () => {
    const q = new JobQueue();
    await expect(q.run(async () => { throw new Error('first job died'); })).rejects.toThrow(/first job died/);
    // The next job still runs cleanly.
    let ran = false;
    await q.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('reports pendingCount accurately while jobs are queued', async () => {
    const q = new JobQueue();
    let release: () => void = () => {};
    const blocker = new Promise<void>((res) => { release = res; });
    const first = q.run(async () => { await blocker; });
    // Microtask: the first job is now `running`; not in `pending`.
    await Promise.resolve();
    expect(q.pendingCount()).toBe(0);
    const second = q.run(async () => {});
    const third = q.run(async () => {});
    expect(q.pendingCount()).toBe(2);
    release();
    await Promise.all([first, second, third]);
    expect(q.pendingCount()).toBe(0);
  });
});
