// POST/GET /api/v1/payments trên Postgres test thật. X-Client-Id tạm thời chưa xác thực (Q2).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestClient, deleteClients, type TestClientOptions } from '../helpers/db.js';
import { checkoutUrlSignatureValid } from '../helpers/vnpay.js';

const NOW = new Date('2026-10-22T05:00:00Z');
const { app, prisma } = createTestApp({ clock: () => NOW });
const clients: string[] = [];

async function newClient(opts?: TestClientOptions) {
  const id = await createTestClient(prisma, opts);
  clients.push(id);
  return id;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    order_id: `ORD-${randomUUID()}`,
    amount: 150000,
    currency: 'VND',
    provider: 'vnpay',
    description: 'Thanh toan don hang 123',
    return_url: 'https://shop.example.com/payment/result',
    metadata: { customer_id: 'C001', nested: { period: '2026-10' } },
    ...overrides,
  };
}

const create = (clientId: string, b: Record<string, unknown>) =>
  request(app).post('/api/v1/payments').set('X-Client-Id', clientId).send(b);

afterAll(async () => {
  await deleteClients(prisma, clients);
  await prisma.$disconnect();
});

describe('POST /api/v1/payments', () => {
  it('201: tạo payment PENDING, checkout_url sandbox có chữ ký hợp lệ, lưu transaction PENDING', async () => {
    const clientId = await newClient();
    const b = body({ expires_in: 600 });
    const res = await create(clientId, b);

    expect(res.status).toBe(201);
    expect(Object.keys(res.body as object).sort()).toEqual([
      'checkout_url',
      'expires_at',
      'payment_id',
      'status',
    ]);
    expect(res.body).toMatchObject({ status: 'PENDING', expires_at: '2026-10-22T05:10:00.000Z' });
    const paymentId = (res.body as { payment_id: string }).payment_id;
    expect(paymentId).toMatch(/^pay_[0-9A-Z]{26}$/);

    const checkoutUrl = new URL((res.body as { checkout_url: string }).checkout_url);
    expect(checkoutUrl.host).toBe('sandbox.vnpayment.vn');
    expect(checkoutUrlSignatureValid(checkoutUrl.toString())).toBe(true);
    const p = checkoutUrl.searchParams;
    expect(p.get('vnp_Amount')).toBe('15000000');
    expect(p.get('vnp_ReturnUrl')).toBe('http://localhost:3000/api/v1/callbacks/vnpay/return');
    expect(p.get('vnp_CreateDate')).toBe('20261022120000');
    expect(p.get('vnp_ExpireDate')).toBe('20261022121000');

    const saved = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { transactions: true },
    });
    expect(saved).toMatchObject({
      clientId,
      orderId: b.order_id,
      amount: 150000,
      status: 'PENDING',
      providerTxnRef: p.get('vnp_TxnRef'),
      metadata: b.metadata,
      needsReview: false,
      paidAt: null,
    });
    expect(saved.transactions).toHaveLength(1);
    expect(saved.transactions[0]).toMatchObject({ status: 'PENDING', amount: 150000, providerTxnId: null });
    expect(saved.transactions[0]?.rawRequest).not.toHaveProperty('vnp_SecureHash');
  });

  it('expires_in mặc định = PAYMENT_TTL_SECONDS (900)', async () => {
    const clientId = await newClient();
    const res = await create(clientId, body());
    expect(res.status).toBe(201);
    expect((res.body as { expires_at: string }).expires_at).toBe('2026-10-22T05:15:00.000Z');
  });

  it.each([
    ['amount float', 'amount', { amount: 1000.5 }],
    ['amount âm', 'amount', { amount: -1 }],
    ['amount = 0', 'amount', { amount: 0 }],
    ['amount dạng chuỗi', 'amount', { amount: '1000' }],
    ['amount vượt int32', 'amount', { amount: 2_147_483_648 }],
    ['currency sai', 'currency', { currency: 'vnd' }],
    ['return_url http không phải localhost', 'return_url', { return_url: 'http://shop.example.com/r' }],
    ['return_url javascript:', 'return_url', { return_url: 'javascript:alert(1)' }],
    ['return_url protocol-relative', 'return_url', { return_url: '//evil.com/r' }],
    ['return_url không phải URL', 'return_url', { return_url: 'abc' }],
    ['return_url thiếu host', 'return_url', { return_url: 'https://' }],
    ['return_url IPv6 hỏng', 'return_url', { return_url: 'http://[::1' }],
    ['return_url có user:pass', 'return_url', { return_url: 'https://u:p@shop.example.com/r' }],
    ['expires_in < 300', 'expires_in', { expires_in: 299 }],
    ['expires_in > 3600', 'expires_in', { expires_in: 3601 }],
    ['thiếu order_id', 'order_id', { order_id: undefined }],
    ['metadata không phải object', 'metadata', { metadata: 'x' }],
  ])('400 VALIDATION_ERROR: %s', async (_name, path, patch) => {
    const clientId = await newClient();
    const res = await create(clientId, body(patch));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const details = (res.body as { error: { details: { path: string }[] } }).error.details;
    expect(details.map((d) => d.path)).toEqual([path]);
    expect(await prisma.payment.count({ where: { clientId } })).toBe(0);
  });

  it.each([
    ['dưới min_amount', 4999],
    ['trên max_amount', 1_000_000_000],
  ])(
    'Q21: amount %s của provider → 400, details [{path,min,max}] lấy từ providers.capabilities',
    async (_n, amount) => {
      const clientId = await newClient();
      const res = await create(clientId, body({ amount }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: { code: 'VALIDATION_ERROR', details: [{ path: 'amount', min: 5000, max: 999999999 }] },
      });
      expect(await prisma.payment.count({ where: { clientId } })).toBe(0);
    },
  );

  it('Q21: amount đúng biên min/max được chấp nhận', async () => {
    const clientId = await newClient();
    expect((await create(clientId, body({ amount: 5000 }))).status).toBe(201);
    expect((await create(clientId, body({ amount: 999999999 }))).status).toBe(201);
  });

  it('Q20: payer_ip (IPv4/IPv6) gửi thành vnp_IpAddr; mặc định 127.0.0.1', async () => {
    const clientId = await newClient();
    const ipOf = async (patch: Record<string, unknown>) => {
      const res = await create(clientId, body(patch));
      expect(res.status).toBe(201);
      return new URL((res.body as { checkout_url: string }).checkout_url).searchParams.get('vnp_IpAddr');
    };
    expect(await ipOf({})).toBe('127.0.0.1');
    expect(await ipOf({ payer_ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipOf({ payer_ip: '2001:db8::1' })).toBe('2001:db8::1');
  });

  it.each(['999.1.1.1', 'abc', '1.2.3', ''])('Q20: payer_ip không hợp lệ (%s) → 400', async (ip) => {
    const clientId = await newClient();
    const res = await create(clientId, body({ payer_ip: ip }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const details = (res.body as { error: { details: { path: string }[] } }).error.details;
    expect(details[0]?.path).toBe('payer_ip');
    expect(await prisma.payment.count({ where: { clientId } })).toBe(0);
  });

  it('Q22: metadata tối đa 8192 byte khi serialize JSON', async () => {
    const clientId = await newClient();
    const sized = (bytes: number) => ({ k: 'x'.repeat(bytes - JSON.stringify({ k: '' }).length) });
    expect(Buffer.byteLength(JSON.stringify(sized(8192)))).toBe(8192);
    expect((await create(clientId, body({ metadata: sized(8192) }))).status).toBe(201);
    const res = await create(clientId, body({ metadata: sized(8193) }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: [{ path: 'metadata' }] } });
    // Đếm byte UTF-8, không đếm ký tự: 3000 ký tự "ệ" (3 byte) vượt giới hạn.
    expect((await create(clientId, body({ metadata: { k: 'ệ'.repeat(3000) } }))).status).toBe(400);
  });

  it('Q22: biên chính xác với ký tự nhiều byte (8192 → 201, 8193 → 400)', async () => {
    const clientId = await newClient();
    // '{"k":""}' = 8 byte; "ệ" = 3 byte UTF-8 → 2728 ký tự = 8184 byte, tổng đúng 8192.
    const exact = { k: 'ệ'.repeat(2728) };
    // "é" = 2 byte: 2727 "ệ" (8181) + 2 "é" (4) = 8185 byte → tổng 8193.
    const over = { k: `${'ệ'.repeat(2727)}éé` };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(8192);
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBe(8193);
    expect((await create(clientId, body({ metadata: exact }))).status).toBe(201);
    const res = await create(clientId, body({ metadata: over }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: [{ path: 'metadata' }] } });
    expect(await prisma.payment.count({ where: { clientId } })).toBe(1);
  });

  it('currency hợp lệ về định dạng nhưng provider không hỗ trợ → 400', async () => {
    const clientId = await newClient();
    const res = await create(clientId, body({ currency: 'USD' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('return_url http://localhost và http://127.0.0.1 được chấp nhận', async () => {
    const clientId = await newClient();
    for (const url of ['http://localhost:8080/r', 'http://127.0.0.1/r']) {
      const res = await create(clientId, body({ return_url: url }));
      expect(res.status).toBe(201);
    }
  });

  it('401 INVALID_SIGNATURE: thiếu X-Client-Id, client không tồn tại, client DISABLED (cùng một response)', async () => {
    const disabled = await newClient({ status: 'DISABLED' });
    const missing = await request(app).post('/api/v1/payments').send(body());
    const unknown = await create('cli_khongtontai', body());
    const off = await create(disabled, body());
    for (const res of [missing, unknown, off]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'INVALID_SIGNATURE', message: 'Xác thực thất bại' } });
    }
    expect(await prisma.payment.count({ where: { clientId: disabled } })).toBe(0);
  });

  it('403 PROVIDER_NOT_ALLOWED: provider chưa bật cho client, chưa liên kết, hoặc không tồn tại', async () => {
    const notEnabled = await newClient({ providers: { vnpay: false } });
    const notLinked = await newClient({ providers: {} });
    const ok = await newClient();
    for (const [clientId, provider] of [
      [notEnabled, 'vnpay'],
      [notLinked, 'vnpay'],
      [ok, 'momo'],
    ] as const) {
      const res = await create(clientId, body({ provider }));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'PROVIDER_NOT_ALLOWED' } });
    }
  });

  it('409 INVALID_STATE khi order đã có payment được thanh toán; FAILED thì vẫn tạo mới được', async () => {
    const clientId = await newClient();
    const b = body();
    const first = await create(clientId, b);
    const firstId = (first.body as { payment_id: string }).payment_id;

    await prisma.payment.update({ where: { id: firstId }, data: { status: 'FAILED' } });
    expect((await create(clientId, { ...b })).status).toBe(201);

    await prisma.payment.update({ where: { id: firstId }, data: { status: 'SUCCEEDED', paidAt: NOW } });
    const res = await create(clientId, { ...b });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_STATE' } });
  });

  it('partial unique index (C5): DB chặn payment đã thanh toán thứ hai của cùng order', async () => {
    const clientId = await newClient();
    const b = body();
    const a = (await create(clientId, b)).body as { payment_id: string };
    const c = (await create(clientId, b)).body as { payment_id: string };
    await prisma.payment.update({ where: { id: a.payment_id }, data: { paidAt: NOW, status: 'SUCCEEDED' } });
    await expect(
      prisma.payment.update({ where: { id: c.payment_id }, data: { paidAt: NOW, status: 'SUCCEEDED' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('GET /api/v1/payments/:payment_id', () => {
  it('200: chi tiết + transactions, snake_case, không lộ raw payload', async () => {
    const clientId = await newClient();
    const b = body();
    const { payment_id } = (await create(clientId, b)).body as { payment_id: string };

    const res = await request(app).get(`/api/v1/payments/${payment_id}`).set('X-Client-Id', clientId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payment_id,
      order_id: b.order_id,
      amount: 150000,
      currency: 'VND',
      status: 'PENDING',
      provider: 'vnpay',
      metadata: b.metadata,
      paid_at: null,
      expires_at: '2026-10-22T05:15:00.000Z',
      needs_review: false,
      refunds: [],
    });
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/raw_request|raw_response|vnp_|secret/i);
    const txns = (res.body as { transactions: unknown[] }).transactions;
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ status: 'PENDING', amount: 150000, provider: 'vnpay' });
  });

  it('404 NOT_FOUND khi payment thuộc client khác (không lộ sự tồn tại)', async () => {
    const owner = await newClient();
    const other = await newClient();
    const { payment_id } = (await create(owner, body())).body as { payment_id: string };

    const cross = await request(app).get(`/api/v1/payments/${payment_id}`).set('X-Client-Id', other);
    const missing = await request(app).get('/api/v1/payments/pay_khongco').set('X-Client-Id', other);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);
  });
});

describe('GET /api/v1/payments?order_id=', () => {
  it('chỉ trả payment của client đang gọi', async () => {
    const a = await newClient();
    const b = await newClient();
    const orderId = `ORD-${randomUUID()}`;
    await create(a, body({ order_id: orderId }));
    await create(a, body({ order_id: orderId }));
    await create(b, body({ order_id: orderId }));

    const res = await request(app).get('/api/v1/payments').query({ order_id: orderId }).set('X-Client-Id', a);
    expect(res.status).toBe(200);
    const data = (res.body as { data: { order_id: string }[] }).data;
    expect(data).toHaveLength(2);
    expect(data.every((p) => p.order_id === orderId)).toBe(true);
    const ids = await prisma.payment.findMany({ where: { clientId: a, orderId }, select: { id: true } });
    expect(data.map((p) => (p as unknown as { payment_id: string }).payment_id).sort()).toEqual(
      ids.map((x) => x.id).sort(),
    );
    // Q19: mỗi item cùng dạng với chi tiết (transactions, refunds, needs_review).
    for (const item of data) {
      expect(item).toMatchObject({ needs_review: false, refunds: [] });
      expect((item as unknown as { transactions: unknown[] }).transactions).toEqual([
        expect.objectContaining({ status: 'PENDING', amount: 150000, provider: 'vnpay' }),
      ]);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/raw_request|raw_response|vnp_/i);
  });

  it('thiếu order_id → 400; client không hợp lệ → 401', async () => {
    const a = await newClient();
    expect((await request(app).get('/api/v1/payments').set('X-Client-Id', a)).status).toBe(400);
    expect((await request(app).get('/api/v1/payments').query({ order_id: 'x' })).status).toBe(401);
  });
});
