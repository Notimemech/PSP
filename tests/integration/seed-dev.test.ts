import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_CLIENTS, seedDev } from '../../src/cli/seed-dev.js';
import { deleteClients, testSecretBox } from '../helpers/db.js';
import { TEST_DATABASE_URL } from '../helpers/test-env.js';

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const ids = DEV_CLIENTS.map((c) => c.id);

beforeAll(async () => {
  await deleteClients(prisma, ids);
});

afterAll(async () => {
  await deleteClients(prisma, ids);
  await prisma.$disconnect();
});

describe('seedDev', () => {
  it('tạo client cố định + payment mẫu đủ trạng thái; chạy lại không tạo trùng, không đổi secret', async () => {
    const first = await seedDev(prisma, testSecretBox);
    expect(first.createdClients.map((c) => c.clientId)).toEqual(ids);
    expect(first.createdPayments).toHaveLength(5);

    const clients = await prisma.client.findMany({
      where: { id: { in: ids } },
      include: { providers: true },
    });
    for (const c of clients) {
      const created = first.createdClients.find((x) => x.clientId === c.id);
      expect(testSecretBox.open(c.secretEncrypted)).toBe(created?.secret);
      expect(c.providers).toEqual([expect.objectContaining({ providerCode: 'vnpay', isEnabled: true })]);
    }
    expect(clients.find((c) => c.id === DEV_CLIENTS[2].id)?.status).toBe('DISABLED');

    const payments = await prisma.payment.findMany({
      where: { clientId: { in: ids } },
      include: { transactions: true, statusHistory: true, webhookEvents: true },
    });
    const byOrder = new Map(payments.map((p) => [p.orderId, p]));
    expect(byOrder.get('SEED-PAID-1')).toMatchObject({ status: 'SUCCEEDED', needsReview: false });
    expect(byOrder.get('SEED-PAID-1')?.paidAt).not.toBeNull();
    expect(byOrder.get('SEED-PAID-1')?.webhookEvents).toEqual([
      expect.objectContaining({ type: 'payment.succeeded', status: 'PENDING' }),
    ]);
    expect(byOrder.get('SEED-FAILED-1')).toMatchObject({ status: 'FAILED', paidAt: null });
    expect(byOrder.get('SEED-REVIEW-1')).toMatchObject({ status: 'PENDING', needsReview: true });
    expect(byOrder.get('SEED-REVIEW-1')?.webhookEvents).toEqual([]);
    expect(byOrder.get('SEED-PENDING-1')?.statusHistory).toEqual([]);
    expect(byOrder.get('SEED-B-PENDING-1')?.clientId).toBe(DEV_CLIENTS[1].id);

    const secretsBefore = clients.map((c) => c.secretEncrypted).sort();
    const second = await seedDev(prisma, testSecretBox);
    expect(second).toEqual({ createdClients: [], createdPayments: [] });
    const after = await prisma.client.findMany({ where: { id: { in: ids } } });
    expect(after.map((c) => c.secretEncrypted).sort()).toEqual(secretsBefore);
    expect(await prisma.payment.count({ where: { clientId: { in: ids } } })).toBe(5);
  });
});
