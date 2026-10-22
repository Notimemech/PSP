// Gắn correlation id cho mỗi request (nhận từ header nếu hợp lệ, không thì tự sinh), trả lại trong
// response header và đặt vào request context để logger tự gắn (NFR-OBS-01).
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '../lib/request-context.js';

export const CORRELATION_HEADER = 'X-Correlation-Id';
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function correlationId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(CORRELATION_HEADER);
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    runWithContext({ correlationId: id }, next);
  };
}
