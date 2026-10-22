import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { VNPAY_RETURN_PATH, buildProviderRegistry, buildReturnUrl } from '../../src/providers/index.js';
import { UnknownProviderError } from '../../src/providers/registry.js';
import { TEST_ENV } from '../helpers/test-env.js';
import { createVnpayStub } from '../helpers/vnpay.js';

describe('buildReturnUrl', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000/api/v1/callbacks/vnpay/return'],
    ['http://localhost:3000/', 'http://localhost:3000/api/v1/callbacks/vnpay/return'],
    ['https://pgs.example.com/pgs', 'https://pgs.example.com/pgs/api/v1/callbacks/vnpay/return'],
    ['https://pgs.example.com/pgs//', 'https://pgs.example.com/pgs/api/v1/callbacks/vnpay/return'],
    ['https://pgs.example.com/a/b?x=1#h', 'https://pgs.example.com/a/b/api/v1/callbacks/vnpay/return'],
  ])('%s → %s (giữ path prefix)', (base, expected) => {
    expect(buildReturnUrl(base)).toBe(expected);
    expect(expected.endsWith(VNPAY_RETURN_PATH)).toBe(true);
  });
});

describe('buildProviderRegistry', () => {
  const registry = buildProviderRegistry(
    loadConfig({ ...TEST_ENV, PUBLIC_BASE_URL: 'https://h.example.com/pgs/' }),
    {
      transport: createVnpayStub().transport,
      clock: () => new Date(),
    },
  );

  it('đăng ký vnpay; vnp_ReturnUrl giữ path prefix của PUBLIC_BASE_URL', () => {
    const vnpay = registry.get('vnpay');
    const { checkoutUrl } = vnpay.buildPaymentUrl({
      providerRef: 'R1',
      amount: 10000,
      currency: 'VND',
      description: 'x',
      payerIp: '127.0.0.1',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 900_000),
    });
    expect(new URL(checkoutUrl).searchParams.get('vnp_ReturnUrl')).toBe(
      'https://h.example.com/pgs/api/v1/callbacks/vnpay/return',
    );
  });

  it('provider chưa đăng ký → UnknownProviderError', () => {
    expect(registry.has('momo')).toBe(false);
    expect(() => registry.get('momo')).toThrow(UnknownProviderError);
  });
});
