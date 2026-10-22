// setNeedsReview chỉ được bật cờ cho payment còn PENDING chưa thanh toán (không đè trạng thái cuối).
import { randomUUID } from 'node:crypto';
import type { PaymentStatus } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { newId, ulid } from '../../src/lib/id.js';
import { createPaymentWithTransaction, setNeedsReview } from '../../src/repositories/payment.repository.js';
import { createTestClient, deleteClients } from '../helpers/db.js';
import { TEST_DATABASE_URL } from '../helpers/test-env.js';

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const clients: string[] = [];

afterAll(async () => {
  await deleteClients(prisma, clients);
  await prisma.$disconnect();
});

async function seedPayment(status: PaymentStatus, paidAt: Date | null) {
  const clientId = await createTestClient(prisma);
  clients.push(clientId);
  const now = new Date();
  const p = await createPaymentWithTransaction(prisma, {
    id: newId('payment'),
    clientId,
    orderId: `ORD-${randomUUID()}`,
    amount: 150000,
    currency: 'VND',
    providerCode: 'vnpay',
    providerTxnRef: ulid(),
    description: 'x',
    returnUrl: 'https://shop.example.com/r',
    metadata: undefined,
    expiresAt: new Date(now.getTime() + 900_000),
    createdAt: now,
    transaction: { id: newId('transaction'), rawRequest: {} },
  });
  await prisma.payment.update({ where: { id: p.id }, data: { status, paidAt } });
  return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

describe('setNeedsReview', () => {
  it('PENDING chưa thanh toán → bật cờ', async () => {
    const p = await seedPayment('PENDING', null);
    expect(await setNeedsReview(prisma, p.clientId, p.id)).toBe(true);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).needsReview).toBe(true);
  });

  it.each([
    ['SUCCEEDED có paid_at', 'SUCCEEDED', new Date('2026-10-22T05:00:00Z')],
    ['FAILED', 'FAILED', null],
    ['EXPIRED', 'EXPIRED', null],
    ['CANCELLED', 'CANCELLED', null],
    ['PENDING nhưng đã có paid_at (bất thường)', 'PENDING', new Date('2026-10-22T05:00:00Z')],
  ] as const)('%s → không đổi gì', async (_n, status, paidAt) => {
    const before = await seedPayment(status, paidAt);
    expect(await setNeedsReview(prisma, before.clientId, before.id)).toBe(false);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual(before);
  });

  it('clientId khác → không đổi gì', async () => {
    const p = await seedPayment('PENDING', null);
    expect(await setNeedsReview(prisma, 'cli_khac', p.id)).toBe(false);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).needsReview).toBe(false);
  });
});
