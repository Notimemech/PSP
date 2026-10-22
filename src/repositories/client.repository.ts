// Truy cập bảng clients, client_providers, providers.
import type { ClientStatus, ProviderStatus } from '@prisma/client';
import type { Db } from './db.js';

export async function findClientStatus(db: Db, clientId: string): Promise<ClientStatus | null> {
  const row = await db.client.findUnique({ where: { id: clientId }, select: { status: true } });
  return row?.status ?? null;
}

export interface ProviderAccess {
  providerStatus: ProviderStatus | null;
  /** providers.capabilities (JSON) — nguồn duy nhất cho giới hạn số tiền (Q21). */
  capabilities: unknown;
  enabledForClient: boolean;
}

/** Provider có tồn tại/bật không và client có được dùng không (FR-CL-04). */
export async function findProviderAccess(
  db: Db,
  clientId: string,
  providerCode: string,
): Promise<ProviderAccess> {
  const [provider, link] = await Promise.all([
    db.provider.findUnique({ where: { code: providerCode }, select: { status: true, capabilities: true } }),
    db.clientProvider.findUnique({
      where: { clientId_providerCode: { clientId, providerCode } },
      select: { isEnabled: true },
    }),
  ]);
  return {
    providerStatus: provider?.status ?? null,
    capabilities: provider?.capabilities ?? null,
    enabledForClient: link?.isEnabled ?? false,
  };
}

export interface NewClient {
  id: string;
  name: string;
  secretEncrypted: string;
  providerCodes: readonly string[];
}

export async function createClientWithProviders(db: Db, c: NewClient): Promise<void> {
  await db.client.create({
    data: {
      id: c.id,
      name: c.name,
      secretEncrypted: c.secretEncrypted,
      providers: { create: c.providerCodes.map((providerCode) => ({ providerCode, isEnabled: true })) },
    },
  });
}
