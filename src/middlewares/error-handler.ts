// Nơi duy nhất ghi response lỗi. Định dạng { error: { code, message, details } } (SRS 4.4).
// Lỗi không lường trước trả message chung; chi tiết chỉ nằm trong log (đã mask).
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type ErrorBody } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

function send(res: Parameters<RequestHandler>[1], err: AppError) {
  const body: ErrorBody = { error: { code: err.code, message: err.message } };
  if (err.details !== undefined) body.error.details = err.details;
  res.status(err.status).json(body);
}

/** Lỗi do body-parser của Express ném ra (JSON hỏng, body quá lớn...). */
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError(ErrorCode.NOT_FOUND, 'Không tìm thấy tài nguyên'));
  };
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      send(res, err);
      return;
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      send(res, new AppError(ErrorCode.VALIDATION_ERROR, 'Dữ liệu không hợp lệ', details));
      return;
    }
    if (isBodyParserError(err) && err.status < 500) {
      send(res, new AppError(ErrorCode.VALIDATION_ERROR, 'Body không hợp lệ', { reason: err.type }));
      return;
    }
    logger.error('unhandled error', { err, method: req.method, path: req.path });
    send(res, new AppError(ErrorCode.INTERNAL_ERROR, 'Lỗi hệ thống'));
  };
}
