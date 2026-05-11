import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `config` is a singleton built from `process.env` at import time (and it
 * `process.exit(1)`s on invalid config), so each case stubs env + re-imports
 * the module fresh via `vi.resetModules()`.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  // OPENROUTER_API_KEY is required — every case must provide it.
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      vi.stubEnv(k, '');
      delete process.env[k];
    } else {
      vi.stubEnv(k, v);
    }
  }
  const mod = await import('../../../src/infra/config.js');
  return mod.config;
}

describe('config — BROWSER_WINDOW_POSITION', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('parses "1920,40" to { x: 1920, y: 40 }', async () => {
    const config = await loadConfig({ BROWSER_WINDOW_POSITION: '1920,40' });
    expect(config.browserWindowPosition).toEqual({ x: 1920, y: 40 });
  });

  it('accepts negative coords', async () => {
    const config = await loadConfig({ BROWSER_WINDOW_POSITION: '-1920,0' });
    expect(config.browserWindowPosition).toEqual({ x: -1920, y: 0 });
  });

  it('exits on a malformed value', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // After the (mocked, non-terminating) `process.exit(1)`, config.ts falls
    // through and dereferences the undefined parse result — so the import
    // rejects. We only care that exit(1) was reached.
    await expect(loadConfig({ BROWSER_WINDOW_POSITION: 'abc' })).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('is undefined when unset', async () => {
    const config = await loadConfig({ BROWSER_WINDOW_POSITION: undefined });
    expect(config.browserWindowPosition).toBeUndefined();
  });
});

describe('config — BROWSER_RETURN_FOCUS / BROWSER_RETURN_FOCUS_TO', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('browserReturnFocus defaults to true when unset', async () => {
    const config = await loadConfig({ BROWSER_RETURN_FOCUS: undefined });
    expect(config.browserReturnFocus).toBe(true);
  });

  it('browserReturnFocus is false when BROWSER_RETURN_FOCUS=false', async () => {
    const config = await loadConfig({ BROWSER_RETURN_FOCUS: 'false' });
    expect(config.browserReturnFocus).toBe(false);
  });

  it('browserReturnFocusToApp is undefined when unset', async () => {
    const config = await loadConfig({ BROWSER_RETURN_FOCUS_TO: undefined });
    expect(config.browserReturnFocusToApp).toBeUndefined();
  });

  it('browserReturnFocusToApp is the literal string when set', async () => {
    const config = await loadConfig({ BROWSER_RETURN_FOCUS_TO: 'iTerm2' });
    expect(config.browserReturnFocusToApp).toBe('iTerm2');
  });
});
