// SecretBox: mã hóa hai chiều AES-256-GCM cho secret client và credentials provider (NFR-SEC-02).
// Định dạng: v1.<iv>.<tag>.<ciphertext>, mỗi phần base64url; IV 12 byte ngẫu nhiên mỗi lần seal.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface SecretBox {
  seal(plain: string): string;
  /** Ném SecretBoxError nếu sai định dạng, sai khóa hoặc dữ liệu bị sửa. */
  open(sealed: string): string;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_LEN) throw new SecretBoxError('Khóa mã hóa phải đúng 32 byte');
  // Giữ bản sao để caller sửa buffer gốc cũng không ảnh hưởng.
  const k = Buffer.from(key);

  return {
    seal(plain) {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGORITHM, k, iv, { authTagLength: TAG_LEN });
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, ct]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION)
        throw new SecretBoxError('Sai định dạng dữ liệu mã hóa');
      const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
      const iv = Buffer.from(ivB64, 'base64url');
      const tag = Buffer.from(tagB64, 'base64url');
      const ct = Buffer.from(ctB64, 'base64url');
      if (iv.length !== IV_LEN || tag.length !== TAG_LEN)
        throw new SecretBoxError('Sai định dạng dữ liệu mã hóa');
      try {
        const decipher = createDecipheriv(ALGORITHM, k, iv, { authTagLength: TAG_LEN });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('Không giải mã được (sai khóa hoặc dữ liệu bị sửa)');
      }
    },
  };
}

/** So sánh hai chuỗi bằng timingSafeEqual; khác độ dài trả false ngay (CLAUDE.md). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
