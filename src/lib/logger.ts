// Logger JSON tự viết (không dùng pino theo quyết định 2026-10-21). Mọi field đi qua mask trước khi ghi,
// và correlation_id được gắn tự động từ request context.
import { currentContext } from './request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MASK = '***';
const MAX_DEPTH = 6;

// Tên field chứa secret hoặc dữ liệu nhạy cảm (NFR-SEC-04). So khớp không phân biệt hoa thường;
// "card"/"pan" chỉ khớp nguyên từ để không che nhầm "company", "span"...
const SENSITIVE_KEY =
  /secret|password|passwd|token|api[-_]?key|admin[-_]?key|authorization|signature|securehash|encryption|credential|cookie|cvv|cvc|card[-_]?number|(^|[-_])(card|pan)([-_]|$)/i;

export function mask(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return '[buffer]';
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : mask(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Nơi ghi một dòng JSON. Mặc định stdout; test truyền hàm thu dòng log. */
  write?: (line: string) => void;
  /** Field cố định gắn vào mọi dòng. */
  base?: LogFields;
}

export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const min = LEVELS[opts.level];
  const base = opts.base ?? {};

  const log = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < min) return;
    const correlationId = currentContext()?.correlationId;
    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(mask({ ...base, ...fields }) as LogFields),
    };
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => {
      log('debug', msg, fields);
    },
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    warn: (msg, fields) => {
      log('warn', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}
