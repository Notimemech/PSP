// Dựng registry từ Config. Composition root (server.ts) truyền globalThis.fetch; test truyền stub.
import type { Config } from '../config/env.js';
import type { HttpTransport } from './IPaymentProvider.js';
import { createProviderRegistry, type ProviderRegistry } from './registry.js';
import { VnpayAdapter } from './vnpay/VnpayAdapter.js';

export const VNPAY_RETURN_PATH = '/api/v1/callbacks/vnpay/return';

/**
 * PUBLIC_BASE_URL + đường dẫn return, GIỮ path prefix của base (vd https://host/pgs → https://host/pgs/api/v1/...).
 * Bỏ query/hash của base. Không dùng new URL(path, base) vì path tuyệt đối sẽ xóa prefix.
 */
export function buildReturnUrl(publicBaseUrl: string, path: string = VNPAY_RETURN_PATH): string {
  const u = new URL(publicBaseUrl);
  u.pathname = u.pathname.replace(/\/+$/, '') + path;
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function buildProviderRegistry(
  config: Config,
  opts: { transport: HttpTransport; clock: () => Date; timeoutMs?: number },
): ProviderRegistry {
  return createProviderRegistry([
    new VnpayAdapter({
      tmnCode: config.vnpay.tmnCode,
      hashSecret: config.vnpay.hashSecret,
      host: config.vnpay.host,
      returnUrl: buildReturnUrl(config.publicBaseUrl),
      timeoutMs: opts.timeoutMs ?? config.providerTimeoutMs,
      transport: opts.transport,
      clock: opts.clock,
    }),
  ]);
}
