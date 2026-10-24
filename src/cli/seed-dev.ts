// Seed dữ liệu dev: npm run seed:dev (chạy sau `npx prisma migrate deploy`, ví dụ sau `docker compose down -v`).
// Tạo 3 client có ID cố định (để curl/Postman dùng lại được) và vài payment mẫu ở các trạng thái khác nhau.
// Chạy lại nhiều lần an toàn: client đã có thì giữ nguyên (không đổi secret), payment mẫu đã có (theo order_id)
// thì bỏ qua. Secret client sinh ngẫu nhiên, chỉ in MỘT LẦN khi tạo; không có secret nào nằm trong file này.
// Không chạy khi NODE_ENV=production.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PrismaClient, type ClientStatus, type Prisma } from '@prisma/client';
import { ConfigError, loadConfig } from '../config/env.js';
import { createSecretBox, type SecretBox } from '../lib/crypto.js';
import { newId, ulid } from '../lib/id.js';

export const DEV_CLIENTS = [
  { id: 'cli_01M5H0R3AEDX508Z7QSD6YSP7V', name: 'Shop A (dev)', status: 'ACTIVE' },
  { id: 'cli_01M5H0R48PJ589V3X2V1P013KN', name: 'Shop B (dev)', status: 'ACTIVE' },
  // Client bị khóa: gọi API bằng ID này phải nhận 401.
  { id: 'cli_01M5H0R5Q8V3K2D9X7T4N6W1ZC', name: 'Shop C (dev, khóa)', status: 'DISABLED' },
] as const satisfies readonly { id: string; name: string; status: ClientStatus }[];

const [SHOP_A, SHOP_B] = DEV_CLIENTS;
const PROVIDER = 'vnpay';
const RETURN_URL = 'http://localhost:5000/return';
const MINUTE = 60_000;

type Scenario = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_REVIEW';

/** Payment mẫu; order_id bắt đầu bằng SEED- để dễ nhận ra và không trùng order của bạn. */
const SAMPLE_PAYMENTS: readonly { clientId: string; orderId: string; amount: number; scenario: Scenario }[] =
  [
    { clientId: SHOP_A.id, orderId: 'SEED-PENDING-1', amount: 100_000, scenario: 'PENDING' },
    { clientId: SHOP_A.id, orderId: 'SEED-PAID-1', amount: 250_000, scenario: 'SUCCEEDED' },
    { clientId: SHOP_A.id, orderId: 'SEED-FAILED-1', amount: 75_000, scenario: 'FAILED' },
    { clientId: SHOP_A.id, orderId: 'SEED-REVIEW-1', amount: 120_000, scenario: 'NEEDS_REVIEW' },
    { clientId: SHOP_B.id, orderId: 'SEED-B-PENDING-1', amount: 50_000, scenario: 'PENDING' },
  ];

export interface SeedDevResult {
  /** Secret của client vừa tạo lần này (client đã có từ trước không có trong danh sách). */
  createdClients: { clientId: string; name: string; secret: string }[];
  createdPayments: { paymentId: string; orderId: string; status: string }[];
}

async function seedClients(db: PrismaClient, secretBox: SecretBox): Promise<SeedDevResult['createdClients']> {
  const created: SeedDevResult['createdClients'] = [];
  for (const c of DEV_CLIENTS) {
    const exists = await db.client.findUnique({ where: { id: c.id }, select: { id: true } });
    if (exists) continue;
    const secret = randomBytes(32).toString('hex');
    await db.client.create({
      data: {
        id: c.id,
        name: c.name,
        status: c.status,
        secretEncrypted: secretBox.seal(secret),
        providers: { create: [{ providerCode: PROVIDER, isEnabled: true }] },
      },
    });
    created.push({ clientId: c.id, name: c.name, secret });
  }
  return created;
}

/** Cùng dạng payload với outbox của PaymentService (src/services/payment.service.ts). */
function eventPayload(
  eventId: string,
  type: string,
  p: { id: string; orderId: string; amount: number; status: string; paidAt: Date | null },
  createdAt: Date,
): Prisma.InputJsonObject {
  return {
    event_id: eventId,
    type,
    created_at: createdAt.toISOString(),
    payment: {
      payment_id: p.id,
      order_id: p.orderId,
      amount: p.amount,
      currency: 'VND',
      status: p.status,
      provider: PROVIDER,
      paid_at: p.paidAt?.toISOString() ?? null,
      metadata: { seed: true },
    },
  };
}

async function seedPayment(db: PrismaClient, s: (typeof SAMPLE_PAYMENTS)[number], now: Date) {
  const createdAt = new Date(now.getTime() - 10 * MINUTE);
  const confirmedAt = new Date(now.getTime() - 8 * MINUTE);
  const paymentId = newId('payment', createdAt.getTime());
  const providerRef = ulid(createdAt.getTime());
  const final = s.scenario === 'SUCCEEDED' || s.scenario === 'FAILED' ? s.scenario : null;
  const paidAt = s.scenario === 'SUCCEEDED' ? confirmedAt : null;
  const status = final ?? 'PENDING';
  // Mã giao dịch VNPay giả (số), chỉ có khi đã có kết luận.
  const providerTxnId = final ? String(14_000_000 + Math.floor(Math.random() * 999_999)) : null;
  // NEEDS_REVIEW: queryDr trả số tiền lệch (FR-CB-03), payment giữ PENDING.
  const rawResponse: Prisma.InputJsonObject | undefined =
    s.scenario === 'PENDING'
      ? undefined
      : {
          vnp_TxnRef: providerRef,
          vnp_Amount: String((s.scenario === 'NEEDS_REVIEW' ? s.amount + 1_000 : s.amount) * 100),
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: s.scenario === 'FAILED' ? '02' : '00',
          ...(providerTxnId ? { vnp_TransactionNo: providerTxnId } : {}),
        };

  await db.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        id: paymentId,
        clientId: s.clientId,
        orderId: s.orderId,
        amount: s.amount,
        currency: 'VND',
        status,
        providerCode: PROVIDER,
        providerTxnRef: providerRef,
        description: `Thanh toan ${s.orderId}`,
        returnUrl: RETURN_URL,
        metadata: { seed: true },
        expiresAt: new Date(createdAt.getTime() + 15 * MINUTE),
        paidAt,
        needsReview: s.scenario === 'NEEDS_REVIEW',
        createdAt,
        transactions: {
          create: {
            id: newId('transaction', createdAt.getTime()),
            providerCode: PROVIDER,
            providerTxnId,
            amount: s.amount,
            status,
            rawRequest: { vnp_TxnRef: providerRef, vnp_Amount: String(s.amount * 100) },
            rawResponse,
            createdAt,
          },
        },
      },
    });
    if (!final) return;
    await tx.paymentStatusHistory.create({
      data: {
        id: newId('statusHistory', confirmedAt.getTime()),
        paymentId,
        fromStatus: 'PENDING',
        toStatus: final,
        source: 'API',
        createdAt: confirmedAt,
      },
    });
    const eventId = newId('event', confirmedAt.getTime());
    const type = final === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed';
    await tx.webhookEvent.create({
      data: {
        id: eventId,
        clientId: s.clientId,
        paymentId,
        type,
        payload: eventPayload(eventId, type, { ...s, id: paymentId, status, paidAt }, confirmedAt),
        createdAt: confirmedAt,
      },
    });
  });
  return {
    paymentId,
    orderId: s.orderId,
    status: s.scenario === 'NEEDS_REVIEW' ? 'PENDING (needs_review)' : status,
  };
}

export async function seedDev(
  db: PrismaClient,
  secretBox: SecretBox,
  clock: () => Date = () => new Date(),
): Promise<SeedDevResult> {
  const provider = await db.provider.findUnique({ where: { code: PROVIDER }, select: { code: true } });
  if (!provider) throw new Error('Chưa có provider vnpay: chạy `npx prisma migrate deploy` trước');

  const createdClients = await seedClients(db, secretBox);
  const createdPayments: SeedDevResult['createdPayments'] = [];
  for (const s of SAMPLE_PAYMENTS) {
    const exists = await db.payment.findFirst({
      where: { clientId: s.clientId, orderId: s.orderId },
      select: { id: true },
    });
    if (exists) continue;
    createdPayments.push(await seedPayment(db, s, clock()));
  }
  return { createdClients, createdPayments };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.env === 'production') throw new Error('Không chạy seed:dev khi NODE_ENV=production');
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const result = await seedDev(prisma, createSecretBox(config.security.encryptionKey));
    const out: string[] = [];
    for (const c of DEV_CLIENTS) {
      const created = result.createdClients.find((x) => x.clientId === c.id);
      out.push(`${c.id}  ${c.name}  ${created ? 'mới tạo' : 'đã có, giữ nguyên'}`);
      if (created) out.push(`  secret: ${created.secret}`);
    }
    out.push(`payment mẫu mới tạo: ${result.createdPayments.length}`);
    for (const p of result.createdPayments) out.push(`  ${p.paymentId}  ${p.orderId}  ${p.status}`);
    if (result.createdClients.length > 0) {
      out.push('Lưu secret ngay: chỉ in một lần và không hiển thị lại.');
    }
    process.stdout.write(out.join('\n') + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`seed:dev thất bại: ${message}\n`);
    process.exit(1);
  });
}
