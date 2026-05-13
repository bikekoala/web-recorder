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

  it('ariaSnapshotMaxChars defaults to 100000 and honours ARIA_SNAPSHOT_MAX_CHARS', async () => {
    expect((await loadConfig({ ARIA_SNAPSHOT_MAX_CHARS: undefined })).ariaSnapshotMaxChars).toBe(100000);
    expect((await loadConfig({ ARIA_SNAPSHOT_MAX_CHARS: '20000' })).ariaSnapshotMaxChars).toBe(20000);
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

describe('pacing config knobs', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('pacingSettleEstMs defaults to 1500 and honours PACING_SETTLE_EST_MS', async () => {
    expect((await loadConfig({ PACING_SETTLE_EST_MS: undefined })).pacingSettleEstMs).toBe(1500);
    expect((await loadConfig({ PACING_SETTLE_EST_MS: '2200' })).pacingSettleEstMs).toBe(2200);
  });

  it('pacingStepOverheadMs defaults to 280 and honours PACING_STEP_OVERHEAD_MS', async () => {
    expect((await loadConfig({ PACING_STEP_OVERHEAD_MS: undefined })).pacingStepOverheadMs).toBe(280);
    expect((await loadConfig({ PACING_STEP_OVERHEAD_MS: '90' })).pacingStepOverheadMs).toBe(90);
  });

  it('directorDwellMinMs / directorDwellStretchMaxMs default to 100 / 2000 and honour their env vars', async () => {
    const def = await loadConfig({ DIRECTOR_DWELL_MIN_MS: undefined, DIRECTOR_DWELL_STRETCH_MAX_MS: undefined });
    expect(def.directorDwellMinMs).toBe(100);
    expect(def.directorDwellStretchMaxMs).toBe(2000);
    const overridden = await loadConfig({ DIRECTOR_DWELL_MIN_MS: '0', DIRECTOR_DWELL_STRETCH_MAX_MS: '3500' });
    expect(overridden.directorDwellMinMs).toBe(0);
    expect(overridden.directorDwellStretchMaxMs).toBe(3500);
  });

  it('planDurationFitToleranceRatio defaults to 0.20 and honours PLAN_DURATION_FIT_TOLERANCE_RATIO', async () => {
    expect((await loadConfig({ PLAN_DURATION_FIT_TOLERANCE_RATIO: undefined })).planDurationFitToleranceRatio).toBeCloseTo(0.20);
    expect((await loadConfig({ PLAN_DURATION_FIT_TOLERANCE_RATIO: '0.10' })).planDurationFitToleranceRatio).toBeCloseTo(0.10);
  });
});
