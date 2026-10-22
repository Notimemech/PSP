// Danh bạ provider: Payment Core lấy adapter theo code, không import adapter cụ thể (FR-PV-03).
import type { IPaymentProvider } from './IPaymentProvider.js';

export class UnknownProviderError extends Error {
  constructor(readonly providerCode: string) {
    super(`Provider chưa đăng ký: ${providerCode}`);
    this.name = 'UnknownProviderError';
  }
}

export interface ProviderRegistry {
  /** Ném UnknownProviderError nếu chưa đăng ký. */
  get(code: string): IPaymentProvider;
  has(code: string): boolean;
}

export function createProviderRegistry(providers: readonly IPaymentProvider[]): ProviderRegistry {
  const byCode = new Map<string, IPaymentProvider>();
  for (const p of providers) {
    if (byCode.has(p.code)) throw new Error(`Provider đăng ký trùng: ${p.code}`);
    byCode.set(p.code, p);
  }
  return {
    get(code) {
      const p = byCode.get(code);
      if (!p) throw new UnknownProviderError(code);
      return p;
    },
    has: (code) => byCode.has(code),
  };
}
