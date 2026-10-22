import { describe, expect, it } from 'vitest';
import { ULID_RE, newId, ulid } from '../../src/lib/id.js';

describe('ulid', () => {
  it('26 ký tự Crockford base32', () => {
    for (let i = 0; i < 100; i++) expect(ulid()).toMatch(ULID_RE);
  });

  it('mã hóa đúng thời gian vào 10 ký tự đầu', () => {
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    // Giá trị mẫu trong đặc tả ULID: 1469918176385 → 01ARYZ6S41
    expect(ulid(1469918176385).slice(0, 10)).toBe('01ARYZ6S41');
  });

  it('sắp xếp theo thời gian', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    const c = ulid(1_800_000_000_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('không trùng khi sinh nhiều lần trong cùng mili giây', () => {
    const t = Date.now();
    const set = new Set(Array.from({ length: 10_000 }, () => ulid(t)));
    expect(set.size).toBe(10_000);
  });

  it('từ chối thời gian ngoài 48 bit', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
    expect(() => ulid(1.5)).toThrow(RangeError);
  });
});

describe('newId', () => {
  it('có tiền tố theo loại', () => {
    expect(newId('payment')).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId('client')).toMatch(/^cli_/);
    expect(newId('event')).toMatch(/^evt_/);
    expect(newId('statusHistory')).toMatch(/^psh_/);
  });
});
