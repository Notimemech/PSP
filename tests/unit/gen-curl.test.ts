import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSignedCurl, toRawBody } from '../../src/cli/gen-curl.js';

const input = {
  base: 'http://localhost:3000/',
  method: 'POST',
  path: '/api/v1/payments?x=1',
  rawBody: `{"description":"it's ok"}`,
  clientId: 'cli_TEST',
  secret: 'test-secret-not-real',
  timestamp: 1729760000,
};

describe('gen-curl', () => {
  it('chữ ký = HMAC-SHA256(secret, METHOD + path + timestamp + raw body), hex thường', () => {
    const expected = createHmac('sha256', input.secret)
      .update(`POST/api/v1/payments?x=11729760000${input.rawBody}`)
      .digest('hex');
    const curl = buildSignedCurl(input);
    expect(curl).toContain(`'X-Signature: ${expected}'`);
    expect(curl).toContain(`'X-Timestamp: 1729760000'`);
    expect(curl).toContain(`'X-Client-Id: cli_TEST'`);
    expect(curl).toContain(`'http://localhost:3000/api/v1/payments?x=1'`);
  });

  it('body gửi đúng chuỗi đã ký, nháy đơn được escape cho bash', () => {
    expect(buildSignedCurl(input)).toContain(`--data-raw '{"description":"it'\\''s ok"}'`);
  });

  it('GET không có body thì không gửi --data-raw', () => {
    const curl = buildSignedCurl({ ...input, method: 'GET', rawBody: '' });
    expect(curl).not.toContain('--data-raw');
    expect(curl).not.toContain('Content-Type');
  });

  it('toRawBody: object → JSON gọn, string giữ nguyên, thay {{order_id}}', () => {
    let n = 0;
    const next = () => `ORD-${++n}`;
    expect(toRawBody({ order_id: '{{order_id}}', amount: 5000 }, next)).toBe(
      '{"order_id":"ORD-1","amount":5000}',
    );
    expect(toRawBody('{hỏng', next)).toBe('{hỏng');
    expect(toRawBody(undefined, next)).toBe('');
  });
});
