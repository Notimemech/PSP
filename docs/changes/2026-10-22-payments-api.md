# 2026-10-22: API thanh toán, nhận kết quả VNPay, schema DB

## 1. Tóm tắt

Thêm luồng thanh toán đầu tiên của PGS (VNPay sandbox), thuần `route → controller → service → repository`, chưa có middleware HMAC / idempotency / rate limit (Q2, Q3).

| Endpoint | Việc |
| --- | --- |
| `POST /api/v1/payments` | Tạo payment PENDING + transaction PENDING, trả `checkout_url` VNPay đã ký |
| `GET /api/v1/payments/:payment_id` | Chi tiết payment (kèm `transactions`, `refunds`, `needs_review`) |
| `GET /api/v1/payments?order_id=` | Mọi payment của một order, cùng dạng với chi tiết (Q19) |
| `GET /api/v1/callbacks/:provider/return` | Trình duyệt payer quay về từ VNPay: verify chữ ký → queryDr → cập nhật → 302 về `return_url?payment_id=` |

Kèm theo:
- Schema Prisma đủ SRS §5 (12 bảng) trong một migration.
- CLI `npm run seed:client -- --name <tên>`.
- Lib ID (ULID có tiền tố) và mã hóa AES-256-GCM.

Quyết định Q2–Q22 (user chốt 2026-10-22) ghi ở `docs/architecture.md` §9 (mục 12–28). Kết quả kiểm tra:
- `npm test`: 144/144 (12 file);
- `lint`, `typecheck`, `prettier --check`: sạch;
- 2 agent test (kỹ thuật + nội dung) đã soát 3 vòng.

> ⚠️ **Chỉ dùng local/sandbox.** `X-Client-Id` chưa được xác thực: ai biết `client_id` là gọi API thay client đó được (Q2). Xem mục 5.

## 2. Luồng chạy

### 2.1 Tạo payment

Đường đi: `POST /payments` → `paymentController.create` → `PaymentService.create`.

1. **Controller** (`src/controllers/payment.controller.ts:32-43`) validate body bằng zod:
   - `amount`: integer dương ≤ 2 147 483 647 (Q12);
   - `return_url`: https, http chỉ cho localhost (C10);
   - `expires_in`: 300..3600 (Q14);
   - `metadata`: ≤ 8192 byte (Q22);
   - `payer_ip`: IPv4/IPv6 (Q20).
2. **Service** (`src/services/payment.service.ts:307-374`) kiểm tra theo thứ tự, lỗi nào trả mã đó:

   | Kiểm tra | Lỗi |
   | --- | --- |
   | Client tồn tại và ACTIVE | 401 |
   | Provider bật cho client | 403 (Q16) |
   | Currency được hỗ trợ | 400 |
   | `amount` trong min/max của `providers.capabilities` | 400 (Q21) |
   | Order chưa có payment đã trả | 409 (Q15) |

3. Service sinh `pay_<ULID>` và `vnp_TxnRef` (ULID trần), rồi gọi `VnpayAdapter.buildPaymentUrl` (ký URL, không gọi mạng).
4. Service lưu payment cùng transaction đầu tiên bằng một lệnh nested create (atomic, Q6).

### 2.2 Nhận kết quả

Đường đi: `GET /callbacks/vnpay/return` → `callbackController` → `PaymentService.confirmFromReturn` (`payment.service.ts:388-432`).

1. `verifyReturnUrl` kiểm chữ ký bằng `timingSafeEqual`. Sai chữ ký thì:
   - lưu `provider_callbacks` với `signature_valid=false`;
   - trả **400** `INVALID_SIGNATURE` (Q10).
2. Tìm payment theo `vnp_TxnRef` và lưu callback. Không thấy → 404.
3. `confirm()` (`:248-304`) **không tin tham số redirect**: gọi `queryDr` (đã verify chữ ký response) rồi đối chiếu số tiền, `TxnRef` và `TmnCode`.

   | Trường hợp | Kết quả |
   | --- | --- |
   | Lệch, hoặc mã lạ | giữ PENDING + `needs_review` (FR-CB-03, Q7/Q8) |
   | `01`/`05` | giữ PENDING |
   | `00` / `02` | `transition()` → SUCCEEDED / FAILED |

4. `transition()` (`:182-221`) chạy trong **một transaction DB**:
   - `SELECT … FOR UPDATE`, kiểm tra lại PENDING;
   - cập nhật payment (`paid_at`), transaction và `payment_status_history` (source `API`);
   - ghi `webhook_events` (outbox, Q9).
5. Luôn trả 302 về `return_url?payment_id=…`, kể cả khi queryDr lỗi (payment giữ PENDING).

## 3. Từng file

### 3.1 Database (`prisma/`)

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `prisma/schema.prisma` | Mô hình dữ liệu Prisma theo SRS §5 (bỏ subscription) | 8 enum (`:19-68`), 12 model. Xem chi tiết ngay dưới bảng. |
| `prisma/migrations/20261022050111_init/migration.sql` | SQL tạo toàn bộ schema | Xem chi tiết ngay dưới bảng. |
| `prisma/migrations/migration_lock.toml` | Khóa provider `postgresql` cho Prisma Migrate | Prisma tự sinh. |

Điểm chính trong `schema.prisma`:
- `Payment` (`:142`):
  - `paidAt` (`:158`): mốc "đã trả", dùng cho unique C5;
  - `needsReview` (`:160`);
  - index `(clientId, orderId)` (`:173`).
- `Transaction` có unique `(providerCode, providerTxnId)` (`:195`).
- `WebhookEvent` có index `(status, nextRetryAt)` cho job gửi sau này (`:253`).
- `IdempotencyKey` đã có bảng nhưng chưa dùng (Q3).
- Không có cột `api_key_hash`.

Điểm chính trong `migration.sql`:
- Partial unique index C5: `payments_client_id_order_id_paid_key … WHERE paid_at IS NOT NULL` (`:291`). Prisma không biểu diễn được nên viết tay.
- `payments_provider_txn_ref_key` (`:205`).
- Seed provider `vnpay` với `capabilities` `min_amount: 5000`, `max_amount: 999999999` (`:294`). Đây là nguồn duy nhất của Q21.

### 3.2 Thư viện dùng chung (`src/lib/`)

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `src/lib/id.ts` (mới) | Sinh ID | Xem chi tiết ngay dưới bảng. |
| `src/lib/crypto.ts` (mới) | Mã hóa secret client (NFR-SEC-02) và so sánh an toàn | Xem chi tiết ngay dưới bảng. |
| `src/lib/errors.ts` (sửa) | Mã lỗi + `AppError` | Thêm tham số thứ 4 `status` để ghi đè HTTP status (`:44-49`). Hiện chỉ dùng cho return sai chữ ký → 400 (Q10). |

Chi tiết `id.ts`:
- `ulid()` (`:27`) tự viết: 48 bit thời gian + 80 bit `randomBytes`, Crockford base32, sắp xếp được theo thời gian.
- `ID_PREFIX` (`:10`): `cli_`, `pay_`, `txn_`, `rfd_`, `cbk_`, `evt_`, `psh_`, `pcf_`, `rec_` (Q5).
- `newId(kind)` (`:45`).

Chi tiết `crypto.ts`:
- `createSecretBox(key)`: AES-256-GCM, IV 12 byte ngẫu nhiên mỗi lần, định dạng `v1.<iv>.<tag>.<ct>`.
- `open()` ném `SecretBoxError` khi sai khóa hoặc dữ liệu bị sửa.
- `safeEqual(a,b)` (`:61`): kiểm tra độ dài trước rồi mới `timingSafeEqual` (quy tắc CLAUDE.md).

### 3.3 Provider (`src/providers/`)

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `src/providers/IPaymentProvider.ts` | Interface mọi cổng phải cài (seam provider) | Xem chi tiết ngay dưới bảng. |
| `src/providers/registry.ts` | Danh bạ provider theo `code` | `createProviderRegistry` từ chối code trùng. `get` ném `UnknownProviderError`. Payment Core chỉ thấy registry, không import adapter (FR-PV-03). |
| `src/providers/index.ts` | Dựng registry từ `Config` | Xem chi tiết ngay dưới bảng. |
| `src/providers/vnpay/VnpayAdapter.ts` | Adapter VNPay sandbox dùng thư viện `vnpay@2.5` | Xem chi tiết ngay dưới bảng. |

Chi tiết `IPaymentProvider.ts`:
- Các method: `buildPaymentUrl`, `verifyReturnUrl`, `queryDr`, `refund` (`:73-83`).
- `HttpTransport` (`:5`): kiểu của `fetch`, được inject để test stub được.
- `QueryResult` là union `ok: true | false`. Nhánh `ok: true` có `status` (`SUCCEEDED/FAILED/PENDING/UNKNOWN`), `amount`, `providerRef`, `merchantMatches`, `raw`.
- `CheckoutInput.payerIp` (Q20).

Chi tiết `index.ts`:
- `buildReturnUrl` (`:13`) **giữ path prefix** của `PUBLIC_BASE_URL` (ví dụ `https://host/pgs` → `https://host/pgs/api/v1/...`).
- `buildProviderRegistry(config, {transport, clock})`: `server.ts` truyền `fetch` thật, test truyền stub.

Chi tiết `VnpayAdapter.ts`:
- `buildPaymentUrl` (`:146`): thư viện ký URL; `vnp_IpAddr` lấy từ `payerIp`; ngày theo GMT+7 tự format (`formatVnpayDate`, `:74`); `vnp_OrderInfo` bỏ dấu (`:84`). Trả `rawRequest` không kèm chữ ký.
- `verifyReturnUrl` (`:167`):
  - chuẩn hóa giống thư viện, nhưng so chữ ký bằng `safeEqual`, vì `VNPay.verifyReturnUrl` của thư viện so bằng `===`;
  - tham số dạng mảng hoặc thiếu `vnp_TxnRef`/`vnp_Amount` → không hợp lệ.
- `queryDr` (`:188`):
  - tự gọi qua `HttpTransport` với `AbortSignal.timeout`, `redirect: 'error'`;
  - ký request; verify chữ ký response theo thứ tự trường của VNPay (`:55-71`);
  - **response thiếu chữ ký bị coi là sai** (thư viện coi là đúng).
  - Lỗi trả về dạng `{ok:false, reason}`: `TIMEOUT`, `NETWORK`, `HTTP_ERROR`, `INVALID_RESPONSE`, `INVALID_SIGNATURE`, `PROVIDER_REJECTED`.
- `mapVnpayTransactionStatus` (`:99`): bảng mã C11/Q7.
- `refund()`: chưa hỗ trợ.

### 3.4 Repository (`src/repositories/`)

Chỉ truy cập Prisma, không có nghiệp vụ.

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `src/repositories/db.ts` | Kiểu `Db` + nhận diện lỗi unique | `Db = PrismaClient \| TransactionClient`, để cùng một hàm chạy được trong và ngoài `$transaction`. `isUniqueViolation` nhận diện P2002. |
| `src/repositories/client.repository.ts` | Bảng `clients`, `client_providers`, `providers` | `findClientStatus`. `findProviderAccess` trả trạng thái provider, `capabilities` (Q21) và việc client có được dùng provider không. `createClientWithProviders` (cho seed). |
| `src/repositories/payment.repository.ts` | Bảng `payments`, `transactions`, `payment_status_history`, `webhook_events` | Xem chi tiết ngay dưới bảng. |
| `src/repositories/callback.repository.ts` | Bảng `provider_callbacks` | `insertCallback` (`processed=false`), `markCallbackProcessed`. |

Chi tiết `payment.repository.ts`. Mọi hàm của bảng `payments` lọc theo `clientId`. Ngoại lệ ghi ở đầu file (`:2-5`).
- `createPaymentWithTransaction` (`:34`): nested create.
- `findPaymentDetail` / `listPaymentsByOrder` (`:64`, `:73`): có `include` transactions/refunds.
- `hasPaidPayment` (`:86`).
- `findPaymentByProviderRef` (`:95`): **không lọc client**, vì lúc return chưa biết client.
- `lockPayment` (`:104`): `SELECT … FOR UPDATE` bằng `Prisma.sql`.
- `setNeedsReview` (`:130`): chỉ áp khi `PENDING` và `paid_at IS NULL`, không đè trạng thái cuối.
- `updatePendingTransaction`, `insertStatusHistory`, `insertWebhookEvent`.

### 3.5 Service (`src/services/payment.service.ts`, mới)

Module sâu nhất: chứa toàn bộ nghiệp vụ, không biết `req`/`res`.

| Phần | Dòng | Ý nghĩa |
| --- | --- | --- |
| `PaymentService` interface | `:52-65` | 4 hàm public: `create`, `get`, `listByOrder`, `confirmFromReturn`. Mỗi hàm ghi rõ lỗi có thể ném. |
| `ConfirmOutcome` + `CONCLUSIVE` | `:82-96` | 6 kết luận của một lần xác nhận. 4 kết luận "đã có kết quả" (`TRANSITIONED`, `NEEDS_REVIEW`, `ALREADY_FINAL`, `SKIPPED_NEEDS_REVIEW`) thì đặt `provider_callbacks.processed=true`. `STILL_PENDING`/`NO_RESULT` để false. |
| `amountLimits` | `:100-119` | Đọc min/max từ `capabilities`. Thiếu key = không giới hạn. Có key nhưng sai kiểu → **fail closed** (log error, 500). |
| `callbackPayload` | `:121-146` | Lọc dữ liệu trình duyệt trước khi lưu: chỉ key `vnp_*`, bỏ chữ ký, key/giá trị ≤ 255 ký tự, mảng ≤ 10 phần tử, ≤ 50 key. |
| `transition` | `:182-221` | Đổi trạng thái + history + outbox trong một transaction. Kiểm tra lại trong lock (FR-CB-04): đã xử lý hoặc `needs_review` thì bỏ. |
| `recordWithoutTransition` | `:227-242` | Lưu `raw_response` (bằng chứng cho xử lý tay) và bật `needs_review` khi cần, không đổi trạng thái. |
| `confirm` | `:248-304` | Lõi xác nhận, dùng chung cho return và cho job sau này. Bỏ qua payment đã cuối hoặc `needs_review` (Q17). Vi phạm unique khi xác nhận (order đã có payment khác được trả, Q18) → `needs_review`, không 500. |
| `create` / `get` / `listByOrder` / `confirmFromReturn` | `:307-432` | Xem mục 2. `confirmFromReturn` bắt mọi lỗi của `confirm` để payer vẫn được redirect. |

### 3.6 Controller và route

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `src/controllers/client-context.ts` (mới) | Nơi **duy nhất** lấy `client_id` | `getClientId(req)`: đọc `X-Client-Id`, regex `^[A-Za-z0-9_-]{1,64}$`; thiếu hoặc sai → 401. **Tạm thời, chưa xác thực (Q2).** Khi có middleware HMAC chỉ cần sửa file này. |
| `src/controllers/payment.controller.ts` (mới) | `/payments` | Xem chi tiết ngay dưới bảng. |
| `src/controllers/callback.controller.ts` (mới) | Return VNPay | Gọi `confirmFromReturn`, trả 302 với `Cache-Control: no-store`. |
| `src/routes/index.ts` (sửa) | Khai báo path | Thêm 3 route payments + 1 route callback. Không có logic. |
| `src/app.ts` (sửa) | `createApp(deps)` | Xem chi tiết ngay dưới bảng. |
| `src/server.ts` (sửa) | Composition root | Dựng `clock` thật và registry với transport = `globalThis.fetch`, rồi truyền vào `createApp`. |

Chi tiết `payment.controller.ts`:
- Schema zod `:12-45`. `return_url` dùng `URL.canParse` để chuỗi như `//evil.com` trả 400 thay vì 500 (`:11`).
- `paymentJson` / `paymentDetailJson` (`:51-92`): map sang snake_case, có `needs_review`. Không trả `raw_request`/`raw_response`.
- List trả `{ data: [...] }`.

Chi tiết `app.ts`:
- `AppDeps` thêm `providers` (registry) và `clock`.
- Tạo `PaymentService` một lần (`:41-47`) rồi truyền vào router.

### 3.7 Cấu hình và CLI

| File | Công dụng | Điểm quan trọng |
| --- | --- | --- |
| `src/config/env.ts` (sửa) | Parse env | `PAYMENT_TTL_SECONDS` giới hạn 300..3600, mặc định 900, khớp `expires_in` (Q14). |
| `src/cli/seed-client.ts` (mới) | `npm run seed:client -- --name <tên>` (Q13) | Xem chi tiết ngay dưới bảng. |
| `package.json` / `package-lock.json` (sửa) | Thêm `vnpay@^2.5.0` (kéo theo `dayjs`) và script `seed:client` | `vnpay` nằm trong danh sách thư viện đã được phép. |

Chi tiết `seed-client.ts`:
- Sinh `cli_<ULID>` và secret 32 byte hex.
- Lưu `secret_encrypted` (AES-256-GCM), bật provider `vnpay`.
- In secret **một lần** ra stdout.
- `seedClient()` được export để test.

### 3.8 Test (`tests/`)

| File | Kiểm gì |
| --- | --- |
| `tests/helpers/vnpay.ts` (mới) | Bộ ký VNPay **độc lập** bằng `node:crypto` (không dùng code `src/`) + stub `HttpTransport` trả response queryDr đã ký. Nhờ vậy test không mock chữ ký. |
| `tests/helpers/db.ts` (mới) | Tạo/xóa client test trên Postgres thật (`pgs_test`). |
| `tests/helpers/app.ts` (sửa) | `createTestApp()`: adapter VNPay thật, chỉ thay transport; cho truyền clock, logger, transport. |
| `tests/unit/id.test.ts` | Định dạng ULID, tiền tố, thứ tự thời gian, biên thời gian. |
| `tests/unit/crypto.test.ts` | Seal/open, IV khác nhau, sửa dữ liệu hoặc sai khóa → lỗi, `safeEqual`. |
| `tests/unit/vnpay-adapter.test.ts` | URL ký đúng, `vnp_IpAddr`, verify return (sai, thiếu chữ ký, tham số mảng), queryDr (timeout, HTTP lỗi, thiếu hoặc sai chữ ký, map mã C11), ngày GMT+7. |
| `tests/unit/provider-registry.test.ts` | Registry, `buildReturnUrl` giữ prefix. |
| `tests/unit/config.test.ts` (sửa) | Biên `PAYMENT_TTL_SECONDS`. |
| `tests/integration/payments.test.ts` | Tạo payment (mọi lỗi 400/401/403/409, biên amount Q21, `payer_ip`, metadata 8192/8193 byte kể cả ký tự nhiều byte, `return_url`), GET/list, cách ly client (404). |
| `tests/integration/callback-return.test.ts` | Sai chữ ký → 400, không thấy ref → 404, SUCCEEDED/FAILED + history + event, lệch số tiền → `needs_review`, queryDr lỗi → PENDING + `processed=false`, return lặp lại idempotent, Q17 bỏ qua `needs_review`, Q18 tuần tự và **song song**, lọc payload. |
| `tests/integration/payment-repository.test.ts` | `setNeedsReview` không đổi payment đã cuối, đã có `paid_at` hoặc thuộc client khác. |
| `tests/integration/provider-capabilities.test.ts` | Q21 fail closed: `capabilities` sai kiểu → 500, không tạo payment, log không lộ giá trị. Dùng provider giả có code ngẫu nhiên để không làm hỏng các test chạy song song. |
| `tests/integration/seed-client.test.ts` | Seed tạo client ACTIVE, secret giải mã đúng, bật `vnpay`. |

### 3.9 Tài liệu

| File | Thay đổi |
| --- | --- |
| `GLOSSARY.md` (mới) | Thuật ngữ miền: Client, Provider, Payer, Order, Payment, Transaction, Provider reference, Paid, Needs review, Return, Confirmation, Event. |
| `docs/architecture.md` | §9 mục 12–28: quyết định Q2–Q22. §10: C6/C10/C11 đã chốt. Bước 1/5/7 của luồng cập nhật theo code. Nợ Q18. |
| `docs/codebase-design.md` | Bảng `ConfirmOutcome`, quy tắc lọc payload, cây thư mục test, danh sách "Chưa làm". |
| `.claude/rules/api-design.md` | Dòng 400 `INVALID_SIGNATURE` (Q10), 400 `VALIDATION_ERROR` cho Q20–Q22, ngoại lệ không lọc `clientId`. |
| `.claude/rules/security.md` | Q17 (kể cả job), Q18, đầu vào Q20–Q22, Q21 fail closed. |
| `CLAUDE.md` | Ghi chú `X-Client-Id` tạm thời, `vnpay` đã cài, cây thư mục, tham chiếu Q2–Q22. |
| `docs/changes/2026-10-22-payments-api.md` | File này. |

## 4. Quyết định chính (chi tiết ở `docs/architecture.md` §9)

| # | Quyết định |
| --- | --- |
| Q2 | `X-Client-Id` chưa xác thực, chỉ local/sandbox. Client lạ/khóa → 401 |
| Q3 | Chưa có Idempotency-Key (bảng đã có) |
| Q5 | ID dạng ULID có tiền tố |
| Q6 | Tạo payment kèm transaction PENDING |
| Q7 | Map queryDr: `00` → SUCCEEDED; `01`/`05` → PENDING; `02` → FAILED; mã khác → PENDING + needs_review |
| Q8 | needs_review giữ PENDING, không tạo event |
| Q9 | Ghi outbox ngay, chưa gửi webhook |
| Q10 | Return: sai chữ ký → 400; không thấy ref → 404; còn lại luôn 302 |
| Q11 | `return_url` phải là https (http chỉ cho localhost) |
| Q12 | `amount` Int ≤ 2³¹−1 |
| Q14 | `expires_in` 300..3600 |
| Q15 | Order đã trả → 409 `INVALID_STATE` |
| Q16 | Provider không được phép → 403 |
| Q17 | Mọi đường tự động bỏ qua `needs_review`; GET trả `needs_review` |
| Q18 | Order bị trả 2 lần → payment thứ hai `needs_review`, xử lý tay |
| Q19 | List theo order có transactions/refunds |
| Q20 | `payer_ip` tùy chọn, mặc định `127.0.0.1` |
| Q21 | min/max lấy từ `providers.capabilities` → 400; cấu hình hỏng → 500 |
| Q22 | `metadata` ≤ 8192 byte → 400 |

## 5. Nợ còn lại

1. **Xác thực HMAC chưa có** (Q2): lỗ hổng đã biết, không dùng ngoài local/sandbox. Quy trình `security-auditor` → `security-verifier` hoãn tới khi có HMAC.
2. **Idempotency-Key, rate limit** (Q3, C13): chưa làm.
3. **Gửi webhook** (pg-boss) và **job** queryDr-pending / expire-payments: `webhook_events` đang tích lũy với trạng thái PENDING, chưa ai gửi. Payment hết hạn chưa tự chuyển EXPIRED.
4. **Q18:** payer thứ hai bị trừ tiền nhưng không có event. Trước production bắt buộc có admin API liệt kê `needs_review` và quy trình hoàn tiền tay.
5. **Refund, cancel, admin API:** chưa làm (`VnpayAdapter.refund` ném lỗi).
6. **Dạng `details` chưa thống nhất hẳn:** lỗi zod / amount / currency trả mảng `[{path, message}]`, nhưng JSON hỏng (body-parser) vẫn trả `{reason}`.
7. **`npm audit`:** 3 lỗi high trong `deepmerge-ts`, kéo theo từ Prisma CLI (dev). Tạm chấp nhận.
8. **DB dev** còn dữ liệu do agent test tạo: client `cli_01M5H0R3AEDX508Z7QSD6YSP7V`, `cli_01M5H0R48PJ589V3X2V1P013KN` và khoảng 10 payment. Có thể xóa tay.
