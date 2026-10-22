import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { TEST_ENV } from '../helpers/test-env.js';

const withEnv = (patch: Record<string, string | undefined>) => ({ ...TEST_ENV, ...patch });

describe('loadConfig', () => {
  it('đọc env hợp lệ và áp giá trị mặc định SRS mục 7', () => {
    const c = loadConfig(TEST_ENV);
    expect(c.port).toBe(3000);
    expect(c.payment.ttlSeconds).toBe(900);
    expect(c.webhook.retryDelaysSeconds).toEqual([0, 60, 300, 900, 3600, 10800, 21600, 43200]);
    expect(c.security.hmacMaxSkewSeconds).toBe(300);
    expect(c.security.encryptionKey).toHaveLength(32);
  });

  it.each([
    ['thiếu ADMIN_API_KEY', { ADMIN_API_KEY: undefined }, 'ADMIN_API_KEY'],
    ['ADMIN_API_KEY ngắn hơn 32 ký tự', { ADMIN_API_KEY: 'a'.repeat(31) }, 'ADMIN_API_KEY'],
    [
      'ENCRYPTION_KEY không đủ 32 byte',
      { ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') },
      'ENCRYPTION_KEY',
    ],
    ['VNP_HOST không phải sandbox', { VNP_HOST: 'https://pay.example.com' }, 'VNP_HOST'],
    ['WEBHOOK_RETRY_DELAYS sai định dạng', { WEBHOOK_RETRY_DELAYS: '0,abc' }, 'WEBHOOK_RETRY_DELAYS'],
  ])('fail-fast khi %s', (_name, patch, field) => {
    expect(() => loadConfig(withEnv(patch))).toThrow(ConfigError);
    expect(() => loadConfig(withEnv(patch))).toThrow(field);
  });

  it('thông báo lỗi không chứa giá trị secret', () => {
    const secret = 'short-secret-value';
    try {
      loadConfig(withEnv({ ADMIN_API_KEY: secret }));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
