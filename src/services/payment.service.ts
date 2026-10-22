// Payment service: module sâu nhất của PGS (docs/codebase-design.md). Chứa nghiệp vụ tạo/truy vấn payment và
// xác nhận kết quả từ provider: state machine, lock theo payment, đối chiếu FR-CB-03 (needs_review),
// outbox webhook_events trong cùng transaction DB. Không biết req/res.
import type { Prisma, PrismaClient, StatusSource } from '@prisma/client';
import { AppError, ErrorCode } from '../lib/errors.js';
import { newId, ulid } from '../lib/id.js';
import type { Logger } from '../lib/logger.js';
import type { QueryResult } from '../providers/IPaymentProvider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { insertCallback, markCallbackProcessed } from '../repositories/callback.repository.js';
import { findClientStatus, findProviderAccess } from '../repositories/client.repository.js';
import { isUniqueViolation } from '../repositories/db.js';
import {
  createPaymentWithTransaction,
  findPaymentByProviderRef,
  findPaymentDetail,
  hasPaidPayment,
  insertStatusHistory,
  insertWebhookEvent,
  listPaymentsByOrder,
  lockPayment,
  setNeedsReview,
  updatePaymentStatus,
  updatePendingTransaction,
  type PaymentDetailRow,
  type PaymentRow,
} from '../repositories/payment.repository.js';

/** Kiểu kết quả service trả cho controller (controller không import từ repository). */
export type PaymentRecord = PaymentRow;
export type PaymentDetailRecord = PaymentDetailRow;

export interface CreatePaymentInput {
  orderId: string;
  amount: number;
  currency: string;
  provider: string;
  description: string;
  returnUrl: string;
  /** IP của payer gửi provider; mặc định 127.0.0.1 (Q20). */
  payerIp?: string;
  /** Giây; mặc định PAYMENT_TTL_SECONDS. */
  expiresIn?: number;
  metadata?: Record<string, unknown>;
}

export interface CreatedPayment {
  payment: PaymentRow;
  checkoutUrl: string;
}

export interface PaymentService {
  /** 401 client không hợp lệ · 403 provider không được phép · 409 order đã thanh toán. */
  create(clientId: string, input: CreatePaymentInput): Promise<CreatedPayment>;
  /** 404 nếu không có hoặc thuộc client khác. */
  get(clientId: string, paymentId: string): Promise<PaymentDetailRow>;
  /** Kèm transactions/refunds như `get` (Q19). */
  listByOrder(clientId: string, orderId: string): Promise<PaymentDetailRow[]>;
  /**
   * Xử lý lượt return của trình duyệt: verify chữ ký → queryDr → cập nhật (nếu có) → URL redirect về client.
   * 400 INVALID_SIGNATURE nếu chữ ký sai · 404 nếu không tìm thấy provider/payment.
   * Lỗi queryDr không làm hỏng redirect: payment giữ PENDING.
   */
  confirmFromReturn(providerCode: string, query: Record<string, unknown>): Promise<{ redirectUrl: string }>;
}

export interface PaymentServiceDeps {
  prisma: PrismaClient;
  providers: ProviderRegistry;
  clock: () => Date;
  logger: Logger;
  /** PAYMENT_TTL_SECONDS */
  defaultTtlSeconds: number;
}

type ConfirmedStatus = 'SUCCEEDED' | 'FAILED';
const EVENT_TYPE: Record<ConfirmedStatus, string> = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
};

/**
 * Kết luận của một lần xác nhận:
 * - TRANSITIONED: đã chuyển SUCCEEDED/FAILED. NEEDS_REVIEW: vừa đánh dấu xử lý tay.
 * - ALREADY_FINAL / SKIPPED_NEEDS_REVIEW: không làm gì vì payment đã có kết luận trước đó.
 * - STILL_PENDING: provider báo chưa xong. NO_RESULT: queryDr lỗi/timeout/chữ ký sai/bị từ chối.
 */
export type ConfirmOutcome =
  'TRANSITIONED' | 'NEEDS_REVIEW' | 'ALREADY_FINAL' | 'SKIPPED_NEEDS_REVIEW' | 'STILL_PENDING' | 'NO_RESULT';

const CONCLUSIVE = new Set<ConfirmOutcome>([
  'TRANSITIONED',
  'NEEDS_REVIEW',
  'ALREADY_FINAL',
  'SKIPPED_NEEDS_REVIEW',
]);

const DEFAULT_PAYER_IP = '127.0.0.1';

/**
 * Giới hạn số tiền đọc từ providers.capabilities (min_amount/max_amount, Q21). Thiếu key = không giới hạn.
 * Có key nhưng không phải số nguyên an toàn ≥ 0 = cấu hình hỏng: trả null (fail closed, caller báo 500).
 */
function amountLimits(capabilities: unknown): { min: number | null; max: number | null } | null {
  const c =
    typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)
      ? (capabilities as Record<string, unknown>)
      : {};
  // undefined = thiếu key (không giới hạn); NaN = có key nhưng hỏng.
  const read = (key: string): number | null => {
    const v = c[key];
    if (v === undefined) return null;
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : NaN;
  };
  const min = read('min_amount');
  const max = read('max_amount');
  if (Number.isNaN(min) || Number.isNaN(max)) return null;
  return { min, max };
}

const SIGNATURE_KEYS = new Set(['vnp_securehash', 'vnp_securehashtype']);
const CALLBACK_MAX_KEYS = 50;
const CALLBACK_MAX_VALUE = 255;

/**
 * Bản sao query để lưu provider_callbacks: chỉ key `vnp_*` (bỏ chữ ký), mỗi giá trị tối đa 255 ký tự,
 * tối đa 50 key — dữ liệu từ trình duyệt, không để phình DB.
 */
function callbackPayload(query: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue> = {};
  let count = 0;
  for (const [k, v] of Object.entries(query)) {
    if (count >= CALLBACK_MAX_KEYS) break;
    if (!k.startsWith('vnp_') || k.length > CALLBACK_MAX_VALUE || SIGNATURE_KEYS.has(k.toLowerCase()))
      continue;
    if (typeof v === 'string') out[k] = v.slice(0, CALLBACK_MAX_VALUE);
    else if (Array.isArray(v)) {
      out[k] = v
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 10)
        .map((x) => x.slice(0, CALLBACK_MAX_VALUE));
    } else continue;
    count++;
  }
  return out;
}

function redirectTo(returnUrl: string, paymentId: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('payment_id', paymentId);
  return url.toString();
}

function eventPayload(eventId: string, type: string, p: PaymentRow, createdAt: Date): Prisma.InputJsonObject {
  return {
    event_id: eventId,
    type,
    created_at: createdAt.toISOString(),
    payment: {
      payment_id: p.id,
      order_id: p.orderId,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      provider: p.providerCode,
      paid_at: p.paidAt?.toISOString() ?? null,
      metadata: (p.metadata ?? null) as Prisma.InputJsonValue,
    },
  };
}

export function createPaymentService(deps: PaymentServiceDeps): PaymentService {
  const { prisma, providers, clock, logger } = deps;

  async function requireActiveClient(clientId: string): Promise<void> {
    const status = await findClientStatus(prisma, clientId);
    // Không phân biệt "không tồn tại" và "bị khóa" (cùng mã middleware HMAC sẽ trả).
    if (status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Xác thực thất bại');
  }

  /** Chuyển PENDING → SUCCEEDED/FAILED + transaction + history + outbox, trong một transaction DB. */
  async function transition(
    payment: PaymentRow,
    to: ConfirmedStatus,
    source: StatusSource,
    result: Extract<QueryResult, { ok: true }>,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const locked = await lockPayment(tx, payment.clientId, payment.id);
      // Kiểm tra lại trong lock: lượt khác đã xử lý thì thôi (FR-CB-04).
      if (!locked || locked.status !== 'PENDING' || locked.paidAt !== null || locked.needsReview)
        return false;
      const now = clock();
      const updated = await updatePaymentStatus(tx, payment.clientId, payment.id, {
        status: to,
        ...(to === 'SUCCEEDED' ? { paidAt: now } : {}),
      });
      await updatePendingTransaction(tx, payment.id, {
        status: to,
        providerTxnId: result.providerTxnId,
        rawResponse: result.raw,
      });
      await insertStatusHistory(tx, {
        id: newId('statusHistory'),
        paymentId: payment.id,
        from: 'PENDING',
        to,
        source,
      });
      const eventId = newId('event');
      const type = EVENT_TYPE[to];
      await insertWebhookEvent(tx, {
        id: eventId,
        clientId: payment.clientId,
        paymentId: payment.id,
        type,
        payload: eventPayload(eventId, type, updated, now),
      });
      return true;
    });
  }

  /**
   * Lưu kết quả queryDr hợp lệ vào transaction PENDING (bằng chứng cho xử lý tay, Q6/FR-CB-03) mà không đổi
   * trạng thái; bật needs_review nếu cần. Làm trong lock để không đè lượt khác đã chuyển trạng thái.
   */
  async function recordWithoutTransition(
    payment: PaymentRow,
    result: Extract<QueryResult, { ok: true }>,
    opts: { needsReview: boolean; withProviderTxnId: boolean },
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const locked = await lockPayment(tx, payment.clientId, payment.id);
      if (!locked || locked.status !== 'PENDING' || locked.paidAt !== null) return false;
      await updatePendingTransaction(tx, payment.id, {
        rawResponse: result.raw,
        ...(opts.withProviderTxnId ? { providerTxnId: result.providerTxnId } : {}),
      });
      if (opts.needsReview) await setNeedsReview(tx, payment.clientId, payment.id);
      return true;
    });
  }

  /**
   * Hỏi provider rồi áp kết quả. Dùng chung cho return URL và (sau này) job queryDr/expire.
   * Trả kết luận để caller biết lượt này đã có kết quả hay cần thử lại sau.
   */
  async function confirm(payment: PaymentRow, source: StatusSource): Promise<ConfirmOutcome> {
    const log = logger.child({ payment_id: payment.id, provider: payment.providerCode });
    if (payment.status !== 'PENDING' || payment.paidAt !== null) return 'ALREADY_FINAL'; // FR-CB-04
    if (payment.needsReview) {
      log.info('payment cần xử lý tay, bỏ qua xác nhận tự động');
      return 'SKIPPED_NEEDS_REVIEW';
    }

    const result = await providers.get(payment.providerCode).queryDr({
      providerRef: payment.providerTxnRef,
      createdAt: payment.createdAt,
    });
    if (!result.ok) {
      log.warn('queryDr không có kết quả, giữ PENDING', { reason: result.reason });
      return 'NO_RESULT';
    }

    // FR-CB-03: đối chiếu số tiền, mã tham chiếu, merchant.
    const mismatch =
      result.amount !== payment.amount ||
      result.providerRef !== payment.providerTxnRef ||
      !result.merchantMatches;
    if (mismatch || result.status === 'UNKNOWN') {
      // Mã giao dịch từ response lệch không đáng tin: không ghi vào provider_txn_id (chỉ nằm trong raw_response).
      const applied = await recordWithoutTransition(payment, result, {
        needsReview: true,
        withProviderTxnId: false,
      });
      log.warn('kết quả provider lệch hoặc không xác định, đánh dấu needs_review', {
        mismatch,
        provider_status: result.providerStatusCode,
      });
      return applied ? 'NEEDS_REVIEW' : 'ALREADY_FINAL';
    }
    if (result.status === 'PENDING') {
      const applied = await recordWithoutTransition(payment, result, {
        needsReview: false,
        withProviderTxnId: true,
      });
      return applied ? 'STILL_PENDING' : 'ALREADY_FINAL';
    }

    try {
      const changed = await transition(payment, result.status, source, result);
      if (changed) log.info('payment đã xác nhận', { status: result.status });
      return changed ? 'TRANSITIONED' : 'ALREADY_FINAL';
    } catch (err) {
      // Vi phạm unique: order đã có payment khác được thanh toán (C5) hoặc trùng mã giao dịch provider.
      if (!isUniqueViolation(err)) throw err;
      const applied = await recordWithoutTransition(payment, result, {
        needsReview: true,
        withProviderTxnId: false,
      });
      log.warn('xung đột unique khi xác nhận, đánh dấu needs_review');
      return applied ? 'NEEDS_REVIEW' : 'ALREADY_FINAL';
    }
  }

  return {
    async create(clientId, input) {
      await requireActiveClient(clientId);

      const access = await findProviderAccess(prisma, clientId, input.provider);
      if (!providers.has(input.provider) || access.providerStatus !== 'ENABLED' || !access.enabledForClient) {
        throw new AppError(ErrorCode.PROVIDER_NOT_ALLOWED, 'Client không được dùng provider này');
      }
      const provider = providers.get(input.provider);
      if (!provider.capabilities.currencies.includes(input.currency)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Provider không hỗ trợ tiền tệ này', [
          { path: 'currency', message: 'Provider không hỗ trợ tiền tệ này' },
        ]);
      }
      const limits = amountLimits(access.capabilities);
      if (!limits) {
        // Không log giá trị capabilities: chỉ cần biết provider nào cấu hình hỏng.
        logger.error('providers.capabilities có min_amount/max_amount không hợp lệ', {
          provider: provider.code,
        });
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Lỗi hệ thống');
      }
      const { min, max } = limits;
      if ((min !== null && input.amount < min) || (max !== null && input.amount > max)) {
        // Cùng dạng details với lỗi zod ([{ path, message }]), thêm min/max để client tự sửa.
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Số tiền ngoài khoảng provider cho phép', [
          { path: 'amount', message: 'Số tiền ngoài khoảng provider cho phép', min, max },
        ]);
      }
      if (await hasPaidPayment(prisma, clientId, input.orderId)) {
        throw new AppError(ErrorCode.INVALID_STATE, 'Order đã có payment được thanh toán');
      }

      const now = clock();
      const expiresAt = new Date(now.getTime() + (input.expiresIn ?? deps.defaultTtlSeconds) * 1000);
      const paymentId = newId('payment');
      const providerRef = ulid(now.getTime());
      const checkout = provider.buildPaymentUrl({
        providerRef,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        payerIp: input.payerIp ?? DEFAULT_PAYER_IP,
        createdAt: now,
        expiresAt,
      });

      const payment = await createPaymentWithTransaction(prisma, {
        id: paymentId,
        clientId,
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        providerCode: provider.code,
        providerTxnRef: providerRef,
        description: input.description,
        returnUrl: input.returnUrl,
        metadata: input.metadata as Prisma.InputJsonObject | undefined,
        expiresAt,
        createdAt: now,
        transaction: { id: newId('transaction'), rawRequest: checkout.rawRequest },
      });
      logger.info('payment created', {
        payment_id: payment.id,
        client_id: clientId,
        provider: provider.code,
      });
      return { payment, checkoutUrl: checkout.checkoutUrl };
    },

    async get(clientId, paymentId) {
      await requireActiveClient(clientId);
      const payment = await findPaymentDetail(prisma, clientId, paymentId);
      if (!payment) throw new AppError(ErrorCode.NOT_FOUND, 'Không tìm thấy payment');
      return payment;
    },

    async listByOrder(clientId, orderId) {
      await requireActiveClient(clientId);
      return listPaymentsByOrder(prisma, clientId, orderId);
    },

    async confirmFromReturn(providerCode, query) {
      if (!providers.has(providerCode)) throw new AppError(ErrorCode.NOT_FOUND, 'Không tìm thấy tài nguyên');
      const provider = providers.get(providerCode);
      const receivedAt = clock();

      const verification = provider.verifyReturnUrl(query);
      if (!verification.valid) {
        await insertCallback(prisma, {
          id: newId('callback'),
          providerCode,
          paymentId: null,
          payload: callbackPayload(query),
          signatureValid: false,
          receivedAt,
        });
        logger.warn('return: chữ ký không hợp lệ', { provider: providerCode });
        // Q10: 400 (không phải 401): người gọi là trình duyệt payer, không phải client chưa xác thực.
        throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Chữ ký không hợp lệ', undefined, 400);
      }

      const payment = await findPaymentByProviderRef(prisma, providerCode, verification.providerRef);
      const callbackId = newId('callback');
      await insertCallback(prisma, {
        id: callbackId,
        providerCode,
        paymentId: payment?.id ?? null,
        payload: callbackPayload(verification.payload),
        signatureValid: true,
        receivedAt,
      });
      if (!payment) {
        logger.warn('return: không tìm thấy payment theo mã tham chiếu', { provider: providerCode });
        throw new AppError(ErrorCode.NOT_FOUND, 'Không tìm thấy payment');
      }

      try {
        const outcome = await confirm(payment, 'API');
        // processed = lượt return đã có kết luận; queryDr chưa cho kết quả xác định thì để false.
        if (CONCLUSIVE.has(outcome)) await markCallbackProcessed(prisma, callbackId);
      } catch (err) {
        // Transaction DB đã rollback nên trạng thái vẫn nhất quán; payer vẫn được đưa về client (Q10).
        logger.error('return: lỗi khi xác nhận payment', { payment_id: payment.id, err });
      }
      return { redirectUrl: redirectTo(payment.returnUrl, payment.id) };
    },
  };
}
