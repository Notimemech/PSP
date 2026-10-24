// Sinh lệnh curl đã ký HMAC để test API bằng tay (chỉ dev/local): npm run curl -- --client <client_id> [...]
// Secret lấy từ DB (giải mã secret_encrypted bằng ENCRYPTION_KEY) nên không phải gõ hay in secret ra màn hình.
// Chuỗi ký = METHOD + path (gồm query) + timestamp + raw body (.claude/rules/api-design.md).
// Lệnh in ra dùng cho bash (Git Bash). Chữ ký chỉ còn hạn HMAC_MAX_SKEW_SECONDS (300s) kể từ lúc sinh.
//
// Ví dụ:
//   npm run curl -- --client cli_xxx                                          POST /api/v1/payments, body mẫu
//   npm run curl -- --client cli_xxx --data '{"order_id":"ORD-9","amount":50000,...}'
//   npm run curl -- --client cli_xxx --file body.json
//   npm run curl -- --client cli_xxx --method GET --path '/api/v1/payments?order_id=ORD-9'
//   npm run curl -- --client cli_xxx --cases cases.json                       nhiều request một lần
//   npm run curl -- --client cli_xxx --ts-offset -400                         timestamp quá hạn (phải 401)
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { ConfigError, loadConfig } from '../config/env.js';
import { createSecretBox } from '../lib/crypto.js';
import { ulid } from '../lib/id.js';
import { findClientForAuth } from '../repositories/client.repository.js';

const DEFAULT_BASE = 'http://localhost:3000';
const DEFAULT_PATH = '/api/v1/payments';
/** Chuỗi này trong body được thay bằng order_id mới mỗi lần sinh. */
const ORDER_PLACEHOLDER = '{{order_id}}';

const SAMPLE_PAYMENT = {
  order_id: ORDER_PLACEHOLDER,
  amount: 100000,
  description: 'Test tu gen-curl',
  return_url: 'http://localhost:5000/return',
  currency: 'VND',
  provider: 'vnpay',
};

export interface CurlCase {
  name?: string;
  method?: string;
  path?: string;
  /** Object/array được JSON.stringify gọn; string được gửi nguyên văn (để thử JSON hỏng). */
  body?: unknown;
  client?: string;
  /** Cộng vào timestamp (giây); âm = quá khứ. Dùng để thử chặn replay. */
  tsOffset?: number;
}

export interface SignedCurlInput {
  base: string;
  method: string;
  path: string;
  rawBody: string;
  clientId: string;
  secret: string;
  timestamp: number;
}

/** Bọc chuỗi trong nháy đơn cho bash. */
function sh(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function signHmac(secret: string, method: string, path: string, ts: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${method}${path}${ts}${rawBody}`).digest('hex');
}

export function buildSignedCurl(i: SignedCurlInput): string {
  const ts = String(i.timestamp);
  const signature = signHmac(i.secret, i.method, i.path, ts, i.rawBody);
  const lines = [
    `curl -sS -i -X ${i.method} ${sh(i.base.replace(/\/+$/, '') + i.path)}`,
    `  -H ${sh(`X-Client-Id: ${i.clientId}`)}`,
    `  -H ${sh(`X-Timestamp: ${ts}`)}`,
    `  -H ${sh(`X-Signature: ${signature}`)}`,
  ];
  if (i.rawBody) {
    lines.push(`  -H 'Content-Type: application/json'`, `  --data-raw ${sh(i.rawBody)}`);
  }
  return lines.join(' \\\n');
}

/** Body → raw string sẽ ký và gửi; thay {{order_id}} bằng mã mới. */
export function toRawBody(body: unknown, newOrderId: () => string): string {
  if (body === undefined || body === null) return '';
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return raw.replaceAll(ORDER_PLACEHOLDER, () => newOrderId());
}

function readCases(values: Record<string, string | boolean | undefined>): CurlCase[] {
  if (typeof values.cases === 'string') {
    const parsed: unknown = JSON.parse(readFileSync(values.cases, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--cases phải là file JSON chứa một mảng');
    return parsed as CurlCase[];
  }
  const method = typeof values.method === 'string' ? values.method : 'POST';
  const path = typeof values.path === 'string' ? values.path : DEFAULT_PATH;
  let body: unknown;
  if (typeof values.data === 'string') body = values.raw ? values.data : JSON.parse(values.data);
  else if (typeof values.file === 'string') {
    const text = readFileSync(values.file, 'utf8');
    body = values.raw ? text : JSON.parse(text);
  } else if (method.toUpperCase() === 'POST' && path === DEFAULT_PATH) body = SAMPLE_PAYMENT;
  const tsOffset = typeof values['ts-offset'] === 'string' ? Number(values['ts-offset']) : 0;
  if (!Number.isInteger(tsOffset)) throw new Error('--ts-offset phải là số nguyên (giây)');
  return [{ method, path, body, tsOffset }];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      client: { type: 'string' },
      method: { type: 'string' },
      path: { type: 'string' },
      data: { type: 'string' },
      file: { type: 'string' },
      cases: { type: 'string' },
      raw: { type: 'boolean' },
      base: { type: 'string' },
      'ts-offset': { type: 'string' },
    },
    strict: true,
  });
  const cases = readCases(values);
  const defaultClient = values.client;
  const base = values.base ?? DEFAULT_BASE;

  const config = loadConfig();
  if (config.env === 'production') throw new Error('Không chạy gen-curl khi NODE_ENV=production');
  const secretBox = createSecretBox(config.security.encryptionKey);
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const secrets = new Map<string, string>();
  const notes: string[] = [];

  async function secretOf(clientId: string): Promise<string> {
    const cached = secrets.get(clientId);
    if (cached) return cached;
    const client = await findClientForAuth(prisma, clientId);
    let secret: string;
    if (!client) {
      // Vẫn sinh lệnh (ký bằng secret ngẫu nhiên) để thử ca "client không tồn tại" → phải 401.
      notes.push(`# Lưu ý: ${clientId} không có trong DB → request sẽ bị 401`);
      secret = randomBytes(32).toString('hex');
    } else {
      if (client.status !== 'ACTIVE')
        notes.push(`# Lưu ý: ${clientId} đang ${client.status} → request sẽ bị 401`);
      secret = secretBox.open(client.secretEncrypted);
    }
    secrets.set(clientId, secret);
    return secret;
  }

  try {
    const out: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [idx, c] of cases.entries()) {
      const clientId = c.client ?? defaultClient;
      if (!clientId) throw new Error('Thiếu --client <client_id> (hoặc "client" trong từng case)');
      const method = (c.method ?? 'GET').toUpperCase();
      const path = c.path ?? DEFAULT_PATH;
      if (!path.startsWith('/')) throw new Error(`path phải bắt đầu bằng "/": ${path}`);
      const curl = buildSignedCurl({
        base,
        method,
        path,
        rawBody: method === 'GET' ? '' : toRawBody(c.body, () => `ORD-${ulid().slice(-10)}`),
        clientId,
        secret: await secretOf(clientId),
        timestamp: now + (c.tsOffset ?? 0),
      });
      out.push(`# ${c.name ?? `#${idx + 1}`}: ${method} ${path}`, curl, '');
    }
    const expires = new Date((now + config.security.hmacMaxSkewSeconds) * 1000).toLocaleTimeString();
    out.push(
      `# Chữ ký hết hạn lúc ${expires} (sau ${config.security.hmacMaxSkewSeconds}s): sinh lại nếu quá giờ.`,
    );
    process.stdout.write([...new Set(notes), ...out].join('\n') + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`gen-curl thất bại: ${message}\n`);
    process.exit(1);
  });
}
