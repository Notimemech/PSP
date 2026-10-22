// Seed client (FR-MT-04, Q13): npm run seed:client -- --name <tên>
// Sinh client_id + secret ngẫu nhiên 32 byte (hex), lưu secret_encrypted (AES-256-GCM), bật provider vnpay,
// in client_id và secret MỘT LẦN ra stdout. Secret không được log hay lưu dạng rõ ở đâu khác.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { ConfigError, loadConfig } from '../config/env.js';
import { createSecretBox, type SecretBox } from '../lib/crypto.js';
import { newId } from '../lib/id.js';
import { createClientWithProviders } from '../repositories/client.repository.js';
import type { Db } from '../repositories/db.js';

const DEFAULT_PROVIDERS = ['vnpay'] as const;
const MAX_NAME = 100;

export interface SeededClient {
  clientId: string;
  secret: string;
}

export async function seedClient(
  db: Db,
  secretBox: SecretBox,
  input: { name: string; providers?: readonly string[] },
): Promise<SeededClient> {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME) throw new Error(`--name phải có 1..${MAX_NAME} ký tự`);
  const clientId = newId('client');
  const secret = randomBytes(32).toString('hex');
  await createClientWithProviders(db, {
    id: clientId,
    name,
    secretEncrypted: secretBox.seal(secret),
    providerCodes: input.providers ?? DEFAULT_PROVIDERS,
  });
  return { clientId, secret };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { name: { type: 'string' } }, strict: true });
  if (!values.name) throw new Error('Thiếu --name. Dùng: npm run seed:client -- --name <tên>');
  const config = loadConfig();
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const { clientId, secret } = await seedClient(prisma, createSecretBox(config.security.encryptionKey), {
      name: values.name,
    });
    process.stdout.write(
      `client_id: ${clientId}\nsecret:    ${secret}\n` +
        'Lưu secret ngay: PGS chỉ in một lần và không hiển thị lại.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`seed:client thất bại: ${message}\n`);
    process.exit(1);
  });
}
