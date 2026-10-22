// Interface chung cho mọi cổng thanh toán (FR-PV-03, NFR-EXT-01). Payment Core chỉ thấy các kiểu chuẩn hóa
// dưới đây, không thấy kiểu của thư viện riêng từng provider.

/** Hàm gửi HTTP ra provider; production là globalThis.fetch, test là stub trả response đã ký thật. */
export type HttpTransport = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderCapabilities {
  currencies: readonly string[];
  refund: boolean;
  partialRefund: boolean;
}

export interface CheckoutInput {
  /** Mã PGS gửi provider (VNPay: vnp_TxnRef). */
  providerRef: string;
  amount: number;
  currency: string;
  description: string;
  /** IP của payer (VNPay: vnp_IpAddr); client gửi `payer_ip`, mặc định 127.0.0.1 (Q20). */
  payerIp: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CheckoutResult {
  checkoutUrl: string;
  /** Tham số đã gửi provider, KHÔNG gồm chữ ký: lưu vào transactions.raw_request. */
  rawRequest: Record<string, string>;
}

export type ReturnVerification =
  | { valid: false }
  | {
      valid: true;
      providerRef: string;
      /** Tham số return đã verify, không gồm chữ ký. */
      payload: Record<string, string>;
    };

export interface QueryInput {
  providerRef: string;
  /** Thời điểm tạo payment (VNPay: vnp_TransactionDate = vnp_CreateDate lúc tạo URL). */
  createdAt: Date;
}

/**
 * Trạng thái giao dịch provider báo về, đã chuẩn hóa (C11):
 * SUCCEEDED/FAILED là kết quả xác định; PENDING là chưa có kết quả; UNKNOWN là mã không nhận ra.
 */
export type ProviderTxnStatus = 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'UNKNOWN';

export type QueryFailureReason =
  'TIMEOUT' | 'NETWORK' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'INVALID_SIGNATURE' | 'PROVIDER_REJECTED';

export type QueryResult =
  | {
      ok: true;
      status: ProviderTxnStatus;
      /** Mã trạng thái gốc của provider (VNPay: vnp_TransactionStatus), để log/tra cứu. */
      providerStatusCode: string;
      /** Số tiền provider báo, theo đơn vị PGS (VND: đồng); null nếu không quy đổi được. */
      amount: number | null;
      providerRef: string;
      /** Merchant trong response đúng merchant của PGS. */
      merchantMatches: boolean;
      /** Mã giao dịch phía provider; null nếu provider chưa cấp. */
      providerTxnId: string | null;
      /** Response đã verify, không gồm chữ ký: lưu vào transactions.raw_response. */
      raw: Record<string, string>;
    }
  | { ok: false; reason: QueryFailureReason };

export interface IPaymentProvider {
  readonly code: string;
  readonly capabilities: ProviderCapabilities;
  /** Tạo URL thanh toán; không gọi mạng. */
  buildPaymentUrl(input: CheckoutInput): CheckoutResult;
  /** Verify chữ ký tham số return. Không bao giờ ném lỗi với input xấu: trả { valid: false }. */
  verifyReturnUrl(query: Record<string, unknown>): ReturnVerification;
  /** Hỏi provider kết quả thật. Không ném lỗi: lỗi mạng/timeout/chữ ký sai trả { ok: false }. */
  queryDr(input: QueryInput): Promise<QueryResult>;
  refund(): Promise<never>;
}
