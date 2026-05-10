import { describe, expect, it } from 'vitest';

import { track } from '../../../src/infra/pending.js';

describe('Pending<T> tracker', () => {
  it('starts as not resolved', () => {
    const p = track(new Promise(() => {})); // never resolves
    expect(p.isResolved).toBe(false);
    expect(p.value).toBeUndefined();
  });

  it('marks resolved after promise resolves', async () => {
    const p = track(Promise.resolve(42));
    // microtask flush
    await new Promise((r) => setImmediate(r));
    expect(p.isResolved).toBe(true);
    expect(p.value).toBe(42);
  });

  it('marks rejected after promise rejects', async () => {
    const p = track(Promise.reject(new Error('boom')));
    await new Promise((r) => setImmediate(r));
    expect(p.isResolved).toBe(true);
    expect(p.error).toBeInstanceOf(Error);
    expect((p.error as Error).message).toBe('boom');
  });

  it('await still works for resolved value', async () => {
    const p = track(Promise.resolve('hi'));
    const v = await p.promise;
    expect(v).toBe('hi');
  });

  it('await throws for rejected', async () => {
    const p = track(Promise.reject(new Error('nope')));
    await expect(p.promise).rejects.toThrow('nope');
  });
});
