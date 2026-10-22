// Truy cập payments, transactions, payment_status_history, webhook_events.
// Hàm đọc/ghi bảng payments nhận clientId và lọc theo nó (FR-MT-01). Ngoại lệ (không nhận clientId):
// - findPaymentByProviderRef: dùng cho return URL (chưa biết client; mã tham chiếu unique toàn hệ thống).
// - Bảng con theo paymentId (transactions, payment_status_history, webhook_events): chỉ gọi sau khi service đã
//   lock/đọc payment theo clientId trong cùng transaction DB.
import { Prisma, type PaymentStatus, type StatusSource, type TransactionStatus } from '@prisma/client';
import type { Db } from './db.js';

const detailInclude = {
  transactions: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.PaymentInclude;

export type PaymentRow = Prisma.PaymentGetPayload<object>;
export type PaymentDetailRow = Prisma.PaymentGetPayload<{ include: typeof detailInclude }>;

export interface NewPayment {
  id: string;
  clientId: string;
  orderId: string;
  amount: number;
  currency: string;
  providerCode: string;
  providerTxnRef: string;
  description: string;
  returnUrl: string;
  metadata: Prisma.InputJsonValue | undefined;
  expiresAt: Date;
  createdAt: Date;
  transaction: { id: string; rawRequest: Prisma.InputJsonValue };
}

/** Tạo payment PENDING kèm transaction PENDING đầu tiên (Q6) trong một lệnh (nested create, atomic). */
export async function createPaymentWithTransaction(db: Db, p: NewPayment): Promise<PaymentRow> {
  return db.payment.create({
    data: {
      id: p.id,
      clientId: p.clientId,
      orderId: p.orderId,
      amount: p.amount,
      currency: p.currency,
      status: 'PENDING',
      providerCode: p.providerCode,
      providerTxnRef: p.providerTxnRef,
      description: p.description,
      returnUrl: p.returnUrl,
      metadata: p.metadata,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      transactions: {
        create: {
          id: p.transaction.id,
          providerCode: p.providerCode,
          amount: p.amount,
          status: 'PENDING',
          rawRequest: p.transaction.rawRequest,
          createdAt: p.createdAt,
        },
      },
    },
  });
}

export async function findPaymentDetail(
  db: Db,
  clientId: string,
  paymentId: string,
): Promise<PaymentDetailRow | null> {
  return db.payment.findFirst({ where: { id: paymentId, clientId }, include: detailInclude });
}

/** Payment của một order, kèm transactions/refunds như chi tiết (Q19). */
export async function listPaymentsByOrder(
  db: Db,
  clientId: string,
  orderId: string,
): Promise<PaymentDetailRow[]> {
  return db.payment.findMany({
    where: { clientId, orderId },
    orderBy: { createdAt: 'asc' },
    include: detailInclude,
  });
}

/** Order đã có payment được thanh toán (paid_at khác null, C5)? */
export async function hasPaidPayment(db: Db, clientId: string, orderId: string): Promise<boolean> {
  const row = await db.payment.findFirst({
    where: { clientId, orderId, paidAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

/** Tra payment theo mã gửi provider; KHÔNG lọc client (dùng cho return URL, xem đầu file). */
export async function findPaymentByProviderRef(
  db: Db,
  providerCode: string,
  providerTxnRef: string,
): Promise<PaymentRow | null> {
  return db.payment.findFirst({ where: { providerCode, providerTxnRef } });
}

/** SELECT ... FOR UPDATE: khóa dòng payment tới hết transaction DB hiện tại. */
export async function lockPayment(
  tx: Prisma.TransactionClient,
  clientId: string,
  paymentId: string,
): Promise<{ status: PaymentStatus; paidAt: Date | null; needsReview: boolean } | null> {
  const rows = await tx.$queryRaw<{ status: PaymentStatus; paid_at: Date | null; needs_review: boolean }[]>(
    Prisma.sql`SELECT status, paid_at, needs_review FROM payments
               WHERE id = ${paymentId} AND client_id = ${clientId} FOR UPDATE`,
  );
  const row = rows[0];
  return row ? { status: row.status, paidAt: row.paid_at, needsReview: row.needs_review } : null;
}

export async function updatePaymentStatus(
  db: Db,
  clientId: string,
  paymentId: string,
  data: { status: PaymentStatus; paidAt?: Date },
): Promise<PaymentRow> {
  // update theo khóa chính (id unique); clientId kiểm tra cùng điều kiện để không ghi nhầm client.
  const { count } = await db.payment.updateMany({ where: { id: paymentId, clientId }, data });
  if (count !== 1) throw new Error('payment không tồn tại khi cập nhật trạng thái');
  return db.payment.findFirstOrThrow({ where: { id: paymentId, clientId } });
}

/** Bật needs_review; chỉ áp cho payment còn PENDING chưa thanh toán (không đè lên trạng thái cuối). */
export async function setNeedsReview(db: Db, clientId: string, paymentId: string): Promise<boolean> {
  const { count } = await db.payment.updateMany({
    where: { id: paymentId, clientId, status: 'PENDING', paidAt: null },
    data: { needsReview: true },
  });
  return count === 1;
}

/**
 * Ghi kết quả provider vào transaction đang PENDING của payment (mỗi payment hiện có một transaction).
 * Không truyền status = giữ PENDING (chỉ lưu bằng chứng cho xử lý tay).
 */
export async function updatePendingTransaction(
  db: Db,
  paymentId: string,
  data: { status?: TransactionStatus; providerTxnId?: string | null; rawResponse: Prisma.InputJsonValue },
): Promise<void> {
  await db.transaction.updateMany({ where: { paymentId, status: 'PENDING' }, data });
}

export async function insertStatusHistory(
  db: Db,
  h: { id: string; paymentId: string; from: PaymentStatus | null; to: PaymentStatus; source: StatusSource },
): Promise<void> {
  await db.paymentStatusHistory.create({
    data: { id: h.id, paymentId: h.paymentId, fromStatus: h.from, toStatus: h.to, source: h.source },
  });
}

export async function insertWebhookEvent(
  db: Db,
  e: { id: string; clientId: string; paymentId: string; type: string; payload: Prisma.InputJsonValue },
): Promise<void> {
  await db.webhookEvent.create({
    data: { id: e.id, clientId: e.clientId, paymentId: e.paymentId, type: e.type, payload: e.payload },
  });
}
