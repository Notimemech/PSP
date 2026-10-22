# Thiết kế codebase — PGS

Tài liệu này mô tả cách chia module của code. Yêu cầu nghiệp vụ nằm ở [`srs.md`](srs.md), kiến trúc và luồng ở [`architecture.md`](architecture.md).

Thuật ngữ:

- **Module**: thứ gì đó có interface và implementation.
- **Interface**: mọi điều caller cần biết để dùng module, gồm chữ ký hàm, bất biến, lỗi có thể ném và cấu hình bắt buộc.
- **Module sâu**: interface nhỏ nhưng che giấu nhiều hành vi phía sau.
- **Seam**: chỗ có thể thay hành vi mà không phải sửa code tại chỗ đó.
- **Adapter**: thứ cụ thể được cắm vào một seam.

Trạng thái: ✅ đã code (dừng ở mức server chạy được) · 📐 mới thiết kế.

## 1. Nguyên tắc

1. **Một composition root.**
   - `src/server.ts` là nơi duy nhất đọc env, tạo `PrismaClient` và mở port.
   - Mọi module khác nhận dependency qua tham số.
   - `createApp(deps)` không tự tạo kết nối nào, nên test (Supertest) và production dùng chung một đường.
2. **Chỉ đặt seam ở chỗ có ít nhất hai adapter thật.**

   | Seam | Adapter production | Adapter còn lại | Lý do |
   | --- | --- | --- | --- |
   | HTTP transport ra VNPay (`fetch`) | `globalThis.fetch` | Stub trả response **đã ký thật** (`.claude/rules/testing.md`) | Test không được gọi mạng |
   | Clock (`now(): Date`) | Đồng hồ hệ thống | Đồng hồ cố định | Test hết hạn payment, lệch timestamp HMAC, lịch retry webhook |
   | `IPaymentProvider` | `VnpayAdapter` | (MoMo, Stripe… về sau) | SRS bắt buộc (FR-PV-03, NFR-EXT-01); chấp nhận dù hiện mới có một adapter |
   | `RateLimitStore` | Bộ nhớ trong process | (Postgres khi scale ngang) | Đã chốt C13 |

   **Không** đặt interface cho repository: test chạy trên Postgres thật, nên repository là module cụ thể, không có seam.
3. **Interface là bề mặt test.**
   - Middleware được test qua HTTP.
   - Service được test qua các hàm public của nó.
   - Không test xuyên vào bên trong.
4. **Phân lớp `route → controller → service → repository`** (CLAUDE.md):
   - Controller chỉ parse bằng zod rồi map sang JSON snake_case.
   - Service chứa nghiệp vụ, không biết đến `req`/`res`.

## 2. Bản đồ module

| Module | Interface (nhỏ) | Che giấu bên trong | |
| --- | --- | --- | --- |
| **Config** `src/config/env.ts` | `loadConfig(env) → Config` · ném `ConfigError` | Schema zod, giá trị mặc định SRS §7, parse CSV lịch retry, kiểm tra `ENCRYPTION_KEY` đủ 32 byte, `ADMIN_API_KEY` ≥ 32 ký tự, `VNP_HOST` chỉ được là sandbox. Thông báo lỗi không chứa giá trị | ✅ |
| **Logger** `src/lib/logger.ts` | `createLogger({level, write?, base?}) → Logger` (`debug/info/warn/error(msg, fields)`, `child`) | Ghi JSON từng dòng, mask key nhạy cảm (đệ quy, có giới hạn độ sâu), tự gắn `correlation_id` | ✅ |
| **Request context** `src/lib/request-context.ts` | `runWithContext(ctx, fn)`, `currentContext()` | AsyncLocalStorage | ✅ |
| **Errors** `src/lib/errors.ts` | `new AppError(code, message, details?)`, `ErrorCode` | Map mã lỗi → HTTP status (SRS 4.4 + mã bổ sung chờ C3) | ✅ |
| **HTTP shell** `src/app.ts` | `createApp({config, logger, prisma, …}) → Express` | Thứ tự middleware, giữ raw body cho HMAC, giới hạn body 100kb, 404, error handler (nơi duy nhất ghi response lỗi) | ✅ |
| **Health** `GET /api/v1/health` | 200 `{status:"ok"}` / 503 `{status:"degraded"}` | Ping `SELECT 1` có timeout 2s; không lộ lỗi DB | ✅ |
| **SecretBox** `src/lib/crypto.ts` | `seal(plain) → string`, `open(sealed) → string` | AES-256-GCM, IV 12 byte ngẫu nhiên, auth tag, định dạng `v1.<iv>.<tag>.<ct>` | 📐 |
| **Client auth** `src/middlewares/hmac-auth.ts` | `clientAuth({clients, secretBox, clock, maxSkew})`: middleware, gắn `req.client` | Đọc header, kiểm tra lệch timestamp, giải mã secret, tính HMAC trên raw body, `timingSafeEqual`. Client không tồn tại hoặc bị khóa cũng trả 401 như chữ ký sai | 📐 |
| **Admin auth** `src/middlewares/admin-auth.ts` | `adminAuth(adminKey)` | So sánh timing-safe | 📐 |
| **Rate limit** `src/middlewares/rate-limit.ts` | `rateLimit({store, perSecond, clock})` | Cửa sổ 1 giây theo `client_id` đã xác thực; dọn key cũ để không phình bộ nhớ | 📐 |
| **Idempotency** `src/middlewares/idempotency.ts` | `idempotent({store, ttl})`: middleware cho POST client | Bắt buộc header, `request_hash`, khóa `(client_id, key)`, phát lại response cũ, xử lý trùng key song song, hết hạn sau 24h | 📐 |
| **Payment provider** `src/providers/` | `IPaymentProvider { code, capabilities, buildPaymentUrl, verifyReturnUrl, queryDr, refund }`; `registry.get(code)` | Thư viện `vnpay`, `vnp_Amount = amount × 100`, verify chữ ký response, timeout + retry có giới hạn, map mã kết quả VNPay → kết quả chuẩn (C11) | 📐 |
| **Payment service** `src/services/payment.service.ts` (module sâu nhất) | `create`, `get`, `list`, `cancel`, `confirm(ref, source)`, `expireDue(now)`, `refund` | State machine 7 trạng thái, lock theo payment, đối chiếu FR-CB-03 (`needs_review`), outbox `webhook_events` trong cùng transaction, `payment_status_history`, sinh `vnp_TxnRef` | 📐 |
| **Callback** `GET /api/v1/callbacks/:provider/return` | 302 về `return_url?payment_id=` | `verifyReturnUrl` → `paymentService.confirm` (queryDr bên trong) → redirect an toàn | 📐 |
| **Webhook dispatcher** `src/jobs/webhook-dispatch.ts` | Job pg-boss `webhook.dispatch(eventId)` | Ký HMAC (C2), chặn SSRF, timeout 10s, lịch retry, đánh dấu FAILED | 📐 |
| **Jobs** `src/jobs/index.ts` | `startJobs(deps) → stop()` | pg-boss schedule cho queryDr-pending, expire-payments và kích hoạt outbox (C12) | 📐 |
| **Seed CLI** `src/cli/seed-client.ts` | `npm run seed:client -- --name <tên>` | Sinh `client_id` và secret, lưu `secret_encrypted`, in secret **một lần** | 📐 |

Vì sao `PaymentService` gom nhiều việc: return URL, job queryDr và job expire đều đi qua **cùng một** `confirm`. Nhờ vậy state machine, lock và outbox chỉ nằm ở một chỗ, sửa một lần là đúng ở mọi nơi gọi tới. Nếu tách thành `StateMachine`, `OutboxWriter`… mà caller phải tự ghép lại thì sẽ thành nhiều module nông.

## 3. Cây thư mục hiện tại

```
src/
  server.ts                     composition root
  app.ts                        createApp(deps)
  config/env.ts                 loadConfig
  lib/                          errors, logger, request-context
  middlewares/                  correlation-id, error-handler
  routes/index.ts               router /api/v1
  controllers/health.controller.ts
  repositories/health.repository.ts
  types/express.d.ts            req.correlationId, req.rawBody
prisma/schema.prisma            datasource + generator; chưa có model
tests/
  setup-env.ts                  env giả cố định cho mọi test
  global-setup.ts               prisma migrate deploy lên DB test
  helpers/                      test-env, createTestApp
  unit/                         config, logger
  integration/                  health (Postgres thật)
docker/postgres/                script tạo DB pgs_test
Dockerfile, docker-compose.yml
```

## 4. Quyết định và giới hạn của bước này

- **Prisma 6.19** (user chốt 2026-10-22): Prisma 7 bắt buộc thêm `@prisma/adapter-pg`, mà thư viện này nằm ngoài danh sách được phép.
- **Bỏ cột `api_key_hash`** (user chốt 2026-10-22, hệ quả của C1).
- **TypeScript 6.0**: typescript-eslint hiện chỉ hỗ trợ TypeScript dưới 6.1, nên chưa lên TS 7.
- **Express 5**: lỗi ném trong handler async được chuyển thẳng tới error handler.
- **ESM** (`"type": "module"`): import nội bộ phải có đuôi `.js`.
- **Cổng Postgres trên host**:
  - Mặc định **5433** (user chốt 2026-10-22), vì máy dev đã có PostgreSQL Windows chiếm 5432. Đổi được qua `PGS_DB_HOST_PORT`.
  - Trong mạng compose, `api` vẫn nối `postgres:5432`; chỉ cổng phía host là 5433. Đổi cổng host thì sửa cả `DATABASE_URL` / `DATABASE_URL_TEST`.
- **`npm audit` báo 3 lỗ hổng high** ở `deepmerge-ts`, đi qua `@prisma/config`.
  - Đây là tooling của Prisma CLI: nó chỉ đọc config của chính dự án, không nhận input từ bên ngoài.
  - Bản sửa là lên Prisma 7, tức đúng phương án đã không chọn.
- **Chưa làm** (📐 ở trên): model Prisma, HMAC, idempotency, rate limit, provider, service, job, seed CLI.
