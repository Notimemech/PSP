// Nơi DUY NHẤT controller lấy client_id của request.
// TẠM THỜI (Q2, user chốt 2026-10-22, chỉ local/sandbox): đọc header X-Client-Id mà CHƯA xác thực HMAC.
// Lỗ hổng đã biết: ai biết client_id là gọi được API thay client đó. Khi có middleware hmac-auth, hàm này chỉ
// cần đọc client đã xác thực mà middleware gắn vào req.
import type { Request } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';

// const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function getClientId(req: Request): string {
  if (!req.clientId) throw new AppError(ErrorCode.INVALID_SIGNATURE, "Authorize failed!");
  return req.clientId;
}
