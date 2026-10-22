// Dựng app cho test qua createApp(deps) với Postgres test thật; không mở port.
// Provider là VnpayAdapter thật; chỉ HTTP transport được thay bằng stub (mặc định: stub trả 500).
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import type { HttpTransport } from '../../src/providers/IPaymentProvider.js';
import { buildProviderRegistry } from '../../src/providers/index.js';
import { TEST_ENV } from './test-env.js';
import { createVnpayStub } from './vnpay.js';

export interface TestAppOptions {
  prisma?: PrismaClient;
  logger?: Logger;
  transport?: HttpTransport;
  clock?: () => Date;
  providerTimeoutMs?: number;
}

export function createTestApp(overrides: TestAppOptions = {}) {
  const config = loadConfig(TEST_ENV);
  const prisma = overrides.prisma ?? new PrismaClient({ datasourceUrl: config.databaseUrl });
  const logger = overrides.logger ?? createLogger({ level: 'error', write: () => undefined });
  const clock = overrides.clock ?? (() => new Date());
  const providers = buildProviderRegistry(config, {
    transport: overrides.transport ?? createVnpayStub().transport,
    clock,
    timeoutMs: overrides.providerTimeoutMs ?? 1000,
  });
  return { app: createApp({ config, logger, prisma, providers, clock }), prisma, config };
}
