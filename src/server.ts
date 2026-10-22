// Composition root: nơi duy nhất đọc env, tạo kết nối thật và mở port.
import type { Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { buildProviderRegistry } from './providers/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    // Logger chưa có cấu hình; ConfigError chỉ chứa tên biến + lý do, không chứa giá trị.
    const message = err instanceof ConfigError ? err.message : String(err);
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'startup aborted', error: message }) + '\n');
    process.exit(1);
  }
}

function main(): void {
  const config = readConfigOrExit();
  const logger = createLogger({ level: config.logLevel, base: { service: 'pgs' } });
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });

  const clock = () => new Date();
  const providers = buildProviderRegistry(config, {
    transport: (input, init) => globalThis.fetch(input, init),
    clock,
  });

  const app = createApp({ config, logger, prisma, providers, clock });
  const server: Server = app.listen(config.port, () => {
    logger.info('server listening', { port: config.port, env: config.env });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(() => {
      void prisma.$disconnect().finally(() => {
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason });
  });
}

main();
