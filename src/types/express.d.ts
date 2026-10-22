// Field PGS gắn thêm vào Request của Express.
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Gắn bởi middleware correlation-id. */
    correlationId: string;
    /** Body thô đúng như nhận được; middleware HMAC ký trên giá trị này, không ký JSON đã parse lại. */
    rawBody?: Buffer;
  }
}
