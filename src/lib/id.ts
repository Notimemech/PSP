// Sinh ID: ULID tự viết (48 bit thời gian ms + 80 bit ngẫu nhiên từ crypto, Crockford base32, 26 ký tự,
// sắp xếp theo thời gian) và ID có tiền tố theo loại bản ghi (quyết định Q5, 2026-10-22).
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ID_PREFIX = {
  client: 'cli',
  payment: 'pay',
  transaction: 'txn',
  refund: 'rfd',
  callback: 'cbk',
  event: 'evt',
  statusHistory: 'psh',
  providerConfig: 'pcf',
  reconciliation: 'rec',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** ULID 26 ký tự. `timeMs` chỉ truyền khi cần cố định thời gian (test). */
export function ulid(timeMs: number = Date.now()): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
    throw new RangeError('ULID: thời gian không hợp lệ');
  }
  let time = '';
  let t = timeMs;
  for (let i = 0; i < TIME_LEN; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 80 bit = 16 ký tự × 5 bit. Lấy 5 bit thấp của mỗi byte: 256 chia hết cho 32 nên phân bố đều.
  const bytes = randomBytes(RANDOM_LEN);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD.charAt(b & 31);
  return time + rand;
}

/** ID có tiền tố, ví dụ `pay_01JB...`. */
export function newId(kind: IdKind, timeMs?: number): string {
  return `${ID_PREFIX[kind]}_${ulid(timeMs)}`;
}
