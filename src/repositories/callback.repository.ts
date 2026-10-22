// Truy cập provider_callbacks: lưu mọi lượt return/IPN để đối chiếu (payload không chứa chữ ký).
import type { Prisma } from '@prisma/client';
import type { Db } from './db.js';

export interface NewCallback {
  id: string;
  providerCode: string;
  paymentId: string | null;
  payload: Prisma.InputJsonValue;
  signatureValid: boolean;
  receivedAt: Date;
}

export async function insertCallback(db: Db, c: NewCallback): Promise<void> {
  await db.providerCallback.create({ data: { ...c, processed: false } });
}

export async function markCallbackProcessed(db: Db, id: string): Promise<void> {
  await db.providerCallback.update({ where: { id }, data: { processed: true } });
}
