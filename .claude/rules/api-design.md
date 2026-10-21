---
paths:
  - "src/**"
  - "tests/**"
---

# Quy tắc thiết kế API (SRS mục 4)

Ký hiệu **(chờ user chốt)** = "(chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở)": đây là đề xuất, chưa phải quyết định. Không coi là hợp đồng cố định.

## Versioning

- Mọi endpoint có tiền tố `/api/v1` (gồm `/api/v1/admin/*`, `/api/v1/callbacks/*`, `/api/v1/health`).
- Thay đổi phá vỡ tương thích phải lên version mới (`/api/v2`), không sửa hợp đồng của v1 (NFR-EXT-02).

## JSON và số tiền

- Request/response dùng JSON, tên trường **snake_case** (`payment_id`, `order_id`, `checkout_url`, `expires_at`).
- Số tiền là **integer** theo đơn vị nhỏ nhất (VND: đồng). Validate bằng zod `z.number().int().positive()`, không nhận float hay string.
- Thời gian trả về dạng ISO 8601 UTC (`2026-10-21T16:15:00Z`).
- `metadata` lưu và trả lại nguyên văn.
- Không trả về secret, API key, hash, `secret_encrypted` hay raw payload của provider trong response.

## Định dạng lỗi

Mọi lỗi trả về theo cấu trúc: `{ "error": { "code": "...", "message": "...", "details": ... } }`. Chỉ `error-handler` middleware được ghi response lỗi; service ném lỗi có kiểu từ `src/lib/errors`.

| HTTP | code | Khi nào | Nguồn |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Thiếu/sai trường (zod) | SRS 4.4 |
| 401 | `INVALID_SIGNATURE` | Sai chữ ký, thiếu header HMAC, timestamp lệch quá giới hạn | SRS 4.4 |
| 403 | `PROVIDER_NOT_ALLOWED` | Client không được dùng provider này | SRS 4.4 |
| 404 | `NOT_FOUND` | Không tìm thấy payment/refund | SRS 4.4 |
| 409 | `IDEMPOTENCY_CONFLICT` | Cùng `Idempotency-Key` nhưng khác body | SRS 4.4 |
| 409 | `INVALID_STATE` | Thao tác không hợp lệ với trạng thái hiện tại | SRS 4.4 |
| 422 | `REFUND_EXCEEDS_AMOUNT` | Tổng hoàn vượt số tiền đã trả | SRS 4.4 |
| 502 | `PROVIDER_ERROR` | Provider trả lỗi | SRS 4.4 |
| 504 | `PROVIDER_TIMEOUT` | Provider không phản hồi trong `PROVIDER_TIMEOUT_MS` | SRS 4.4 |
| 400 | `VALIDATION_ERROR` | Thiếu `Idempotency-Key` ở POST client | Diễn giải SRS 4.4 (+FR-PM-03) |
| 404 | `NOT_FOUND` | Tài nguyên thuộc client khác (không trả 403 để tránh lộ sự tồn tại) | Diễn giải SRS 4.4 (+FR-QR-03) |
| 409 | `IDEMPOTENCY_CONFLICT` | Request cùng key đang được xử lý: trả ngay, `details.reason = "in_progress"` | Bổ sung: đề xuất – chờ user chốt |
| 429 | `RATE_LIMITED` | Vượt rate limit theo client | Bổ sung: đề xuất – chờ user chốt |
| 401 | `UNAUTHORIZED` | Admin API: thiếu/sai `X-Admin-Key` | Bổ sung: đề xuất – chờ user chốt |
| 500 | `INTERNAL_ERROR` | Lỗi không lường trước (message chung) | Bổ sung: đề xuất – chờ user chốt |

- Tên các mã lỗi bổ sung (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở). Code và test nên tham chiếu hằng số trong `src/lib/errors`, không hard-code chuỗi rải rác.
- Không lộ stack trace, câu SQL hay secret trong `message`/`details`.

## Xác thực HMAC (client → PGS)

- Header: `X-Client-Id`, `X-Timestamp`, `X-Signature`. Cách gửi API key (header nào, có tách khỏi `X-Client-Id` không) (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).
- Chuỗi ký = `method + path + timestamp + body` (nối trực tiếp, không dấu phân cách):
  - `method`: viết hoa (`POST`).
  - `path`: `req.originalUrl`, gồm `/api/v1` và query string (ví dụ `/api/v1/payments?status=PENDING`).
  - `timestamp`: đúng chuỗi `X-Timestamp`, Unix **giây**.
  - `body`: **raw body** đúng như nhận được, chuỗi rỗng nếu không có body. Không ký trên JSON đã parse lại.
- `X-Signature` = hex chữ thường của HMAC-SHA256(secret_client, chuỗi ký). Secret lấy bằng cách giải mã `secret_encrypted` (AES-256-GCM).
- So sánh bằng `crypto.timingSafeEqual` (kiểm tra độ dài trước). Lệch `|now - X-Timestamp|` > `HMAC_MAX_SKEW_SECONDS` (300) → 401.
- `client_id` dùng trong service lấy từ `req` sau middleware xác thực, không lấy từ body.
- Admin: header `X-Admin-Key`, so sánh timing-safe với `ADMIN_API_KEY` (bắt buộc, ≥ 32 ký tự).

## Idempotency

- Mọi POST của client (`/payments`, `/payments/{id}/cancel`, `/payments/{id}/refunds`) bắt buộc có `Idempotency-Key`; thiếu → 400 `VALIDATION_ERROR`.
- POST `/admin/*` có cần idempotency không (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).
- Khóa lưu theo PK `(client_id, key)` kèm `request_hash` (SHA-256 của method + path + raw body), giữ `IDEMPOTENCY_TTL_HOURS` (24h).
- Cùng key + cùng hash → trả nguyên response cũ (status + body). Cùng key + khác hash → 409 `IDEMPOTENCY_CONFLICT`.
- Có cache cả response lỗi (4xx/5xx) theo key hay không (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).
- Request trùng key gửi song song: chỉ một request được xử lý (unique constraint hoặc advisory lock). Request đến sau trong lúc request đầu chưa xong → trả ngay 409 `IDEMPOTENCY_CONFLICT` với `details.reason = "in_progress"` (đề xuất).

## Phân lớp

- `routes/`: khai báo path + middleware, không chứa logic.
- `controllers/`: parse/validate bằng zod, gọi service, map kết quả sang JSON snake_case.
- `services/`: nghiệp vụ, state machine, transaction (outbox); không biết `req`/`res`.
- `repositories/`: truy cập Prisma; mọi hàm nhận `clientId` và lọc theo nó. Raw query chỉ dùng tagged template `Prisma.sql`, không nối chuỗi.
- `providers/`: adapter cài `IPaymentProvider`; service gọi provider qua `registry`, không import trực tiếp `VnpayAdapter`.
- `app.ts` export `createApp(deps)` (inject repository, provider registry, HTTP transport, clock) để test dựng app không cần mở port.
