# CLAUDE.md: Payment Gateway Service (PGS)

PGS là backend service độc lập, cung cấp một REST API thống nhất để các client system tạo và quản lý thanh toán qua nhiều cổng.
Bản đầu chỉ kết nối VNPay sandbox (chưa có IPN); kết quả được xác nhận bằng return URL (verify chữ ký) + queryDr, sau đó báo cho client qua webhook.
Một instance dùng chung cho nhiều client (multi-tenant theo `client_id`), không có UI. Nguồn yêu cầu duy nhất: [`docs/srs.md`](docs/srs.md).

Tài liệu thêm: `docs/architecture.md`, `docs/adr/`, `.claude/rules/` (api-design, testing, security).

## Stack

- Node.js 22 LTS, TypeScript strict, Express.js (không dùng NestJS)
- PostgreSQL + Prisma; hàng đợi job/webhook bằng pg-boss (không dùng Redis/RabbitMQ)
- VNPay sandbox qua thư viện `vnpay` (lehuygiang28/vnpay). Host: `sandbox.vnpayment.vn`
- Validate env/input bằng zod; test bằng Vitest + Supertest; ESLint + Prettier
- Chạy local bằng Docker Compose (`api`, `postgres`)

## Kiến trúc phân lớp

- `route → controller → service → repository`. Controller không gọi Prisma; repository không chứa nghiệp vụ.
- Provider: mỗi cổng có một adapter cài `IPaymentProvider` (`src/providers/`), đăng ký trong `registry.ts`. Payment Core không import adapter cụ thể.
- Đổi trạng thái payment và ghi `webhook_events` nằm trong cùng một transaction DB (outbox); pg-boss gửi webhook.

## Cấu trúc thư mục

```
src/
  app.ts, server.ts, config/        # env parse bằng zod
  routes/ controllers/ services/ repositories/
  middlewares/                      # hmac-auth, admin-auth, idempotency, correlation-id, rate-limit, error-handler
  providers/                        # IPaymentProvider.ts, vnpay/VnpayAdapter.ts, registry.ts
  jobs/                             # webhook-dispatch, querydr-pending, expire-payments
  lib/                              # crypto, logger, errors, money
  cli/                              # seed-client.ts
prisma/                             # schema.prisma, migrations/
tests/                              # unit/, integration/, security/, helpers/
docs/                               # srs.md, architecture.md, adr/, security/reports/
```

## Lệnh

- Dev: `npm run dev` · Build: `npm run build`
- Test: `npm test` · Test bảo mật: `npm run test:security`
- Lint: `npm run lint` · Typecheck: `npm run typecheck` · Format: `npm run format`
- Migrate: `npx prisma migrate dev` (dev), `npx prisma migrate deploy`, `npx prisma generate`
- Seed client: `npm run seed:client -- --name <tên>`
- Docker: `docker compose up -d postgres` (chỉ DB), `docker compose up --build` (cả stack), `docker compose down`

## Quyết định đã chốt (2026-10-21)

- Secret client lưu **mã hóa AES-256-GCM** (cột `secret_encrypted`, khóa từ env `ENCRYPTION_KEY`), không lưu hash, vì cần secret gốc để tính HMAC.
- Payment có 7 trạng thái: `PENDING`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `PARTIALLY_REFUNDED`, `REFUNDED`.
  - `FAILED`/`EXPIRED`/`CANCELLED` là trạng thái cuối. Trước khi thanh toán, chỉ `PENDING` còn đổi được.
  - Lệch số tiền/mã giao dịch (FR-CB-03) → bật cờ `needs_review`, không tạo trạng thái mới.
  - Mọi lần chuyển trạng thái ghi vào `payment_status_history`; chuyển không hợp lệ → `INVALID_STATE` (409).
- Admin API `/api/v1/admin/*`: header `X-Admin-Key`, so sánh timing-safe với env `ADMIN_API_KEY` (chỉ dùng local/sandbox).
- Chưa làm IPN. PGS không lưu subscription; `metadata` lưu nguyên văn và trả lại trong webhook.
- Thư viện được phép:
  - Runtime: `express`, `@prisma/client`/`prisma`, `pg-boss`, `vnpay`, `zod`.
  - Dev: `typescript`, `vitest`, `supertest`, `eslint`, `prettier` (+ types/tooling tối thiểu).
  - KHÔNG dùng pino, opossum, helmet: logger JSON (có mask) và retry/timeout/circuit đều tự viết trong `src/lib/`.
  - Dev TypeScript (chốt 2026-10-22): `tsx`, `@types/node`, `@types/express`, `@types/supertest`, `typescript-eslint`, `@eslint/js`, `globals`, `@vitest/coverage-v8`.
- **Không cài thư viện mới khi chưa hỏi user.**
- Chốt 2026-10-22: xác thực client = `X-Client-Id` + HMAC, không có header API key riêng (C1); FR-PM-04 unique `WHERE paid_at IS NOT NULL` (C5); rate limit trong process theo `client_id`, một instance dùng chung (C13); line ending LF.

Chốt trong vòng rà soát Phase 1:

- `ADMIN_API_KEY` **bắt buộc**: app fail-fast khi khởi động nếu thiếu hoặc ngắn hơn 32 ký tự.

Điểm chờ chốt: `docs/architecture.md#10-câu-hỏi-mở`. Không tự quyết, phải hỏi user.

## Quy tắc bắt buộc

- Không log và không lưu dữ liệu thẻ hoặc secret (secret client, `VNP_HASH_SECRET`, `ENCRYPTION_KEY`, API key, `ADMIN_API_KEY`). Log phải đi qua logger có mask.
- Luôn verify chữ ký mọi dữ liệu VNPay trả về (`verifyReturnUrl`; IPN khi có).
- So sánh chữ ký/khóa bằng `crypto.timingSafeEqual` (kiểm tra độ dài trước), không dùng `===`.
- Không cập nhật trạng thái payment chỉ dựa vào tham số redirect: phải gọi queryDr để xác nhận, rồi đối chiếu số tiền và `vnp_TxnRef`.
- Mọi query phải lọc theo `client_id` lấy từ `X-Client-Id` đã xác thực HMAC; không tin `client_id` trong body/query.
- Số tiền là integer theo đơn vị nhỏ nhất (VND: đồng). Không dùng float.
- Mọi POST của client bắt buộc có `Idempotency-Key` (lưu 24h; cùng key + body → trả kết quả cũ; khác body → 409). POST `/admin/*`: chờ user chốt.
- Chuỗi ký HMAC = `METHOD` viết hoa + path (`req.originalUrl`, gồm `/api/v1` và query) + timestamp (Unix giây) + raw body; chữ ký là hex chữ thường. Chi tiết: `.claude/rules/api-design.md`.
- `vnp_TxnRef` do PGS sinh, unique toàn hệ thống.
- Không gọi host VNPay production (`pay.vnpay.vn`, `merchant.vnpay.vn`).
- Không đọc `.env*` (trừ `.env.example`); không commit secret.
- Hook `.claude/hooks/guard.mjs` chặn mọi lệnh/đường dẫn tham chiếu tới `.env` (trừ `.env.example`) và host `*.vnpay.vn`, kể cả `cp .env.example .env`: user tự tạo `.env`. Bị chặn thì không tìm cách lách, hãy hỏi user.

## Quy trình bảo mật

Khi thay đổi code thuộc **auth, payment, callback, webhook, refund hoặc cấu hình bảo mật**:

1. Chạy agent `security-auditor` → báo cáo `docs/security/reports/<YYYY-MM-DD>-<phạm-vi>-audit.md`.
2. Chạy agent `security-verifier` trên báo cáo vừa tạo → `<tên báo cáo>-verification.md` + test tái hiện trong `tests/security/`.
3. Chỉ sửa các finding mà verifier kết luận **CONFIRMED**. Bỏ qua FALSE_POSITIVE; NEEDS_INFO thì hỏi user.
4. Sửa xong, chạy lại `security-verifier` cho các finding đó: test regression trong `tests/security/` phải PASS.

## Định nghĩa "xong việc"

- (a) `npm test` pass.
- (b) `npm run lint` và `npm run typecheck` sạch.
- (c) `npm run test:security` chỉ được fail ở các ID có trong `tests/security/open-findings.json`.
  - File này do `security-verifier` quản lý, chỉ chứa finding Medium/Low CONFIRMED mà user đã chấp nhận để lại. Không bao giờ chứa High/Critical.
  - Phase 2: vitest config loại các test có ID trong file này ra khỏi `npm test`.
  - (C4 chờ chốt: cho tới khi user trả lời, `open-findings.json` phải là `[]`, tức mọi finding CONFIRMED phải FIXED.)
- (d) Trong mọi file `docs/security/reports/*-verification.md`, không có finding High/Critical ở trạng thái OPEN. Finding High/Critical có kết luận NEEDS_INFO chưa được coi là xong cho tới khi user quyết định.

## Mẫu báo cáo cuối việc

Khi xong việc, trả lời theo mẫu:

```
**Đã hoàn thành việc gì?**
- <việc 1>
- <việc 2>

**Sửa những file nào?**
- `path/to/file.ts`: <thay đổi gì> (liên quan: <việc 1>)
- `path/to/other.ts`: <thay đổi gì> (liên quan: <việc 2>)
```
