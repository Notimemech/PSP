// Dựng Express app từ dependency được truyền vào; không đọc env, không mở port, không tự tạo kết nối.
// server.ts (production) và test (Supertest) đều đi qua hàm này.
import express, { type Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { correlationId } from './middlewares/correlation-id.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import type { ProviderRegistry } from './providers/registry.js';
import { apiV1Router } from './routes/index.js';
import { createPaymentService } from './services/payment.service.js';
import { hmacAuth } from './middlewares/hmac-auth.js';
import { createSecretBox } from './lib/crypto.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  /** Adapter provider (đã nhận HTTP transport từ composition root). */
  providers: ProviderRegistry;
  /** Đồng hồ; test truyền đồng hồ cố định. */
  clock: () => Date;
}

const JSON_BODY_LIMIT = '100kb';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(correlationId());
  app.use(
    express.json({
      limit: JSON_BODY_LIMIT,
      verify: (req, _res, buf) => {
        // Giữ raw body cho middleware HMAC (ký trên byte gốc, không ký JSON đã parse lại).
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  const auth = hmacAuth({
    prisma: deps.prisma,
    secretBox: createSecretBox(deps.config.security.encryptionKey),
    clock: deps.clock,
    maxSkewSeconds: deps.config.security.hmacMaxSkewSeconds
  })

  const payments = createPaymentService({
    prisma: deps.prisma,
    providers: deps.providers,
    clock: deps.clock,
    logger: deps.logger,
    defaultTtlSeconds: deps.config.payment.ttlSeconds,
  });
  app.use('/api/v1', apiV1Router(deps, { payments }, auth));

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
