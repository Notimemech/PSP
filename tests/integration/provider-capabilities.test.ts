// Q21 fail closed: min_amount/max_amount trong providers.capabilities có mặt nhưng hỏng → 500, không coi là
// "không giới hạn". Dùng một dòng providers RIÊNG (code ngẫu nhiên, adapter VnpayAdapter thật đổi code) thay vì
// sửa dòng `vnpay`, để không ảnh hưởng các file test khác chạy song song trên cùng DB test.
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import { buildReturnUrl } from '../../src/providers/index.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { VnpayAdapter } from '../../src/providers/vnpay/VnpayAdapter.js';
import { createTestClient, deleteClients } from '../helpers/db.js';
import { TEST_ENV } from '../helpers/test-env.js';
import { createVnpayStub } from '../helpers/vnpay.js';

const CODE = `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;

class TestCodeAdapter extends VnpayAdapter {
  override readonly code = CODE;
}

const config = loadConfig(TEST_ENV);
const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
const logLines: string[] = [];
const logger = createLogger({ level: 'error', write: (l) => logLines.push(l) });
const app = createApp({
  config,
  logger,
  prisma,
  clock: () => new Date(),
  providers: createProviderRegistry([
    new TestCodeAdapter({
      tmnCode: config.vnpay.tmnCode,
      hashSecret: config.vnpay.hashSecret,
      host: config.vnpay.host,
      returnUrl: buildReturnUrl(config.publicBaseUrl),
      timeoutMs: 1000,
      transport: createVnpayStub().transport,
    }),
  ]),
});
let clientId = '';

const setCapabilities = (capabilities: Prisma.InputJsonValue) =>
  prisma.provider.update({ where: { code: CODE }, data: { capabilities } });

const create = (amount: number) =>
  request(app)
    .post('/api/v1/payments')
    .set('X-Client-Id', clientId)
    .send({
      order_id: `ORD-${randomUUID()}`,
      amount,
      currency: 'VND',
      provider: CODE,
      description: 'x',
      return_url: 'https://shop.example.com/r',
    });

beforeAll(async () => {
  await prisma.provider.create({ data: { code: CODE, name: 'Test', capabilities: {}, status: 'ENABLED' } });
  clientId = await createTestClient(prisma, { providers: { [CODE]: true } });
});

afterAll(async () => {
  await deleteClients(prisma, [clientId]);
  await prisma.provider.delete({ where: { code: CODE } });
  await prisma.$disconnect();
});

describe('Q21: giới hạn số tiền từ providers.capabilities', () => {
  it.each([
    ['min_amount là chuỗi', { min_amount: '5000' }],
    ['max_amount là số lẻ', { max_amount: 10.5 }],
    ['min_amount âm', { min_amount: -1 }],
    ['max_amount null', { max_amount: null }],
  ])('%s → 500 INTERNAL_ERROR, log lỗi không chứa giá trị, không tạo payment', async (_n, caps) => {
    await setCapabilities(caps);
    logLines.length = 0;
    const res = await create(10_000);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' } });
    expect(await prisma.payment.count({ where: { clientId } })).toBe(0);
    expect(logLines.some((l) => l.includes('capabilities') && l.includes(CODE))).toBe(true);
    expect(logLines.join('\n')).not.toContain(config.vnpay.hashSecret);
  });

  it('thiếu key → không giới hạn; key hợp lệ → áp giới hạn', async () => {
    await setCapabilities({ currencies: ['VND'] });
    expect((await create(1)).status).toBe(201);
    await setCapabilities({ min_amount: 100, max_amount: 200 });
    expect((await create(99)).status).toBe(400);
    expect((await create(201)).status).toBe(400);
    expect((await create(150)).status).toBe(201);
  });
});
