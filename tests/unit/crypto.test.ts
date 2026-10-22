import { describe, expect, it } from 'vitest';
import { SecretBoxError, createSecretBox, safeEqual } from '../../src/lib/crypto.js';

const key = Buffer.alloc(32, 7);

describe('SecretBox', () => {
  const box = createSecretBox(key);

  it('seal rồi open ra đúng giá trị gốc', () => {
    const plain = 'bí mật ✓ 0123456789abcdef';
    expect(box.open(box.seal(plain))).toBe(plain);
  });

  it('định dạng v1.<iv>.<tag>.<ct> base64url, IV ngẫu nhiên mỗi lần', () => {
    const a = box.seal('x');
    const b = box.seal('x');
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('x.');
  });

  it('sai khóa → SecretBoxError', () => {
    const sealed = box.seal('secret');
    expect(() => createSecretBox(Buffer.alloc(32, 8)).open(sealed)).toThrow(SecretBoxError);
  });

  it('dữ liệu bị sửa (ciphertext hoặc tag) → SecretBoxError', () => {
    const [v, iv, tag, ct] = box.seal('secret-value').split('.') as [string, string, string, string];
    const flip = (s: string) => {
      const buf = Buffer.from(s, 'base64url');
      buf[0] = (buf[0] ?? 0) ^ 1;
      return buf.toString('base64url');
    };
    expect(() => box.open([v, iv, tag, flip(ct)].join('.'))).toThrow(SecretBoxError);
    expect(() => box.open([v, iv, flip(tag), ct].join('.'))).toThrow(SecretBoxError);
  });

  it('sai định dạng/phiên bản → SecretBoxError', () => {
    expect(() => box.open('abc')).toThrow(SecretBoxError);
    expect(() => box.open(box.seal('x').replace(/^v1/, 'v2'))).toThrow(SecretBoxError);
  });

  it('khóa không đủ 32 byte bị từ chối', () => {
    expect(() => createSecretBox(Buffer.alloc(16))).toThrow(SecretBoxError);
  });
});

describe('safeEqual', () => {
  it('so sánh đúng, khác độ dài trả false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
