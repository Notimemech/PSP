// Seed và dọn dữ liệu test theo client. Không truncate toàn bộ bảng vì các file test chạy song song
// trên cùng DB test: mỗi test tạo client riêng (ID ngẫu nhiên) và chỉ xóa dữ liệu của client đó.
import type { ClientStatus, PrismaClient } from '@prisma/client';
import { createSecretBox } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/id.js';
import { TEST_ENV } from './test-env.js';

export const testSecretBox = createSecretBox(Buffer.from(TEST_ENV.ENCRYPTION_KEY ?? '', 'base64'));

export interface TestClientOptions {
  status?: ClientStatus;
  /** Provider và trạng thái bật trong client_providers. Mặc định { vnpay: true }. */
  providers?: Record<string, boolean>;
}

export async function createTestClient(prisma: PrismaClient, opts: TestClientOptions = {}): Promise<string> {
  const id = newId('client');
  const providers = opts.providers ?? { vnpay: true };
  await prisma.client.create({
    data: {
      id,
      name: `test ${id}`,
      secretEncrypted: testSecretBox.seal('test-secret-not-real'),
      status: opts.status ?? 'ACTIVE',
      providers: {
        create: Object.entries(providers).map(([providerCode, isEnabled]) => ({ providerCode, isEnabled })),
      },
    },
  });
  return id;
}

/** Xóa toàn bộ dữ liệu của các client (theo thứ tự FK). */
export async function deleteClients(prisma: PrismaClient, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const payments = await prisma.payment.findMany({
    where: { clientId: { in: clientIds } },
    select: { id: true, providerTxnRef: true },
  });
  const paymentIds = payments.map((p) => p.id);
  const refs = payments.map((p) => p.providerTxnRef);
  await prisma.$transaction([
    prisma.webhookEvent.deleteMany({ where: { clientId: { in: clientIds } } }),
    prisma.paymentStatusHistory.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.transaction.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.refund.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    prisma.providerCallback.deleteMany({ where: { paymentId: { in: paymentIds } } }),
    // Callback chữ ký sai không gắn payment: xóa theo vnp_TxnRef trong payload.
    ...refs.map((ref) =>
      prisma.providerCallback.deleteMany({ where: { payload: { path: ['vnp_TxnRef'], equals: ref } } }),
    ),
    prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
    prisma.idempotencyKey.deleteMany({ where: { clientId: { in: clientIds } } }),
    prisma.clientProvider.deleteMany({ where: { clientId: { in: clientIds } } }),
    prisma.client.deleteMany({ where: { id: { in: clientIds } } }),
  ]);
}
