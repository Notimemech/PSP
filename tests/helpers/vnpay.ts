// Helper VNPay cho test: ký/verify bằng node:crypto, ĐỘC LẬP với code adapter (không dùng lại hàm của src/),
// để test bắt được lỗi ký sai trong adapter. Stub chỉ thay HTTP transport; response queryDr được ký thật.
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { HttpTransport } from '../../src/providers/IPaymentProvider.js';
import { TEST_ENV } from './test-env.js';

export const TEST_HASH_SECRET = TEST_ENV.VNP_HASH_SECRET ?? '';
export const TEST_TMN_CODE = TEST_ENV.VNP_TMN_CODE ?? '';
export const QUERYDR_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
export const RETURN_PATH = '/api/v1/callbacks/vnpay/return';

const hmac512 = (data: string, secret = TEST_HASH_SECRET) =>
  createHmac('sha512', secret).update(data, 'utf8').digest('hex');

/** Chuỗi ký kiểu URL thanh toán/return của VNPay: sort key, bỏ giá trị rỗng, URL-encode (space = "+"). */
function canonicalQuery(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v !== undefined && v !== '') usp.append(k, v);
  }
  return usp.toString();
}

/** Kiểm tra chữ ký của checkout_url do PGS tạo. */
export function checkoutUrlSignatureValid(checkoutUrl: string): boolean {
  const url = new URL(checkoutUrl);
  const params = Object.fromEntries(url.searchParams);
  const { vnp_SecureHash: sig, ...rest } = params;
  return sig === hmac512(canonicalQuery(rest));
}

/** Ký tham số return như VNPay redirect về; trả query string. */
export function signedReturnQuery(params: Record<string, string>, secret = TEST_HASH_SECRET): string {
  const canonical = canonicalQuery(params);
  const usp = new URLSearchParams(canonical);
  usp.append('vnp_SecureHash', hmac512(canonical, secret));
  return usp.toString();
}

/** Tham số return hợp lệ dựng từ checkout_url (giả lập payer thanh toán thành công trên VNPay). */
export function returnParamsFromCheckout(
  checkoutUrl: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const p = new URL(checkoutUrl).searchParams;
  return {
    vnp_Amount: p.get('vnp_Amount') ?? '',
    vnp_BankCode: 'NCB',
    vnp_BankTranNo: 'VNP14123456',
    vnp_CardType: 'ATM',
    vnp_OrderInfo: p.get('vnp_OrderInfo') ?? '',
    vnp_PayDate: '20261022120000',
    vnp_ResponseCode: '00',
    vnp_TmnCode: p.get('vnp_TmnCode') ?? '',
    vnp_TransactionNo: '14123456',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: p.get('vnp_TxnRef') ?? '',
    ...overrides,
  };
}

const REQUEST_SIGNED = [
  'vnp_RequestId',
  'vnp_Version',
  'vnp_Command',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_TransactionDate',
  'vnp_CreateDate',
  'vnp_IpAddr',
  'vnp_OrderInfo',
] as const;

const RESPONSE_SIGNED = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
  'vnp_PromotionCode',
  'vnp_PromotionAmount',
] as const;

export type QueryDrRequest = Record<string, string>;

export function queryDrRequestSignatureValid(req: QueryDrRequest): boolean {
  return req.vnp_SecureHash === hmac512(REQUEST_SIGNED.map((f) => req[f] ?? '').join('|'));
}

/** Body response queryDr đã ký thật. `amountMinor` = amount × 100 (đơn vị VNPay). */
export function signedQueryDrResponse(
  req: QueryDrRequest,
  opts: { amountMinor: number; status: string; overrides?: Record<string, string>; secret?: string },
): Record<string, string> {
  const fields: Record<string, string> = {
    vnp_ResponseId: randomBytes(8).toString('hex'),
    vnp_Command: 'querydr',
    vnp_ResponseCode: '00',
    vnp_Message: 'QueryDR Success',
    vnp_TmnCode: TEST_TMN_CODE,
    vnp_TxnRef: req.vnp_TxnRef ?? '',
    vnp_Amount: String(opts.amountMinor),
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20261022120000',
    // Ngẫu nhiên: transactions có unique (provider_code, provider_txn_id) trên DB test dùng chung.
    vnp_TransactionNo: String(10_000_000 + randomInt(89_999_999)),
    vnp_TransactionType: '01',
    vnp_TransactionStatus: opts.status,
    vnp_OrderInfo: req.vnp_OrderInfo ?? '',
    vnp_PromotionCode: '',
    vnp_PromotionAmount: '',
    ...opts.overrides,
  };
  const sig = hmac512(RESPONSE_SIGNED.map((f) => fields[f] ?? '').join('|'), opts.secret);
  return { ...fields, vnp_SecureHash: sig };
}

type Responder = (req: QueryDrRequest, init: RequestInit) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Responder treo cho tới khi adapter hủy request (timeout). */
export const hangUntilAborted: Responder = (_req, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });

/** Stub HTTP transport ra VNPay. Mặc định trả 500 (giả lập VNPay lỗi). */
export function createVnpayStub() {
  let responder: Responder = () => jsonResponse({}, 500);
  const calls: QueryDrRequest[] = [];
  const transport: HttpTransport = async (url, init) => {
    if (url !== QUERYDR_URL) throw new Error(`stub: URL không mong đợi ${url}`);
    if (typeof init.body !== 'string') throw new Error('stub: body phải là chuỗi JSON');
    const body = JSON.parse(init.body) as QueryDrRequest;
    calls.push(body);
    return responder(body, init);
  };
  return {
    transport,
    calls,
    respond(fn: Responder) {
      responder = fn;
    },
    reset() {
      calls.length = 0;
      responder = () => jsonResponse({}, 500);
    },
  };
}

export type VnpayStub = ReturnType<typeof createVnpayStub>;
