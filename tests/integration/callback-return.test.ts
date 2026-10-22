// GET /api/v1/callbacks/vnpay/return: return URL ký thật, queryDr qua stub transport với response ký thật.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestClient, deleteClients } from '../helpers/db.js';
import {
  RETURN_PATH,
  createVnpayStub,
  hangUntilAborted,
  jsonResponse,
  returnParamsFromCheckout,
  signedQueryDrResponse,
  signedReturnQuery,
} from '../helpers/vnpay.js';

const stub = createVnpayStub();
const { app, prisma } = createTestApp({ transport: stub.transport, providerTimeoutMs: 100 });
const clients: string[] = [];
const AMOUNT = 150000;
const RETURN_URL = 'https://shop.example.com/payment/result?lang=vi';

interface Created {
  clientId: string;
  paymentId: string;
  checkoutUrl: string;
  txnRef: string;
}

async function createPayment(orderId = `ORD-${randomUUID()}`, clientId?: string): Promise<Created> {
  const cid = clientId ?? (await createTestClient(prisma));
  if (!clientId) clients.push(cid);
  const res = await request(app)
    .post('/api/v1/payments')
    .set('X-Client-Id', cid)
    .send({
      order_id: orderId,
      amount: AMOUNT,
      currency: 'VND',
      provider: 'vnpay',
      description: 'Thanh toan',
      return_url: RETURN_URL,
      metadata: { subscription_id: 'sub_1' },
    });
  expect(res.status).toBe(201);
  const b = res.body as { payment_id: string; checkout_url: string };
  return {
    clientId: cid,
    paymentId: b.payment_id,
    checkoutUrl: b.checkout_url,
    txnRef: new URL(b.checkout_url).searchParams.get('vnp_TxnRef') ?? '',
  };
}

function queryDrReturns(status: string, amountMinor = AMOUNT * 100, overrides?: Record<string, string>) {
  stub.respond((req) => jsonResponse(signedQueryDrResponse(req, { amountMinor, status, overrides })));
}

const callReturn = (qs: string) => request(app).get(`${RETURN_PATH}?${qs}`).redirects(0);
const validReturn = (c: Created) => callReturn(signedReturnQuery(returnParamsFromCheckout(c.checkoutUrl)));

async function state(paymentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { transactions: true },
  });
  const history = await prisma.paymentStatusHistory.findMany({ where: { paymentId } });
  const events = await prisma.webhookEvent.findMany({ where: { paymentId } });
  const callbacks = await prisma.providerCallback.findMany({ where: { paymentId } });
  return { payment, history, events, callbacks };
}

function expectRedirect(res: request.Response, paymentId: string) {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location ?? '');
  expect(loc.origin + loc.pathname).toBe('https://shop.example.com/payment/result');
  expect(loc.searchParams.get('payment_id')).toBe(paymentId);
  expect(loc.searchParams.get('lang')).toBe('vi');
  expect([...loc.searchParams.keys()].some((k) => k.startsWith('vnp_'))).toBe(false);
}

beforeEach(() => {
  stub.reset();
});

afterAll(async () => {
  await deleteClients(prisma, clients);
  await prisma.$disconnect();
});

describe('return: chữ ký không hợp lệ', () => {
  it('chữ ký sai → 400 INVALID_SIGNATURE, không redirect, lưu callback signature_valid=false, không gọi queryDr', async () => {
    const c = await createPayment();
    const res = await callReturn(signedReturnQuery(returnParamsFromCheckout(c.checkoutUrl), 'wrong-secret'));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(stub.calls).toHaveLength(0);

    const cb = await prisma.providerCallback.findMany({
      where: { payload: { path: ['vnp_TxnRef'], equals: c.txnRef } },
    });
    expect(cb).toHaveLength(1);
    expect(cb[0]).toMatchObject({
      signatureValid: false,
      processed: false,
      paymentId: null,
      providerCode: 'vnpay',
    });
    expect(cb[0]?.payload).not.toHaveProperty('vnp_SecureHash');
    expect((await state(c.paymentId)).payment.status).toBe('PENDING');
  });

  it('sửa vnp_Amount trên URL sau khi ký → 400, payment không đổi', async () => {
    const c = await createPayment();
    queryDrReturns('00');
    const qs = new URLSearchParams(signedReturnQuery(returnParamsFromCheckout(c.checkoutUrl)));
    qs.set('vnp_Amount', '100');
    const res = await callReturn(qs.toString());
    expect(res.status).toBe(400);
    expect(stub.calls).toHaveLength(0);
    expect((await state(c.paymentId)).payment.status).toBe('PENDING');
  });

  it.each([
    ['vnp_Amount lặp', (qs: string) => `${qs}&vnp_Amount=1`],
    ['query lồng', (qs: string) => `${qs}&vnp_Extra[a]=1`],
  ])('%s → 400, callback signature_valid=false', async (_n, mutate) => {
    const c = await createPayment();
    queryDrReturns('00');
    const res = await callReturn(mutate(signedReturnQuery(returnParamsFromCheckout(c.checkoutUrl))));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(stub.calls).toHaveLength(0);
    const cb = await prisma.providerCallback.findMany({
      where: { payload: { path: ['vnp_TxnRef'], equals: c.txnRef } },
    });
    expect(cb).toHaveLength(1);
    expect(cb[0]).toMatchObject({ signatureValid: false, processed: false, paymentId: null });
    expect((await state(c.paymentId)).payment.status).toBe('PENDING');
  });

  it('payload callback chỉ giữ key vnp_ (bỏ chữ ký), cắt giá trị 255 ký tự, tối đa 50 key', async () => {
    const c = await createPayment();
    const extra = new URLSearchParams();
    extra.set('utm_source', 'x');
    extra.set('vnp_Long', 'y'.repeat(1000));
    for (let i = 0; i < 60; i++) extra.set(`vnp_Z${String(i).padStart(2, '0')}`, 'z');
    const signed = signedReturnQuery(returnParamsFromCheckout(c.checkoutUrl), 'wrong-secret');
    const qs = `${signed}&${extra.toString()}`;
    expect((await callReturn(qs)).status).toBe(400);
    const [cb] = await prisma.providerCallback.findMany({
      where: { payload: { path: ['vnp_TxnRef'], equals: c.txnRef } },
    });
    const payload = cb?.payload as Record<string, string>;
    expect(Object.keys(payload).length).toBeLessThanOrEqual(50);
    expect(Object.keys(payload).every((k) => k.startsWith('vnp_'))).toBe(true);
    expect(payload).not.toHaveProperty('vnp_SecureHash');
    expect(payload).not.toHaveProperty('utm_source');
    expect(payload.vnp_Long).toHaveLength(255);
  });

  it('chữ ký đúng nhưng vnp_TxnRef không tồn tại → 404', async () => {
    const res = await callReturn(
      signedReturnQuery({ vnp_Amount: '100', vnp_TxnRef: `NOPE${Date.now()}`, vnp_ResponseCode: '00' }),
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('provider không đăng ký → 404', async () => {
    const res = await request(app).get('/api/v1/callbacks/momo/return?x=1').redirects(0);
    expect(res.status).toBe(404);
  });
});

describe('return: hợp lệ + queryDr', () => {
  it('queryDr 00 → 302, SUCCEEDED, paid_at, history, transaction, webhook_event trong DB', async () => {
    const c = await createPayment();
    queryDrReturns('00');
    const res = await validReturn(c);
    expectRedirect(res, c.paymentId);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.vnp_TxnRef).toBe(c.txnRef);

    const s = await state(c.paymentId);
    expect(s.payment.status).toBe('SUCCEEDED');
    expect(s.payment.paidAt).not.toBeNull();
    expect(s.payment.needsReview).toBe(false);
    expect(s.payment.transactions[0]).toMatchObject({
      status: 'SUCCEEDED',
      providerTxnId: expect.stringMatching(/^\d{8}$/) as string,
    });
    expect(s.payment.transactions[0]?.rawResponse).not.toHaveProperty('vnp_SecureHash');
    expect(s.history).toEqual([
      expect.objectContaining({ fromStatus: 'PENDING', toStatus: 'SUCCEEDED', source: 'API' }),
    ]);
    expect(s.events).toHaveLength(1);
    const ev = s.events[0];
    expect(ev).toMatchObject({
      type: 'payment.succeeded',
      status: 'PENDING',
      attempts: 0,
      clientId: c.clientId,
    });
    expect(ev?.id).toMatch(/^evt_/);
    expect(ev?.payload).toMatchObject({
      event_id: ev?.id,
      type: 'payment.succeeded',
      payment: {
        payment_id: c.paymentId,
        amount: AMOUNT,
        currency: 'VND',
        status: 'SUCCEEDED',
        provider: 'vnpay',
        metadata: { subscription_id: 'sub_1' },
      },
    });
    expect(s.callbacks).toEqual([expect.objectContaining({ signatureValid: true, processed: true })]);

    const api = await request(app).get(`/api/v1/payments/${c.paymentId}`).set('X-Client-Id', c.clientId);
    expect(api.body).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('queryDr 02 → FAILED + payment.failed', async () => {
    const c = await createPayment();
    queryDrReturns('02');
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment.status).toBe('FAILED');
    expect(s.payment.paidAt).toBeNull();
    expect(s.history.map((h) => h.toStatus)).toEqual(['FAILED']);
    expect(s.events.map((e) => e.type)).toEqual(['payment.failed']);
  });

  it.each(['01', '05'])('queryDr %s → giữ PENDING, không history/event', async (code) => {
    const c = await createPayment();
    queryDrReturns(code);
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: false });
    expect(s.history).toHaveLength(0);
    expect(s.events).toHaveLength(0);
    // Lưu bằng chứng: raw_response + mã giao dịch, transaction vẫn PENDING; lượt return chưa có kết luận.
    expect(s.payment.transactions[0]).toMatchObject({
      status: 'PENDING',
      providerTxnId: expect.stringMatching(/^\d{8}$/) as string,
      rawResponse: expect.objectContaining({ vnp_TransactionStatus: code }) as object,
    });
    expect(s.callbacks).toEqual([expect.objectContaining({ processed: false })]);
  });

  it('queryDr mã lạ → PENDING + needs_review, lưu raw_response, callback processed', async () => {
    const c = await createPayment();
    queryDrReturns('07');
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: true });
    expect(s.events).toHaveLength(0);
    expect(s.payment.transactions[0]).toMatchObject({
      status: 'PENDING',
      rawResponse: expect.objectContaining({ vnp_TransactionStatus: '07' }) as object,
    });
    expect(s.payment.transactions[0]?.rawResponse).not.toHaveProperty('vnp_SecureHash');
    expect(s.callbacks).toEqual([expect.objectContaining({ processed: true })]);
  });

  it.each([
    ['số tiền', AMOUNT * 100 + 100, {}],
    ['merchant', AMOUNT * 100, { vnp_TmnCode: 'OTHERTMN' }],
  ])('queryDr lệch %s → needs_review, vẫn PENDING, không event', async (_n, amountMinor, overrides) => {
    const c = await createPayment();
    queryDrReturns('00', amountMinor, overrides);
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: true, paidAt: null });
    expect(s.history).toHaveLength(0);
    expect(s.events).toHaveLength(0);
    // raw_response lưu làm bằng chứng; mã giao dịch từ response lệch không ghi vào provider_txn_id.
    expect(s.payment.transactions[0]).toMatchObject({ status: 'PENDING', providerTxnId: null });
    expect(s.payment.transactions[0]?.rawResponse).toMatchObject({ vnp_Amount: String(amountMinor) });
    expect(s.callbacks).toEqual([expect.objectContaining({ processed: true })]);
  });

  it('queryDr trả vnp_TxnRef khác → needs_review, không SUCCEEDED', async () => {
    const c = await createPayment();
    queryDrReturns('00', AMOUNT * 100, { vnp_TxnRef: 'SOMEOTHERREF' });
    expectRedirect(await validReturn(c), c.paymentId);
    expect((await state(c.paymentId)).payment).toMatchObject({ status: 'PENDING', needsReview: true });
  });

  it('gọi return 2 lần → chỉ 1 history, 1 event; lần 2 không gọi queryDr', async () => {
    const c = await createPayment();
    queryDrReturns('00');
    expectRedirect(await validReturn(c), c.paymentId);
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.history).toHaveLength(1);
    expect(s.events).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
    expect(s.callbacks).toHaveLength(2);
  });

  it('2 lượt return song song → vẫn chỉ 1 history, 1 event (lock FOR UPDATE)', async () => {
    const c = await createPayment();
    queryDrReturns('00');
    const [a, b] = await Promise.all([validReturn(c), validReturn(c)]);
    expectRedirect(a, c.paymentId);
    expectRedirect(b, c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment.status).toBe('SUCCEEDED');
    expect(s.history).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it.each([
    [
      'HTTP 500',
      () => {
        stub.respond(() => jsonResponse({}, 500));
      },
    ],
    [
      'timeout',
      () => {
        stub.respond(hangUntilAborted);
      },
    ],
    [
      'lỗi mạng',
      () => {
        stub.respond(() => Promise.reject(new TypeError('fetch failed')));
      },
    ],
    [
      'response ký sai',
      () => {
        stub.respond((req) =>
          jsonResponse(
            signedQueryDrResponse(req, { amountMinor: AMOUNT * 100, status: '00', secret: 'bad' }),
          ),
        );
      },
    ],
    [
      'ResponseCode khác 00',
      () => {
        stub.respond((req) =>
          jsonResponse(
            signedQueryDrResponse(req, { amountMinor: 0, status: '', overrides: { vnp_ResponseCode: '91' } }),
          ),
        );
      },
    ],
  ])('queryDr lỗi (%s) → giữ PENDING, vẫn 302, callback processed=false', async (_n, setup) => {
    const c = await createPayment();
    setup();
    expectRedirect(await validReturn(c), c.paymentId);
    const s = await state(c.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: false });
    expect(s.payment.transactions[0]).toMatchObject({ status: 'PENDING', rawResponse: null });
    expect(s.history).toHaveLength(0);
    expect(s.events).toHaveLength(0);
    expect(s.callbacks).toHaveLength(1);
    expect(s.callbacks[0]).toMatchObject({ signatureValid: true, processed: false });
  });

  it('payment đã ở trạng thái cuối → không gọi queryDr, không đổi, vẫn redirect', async () => {
    const c = await createPayment();
    await prisma.payment.update({ where: { id: c.paymentId }, data: { status: 'FAILED' } });
    queryDrReturns('00');
    expectRedirect(await validReturn(c), c.paymentId);
    expect(stub.calls).toHaveLength(0);
    const s = await state(c.paymentId);
    expect(s.payment.status).toBe('FAILED');
    expect(s.events).toHaveLength(0);
  });

  it('payment đã SUCCEEDED (có paid_at) → 302, không gọi queryDr, không đổi gì', async () => {
    const c = await createPayment();
    const paidAt = new Date('2026-10-22T05:01:00Z');
    await prisma.payment.update({ where: { id: c.paymentId }, data: { status: 'SUCCEEDED', paidAt } });
    const before = await state(c.paymentId);
    queryDrReturns('02');
    expectRedirect(await validReturn(c), c.paymentId);
    expect(stub.calls).toHaveLength(0);
    const after = await state(c.paymentId);
    expect(after.payment).toMatchObject({ status: 'SUCCEEDED', paidAt, needsReview: false });
    expect(after.payment.updatedAt).toEqual(before.payment.updatedAt);
    expect(after.payment.transactions).toEqual(before.payment.transactions);
    expect(after.history).toHaveLength(0);
    expect(after.events).toHaveLength(0);
    expect(after.callbacks).toEqual([expect.objectContaining({ processed: true })]);
  });

  it('order đã có payment khác được thanh toán → payment sau needs_review, không SUCCEEDED (C5)', async () => {
    const orderId = `ORD-${randomUUID()}`;
    const first = await createPayment(orderId);
    const second = await createPayment(orderId, first.clientId);
    queryDrReturns('00');
    expectRedirect(await validReturn(first), first.paymentId);
    expectRedirect(await validReturn(second), second.paymentId);
    expect((await state(first.paymentId)).payment.status).toBe('SUCCEEDED');
    const s = await state(second.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: true, paidAt: null });
    expect(s.events).toHaveLength(0);
    expect(s.history).toHaveLength(0);
    // Q18: không 500; giữ bằng chứng raw_response cho xử lý tay, lượt return có kết luận.
    expect(s.payment.transactions[0]).toMatchObject({ status: 'PENDING', providerTxnId: null });
    expect(s.payment.transactions[0]?.rawResponse).toMatchObject({ vnp_TxnRef: second.txnRef });
    expect(s.callbacks).toEqual([expect.objectContaining({ processed: true })]);
    const api = await request(app)
      .get(`/api/v1/payments/${second.paymentId}`)
      .set('X-Client-Id', second.clientId);
    expect(api.body).toMatchObject({ status: 'PENDING', needs_review: true });
  });

  it('Q18: 2 payment cùng order, 2 lượt return song song → đúng 1 SUCCEEDED, 1 PENDING needs_review, 1 event', async () => {
    const orderId = `ORD-${randomUUID()}`;
    const first = await createPayment(orderId);
    const second = await createPayment(orderId, first.clientId);
    queryDrReturns('00');
    const [a, b] = await Promise.all([validReturn(first), validReturn(second)]);
    expectRedirect(a, first.paymentId);
    expectRedirect(b, second.paymentId);

    const payments = await prisma.payment.findMany({ where: { clientId: first.clientId, orderId } });
    expect(payments.filter((p) => p.status === 'SUCCEEDED' && p.paidAt !== null)).toHaveLength(1);
    const loser = payments.filter((p) => p.status === 'PENDING');
    expect(loser).toHaveLength(1);
    expect(loser[0]).toMatchObject({ needsReview: true, paidAt: null });
    const events = await prisma.webhookEvent.findMany({
      where: { paymentId: { in: payments.map((p) => p.id) } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment.succeeded');
  });

  it('Q17: payment đã needs_review → return không gọi queryDr, không đổi gì, callback processed', async () => {
    const c = await createPayment();
    await prisma.payment.update({ where: { id: c.paymentId }, data: { needsReview: true } });
    queryDrReturns('00');
    expectRedirect(await validReturn(c), c.paymentId);
    expect(stub.calls).toHaveLength(0);
    const s = await state(c.paymentId);
    expect(s.payment).toMatchObject({ status: 'PENDING', needsReview: true, paidAt: null });
    expect(s.history).toHaveLength(0);
    expect(s.events).toHaveLength(0);
    expect(s.callbacks).toEqual([expect.objectContaining({ processed: true })]);
  });
});
