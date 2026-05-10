import pino from 'pino';
import { config } from './config.js';

/**
 * Process-wide logger. All logging goes through here.
 *
 * Always create a child logger with structured context for a unit of work
 * (e.g. `logger.child({ traceId, jobId })`) instead of formatting context
 * into the message string.
 */
export const logger = pino({
  level: config.logLevel,
  // `exactOptionalPropertyTypes: true` forbids `transport: undefined` — only
  // include the property when we actually want pretty-printing.
  ...(config.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
