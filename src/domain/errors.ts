/**
 * Typed domain errors. Adapters translate library exceptions into one of these
 * at the boundary so that core/ never has to inspect vendor error shapes.
 *
 * Convention:
 * - `code` is a stable string identifier suitable for log filtering and
 *   programmatic handling. Never change a code; add a new one instead.
 * - `cause` preserves the original error for diagnostic logging.
 */

export class DomainError extends Error {
  public readonly code: string;
  public override readonly cause: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = cause;
  }
}

/** The page agent failed to find or interact with an element. */
export class ElementNotFoundError extends DomainError {
  constructor(instruction: string, cause?: unknown) {
    super(
      'ELEMENT_NOT_FOUND',
      `Could not resolve element for instruction: ${instruction}`,
      cause,
    );
  }
}

/** Browser/page launch failed. */
export class SessionStartError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('SESSION_START_FAILED', message, cause);
  }
}

/** Recording artifact missing or malformed at session close. */
export class RecordingError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super('RECORDING_FAILED', message, cause);
  }
}

/** Required configuration (e.g. an API key) is missing at runtime. */
export class ConfigError extends DomainError {
  constructor(field: string) {
    super('CONFIG_MISSING', `Required configuration missing: ${field}`);
  }
}
