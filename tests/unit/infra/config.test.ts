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

describe('rehearsal config knobs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reconRehearse defaults to true', async () => {
    const config = await loadConfig({ RECON_REHEARSE: undefined });
    expect(config.reconRehearse).toBe(true);
  });

  it('RECON_REHEARSE=false disables it', async () => {
    const config = await loadConfig({ RECON_REHEARSE: 'false' });
    expect(config.reconRehearse).toBe(false);
  });

  it('reconRehearsalBudgetMs / reconReconvergeMax have sensible defaults', async () => {
    const config = await loadConfig({ RECON_REHEARSAL_BUDGET_MS: undefined, RECON_RECONVERGE_MAX: undefined });
    expect(config.reconRehearsalBudgetMs).toBe(45000);
    expect(config.reconReconvergeMax).toBe(1);
  });

  it('ariaSnapshotDepth defaults to 25 and honours ARIA_SNAPSHOT_DEPTH', async () => {
    expect((await loadConfig({ ARIA_SNAPSHOT_DEPTH: undefined })).ariaSnapshotDepth).toBe(25);
    expect((await loadConfig({ ARIA_SNAPSHOT_DEPTH: '12' })).ariaSnapshotDepth).toBe(12);
  });
});

describe('blocker-dismiss config knobs', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('blockerDismiss defaults to true', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS: undefined });
    expect(config.blockerDismiss).toBe(true);
  });
  it('BLOCKER_DISMISS=false disables it', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS: 'false' });
    expect(config.blockerDismiss).toBe(false);
  });
  it('blockerDismissMaxRounds / blockerDismissMaxMs have sensible defaults', async () => {
    const config = await loadConfig({ BLOCKER_DISMISS_MAX_ROUNDS: undefined, BLOCKER_DISMISS_MAX_MS: undefined });
    expect(config.blockerDismissMaxRounds).toBe(3);
    expect(config.blockerDismissMaxMs).toBe(10000);
  });
  it('llmBlockerModelResolved falls back to llmModel', async () => {
    const config = await loadConfig({ LLM_BLOCKER_MODEL: undefined, LLM_MODEL: 'test/mini' });
    expect(config.llmBlockerModelResolved).toBe('test/mini');
  });
  it('llmBlockerModelResolved honours LLM_BLOCKER_MODEL', async () => {
    const config = await loadConfig({ LLM_BLOCKER_MODEL: 'foo/vision' });
    expect(config.llmBlockerModelResolved).toBe('foo/vision');
  });
});
