import type { PrismaClient } from '@prisma/client';

/** Ping Postgres; ném lỗi nếu không kết nối được hoặc quá `timeoutMs`. */
export async function pingDatabase(prisma: PrismaClient, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`database ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
