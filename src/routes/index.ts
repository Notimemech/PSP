// Router /api/v1. Chỉ khai báo path + middleware; logic nằm ở controller.
// Bước sau thêm: /payments, /refunds, /providers (HMAC + idempotency + rate limit),
// /callbacks/:provider/return (chữ ký VNPay), /admin/* (X-Admin-Key).
import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';
import type { AppDeps } from '../app.js';

export function apiV1Router(deps: AppDeps): Router {
  const router = Router();
  router.get('/health', healthController(deps.prisma, deps.logger));
  return router;
}
