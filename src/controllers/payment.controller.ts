// /api/v1/payments: parse bằng zod, gọi PaymentService, map sang JSON snake_case (không trả raw payload).
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { PaymentDetailRecord, PaymentRecord, PaymentService } from '../services/payment.service.js';
import { getClientId } from './client-context.js';

const MAX_INT32 = 2_147_483_647;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

// C10 (user chốt 2026-10-22): chỉ https; http chỉ cho localhost/127.0.0.1. Không cho user:pass trong URL.
// Không dùng z.url() + new URL: z.url() không dừng chuỗi kiểm tra nên new URL ném TypeError (→ 500).
const returnUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    if (!URL.canParse(s)) return false;
    const u = new URL(s);
    if (u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname));
  }, 'return_url phải là https (http chỉ cho localhost)');

const orderId = z.string().min(1).max(64);

// Q22: metadata lưu nguyên văn nhưng giới hạn 8 KB (JSON đã serialize).
const METADATA_MAX_BYTES = 8192;
const metadata = z
  .record(z.string(), z.unknown())
  .refine((m) => Buffer.byteLength(JSON.stringify(m), 'utf8') <= METADATA_MAX_BYTES, {
    message: `metadata tối đa ${METADATA_MAX_BYTES} byte khi serialize JSON`,
  });

const createSchema = z.object({
  order_id: orderId,
  amount: z.number().int().positive().max(MAX_INT32),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Mã tiền tệ ISO 4217 viết hoa'),
  provider: z.string().min(1).max(32),
  description: z.string().trim().min(1).max(255),
  return_url: returnUrl,
  expires_in: z.number().int().min(300).max(3600).optional(),
  metadata: metadata.optional(),
  // Q20: IP payer gửi VNPay (vnp_IpAddr); mặc định 127.0.0.1 ở service.
  payer_ip: z.union([z.ipv4(), z.ipv6()]).optional(),
});

const listSchema = z.object({ order_id: orderId });

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function paymentJson(p: PaymentRecord) {
  return {
    payment_id: p.id,
    order_id: p.orderId,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    provider: p.providerCode,
    description: p.description,
    return_url: p.returnUrl,
    metadata: p.metadata ?? null,
    // Q17: client thấy cờ xử lý tay (payment giữ PENDING, không tự xác nhận lại).
    needs_review: p.needsReview,
    expires_at: iso(p.expiresAt),
    paid_at: iso(p.paidAt),
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
  };
}

function paymentDetailJson(p: PaymentDetailRecord) {
  return {
    ...paymentJson(p),
    transactions: p.transactions.map((t) => ({
      transaction_id: t.id,
      provider: t.providerCode,
      provider_txn_id: t.providerTxnId,
      amount: t.amount,
      status: t.status,
      created_at: iso(t.createdAt),
      updated_at: iso(t.updatedAt),
    })),
    refunds: p.refunds.map((r) => ({
      refund_id: r.id,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      created_at: iso(r.createdAt),
      updated_at: iso(r.updatedAt),
    })),
  };
}

export function paymentController(service: PaymentService) {
  const create: RequestHandler = async (req, res) => {
    const clientId = getClientId(req);
    const body = createSchema.parse(req.body);
    const { payment, checkoutUrl } = await service.create(clientId, {
      orderId: body.order_id,
      amount: body.amount,
      currency: body.currency,
      provider: body.provider,
      description: body.description,
      returnUrl: body.return_url,
      payerIp: body.payer_ip,
      expiresIn: body.expires_in,
      metadata: body.metadata,
    });
    res.status(201).json({
      payment_id: payment.id,
      status: payment.status,
      checkout_url: checkoutUrl,
      expires_at: iso(payment.expiresAt),
    });
  };

  const get: RequestHandler<{ payment_id: string }> = async (req, res) => {
    const clientId = getClientId(req);
    const payment = await service.get(clientId, req.params.payment_id);
    res.json(paymentDetailJson(payment));
  };

  const list: RequestHandler = async (req, res) => {
    const clientId = getClientId(req);
    const query = listSchema.parse(req.query);
    const payments = await service.listByOrder(clientId, query.order_id);
    res.json({ data: payments.map(paymentDetailJson) });
  };

  return { create, get, list };
}
