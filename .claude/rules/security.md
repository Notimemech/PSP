---
paths:
  - "src/**"
  - "prisma/**"
---

# Checklist bảo mật (SRS mục 6 + quyết định đã chốt)

Thay đổi trong auth, payment, callback, webhook, refund hoặc cấu hình bảo mật → làm theo "Quy trình bảo mật" trong `CLAUDE.md` (`security-auditor` → `security-verifier`).
Mục có ghi "(chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở)" là đề xuất, chưa phải quyết định.

## NFR-SEC-01: Xác thực

- [ ] Mọi route client đi qua middleware HMAC (`X-Client-Id`, `X-Timestamp`, `X-Signature`). Ngoại lệ duy nhất:
  - `/api/v1/health`: không xác thực.
  - `/api/v1/callbacks/*`: xác thực bằng chữ ký VNPay (NFR-SEC-03).
  - `/api/v1/admin/*`: xác thực bằng `X-Admin-Key`, không dùng HMAC.
- [ ] Xác thực client = `X-Client-Id` + HMAC; không có header API key riêng (C1 đã chốt).
- [ ] Chữ ký tính trên raw body; so sánh bằng `crypto.timingSafeEqual` sau khi kiểm tra độ dài.
- [ ] Chặn replay: timestamp lệch > `HMAC_MAX_SKEW_SECONDS` (300s) → 401.
- [ ] Client có `status` vô hiệu hóa → 401.
- [ ] `ADMIN_API_KEY` bắt buộc: app **fail-fast khi khởi động** nếu thiếu hoặc ngắn hơn 32 ký tự. `X-Admin-Key` so sánh timing-safe.
- [ ] TLS do reverse proxy/tunnel đảm nhận; không tắt kiểm tra chứng chỉ khi gọi ra ngoài.

## NFR-SEC-02: Lưu secret

- [ ] Secret client (`secret_encrypted`) và credentials provider mã hóa AES-256-GCM (IV ngẫu nhiên 12 byte mỗi lần, lưu kèm auth tag), khóa từ `ENCRYPTION_KEY` (32 byte).
- [ ] Không lưu API key riêng (C1); không có cột `api_key_hash` (user chốt bỏ, 2026-10-22).
- [ ] Không có secret/khóa trong source code, seed, test fixture hay migration (`prisma/**`).
- [ ] Config parse bằng zod khi khởi động; thiếu hoặc sai biến bắt buộc thì dừng app.

## NFR-SEC-03: Dữ liệu từ VNPay

- [ ] Mọi dữ liệu return URL đều qua `verifyReturnUrl`; chữ ký sai → không đổi trạng thái, ghi `provider_callbacks.signature_valid = false`.
- [ ] Chữ ký đúng vẫn phải gọi queryDr để xác nhận rồi mới cập nhật payment (FR-CB-02); verify chữ ký response queryDr.
- [ ] Đối chiếu số tiền (`vnp_Amount` = amount × 100) và `vnp_TxnRef` với dữ liệu đã lưu; lệch → `needs_review = true`, không chuyển SUCCEEDED.
- [ ] Payment `needs_review` (C6 đã chốt 2026-10-22): giữ `PENDING`, không tạo event, không tự xác nhận lại (Q17), kể cả job queryDr/expire; xử lý tay.
- [ ] Map `vnp_TransactionStatus` của queryDr (C11 đã chốt 2026-10-22): `00` → SUCCEEDED; `01`, `05` → giữ PENDING; `02` → FAILED; mã khác → giữ PENDING + `needs_review`. queryDr lỗi/timeout/chữ ký response sai hoặc thiếu → giữ PENDING.
- [ ] `VNP_HOST` chỉ là sandbox; không hard-code host production.

## NFR-SEC-04: Log và dữ liệu nhạy cảm

- [ ] Không lưu/log dữ liệu thẻ (PAN, CVV, ngày hết hạn).
- [ ] Logger tự viết mask các key: `secret`, `password`, `token`, `api_key`, `x-signature`, `x-admin-key`, `authorization`, `vnp_SecureHash`, `hash_secret`, `encryption_key`.
- [ ] Response lỗi không chứa stack trace, câu SQL, secret hay raw response của provider.

## NFR-SEC-05: Rate limit

- [ ] Rate limit theo `client_id` (`RATE_LIMIT_PER_SECOND`, mặc định 100); middleware tự viết, bộ đếm trong process theo `client_id` (C13 đã chốt: một instance dùng chung), một client vượt không ảnh hưởng client khác, bộ đếm phải được dọn để không phình bộ nhớ. Mã lỗi khi vượt (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).

## NFR-REL-01: Outbox

- [ ] Đổi trạng thái payment/refund, ghi `payment_status_history` và tạo `webhook_events` trong **cùng một transaction DB**.

## NFR-REL-02: Không trùng giao dịch

- [ ] Idempotency cho mọi POST client (`Idempotency-Key`, PK `(client_id, key)`, so `request_hash`); xử lý đúng khi gửi trùng key song song.
- [ ] Return URL/queryDr/job xử lý idempotent: cùng kết quả nhận nhiều lần chỉ cập nhật một lần (FR-CB-04).
- [ ] Lock theo payment khi đổi trạng thái (`SELECT ... FOR UPDATE` hoặc `pg_advisory_xact_lock`); kiểm tra trạng thái nguồn hợp lệ trong lock.
- [ ] Một `order_id` không có hơn một payment SUCCEEDED (FR-PM-04); partial unique index `(client_id, order_id) WHERE paid_at IS NOT NULL` (C5 đã chốt). `provider_txn_ref` unique toàn hệ thống.
- [ ] Q18: xác nhận vi phạm unique (order đã có payment khác được trả) → `needs_review` + lưu `raw_response`, không 500, không event. Nợ: bắt buộc có admin API liệt kê payment `needs_review` và quy trình hoàn tiền tay trước khi lên production.
- [ ] Refund: tổng hoàn ≤ số đã trả, kiểm tra trong lock → `REFUND_EXCEEDS_AMOUNT`.

## NFR-OBS-01 / NFR-OBS-03: Log và audit

- [ ] Log JSON có `correlation_id` xuyên suốt request → provider → webhook.
- [ ] Mọi thao tác admin và mọi lần đổi trạng thái được ghi audit (`payment_status_history` với `source`); không xóa audit log.

## Cách ly tenant (FR-MT-01, FR-QR-03)

- [ ] Mọi query repository lọc theo `client_id` lấy từ xác thực; không tin `client_id` trong body/query.
- [ ] Tài nguyên của client khác → 404 `NOT_FOUND` (diễn giải SRS 4.4 + FR-QR-03), không trả 403 để tránh lộ sự tồn tại.
- [ ] Client chỉ dùng provider được bật trong `client_providers`; nếu không → 403 `PROVIDER_NOT_ALLOWED`.

## Đầu vào, SSRF và webhook gửi đi

- [ ] Validate mọi input bằng zod; số tiền là integer dương, nằm trong `min_amount`/`max_amount` của `providers.capabilities` (Q21; cấu hình hỏng → 500, fail closed).
- [ ] `metadata` ≤ 8192 byte JSON UTF-8 (Q22); `payer_ip` chỉ IPv4/IPv6 (Q20).
- [ ] Raw SQL chỉ dùng `Prisma.sql`/tagged template, không nối chuỗi.
- [ ] `return_url` (C10 đã chốt 2026-10-22): chỉ `https:`; `http:` chỉ khi host là `localhost`/`127.0.0.1`; không có user:pass.
- [ ] Webhook URL: chặn IP private/loopback/link-local/metadata (169.254.169.254) khi gửi; không follow redirect; timeout `WEBHOOK_TIMEOUT_MS`.
- [ ] Webhook gửi đi ký HMAC-SHA256 bằng secret client kèm timestamp, có `event_id` duy nhất (FR-WH-02, FR-WH-05). Định dạng header/chuỗi ký (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).
- [ ] Sự kiện `payment.cancelled` (chờ user chốt, xem docs/architecture.md#10-câu-hỏi-mở).
- [ ] Gọi provider có timeout `PROVIDER_TIMEOUT_MS` và retry giới hạn (tự viết).

## Phụ thuộc

- [ ] Không cài thư viện mới khi chưa hỏi user; chạy `npm audit` khi audit.

## Phân mức độ finding

Nguồn duy nhất cho `security-auditor` và `security-verifier`.

| Mức | Tiêu chí | Ví dụ trong PGS |
| --- | --- | --- |
| Critical | Khai thác từ xa, không cần xác thực hoặc chỉ cần quyền client thường, gây mất tiền, đánh dấu thanh toán giả, hoặc lộ secret/khóa | Bỏ qua verify chữ ký VNPay; payment SUCCEEDED chỉ nhờ tham số redirect; bypass HMAC; lộ `ENCRYPTION_KEY`/`VNP_HASH_SECRET` |
| High | Vượt quyền giữa các tenant, trùng giao dịch/hoàn tiền, hoặc lộ dữ liệu nhạy cảm, khai thác được trong điều kiện thực tế | Đọc payment của client khác; race idempotency tạo 2 payment; refund vượt số tiền; replay request; SSRF qua webhook URL; so sánh chữ ký không timing-safe |
| Medium | Cần điều kiện đặc biệt hoặc tác động giới hạn; thiếu lớp phòng thủ | Thiếu rate limit; log chưa mask một trường ít nhạy cảm; thông báo lỗi lộ chi tiết nội bộ; dependency có CVE nhưng không gọi tới đường dẫn bị lỗi |
| Low | Vấn đề hardening, khó khai thác, tác động nhỏ | Thiếu header bảo mật; độ dài tối đa input chưa giới hạn; cấu hình mặc định chưa tối ưu |

Độ tin cậy:

- **Cao**: có bằng chứng tái hiện được (request/response thật hoặc test chạy được) và đã đọc đủ code đường đi.
- **Trung bình**: có bằng chứng code và đã đọc đủ đường đi từ input tới chỗ lỗi, nhưng chưa chạy tái hiện.
- **Thấp**: vẫn PHẢI có bằng chứng code (`file:line` + trích đoạn), chỉ là chưa tái hiện được bằng request/test, và còn phụ thuộc điều kiện/cấu hình hoặc một phần đường đi chưa đọc hết.

Không có bằng chứng code (`file:line` + trích đoạn) thì không phải finding, kể cả ở độ tin cậy Thấp: đưa vào mục "Nghi vấn chưa xác minh". Đây là nguồn duy nhất cho định nghĩa này.
