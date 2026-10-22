// VnpayAdapter: thư viện vnpay chạy thật, chỉ stub HTTP transport; response queryDr được ký thật.
import { VNPay, HashAlgorithm, ignoreLogger } from 'vnpay';
import { describe, expect, it } from 'vitest';
import {
  VnpayAdapter,
  formatVnpayDate,
  mapVnpayTransactionStatus,
  toVnpayOrderInfo,
} from '../../src/providers/vnpay/VnpayAdapter.js';
import {
  TEST_HASH_SECRET,
  TEST_TMN_CODE,
  checkoutUrlSignatureValid,
  createVnpayStub,
  hangUntilAborted,
  jsonResponse,
  queryDrRequestSignatureValid,
  returnParamsFromCheckout,
  signedQueryDrResponse,
  signedReturnQuery,
} from '../helpers/vnpay.js';

const HOST = 'https://sandbox.vnpayment.vn';
const RETURN_URL = 'http://localhost:3000/api/v1/callbacks/vnpay/return';
const CREATED = new Date('2026-10-22T05:00:00Z'); // 12:00:00 GMT+7
const EXPIRES = new Date('2026-10-22T05:15:00Z');

function makeAdapter(timeoutMs = 1000) {
  const stub = createVnpayStub();
  const adapter = new VnpayAdapter({
    tmnCode: TEST_TMN_CODE,
    hashSecret: TEST_HASH_SECRET,
    host: HOST,
    returnUrl: RETURN_URL,
    timeoutMs,
    transport: stub.transport,
    clock: () => new Date('2026-10-22T05:05:00Z'),
  });
  return { adapter, stub };
}

function checkout(adapter: VnpayAdapter, amount = 150_000) {
  return adapter.buildPaymentUrl({
    providerRef: 'REF123',
    amount,
    currency: 'VND',
    description: 'Thanh toán đơn hàng #123 – Đặc biệt',
    payerIp: '203.0.113.7',
    createdAt: CREATED,
    expiresAt: EXPIRES,
  });
}

const parse = (qs: string) => Object.fromEntries(new URLSearchParams(qs));

describe('mapVnpayTransactionStatus (C11)', () => {
  it.each([
    ['00', 'SUCCEEDED'],
    ['01', 'PENDING'],
    ['05', 'PENDING'],
    ['02', 'FAILED'],
    ['04', 'UNKNOWN'],
    ['07', 'UNKNOWN'],
    ['09', 'UNKNOWN'],
    ['', 'UNKNOWN'],
  ])('%s → %s', (code, expected) => {
    expect(mapVnpayTransactionStatus(code)).toBe(expected);
  });
});

describe('helper định dạng', () => {
  it('formatVnpayDate theo GMT+7, không phụ thuộc múi giờ máy', () => {
    expect(formatVnpayDate(new Date('2026-10-21T17:30:05Z'))).toBe('20261022003005');
  });

  it('toVnpayOrderInfo bỏ dấu và ký tự đặc biệt; rỗng thì dùng mặc định', () => {
    expect(toVnpayOrderInfo('Thanh toán đơn #123 – Đặc biệt', 'R1')).toBe('Thanh toan don 123 Dac biet');
    expect(toVnpayOrderInfo('###', 'R1')).toBe('Thanh toan R1');
  });
});

describe('buildPaymentUrl', () => {
  it('URL sandbox, đủ tham số, chữ ký hợp lệ; rawRequest không chứa chữ ký', () => {
    const { adapter } = makeAdapter();
    const { checkoutUrl, rawRequest } = checkout(adapter);
    const url = new URL(checkoutUrl);
    expect(url.origin + url.pathname).toBe('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
    const p = url.searchParams;
    expect(p.get('vnp_Amount')).toBe('15000000');
    expect(p.get('vnp_TxnRef')).toBe('REF123');
    expect(p.get('vnp_TmnCode')).toBe(TEST_TMN_CODE);
    expect(p.get('vnp_ReturnUrl')).toBe(RETURN_URL);
    expect(p.get('vnp_CreateDate')).toBe('20261022120000');
    expect(p.get('vnp_ExpireDate')).toBe('20261022121500');
    expect(p.get('vnp_CurrCode')).toBe('VND');
    expect(p.get('vnp_Command')).toBe('pay');
    expect(p.get('vnp_IpAddr')).toBe('203.0.113.7');
    expect(p.get('vnp_OrderInfo')).toBe('Thanh toan don hang 123 Dac biet');
    expect(checkoutUrlSignatureValid(checkoutUrl)).toBe(true);
    expect(rawRequest).not.toHaveProperty('vnp_SecureHash');
    expect(rawRequest.vnp_TxnRef).toBe('REF123');
  });
});

describe('verifyReturnUrl', () => {
  const { adapter } = makeAdapter();
  const { checkoutUrl } = checkout(adapter);
  const params = returnParamsFromCheckout(checkoutUrl);

  it('chữ ký đúng → valid, payload không chứa chữ ký', () => {
    const r = adapter.verifyReturnUrl(parse(signedReturnQuery(params)));
    expect(r).toEqual({ valid: true, providerRef: 'REF123', payload: params });
  });

  it('khớp kết quả của VNPay.verifyReturnUrl trong thư viện (cùng cách chuẩn hóa)', () => {
    const lib = new VNPay({
      tmnCode: TEST_TMN_CODE,
      secureSecret: TEST_HASH_SECRET,
      hashAlgorithm: HashAlgorithm.SHA512,
      loggerFn: ignoreLogger,
    });
    const good = parse(signedReturnQuery(params));
    const bad = { ...good, vnp_Amount: '100' };
    expect(lib.verifyReturnUrl(good as never).isVerified).toBe(true);
    expect(adapter.verifyReturnUrl(good).valid).toBe(true);
    expect(lib.verifyReturnUrl(bad as never).isVerified).toBe(false);
    expect(adapter.verifyReturnUrl(bad).valid).toBe(false);
  });

  it.each([
    ['sửa vnp_Amount', { vnp_Amount: '100' }],
    ['sửa vnp_TxnRef', { vnp_TxnRef: 'OTHER' }],
    ['sửa vnp_ResponseCode', { vnp_ResponseCode: '24' }],
  ])('%s sau khi ký → invalid', (_name, patch) => {
    const q = { ...parse(signedReturnQuery(params)), ...patch };
    expect(adapter.verifyReturnUrl(q).valid).toBe(false);
  });

  it('ký bằng secret khác / thiếu chữ ký / tham số lặp → invalid', () => {
    expect(adapter.verifyReturnUrl(parse(signedReturnQuery(params, 'wrong-secret'))).valid).toBe(false);
    expect(adapter.verifyReturnUrl(params).valid).toBe(false);
    const signed = parse(signedReturnQuery(params));
    expect(adapter.verifyReturnUrl({ ...signed, vnp_Amount: [signed.vnp_Amount, '1'] }).valid).toBe(false);
  });
});

describe('queryDr', () => {
  const input = { providerRef: 'REF123', createdAt: CREATED };

  it('request ký đúng; response ký thật → kết quả chuẩn hóa', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) =>
      jsonResponse(signedQueryDrResponse(req, { amountMinor: 15_000_000, status: '00' })),
    );
    const r = await adapter.queryDr(input);
    const req = stub.calls[0];
    expect(req && queryDrRequestSignatureValid(req)).toBe(true);
    expect(req?.vnp_TransactionDate).toBe('20261022120000');
    expect(req?.vnp_Command).toBe('querydr');
    expect(r).toMatchObject({
      ok: true,
      status: 'SUCCEEDED',
      amount: 150_000,
      providerRef: 'REF123',
      merchantMatches: true,
      providerTxnId: expect.stringMatching(/^\d{8}$/) as string,
    });
    expect(r.ok && r.raw).not.toHaveProperty('vnp_SecureHash');
  });

  it('response ký sai secret → INVALID_SIGNATURE', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) =>
      jsonResponse(signedQueryDrResponse(req, { amountMinor: 15_000_000, status: '00', secret: 'nope' })),
    );
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('response bị sửa sau khi ký → INVALID_SIGNATURE', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) => {
      const body = signedQueryDrResponse(req, { amountMinor: 15_000_000, status: '02' });
      return jsonResponse({ ...body, vnp_TransactionStatus: '00' });
    });
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('response thiếu chữ ký → INVALID_SIGNATURE (thư viện coi là hợp lệ, adapter thì không)', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) => {
      const body: Record<string, string> = signedQueryDrResponse(req, { amountMinor: 1, status: '00' });
      delete body.vnp_SecureHash;
      return jsonResponse(body);
    });
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('vnp_ResponseCode khác 00 → PROVIDER_REJECTED', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) =>
      jsonResponse(
        signedQueryDrResponse(req, { amountMinor: 0, status: '', overrides: { vnp_ResponseCode: '91' } }),
      ),
    );
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'PROVIDER_REJECTED' });
  });

  it('merchant khác và số tiền lẻ được báo ra để service đánh dấu', async () => {
    const { adapter, stub } = makeAdapter();
    stub.respond((req) =>
      jsonResponse(
        signedQueryDrResponse(req, {
          amountMinor: 1_234_567,
          status: '00',
          overrides: { vnp_TmnCode: 'OTHER' },
        }),
      ),
    );
    expect(await adapter.queryDr(input)).toMatchObject({ ok: true, merchantMatches: false, amount: null });
  });

  it('HTTP 500 / lỗi mạng / JSON hỏng / timeout', async () => {
    const { adapter, stub } = makeAdapter(50);
    stub.respond(() => jsonResponse({}, 500));
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'HTTP_ERROR' });
    stub.respond(() => Promise.reject(new TypeError('fetch failed')));
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'NETWORK' });
    stub.respond(() => new Response('not json', { status: 200 }));
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'INVALID_RESPONSE' });
    stub.respond(hangUntilAborted);
    expect(await adapter.queryDr(input)).toEqual({ ok: false, reason: 'TIMEOUT' });
  });
});
