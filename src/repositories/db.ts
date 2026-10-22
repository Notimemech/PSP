import type { Prisma, PrismaClient } from '@prisma/client';

/** Handle DB dùng chung cho repository: client gốc hoặc client trong $transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Lỗi vi phạm unique constraint của Prisma (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}
