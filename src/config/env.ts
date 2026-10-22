// Đọc và kiểm tra biến môi trường một lần khi khởi động (fail-fast). Phần còn lại của app chỉ nhận
// object Config đã kiểm tra, không đọc process.env trực tiếp.
import { z } from 'zod';

// MVP chỉ chạy VNPay sandbox; host production bị từ chối ngay từ cấu hình.
const VNPAY_SANDBOX_HOST = 'sandbox.vnpayment.vn';

const intFromEnv = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const delaysFromEnv = z
  .string()
  .default('0,60,300,900,3600,10800,21600,43200')
  .transform((s) => s.split(',').map((part) => Number(part.trim())))
  .pipe(z.array(z.number().int().nonnegative()).min(1));

const encryptionKey = z
  .string()
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'phải là 32 byte mã hóa base64');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PUBLIC_BASE_URL: z.url(),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'phải là URL PostgreSQL'),

  VNP_TMN_CODE: z.string().min(1),
  VNP_HASH_SECRET: z.string().min(1),
  VNP_HOST: z
    .url()
    .refine((s) => new URL(s).hostname === VNPAY_SANDBOX_HOST, `chỉ chấp nhận ${VNPAY_SANDBOX_HOST}`),

  ENCRYPTION_KEY: encryptionKey,
  ADMIN_API_KEY: z.string().min(32),

  PAYMENT_TTL_SECONDS: intFromEnv(900),
  QUERYDR_PENDING_AFTER_MINUTES: intFromEnv(5),
  QUERYDR_INTERVAL_SECONDS: intFromEnv(60),
  WEBHOOK_TIMEOUT_MS: intFromEnv(10_000),
  WEBHOOK_RETRY_DELAYS: delaysFromEnv,
  HMAC_MAX_SKEW_SECONDS: intFromEnv(300),
  IDEMPOTENCY_TTL_HOURS: intFromEnv(24),
  RATE_LIMIT_PER_SECOND: intFromEnv(100),
  PROVIDER_TIMEOUT_MS: intFromEnv(30_000),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  publicBaseUrl: string;
  databaseUrl: string;
  vnpay: { tmnCode: string; hashSecret: string; host: string };
  security: {
    encryptionKey: Buffer;
    adminApiKey: string;
    hmacMaxSkewSeconds: number;
    rateLimitPerSecond: number;
  };
  payment: { ttlSeconds: number; queryDrPendingAfterMinutes: number; queryDrIntervalSeconds: number };
  webhook: { timeoutMs: number; retryDelaysSeconds: number[] };
  idempotencyTtlHours: number;
  providerTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Cấu hình không hợp lệ:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Kiểm tra env và trả Config có cấu trúc. Sai thì ném ConfigError chỉ nêu tên biến và lý do,
 * không bao giờ in giá trị (có thể là secret).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    databaseUrl: e.DATABASE_URL,
    vnpay: { tmnCode: e.VNP_TMN_CODE, hashSecret: e.VNP_HASH_SECRET, host: e.VNP_HOST },
    security: {
      encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
      adminApiKey: e.ADMIN_API_KEY,
      hmacMaxSkewSeconds: e.HMAC_MAX_SKEW_SECONDS,
      rateLimitPerSecond: e.RATE_LIMIT_PER_SECOND,
    },
    payment: {
      ttlSeconds: e.PAYMENT_TTL_SECONDS,
      queryDrPendingAfterMinutes: e.QUERYDR_PENDING_AFTER_MINUTES,
      queryDrIntervalSeconds: e.QUERYDR_INTERVAL_SECONDS,
    },
    webhook: { timeoutMs: e.WEBHOOK_TIMEOUT_MS, retryDelaysSeconds: e.WEBHOOK_RETRY_DELAYS },
    idempotencyTtlHours: e.IDEMPOTENCY_TTL_HOURS,
    providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
  };
}
