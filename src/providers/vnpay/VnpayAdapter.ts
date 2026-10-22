// Adapter VNPay (chỉ sandbox; VNP_HOST đã bị config giới hạn).
// - buildPaymentUrl: dùng VNPay.buildPaymentUrl của thư viện `vnpay` (ký URL, không gọi mạng).
// - verifyReturnUrl: dùng hàm chuẩn hóa + hash của thư viện (buildPaymentUrlSearchParams, hash), nhưng so chữ ký
//   bằng timingSafeEqual: VNPay.verifyReturnUrl của thư viện so bằng `===` (trái quy tắc CLAUDE.md).
// - queryDr: tự gọi API bằng HTTP transport được inject (thư viện gọi thẳng fetch toàn cục nên không test được
//   bằng stub), ký request/verify response bằng hàm `hash` của thư viện. Khác thư viện: response THIẾU chữ ký
//   bị coi là sai chữ ký (thư viện coi là hợp lệ).
import { randomBytes } from 'node:crypto';
import {
  HashAlgorithm,
  ProductCode,
  QUERY_DR_REFUND_ENDPOINT,
  VNPay,
  VNP_VERSION,
  VnpLocale,
  buildPaymentUrlSearchParams,
  hash,
  ignoreLogger,
  resolveUrlString,
} from 'vnpay';
import { safeEqual } from '../../lib/crypto.js';
import type {
  CheckoutInput,
  CheckoutResult,
  HttpTransport,
  IPaymentProvider,
  ProviderCapabilities,
  ProviderTxnStatus,
  QueryInput,
  QueryResult,
  ReturnVerification,
} from '../IPaymentProvider.js';

export interface VnpayAdapterOptions {
  tmnCode: string;
  hashSecret: string;
  /** Host sandbox, đã kiểm tra trong config. */
  host: string;
  /** PUBLIC_BASE_URL + /api/v1/callbacks/vnpay/return */
  returnUrl: string;
  /** PROVIDER_TIMEOUT_MS */
  timeoutMs: number;
  transport: HttpTransport;
  clock?: () => Date;
}

const ALGORITHM = HashAlgorithm.SHA512;
// IP máy chủ PGS gửi kèm queryDr (VNPay bắt buộc trường này). URL thanh toán dùng payerIp từ client (Q20).
const SERVER_IP = '127.0.0.1';
const DIGITS = /^[0-9]+$/;
const HEX = /^[0-9a-fA-F]+$/;
const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000;

// Thứ tự trường ký response queryDr theo tài liệu API querydr của VNPay.
const QUERYDR_RESPONSE_SIGNED_FIELDS = [
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

/** Định dạng yyyyMMddHHmmss theo giờ GMT+7, không phụ thuộc múi giờ của máy chạy. */
export function formatVnpayDate(d: Date): string {
  const t = new Date(d.getTime() + GMT7_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`
  );
}

/** vnp_OrderInfo: tiếng Việt không dấu, không ký tự đặc biệt (yêu cầu của VNPay). */
export function toVnpayOrderInfo(description: string, providerRef: string): string {
  const ascii = description
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
    .trim();
  return ascii || `Thanh toan ${providerRef}`;
}

/** Map vnp_TransactionStatus của queryDr (C11, user chốt 2026-10-22). */
export function mapVnpayTransactionStatus(code: string): ProviderTxnStatus {
  switch (code) {
    case '00':
      return 'SUCCEEDED';
    case '01': // giao dịch chưa hoàn tất
    case '05': // VNPay đang xử lý
      return 'PENDING';
    case '02': // giao dịch bị lỗi
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export class VnpayAdapter implements IPaymentProvider {
  readonly code: string = 'vnpay';
  readonly capabilities: ProviderCapabilities = { currencies: ['VND'], refund: true, partialRefund: true };

  private readonly vnpay: VNPay;
  private readonly clock: () => Date;
  private readonly queryUrl: string;

  constructor(private readonly opts: VnpayAdapterOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.vnpay = new VNPay({
      vnpayHost: opts.host,
      queryDrAndRefundHost: opts.host,
      tmnCode: opts.tmnCode,
      secureSecret: opts.hashSecret,
      hashAlgorithm: ALGORITHM,
      vnp_Locale: VnpLocale.VN,
      enableLog: false,
      loggerFn: ignoreLogger,
    });
    this.queryUrl = resolveUrlString(opts.host, QUERY_DR_REFUND_ENDPOINT);
  }

  buildPaymentUrl(input: CheckoutInput): CheckoutResult {
    if (input.currency !== 'VND') throw new Error('VNPay chỉ hỗ trợ VND');
    // Thư viện tự nhân 100 (vnp_Amount = amount × 100); amount ≤ 2^31-1 nên kết quả < 2^53, an toàn.
    const url = this.vnpay.buildPaymentUrl({
      vnp_Amount: input.amount,
      vnp_TxnRef: input.providerRef,
      vnp_OrderInfo: toVnpayOrderInfo(input.description, input.providerRef),
      vnp_OrderType: ProductCode.Other,
      vnp_IpAddr: input.payerIp,
      vnp_ReturnUrl: this.opts.returnUrl,
      vnp_Locale: VnpLocale.VN,
      vnp_CreateDate: Number(formatVnpayDate(input.createdAt)),
      vnp_ExpireDate: Number(formatVnpayDate(input.expiresAt)),
    });
    const rawRequest: Record<string, string> = {};
    for (const [k, v] of new URL(url).searchParams) {
      if (k !== 'vnp_SecureHash') rawRequest[k] = v;
    }
    return { checkoutUrl: url, rawRequest };
  }

  verifyReturnUrl(query: Record<string, unknown>): ReturnVerification {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      // Tham số lặp (mảng) hoặc lồng nhau: không phải dữ liệu VNPay gửi.
      if (typeof v !== 'string') return { valid: false };
      params[k] = v;
    }
    const received = params.vnp_SecureHash;
    const signed = { ...params };
    delete signed.vnp_SecureHash;
    delete signed.vnp_SecureHashType;
    if (!received || !HEX.test(received)) return { valid: false };
    if (!signed.vnp_TxnRef || !DIGITS.test(signed.vnp_Amount ?? '')) return { valid: false };

    // Cùng cách chuẩn hóa với VNPay.verifyReturnUrl của thư viện: sort key, bỏ giá trị rỗng, URL-encode.
    const data = buildPaymentUrlSearchParams(signed).toString();
    const expected = hash(this.opts.hashSecret, data, ALGORITHM);
    if (!safeEqual(expected, received.toLowerCase())) return { valid: false };
    return { valid: true, providerRef: signed.vnp_TxnRef, payload: signed };
  }

  async queryDr(input: QueryInput): Promise<QueryResult> {
    const now = this.clock();
    const req = {
      vnp_RequestId: randomBytes(16).toString('hex'),
      vnp_Version: VNP_VERSION,
      vnp_Command: 'querydr',
      vnp_TmnCode: this.opts.tmnCode,
      vnp_TxnRef: input.providerRef,
      vnp_OrderInfo: `Truy van ${input.providerRef}`,
      vnp_TransactionDate: formatVnpayDate(input.createdAt),
      vnp_CreateDate: formatVnpayDate(now),
      vnp_IpAddr: SERVER_IP,
    };
    const signData = [
      req.vnp_RequestId,
      req.vnp_Version,
      req.vnp_Command,
      req.vnp_TmnCode,
      req.vnp_TxnRef,
      req.vnp_TransactionDate,
      req.vnp_CreateDate,
      req.vnp_IpAddr,
      req.vnp_OrderInfo,
    ].join('|');
    const body = JSON.stringify({ ...req, vnp_SecureHash: hash(this.opts.hashSecret, signData, ALGORITHM) });

    let data: unknown;
    try {
      const res = await this.opts.transport(this.queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: 'HTTP_ERROR' };
      try {
        data = await res.json();
      } catch (err) {
        return { ok: false, reason: isTimeoutError(err) ? 'TIMEOUT' : 'INVALID_RESPONSE' };
      }
    } catch (err) {
      return { ok: false, reason: isTimeoutError(err) ? 'TIMEOUT' : 'NETWORK' };
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ok: false, reason: 'INVALID_RESPONSE' };
    }

    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      const s = asString(v);
      if (s !== undefined) fields[k] = s;
    }
    const { vnp_SecureHash: received, ...raw } = fields;
    if (!received || !HEX.test(received)) return { ok: false, reason: 'INVALID_SIGNATURE' };
    const responseSignData = QUERYDR_RESPONSE_SIGNED_FIELDS.map((f) => fields[f] ?? '').join('|');
    const expected = hash(this.opts.hashSecret, responseSignData, ALGORITHM);
    if (!safeEqual(expected, received.toLowerCase())) return { ok: false, reason: 'INVALID_SIGNATURE' };

    if (fields.vnp_ResponseCode !== '00') return { ok: false, reason: 'PROVIDER_REJECTED' };

    const statusCode = fields.vnp_TransactionStatus ?? '';
    const amountStr = fields.vnp_Amount ?? '';
    const amountMinor = DIGITS.test(amountStr) ? Number(amountStr) : NaN;
    const amount = Number.isSafeInteger(amountMinor) && amountMinor % 100 === 0 ? amountMinor / 100 : null;
    const txnNo = fields.vnp_TransactionNo;

    return {
      ok: true,
      status: mapVnpayTransactionStatus(statusCode),
      providerStatusCode: statusCode,
      amount,
      providerRef: fields.vnp_TxnRef ?? '',
      merchantMatches: fields.vnp_TmnCode === this.opts.tmnCode,
      // VNPay trả "0" khi chưa có giao dịch: không coi là mã giao dịch.
      providerTxnId: txnNo && txnNo !== '0' ? txnNo : null,
      raw,
    };
  }

  refund(): Promise<never> {
    return Promise.reject(new Error('VNPay refund chưa được hỗ trợ ở bước này'));
  }
}
