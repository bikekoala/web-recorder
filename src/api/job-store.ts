/**
 * In-memory job state store for the HTTP API. One process; jobs are lost on
 * restart. Acceptable for v1 self-hosted single-instance deployments — the
 * authoritative record of every completed run is the run.json on disk under
 * `output/<date>/<HH-MM-SS>-<runId>/`. The store is just a "what's running
 * right now" view that survives until the next process boot.
 *
 * Concurrency: a JobStore does NOT enforce one-job-at-a-time — that's the
 * server's job (see {@link JobQueue} below).
 */

import { randomUUID } from 'node:crypto';

import type { JobState, JobStatus, RecordRequest } from './request.js';

export class JobStore {
  private readonly jobs = new Map<string, JobState>();

  /** Insert a new job in `queued` state. Returns the assigned runId. */
  enqueue(request: RecordRequest): JobState {
    const runId = randomUUID();
    const state: JobState = {
      runId,
      status: 'queued',
      request,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(runId, state);
    return state;
  }

  /** Look up a job by id, or undefined if it never existed (or was evicted). */
  get(runId: string): JobState | undefined {
    return this.jobs.get(runId);
  }

  /**
   * Update a job's state. The caller passes the next `status` plus optional
   * payload fields. Throws if the runId is unknown — every transition starts
   * from a job that {@link enqueue} created, so a miss is a programmer error,
   * not a normal runtime case.
   */
  update(runId: string, patch: { status: JobStatus } & Partial<Omit<JobState, 'runId' | 'createdAt' | 'request'>>): JobState {
    const prev = this.jobs.get(runId);
    if (!prev) throw new Error(`JobStore.update: unknown runId ${runId}`);
    const next: JobState = { ...prev, ...patch };
    if (patch.status === 'running' && !prev.startedAt) next.startedAt = new Date().toISOString();
    if ((patch.status === 'succeeded' || patch.status === 'failed') && !prev.completedAt) {
      next.completedAt = new Date().toISOString();
    }
    this.jobs.set(runId, next);
    return next;
  }

  /** Snapshot of all current jobs — diagnostic only; not part of the API. */
  all(): JobState[] {
    return [...this.jobs.values()];
  }
}

/**
 * Serializes job execution to one at a time. A new request `enqueue`s and then
 * `process` runs in the background; subsequent requests wait their turn. This
 * matches the single-Browser-instance reality of the recording stack — running
 * two recordings in parallel would multiply memory + LLM concurrency without
 * any clean benefit at v1 scale.
 */
export class JobQueue {
  private running = false;
  private readonly pending: Array<() => Promise<void>> = [];

  /** Schedule a job. Returns when this specific job has finished (succeeded or failed). */
  async run(work: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          await work();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  /** Number of jobs waiting (does not include the currently-running one). */
  pendingCount(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        await next();
      }
    } finally {
      this.running = false;
    }
  }
}
