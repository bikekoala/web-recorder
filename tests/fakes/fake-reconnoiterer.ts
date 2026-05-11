import type { Performance } from '../../src/domain/performance.js';
import type { IReconnoiterer, ReconInput } from '../../src/ports/reconnoiterer.js';
import type { IPageSession } from '../../src/ports/page-session.js';

/**
 * Programmable IReconnoiterer for unit tests. Construct with a queue of
 * Performances; each recon() call shifts one off. If the queue is empty it
 * throws (so a test that doesn't expect a re-plan fails loudly if one happens).
 */
export class FakeReconnoiterer implements IReconnoiterer {
  modelId = 'fake/recon';
  calls: ReconInput[] = [];
  private queue: Performance[];
  constructor(initial: Performance[] = []) { this.queue = [...initial]; }
  enqueue(...p: Performance[]) { this.queue.push(...p); }
  async recon(input: ReconInput, _session: IPageSession): Promise<Performance> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeReconnoiterer: no more queued Performances');
    return next;
  }
}
