/**
 * HTTP server entry point.
 *
 * Boots the API on PORT (default 8787), wires a per-job factory that
 * instantiates Stagehand + LlmReconnoiterer + PerformanceDirector +
 * RecordJobRunner for each accepted request. See `src/api/server.ts` for the
 * routes.
 *
 * Run:
 *   npm run serve
 *
 * Smoke test:
 *   curl -s http://localhost:8787/health
 *   curl -s -X POST http://localhost:8787/record \\
 *     -H 'Content-Type: application/json' \\
 *     -d '{"url":"https://react.dev","prompt":"看看 React 主页","durationMs":10000}'
 *   curl -s http://localhost:8787/record/<runId>
 */

import { StagehandPageSession } from '../src/adapters/agent/stagehand-session.js';
import { LlmBlockerDismisser } from '../src/adapters/blocker/llm-blocker-dismisser.js';
import { PerformanceDirector } from '../src/adapters/director/performance-director.js';
import { LlmReconnoiterer } from '../src/adapters/recon/llm-reconnoiterer.js';
import { RecordJobRunner } from '../src/core/record-job-runner.js';
import { createApiServer, type JobFactory } from '../src/api/server.js';
import { config } from '../src/infra/config.js';
import { logger as rootLogger } from '../src/infra/logger.js';

const log = rootLogger.child({ component: 'serve' });
const PORT = Number(process.env.PORT ?? 8787);

const jobFactory: JobFactory = async (request, { outputDir }) => {
  const session = new StagehandPageSession({
    outputDir,
    headless: request.headless,
    viewport: config.viewport,
    verbose: 1,
  });
  const reconnoiterer = new LlmReconnoiterer(
    config.blockerDismiss ? { blockerDismisser: new LlmBlockerDismisser() } : {},
  );
  const director = new PerformanceDirector({ replanner: reconnoiterer });
  const runner = new RecordJobRunner(session, reconnoiterer, director);
  return runner.run({
    url: request.url,
    prompt: request.prompt,
    durationMs: request.durationMs,
    outputDir,
    headless: request.headless,
  });
};

const { server } = createApiServer({ port: PORT, jobFactory });

server.listen(PORT, () => {
  log.info(
    {
      port: PORT,
      reconModel: config.llmReconModelResolved,
      judgeModel: config.llmJudgeModel,
      outputDir: config.outputDir,
    },
    `web-recorder API listening on http://localhost:${PORT}`,
  );
});

// Graceful shutdown — let an in-flight recording finish (or abort if killed
// twice). The Browser instance is owned by RecordJobRunner; closing the server
// stops accepting new requests, but the current job runs to completion.
function shutdown(signal: string): void {
  log.info({ signal }, 'shutting down — stopping accept; in-flight job (if any) will run to completion');
  server.close((err) => {
    if (err) {
      log.warn({ err }, 'server.close errored');
      process.exit(1);
    }
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
