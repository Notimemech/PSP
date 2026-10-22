// Dựng app cho test qua createApp(deps) với Postgres test thật; không mở port.
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { TEST_ENV } from './test-env.js';

export function createTestApp(overrides: { prisma?: PrismaClient; logger?: Logger } = {}) {
  const config = loadConfig(TEST_ENV);
  const prisma = overrides.prisma ?? new PrismaClient({ datasourceUrl: config.databaseUrl });
  const logger = overrides.logger ?? createLogger({ level: 'error', write: () => undefined });
  return { app: createApp({ config, logger, prisma }), prisma, config };
}
