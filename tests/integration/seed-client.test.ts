import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { seedClient } from '../../src/cli/seed-client.js';
import { deleteClients, testSecretBox } from '../helpers/db.js';
import { TEST_DATABASE_URL } from '../helpers/test-env.js';

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const created: string[] = [];

afterAll(async () => {
  await deleteClients(prisma, created);
  await prisma.$disconnect();
});

describe('seedClient', () => {
  it('tạo client ACTIVE, secret 32 byte hex chỉ lưu dạng mã hóa, bật vnpay', async () => {
    const { clientId, secret } = await seedClient(prisma, testSecretBox, { name: '  Shop A  ' });
    created.push(clientId);

    expect(clientId).toMatch(/^cli_[0-9A-Z]{26}$/);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { providers: true },
    });
    expect(row).toMatchObject({ name: 'Shop A', status: 'ACTIVE' });
    expect(row.secretEncrypted).not.toContain(secret);
    expect(row.secretEncrypted.startsWith('v1.')).toBe(true);
    expect(testSecretBox.open(row.secretEncrypted)).toBe(secret);
    expect(row.providers).toEqual([expect.objectContaining({ providerCode: 'vnpay', isEnabled: true })]);
  });

  it('mỗi lần sinh client_id và secret khác nhau', async () => {
    const a = await seedClient(prisma, testSecretBox, { name: 'A' });
    const b = await seedClient(prisma, testSecretBox, { name: 'B' });
    created.push(a.clientId, b.clientId);
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.secret).not.toBe(b.secret);
  });

  it('tên rỗng hoặc quá dài bị từ chối', async () => {
    await expect(seedClient(prisma, testSecretBox, { name: '   ' })).rejects.toThrow();
    await expect(seedClient(prisma, testSecretBox, { name: 'x'.repeat(101) })).rejects.toThrow();
  });
});
