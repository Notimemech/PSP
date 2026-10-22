// Giá trị giả cố định cho test (không đọc .env). Chỉ DATABASE_URL_TEST được lấy từ shell.
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgresql://pgs:change_me@localhost:5433/pgs_test';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: TEST_DATABASE_URL,
  VNP_TMN_CODE: 'TESTTMN1',
  VNP_HASH_SECRET: 'test_hash_secret_not_real',
  VNP_HOST: 'https://sandbox.vnpayment.vn',
  // 32 byte 0x01, base64.
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ADMIN_API_KEY: 'test-admin-key-0123456789abcdef0123',
};
