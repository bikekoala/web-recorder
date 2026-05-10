import type { DirectorState } from '../../src/domain/director-state.js';
import type { DecisionResponse, IFastDecider } from '../../src/ports/fast-decider.js';

/**
 * Programmable IFastDecider for unit tests.
 *
 * Construct with a queue of pre-canned responses. Each `decide()` call
 * shifts one off the queue. Optional `delayMs` simulates LLM latency
 * so the test can verify streaming overlap.
 */
export interface FakeDeciderResponse {
  response: DecisionResponse;
  delayMs?: number;
}

export class FakeFastDecider implements IFastDecider {
  decisions: Array<{ state: DirectorState; t: number }> = [];
  startedAt = Date.now();
  queue: FakeDeciderResponse[] = [];
  defaultDelayMs = 50;
  /** Identifier surfaced via the IFastDecider port for log entries. */
  modelId = 'fake/decider';

  constructor(initial: FakeDeciderResponse[] = []) {
    this.queue = [...initial];
  }

  enqueue(...resp: FakeDeciderResponse[]) {
    this.queue.push(...resp);
  }

  async decide(state: DirectorState): Promise<DecisionResponse> {
    this.decisions.push({ state, t: Date.now() - this.startedAt });
    const next = this.queue.shift();
    if (!next) {
      // Default: emit `done` so the loop terminates safely in tests.
      return { actions: [{ kind: 'done', reasoning: 'fake decider exhausted' }] };
    }
    if (next.delayMs && next.delayMs > 0) {
      await new Promise((r) => setTimeout(r, next.delayMs));
    } else {
      await new Promise((r) => setTimeout(r, this.defaultDelayMs));
    }
    return next.response;
  }
}
