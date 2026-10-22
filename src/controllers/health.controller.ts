// GET /api/v1/health: không xác thực; chỉ báo trạng thái, không lộ chi tiết lỗi DB ra ngoài.
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';
import { pingDatabase } from '../repositories/health.repository.js';

const DB_PING_TIMEOUT_MS = 2000;

export function healthController(prisma: PrismaClient, logger: Logger): RequestHandler {
  return async (_req, res) => {
    try {
      await pingDatabase(prisma, DB_PING_TIMEOUT_MS);
      res.status(200).json({ status: 'ok', checks: { database: 'up' } });
    } catch (err) {
      logger.warn('health check: database down', { err });
      res.status(503).json({ status: 'degraded', checks: { database: 'down' } });
    }
  };
}
