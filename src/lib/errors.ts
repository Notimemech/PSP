// Lỗi nghiệp vụ có kiểu. Service ném AppError; chỉ middleware error-handler ghi response lỗi.

// Mã lỗi SRS 4.4 + các mã bổ sung còn chờ user chốt (C3, docs/architecture.md#10-câu-hỏi-mở).
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  PROVIDER_NOT_ALLOWED: 'PROVIDER_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVALID_STATE: 'INVALID_STATE',
  REFUND_EXCEEDS_AMOUNT: 'REFUND_EXCEEDS_AMOUNT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  // Bổ sung, chờ chốt C3:
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_SIGNATURE: 401,
  PROVIDER_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE: 409,
  REFUND_EXCEEDS_AMOUNT: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = HTTP_STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}
