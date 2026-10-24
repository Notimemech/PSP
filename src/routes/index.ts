// Router /api/v1. Chỉ khai báo path + middleware; logic nằm ở controller.
// Chưa có middleware HMAC/idempotency/rate limit (user chốt 2026-10-22, Q2/Q3): client_id tạm lấy từ
// X-Client-Id chưa xác thực (controllers/client-context.ts).
import { Router, type RequestHandler } from 'express';
import { callbackController } from '../controllers/callback.controller.js';
import { healthController } from '../controllers/health.controller.js';
import { paymentController } from '../controllers/payment.controller.js';
import type { AppDeps } from '../app.js';
import type { PaymentService } from '../services/payment.service.js';

export function apiV1Router(deps: AppDeps, services: { payments: PaymentService }, auth: RequestHandler): Router {
  const router = Router();
  router.get('/health', healthController(deps.prisma, deps.logger));

  const payments = paymentController(services.payments);
  router.post('/payments',auth, payments.create);
  router.get('/payments',auth, payments.list);
  router.get('/payments/:payment_id',auth, payments.get);

  const callbacks = callbackController(services.payments);
  router.get('/callbacks/:provider/return', callbacks.providerReturn);
  return router;
}
