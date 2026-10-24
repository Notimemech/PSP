import { createHmac } from 'node:crypto';
import { AppError, ErrorCode } from '../lib/errors.js';
import { safeEqual, type SecretBox } from '../lib/crypto.js';
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import { findClientForAuth } from '../repositories/client.repository.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface HmacAuthDeps {
  prisma: PrismaClient;
  secretBox: SecretBox;
  clock: () => Date;
  maxSkewSeconds: number;
}

export function hmacAuth(deps: HmacAuthDeps): RequestHandler {
  return async (req, _res, next) => {
    const now = deps.clock();

    const nowSecond = Math.floor(now.getTime() / 1000);
    const tsHeader = req.get('X-Timestamp') ?? '';
    if (!/^\d{1,12}$/.test(tsHeader)) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!');
    const ts = Number(tsHeader);

    if (Math.abs(nowSecond - ts) > deps.maxSkewSeconds) {
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!!');
    }

    const id = req.get('X-Client-Id');

    if (!id || !CLIENT_ID_RE.test(id)) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!!');

    const sign = req.get('X-Signature');
    if (!sign) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!!');

    const client = await findClientForAuth(deps.prisma, id);

    if (!client) throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!!');

    const body = req.rawBody?.toString('utf8') ?? '';

    const signature = `${req.method}${req.originalUrl}${tsHeader}${body}`;
    const secret = deps.secretBox.open(client.secretEncrypted);
    const signWithSecret = createHmac('sha256', secret).update(signature).digest('hex');

    if (!safeEqual(signWithSecret, sign ?? ''))
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Authorize failed!!');

    req.clientId = id;
    next();
  };
}
