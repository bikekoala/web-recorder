/**
 * Wrap a Promise to expose its resolution state synchronously.
 *
 * The streaming Director needs to peek at "did the LLM call return yet?"
 * without awaiting, so it can decide between draining the queue and
 * inserting an implicit dwell. Native promises don't expose this; this
 * utility tracks resolution via a side-effect on the original promise.
 *
 * The original promise is preserved on `.promise` for normal awaiting.
 */
export interface Pending<T> {
  readonly promise: Promise<T>;
  readonly isResolved: boolean;
  readonly value: T | undefined;
  readonly error: unknown;
}

export function track<T>(promise: Promise<T>): Pending<T> {
  const state: { isResolved: boolean; value: T | undefined; error: unknown } = {
    isResolved: false,
    value: undefined,
    error: undefined,
  };
  // Attach state-tracking handlers on the original promise. The rejection arm
  // re-throws so consumers awaiting `.promise` see the error normally.
  // Two no-op `.catch(() => {})` calls are needed to prevent unhandled-rejection
  // warnings:
  //   1. On `promise` itself — Node sees it as handled synchronously.
  //   2. On `tracked` — the re-throw in the rejection arm creates a new rejected
  //      promise; without a sibling catch on it, Node still fires the warning
  //      for callers who never await `.promise`.
  // Attaching a sibling `.catch()` does NOT swallow errors for awaiters of
  // `.promise` because each `.then`/`.catch` call creates an independent chain.
  promise.catch(() => {});
  const tracked = promise.then(
    (v) => {
      state.isResolved = true;
      state.value = v;
      return v;
    },
    (e) => {
      state.isResolved = true;
      state.error = e;
      throw e;
    },
  );
  tracked.catch(() => {});
  return {
    promise: tracked,
    get isResolved() { return state.isResolved; },
    get value() { return state.value; },
    get error() { return state.error; },
  };
}
