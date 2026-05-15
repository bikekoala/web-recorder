/**
 * Smoke test: validate the Playwright + recordVideo + remote-debugging-port
 * pipeline with NO Stagehand involvement and NO LLM API key required.
 *
 * Goals:
 *   1. `chromium.launchPersistentContext` with `--remote-debugging-port=0`
 *      starts up cleanly.
 *   2. `DevToolsActivePort` appears and we can read a valid CDP URL from it.
 *   3. recordVideo produces a .webm file when the context closes.
 *
 * If this smoke test passes, the only remaining unknown for the full
 * `npm run prototype:stagehand` run is the Stagehand wiring itself.
 *
 * Run:
 *   npm run smoke:recording
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';

import { config } from '../src/infra/config.js';
import { logger } from '../src/infra/logger.js';
import { buildRunDir } from '../src/infra/run-dir.js';

async function readDevToolsPort(userDataDir: string, timeoutMs = 5000): Promise<number> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(portFile, 'utf8');
      if (content.includes('\n')) {
        const firstLine = content.split('\n')[0];
        if (firstLine) return Number.parseInt(firstLine, 10);
      }
    } catch {
      /* not yet written */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`DevToolsActivePort not appearing in ${userDataDir}`);
}

async function main(): Promise<void> {
  const log = logger.child({ script: 'smoke-recording' });

  const outputDir = buildRunDir({ outputRoot: config.outputDir, kind: 'smoke' });
  await mkdir(outputDir, { recursive: true });

  const userDataDir = await mkdtemp(join(tmpdir(), 'web-recorder-smoke-'));
  log.info({ outputDir, userDataDir }, 'launching Chromium');

  // Headed on macOS so you can watch the smoke test; headless on Linux where
  // there's no display server. Override via SMOKE_HEADLESS=true/false.
  const headless = process.env.SMOKE_HEADLESS !== undefined
    ? process.env.SMOKE_HEADLESS !== 'false'
    : process.platform !== 'darwin';
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: config.viewport,
    args: ['--remote-debugging-port=0'],
    recordVideo: { dir: outputDir, size: config.viewport },
  });

  try {
    const port = await readDevToolsPort(userDataDir);
    const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
    const versionJson = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
    log.info(
      { port, cdpUrl: versionJson.webSocketDebuggerUrl, browser: versionRes.headers.get('content-type') },
      'CDP endpoint reachable',
    );

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollBy({ top: 200, behavior: 'smooth' }));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(1000);

    const videoHandle = page.video();
    if (!videoHandle) {
      throw new Error('page.video() returned null — recordVideo not wired');
    }

    // Must close the context BEFORE asking for the path; the file is written
    // out during context.close().
    await ctx.close();
    const videoPath = await videoHandle.path();
    log.info({ videoPath }, '✅ smoke test complete — video produced');
    log.info(`\n  Open:  open "${resolve(videoPath)}"\n`);
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  logger.error({ err }, '❌ smoke test failed');
  process.exit(1);
});
