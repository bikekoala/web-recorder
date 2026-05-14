/**
 * In-memory job state store for the HTTP API. One process; jobs are lost on
 * restart. Acceptable for v1 self-hosted single-instance deployments — the
 * authoritative record of every completed run is the run.json on disk under
 * `output/<date>/<HH-MM-SS>-<runId>/`. The store is just a "what's running
 * right now" view that survives until the next process boot.
 *
 * Concurrency: jobs run concurrently (no JobQueue) — the v1 API spec allows
 * parallel recordings (multiple browsers). This store is concurrency-safe in
 * the single-threaded Node sense (no async between Map reads/writes).
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
      statusUrl: `/api/v1/recordings/${runId}`,
      videoUrl: `/api/v1/recordings/${runId}/video`,
      runJsonUrl: `/api/v1/recordings/${runId}/run.json`,
    };
    this.jobs.set(runId, state);
    return state;
  }

  /** Look up a job by id. */
  get(runId: string): JobState | undefined {
    return this.jobs.get(runId);
  }

  /**
   * Update a job's state. Throws if the runId is unknown — every transition
   * starts from a job that {@link enqueue} created, so a miss is a bug.
   */
  update(runId: string, patch: { status: JobStatus } & Partial<Omit<JobState, 'runId' | 'createdAt' | 'request' | 'statusUrl'>>): JobState {
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

  /** Snapshot of all current jobs (newest-first by createdAt). */
  all(): JobState[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Count jobs currently in a given status — used by /health. */
  countByStatus(status: JobStatus): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === status) n += 1;
    return n;
  }
}
