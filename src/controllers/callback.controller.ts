// GET /api/v1/callbacks/:provider/return: trình duyệt payer gọi, mọi tham số là dữ liệu không tin cậy.
// Không có HMAC client; xác thực bằng chữ ký provider bên trong PaymentService.
import type { RequestHandler } from 'express';
import type { PaymentService } from '../services/payment.service.js';

export function callbackController(service: PaymentService) {
  const providerReturn: RequestHandler<{ provider: string }> = async (req, res) => {
    const { redirectUrl } = await service.confirmFromReturn(req.params.provider, req.query);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, redirectUrl);
  };
  return { providerReturn };
}
