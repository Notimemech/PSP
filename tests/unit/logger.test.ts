import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';
import { runWithContext } from '../../src/lib/request-context.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('logger', () => {
  it('che các field nhạy cảm, kể cả lồng nhau', () => {
    const { logger, lines } = capture();
    logger.info('x', {
      client_secret: 's1',
      headers: { 'X-Signature': 's2', 'X-Admin-Key': 's3', 'content-type': 'json' },
      vnp: { vnp_SecureHash: 's4', vnp_Amount: 100 },
      card_number: '4111',
      company: 'ACME',
    });
    const out = JSON.stringify(lines[0]);
    for (const s of ['s1', 's2', 's3', 's4', '4111']) expect(out).not.toContain(`"${s}"`);
    expect(out).toContain('"content-type":"json"');
    expect(out).toContain('"vnp_Amount":100');
    expect(out).toContain('"company":"ACME"');
  });

  it('tự gắn correlation_id từ request context', () => {
    const { logger, lines } = capture();
    runWithContext({ correlationId: 'cid-1' }, () => {
      logger.info('trong request');
    });
    expect(lines[0]).toMatchObject({ msg: 'trong request', correlation_id: 'cid-1' });
  });

  it('bỏ log dưới mức cấu hình', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    logger.info('bỏ');
    logger.warn('giữ');
    expect(lines).toHaveLength(1);
  });
});
