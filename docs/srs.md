# SRS – Payment Gateway Service

Oct 21, 2026 · @Quang

## 1. Giới thiệu

**Mục đích:** Payment Gateway Service (PGS) là một backend service độc lập, cung cấp một API thống nhất để các hệ thống cá nhân (client systems), qua một instance dùng chung, tạo và quản lý giao dịch thanh toán qua nhiều cổng bên ngoài (bản đầu: VNPay sandbox; thiết kế sẵn để thêm MoMo, ZaloPay, Stripe…) mà không cần tích hợp từng cổng riêng.

**Phạm vi:**

- Trong phạm vi: tạo thanh toán, xác nhận kết quả (return URL + truy vấn lại provider; IPN ở giai đoạn sau), thông báo kết quả cho client (webhook), truy vấn trạng thái, hoàn tiền, đối soát, quản lý client và cấu hình cổng.
- Ngoài phạm vi: giao diện người dùng cuối, Admin UI, quản lý subscription/gói cước (client tự quản lý, mỗi kỳ gọi tạo payment), lưu trữ số thẻ (PAN), quản lý đơn hàng/sản phẩm, ví điện tử nội bộ, kế toán.

**Thuật ngữ:**

| Thuật ngữ | Ý nghĩa |
| --- | --- |
| Client system | Hệ thống nội bộ gọi PGS (web bán hàng, app, LMS…) |
| Provider / Cổng | Cổng thanh toán bên ngoài (VNPay, MoMo, Stripe…) |
| Adapter | Module chuyển đổi request/response chuẩn của PGS sang API riêng của từng provider |
| Payment | Một yêu cầu thanh toán gắn với một đơn hàng của client |
| Transaction | Một lần thử thực hiện payment trên một provider (1 payment có thể có nhiều transaction) |
| IPN / Callback | Thông báo server-to-server từ provider về kết quả giao dịch |
| Webhook | Thông báo từ PGS tới client system |
| Idempotency key | Khóa do client gửi để đảm bảo một request lặp lại không tạo giao dịch trùng |
| Reconciliation | Đối soát dữ liệu giao dịch PGS với file/API của provider |

**Tài liệu tham chiếu:** IEEE 830 / ISO/IEC/IEEE 29148 (cấu trúc SRS), tài liệu API của từng provider, PCI DSS (định hướng bảo mật), OWASP API Security Top 10.

## 2. Mô tả tổng quan

PGS đứng giữa client systems và các provider: client chỉ gọi một API chuẩn, PGS chọn adapter tương ứng, lưu trạng thái giao dịch và báo kết quả ngược lại qua webhook.

**Các thành phần chính:**

- **Public API (REST):** endpoint cho client systems, xác thực bằng API key + chữ ký HMAC.
- **Payment Core:** nghiệp vụ payment/refund, state machine, idempotency.
- **Provider Adapters:** mỗi provider một adapter cài đặt chung một interface (`IPaymentProvider`).
- **Callback Receiver:** endpoint nhận redirect (return URL) từ provider, xác minh chữ ký rồi truy vấn lại trạng thái; endpoint IPN làm ở giai đoạn sau.
- **Webhook Dispatcher:** gửi sự kiện tới client, retry qua message queue.
- **Reconciliation Job:** job định kỳ đối soát với provider.
- **Admin API:** quản lý client, cấu hình provider, tra cứu giao dịch.
- **Hạ tầng:** ở MVP chỉ có PostgreSQL: lưu dữ liệu, idempotency, lock (advisory lock) và hàng đợi job/webhook (pg-boss). Redis/RabbitMQ chỉ thêm khi tải đòi hỏi. Secret qua biến môi trường.

**Đối tượng sử dụng:**

| Actor | Vai trò | Kênh |
| --- | --- | --- |
| Client system | Tạo thanh toán, hoàn tiền, truy vấn, nhận webhook | Public API |
| Provider | Trả kết quả giao dịch | Callback Receiver |
| Admin / vận hành | Cấu hình, tra cứu, xử lý sai lệch | Admin API |
| Người trả tiền (end user) | Thanh toán trên trang của provider | Không tương tác trực tiếp với PGS (chỉ qua redirect) |

**Ràng buộc:**

- Thuần backend, không có UI (kể cả Admin UI); giao tiếp qua HTTPS/JSON. Bản đầu chỉ kết nối VNPay sandbox; lên production chỉ đổi cấu hình. Bản sandbox chưa làm IPN.
- Công nghệ: Node.js LTS + TypeScript + Express.js (phân lớp route → controller → service → repository); thư viện lehuygiang28/vnpay (chỉ chạy trên Node.js) cho tạo URL thanh toán, verify return/IPN, queryDr, refund; Prisma + PostgreSQL; đóng gói Docker.
- Không lưu dữ liệu thẻ; mọi thao tác nhập thẻ diễn ra trên trang của provider (hosted checkout).
- Phải tuân theo đặc tả và giới hạn của từng provider (định dạng số tiền, thời hạn giao dịch, IP whitelist).

**Giả định:**

- Client systems là hệ thống nội bộ tin cậy, có endpoint nhận webhook công khai qua HTTPS.
- Mỗi provider có môi trường sandbox để phát triển và kiểm thử.
- Tiền tệ VND (VNPay chỉ nhận VND); đa tiền tệ khi có provider khác.

## 3. Yêu cầu chức năng

Mức ưu tiên: **M** = bắt buộc (MVP), **S** = nên có, **C** = có thể làm sau.

### 3.1 Quản lý client system

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-CL-01 | Admin tạo/sửa/vô hiệu hóa client; mỗi client có `client_id`, API key và secret riêng | M |
| FR-CL-02 | Client đăng ký webhook URL và danh sách sự kiện muốn nhận | M |
| FR-CL-03 | Xoay vòng (rotate) secret mà không gián đoạn: secret cũ còn hiệu lực trong thời gian chuyển tiếp | S |
| FR-CL-04 | Cấu hình provider được phép dùng cho từng client (VD: client A chỉ VNPay + MoMo) | M |
| FR-CL-05 | Giới hạn IP gọi API theo client (IP allowlist) | C |

### 3.2 Cấu hình provider

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-PV-01 | Lưu thông tin kết nối (merchant code, key, endpoint) cho từng provider và môi trường (sandbox/production), mã hóa khi lưu | M |
| FR-PV-02 | Bật/tắt một provider mà không cần deploy lại | M |
| FR-PV-03 | Thêm provider mới chỉ bằng cách viết adapter mới theo interface chung, không sửa Payment Core | M |
| FR-PV-04 | Khai báo khả năng của provider (hỗ trợ refund? partial refund? tiền tệ? số tiền min/max) | S |

### 3.3 Tạo thanh toán

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-PM-01 | Client tạo payment với: `order_id`, số tiền, tiền tệ, provider, mô tả, `return_url`, metadata | M |
| FR-PM-02 | PGS gọi provider và trả về `payment_id` + `checkout_url` (hoặc QR / deeplink tuỳ provider) | M |
| FR-PM-03 | Bắt buộc header `Idempotency-Key`; cùng key + cùng body trả lại kết quả cũ, khác body trả lỗi 409 | M |
| FR-PM-04 | Một `order_id` của cùng client không được có hơn một payment thành công | M |
| FR-PM-05 | Payment có thời hạn (mặc định cấu hình được); quá hạn chuyển sang `EXPIRED` | M |
| FR-PM-06 | Client hủy payment đang chờ (`PENDING`) | S |
| FR-PM-07 | Cho phép tạo lại transaction mới (thử provider khác) cho payment chưa thành công | C |

### 3.4 Nhận kết quả từ provider

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-CB-01 | Endpoint return URL nhận redirect của người dùng từ VNPay; xác minh chữ ký (`verifyReturnUrl`) | M |
| FR-CB-02 | Chữ ký hợp lệ thì gọi queryDr để VNPay xác nhận trạng thái rồi mới cập nhật payment; không cập nhật chỉ dựa vào tham số redirect | M |
| FR-CB-03 | Đối chiếu số tiền và mã giao dịch với dữ liệu đã lưu; sai lệch thì đánh dấu cần xử lý tay | M |
| FR-CB-04 | Xử lý idempotent: cùng một kết quả nhận nhiều lần chỉ cập nhật trạng thái một lần | M |
| FR-CB-05 | Chuyển người dùng về `return_url` của client kèm `payment_id`; client lấy trạng thái qua webhook hoặc `GET /payments/{id}` | M |
| FR-CB-06 | Job queryDr cho payment PENDING quá N phút (người dùng đóng trình duyệt, không quay lại) | M |
| FR-CB-07 | Giai đoạn sau: endpoint IPN, xác minh chữ ký, xử lý idempotent, trả response đúng định dạng VNPay | C |

### 3.5 Webhook tới client

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-WH-01 | Gửi sự kiện `payment.succeeded`, `payment.failed`, `payment.expired`, `refund.succeeded`, `refund.failed` | M |
| FR-WH-02 | Ký webhook bằng HMAC-SHA256 với secret của client, kèm timestamp chống replay | M |
| FR-WH-03 | Retry với exponential backoff khi client không trả 2xx (số lần và khoảng cách cấu hình được) | M |
| FR-WH-04 | Lưu lịch sử gửi webhook; admin gửi lại thủ công | S |
| FR-WH-05 | Mỗi sự kiện có `event_id` duy nhất để client tự loại trùng | M |

### 3.6 Hoàn tiền

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-RF-01 | Client yêu cầu hoàn tiền toàn phần cho payment `SUCCEEDED` | M |
| FR-RF-02 | Hoàn tiền một phần, nhiều lần; tổng tiền hoàn không vượt số tiền đã thanh toán | S |
| FR-RF-03 | Refund cũng dùng `Idempotency-Key` | M |
| FR-RF-04 | Provider không hỗ trợ refund qua API → tạo refund trạng thái `MANUAL_REQUIRED` | S |

### 3.7 Truy vấn

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-QR-01 | Lấy chi tiết payment theo `payment_id` hoặc `order_id` (kèm transactions, refunds) | M |
| FR-QR-02 | Danh sách payment có lọc theo thời gian, trạng thái, provider; phân trang | S |
| FR-QR-03 | Client chỉ xem được dữ liệu của chính mình | M |

### 3.8 Đối soát

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-RC-01 | Job hằng ngày lấy dữ liệu giao dịch từ provider (API hoặc file) và so với PGS | S |
| FR-RC-02 | Ghi nhận sai lệch: có ở provider không có ở PGS, lệch trạng thái, lệch số tiền | S |
| FR-RC-03 | Báo cáo đối soát theo ngày, xuất CSV qua Admin API | C |

### 3.9 Hỗ trợ client làm subscription

PGS không lưu subscription. Client system tự quản lý gói, chu kỳ và việc gia hạn; mỗi lần cần thu tiền (kỳ đầu, gia hạn, mua một lần) client gọi `POST /payments` như một payment thường.

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-SB-01 | `metadata` của payment lưu nguyên văn và trả lại trong webhook, để client gắn `subscription_id`, `period` của riêng mình | M |
| FR-SB-02 | Truy vấn payment theo trường trong metadata (VD `metadata.subscription_id`) | S |

### 3.10 Yêu cầu cho instance dùng chung

| ID | Yêu cầu | Ưu tiên |
| --- | --- | --- |
| FR-MT-01 | Mọi bản ghi gắn `client_id`; mọi truy vấn lọc theo client từ API key, không tin `client_id` trong body | M |
| FR-MT-02 | PGS tự sinh mã gửi VNPay (`vnp_TxnRef`) duy nhất toàn hệ thống; `order_id` của client chỉ lưu để tra cứu, vì nhiều client có thể trùng `order_id` | M |
| FR-MT-03 | Mặc định các client dùng chung một merchant VNPay; cho phép gán merchant riêng cho từng client | S |
| FR-MT-04 | Thêm client mới chỉ bằng Admin API hoặc lệnh CLI (seed), không deploy lại | M |
| FR-MT-05 | Rate limit và quota theo từng client để một hệ thống không làm nghẽn hệ thống khác | S |

## 4. Thiết kế API & luồng nghiệp vụ

Tất cả endpoint có tiền tố `/api/v1`, dùng JSON, số tiền là số nguyên theo đơn vị nhỏ nhất của tiền tệ (VND: đồng; USD: cent).

### 4.1 Danh sách endpoint

| Method | Path | Mô tả | Gọi bởi |
| --- | --- | --- | --- |
| POST | `/payments` | Tạo payment, trả `checkout_url` | Client |
| GET | `/payments/{payment_id}` | Chi tiết payment | Client |
| GET | `/payments?order_id=&status=&from=&to=` | Danh sách, lọc, phân trang | Client |
| POST | `/payments/{payment_id}/cancel` | Hủy payment đang chờ | Client |
| POST | `/payments/{payment_id}/refunds` | Tạo refund | Client |
| GET | `/refunds/{refund_id}` | Chi tiết refund | Client |
| GET | `/providers` | Provider client được dùng + khả năng | Client |
| POST | `/callbacks/{provider}/ipn` | Nhận IPN (giai đoạn sau) | Provider |
| GET | `/callbacks/{provider}/return` | Nhận redirect, chuyển về `return_url` | Trình duyệt người dùng |
| \* | `/admin/clients`, `/admin/providers`, `/admin/webhooks/{id}/resend`, `/admin/reconciliations` | Quản trị | Admin |
| GET | `/health` | Health check | Hạ tầng |

### 4.2 Xác thực request từ client

Mỗi request gửi các header: `X-Client-Id`, `X-Timestamp`, `X-Signature` = HMAC-SHA256(secret, `method + path + timestamp + body`), và `Idempotency-Key` với POST. Request lệch thời gian quá 5 phút bị từ chối.

### 4.3 Ví dụ tạo payment

```json
POST /api/v1/payments
{
  "order_id": "ORD-2026-000123",
  "amount": 150000,
  "currency": "VND",
  "provider": "vnpay",
  "description": "Thanh toan don hang 123",
  "return_url": "https://shop.example.com/payment/result",
  "expires_in": 900,
  "metadata": { "customer_id": "C001" }
}

201 Created
{
  "payment_id": "pay_01J...",
  "status": "PENDING",
  "checkout_url": "https://sandbox.vnpayment.vn/...",
  "expires_at": "2026-10-21T16:15:00Z"
}
```

### 4.4 Định dạng lỗi

Mọi lỗi trả cùng cấu trúc `{ "error": { "code", "message", "details" } }`.

| HTTP | code | Khi nào |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Thiếu/sai trường |
| 401 | `INVALID_SIGNATURE` | Sai chữ ký hoặc timestamp |
| 403 | `PROVIDER_NOT_ALLOWED` | Client không được dùng provider này |
| 404 | `NOT_FOUND` | Không tìm thấy payment/refund |
| 409 | `IDEMPOTENCY_CONFLICT` / `INVALID_STATE` | Trùng key khác body / thao tác không hợp lệ với trạng thái |
| 422 | `REFUND_EXCEEDS_AMOUNT` | Tổng hoàn vượt số tiền đã trả |
| 502 | `PROVIDER_ERROR` | Provider trả lỗi |
| 504 | `PROVIDER_TIMEOUT` | Provider không phản hồi |

### 4.5 Vòng đời payment

&#91;embedded content: vòng đời payment · 7 trạng thái\]

PENDING là trạng thái duy nhất còn thay đổi được trước thanh toán; FAILED, EXPIRED, CANCELLED là trạng thái cuối. Mọi lần chuyển trạng thái được ghi vào `payment_status_history`; chuyển không hợp lệ trả `INVALID_STATE`.

### 4.6 Luồng thanh toán chuẩn

&#91;embedded content: luồng thanh toán sandbox · 9 bước\]

PGS tự ký URL thanh toán bằng thư viện, không gọi VNPay ở bước 1–2. Bước 6–8 quyết định kết quả: PGS xác minh chữ ký redirect, hỏi lại VNPay bằng queryDr, cập nhật trạng thái rồi bắn webhook. Nếu người dùng không quay lại, job queryDr (FR-CB-06) làm thay bước 5. Khi có IPN, VNPay sẽ chủ động báo cho PGS thay cho bước 6–7.

## 5. Mô hình dữ liệu

Các bảng cốt lõi; mọi bảng có thêm `created_at`, `updated_at`. Trường nhạy cảm (secret, key provider) được mã hóa.

| Bảng | Trường chính | Quan hệ / ràng buộc |
| --- | --- | --- |
| `clients` | id, name, api\_key\_hash (SHA-256), secret\_encrypted (AES-256-GCM), webhook\_url, webhook\_events, status | 1 client – n payments |
| `providers` | code (vnpay, momo…), name, capabilities (JSON), status |  |
| `provider_configs` | id, provider\_code, environment, credentials (mã hóa), status | n–1 providers |
| `client_providers` | client\_id, provider\_code, is\_enabled | PK (client\_id, provider\_code) |
| `payments` | id, client\_id, order\_id, amount, currency, status, provider\_code, description, return\_url, metadata, expires\_at, paid\_at | Unique (client\_id, order\_id) cho trạng thái SUCCEEDED |
| `transactions` | id, payment\_id, provider\_code, provider\_txn\_id, amount, status, raw\_request, raw\_response | n–1 payments; unique (provider\_code, provider\_txn\_id) |
| `refunds` | id, payment\_id, amount, reason, status, provider\_refund\_id | n–1 payments |
| `provider_callbacks` | id, provider\_code, payload, signature\_valid, processed, received\_at | Lưu nguyên văn IPN để đối chiếu |
| `webhook_events` | id (event\_id), client\_id, type, payload, status, attempts, next\_retry\_at, last\_response | n–1 clients |
| `idempotency_keys` | client\_id, key, request\_hash, response, expires\_at | PK (client\_id, key); hết hạn sau 24h |
| `payment_status_history` | id, payment\_id, from\_status, to\_status, source (api/ipn/job/admin) | Audit mọi lần đổi trạng thái |
| `reconciliation_items` | id, date, provider\_code, provider\_txn\_id, issue\_type, resolved |  |

Cột bổ sung cho instance dùng chung:

| Bảng | Trường chính | Quan hệ / ràng buộc |
| --- | --- | --- |
| `payments` (thêm cột) | provider\_txn\_ref | Unique toàn hệ thống (FR-MT-02) |
| `clients` (thêm cột) | provider\_config\_id (nullable) | Null = dùng merchant chung (FR-MT-03) |
| Schema `pgboss` | Do pg-boss tự tạo | Hàng đợi webhook và job queryDr |

## 6. Yêu cầu phi chức năng

Các con số dưới đây là mục tiêu đề xuất cho bản đầu, cần chốt lại theo tải thực tế.

| ID | Nhóm | Yêu cầu |
| --- | --- | --- |
| NFR-SEC-01 | Bảo mật | Chỉ HTTPS (TLS 1.2+); xác thực client bằng API key + HMAC |
| NFR-SEC-02 | Bảo mật | Credentials provider và secret client mã hóa hai chiều khi lưu (AES-256-GCM) vì cần giá trị gốc để ký/verify HMAC; API key chỉ lưu hash SHA-256, khóa nằm trong biến môi trường của server, không nằm trong source code |
| NFR-SEC-03 | Bảo mật | Xác minh chữ ký mọi dữ liệu VNPay trả về (return URL; IPN khi có); tùy provider thêm IP allowlist |
| NFR-SEC-04 | Bảo mật | Không lưu/ghi log dữ liệu thẻ; che (mask) dữ liệu nhạy cảm trong log |
| NFR-SEC-05 | Bảo mật | Rate limit theo client (VD 100 req/giây) |
| NFR-PER-01 | Hiệu năng | API nội bộ (không tính thời gian provider) p95 < 200 ms |
| NFR-PER-02 | Hiệu năng | Timeout gọi provider cấu hình được, mặc định 30 giây |
| NFR-PER-03 | Hiệu năng | Webhook được gửi lần đầu trong vòng 5 giây sau khi trạng thái đổi |
| NFR-REL-01 | Độ tin cậy | Không mất sự kiện: cập nhật trạng thái và ghi webhook event trong cùng một transaction DB (outbox pattern) |
| NFR-REL-02 | Độ tin cậy | Không trùng giao dịch: idempotency cho API, IPN và xử lý job; dùng lock theo payment khi đổi trạng thái |
| NFR-REL-03 | Độ tin cậy | Mục tiêu sẵn sàng 99.9%/tháng; service stateless, chạy nhiều instance |
| NFR-REL-04 | Độ tin cậy | Circuit breaker và retry có giới hạn khi gọi provider (thư viện opossum) |
| NFR-OBS-01 | Giám sát | Log có cấu trúc (JSON) kèm `correlation_id` xuyên suốt request → provider → webhook |
| NFR-OBS-02 | Giám sát | Metrics: số payment theo trạng thái/provider, tỉ lệ lỗi provider, webhook thất bại; cảnh báo khi vượt ngưỡng |
| NFR-OBS-03 | Giám sát | Audit log mọi thao tác admin và mọi lần đổi trạng thái, lưu tối thiểu 5 năm |
| NFR-EXT-01 | Mở rộng | Thêm provider = thêm một adapter + cấu hình, không sửa code các phần khác |
| NFR-EXT-02 | Mở rộng | API có version (`/v1`); thay đổi phá vỡ tương thích phải lên version mới |
| NFR-MNT-01 | Bảo trì | Tài liệu API bằng OpenAPI/Swagger; unit test cho Core và từng adapter, coverage ≥ 70% |
| NFR-MNT-02 | Bảo trì | Cung cấp SDK dạng npm package để các hệ thống sau tích hợp nhanh (ký request, verify webhook) |
| NFR-DEP-01 | Triển khai | Đóng gói Docker; cấu hình qua biến môi trường; tách môi trường dev / staging (sandbox provider) / production |

## 7. Phạm vi phát hành & câu hỏi mở

**Quyết định đã chốt (21/10/2026):**

| Câu hỏi | Quyết định |
| --- | --- |
| Provider cho MVP | VNPay, chỉ sandbox; dùng thư viện [lehuygiang28/vnpay](https://github.com/lehuygiang28/vnpay) |
| Vai trò của PGS | Chỉ đứng giữa client và provider; không lưu subscription, client tự quản lý và gọi tạo payment mỗi kỳ |
| Hệ thống tích hợp đầu tiên | Hệ thống cá nhân của chủ dự án, bán subscription (một lần hoặc định kỳ) |
| Framework | Express.js + TypeScript |
| IPN | Chưa làm; bản sandbox xác nhận kết quả bằng return URL + queryDr |
| CSDL | PostgreSQL |
| Mô hình triển khai | Một instance dùng chung cho mọi hệ thống, scale ngang khi cần |
| Admin UI | Không làm; quản trị qua Admin API và lệnh CLI |

**Đề xuất tham số vận hành** (cấu hình được qua biến môi trường):

| Tham số | Giá trị đề xuất |
| --- | --- |
| Thời hạn payment | 15 phút |
| Job queryDr | Chạy mỗi phút cho payment PENDING quá 5 phút, và một lần trước khi đánh dấu EXPIRED |
| Retry webhook | 8 lần trong khoảng 22 giờ: ngay, +1 phút, +5 phút, +15 phút, +1 giờ, +3 giờ, +6 giờ, +12 giờ; sau đó FAILED, gửi lại qua Admin API |
| Timeout client nhận webhook | 10 giây |
| Lệch timestamp tối đa | 5 phút |
| Lưu idempotency key | 24 giờ |

**Giai đoạn phát hành:**

| Giai đoạn | Nội dung |
| --- | --- |
| MVP (sandbox) | Yêu cầu mức M; VNPay sandbox; kết quả qua return URL + queryDr; Admin API + CLI seed client; chạy local |
| Giai đoạn 2 | IPN; deploy public; yêu cầu mức S: partial refund, đối soát, rotate secret, merchant riêng theo client, SDK npm |
| Giai đoạn 3 | VNPay production; yêu cầu mức C và provider mới (MoMo, Stripe…) |

**Câu hỏi còn mở:**

- [ ] Có mua domain riêng không (cần khi bật IPN, xem mục 8)?

## 8. Triển khai

Giai đoạn sandbox: chạy API + PostgreSQL bằng Docker Compose ngay trên máy cá nhân, chi phí 0 đồng. Chưa có IPN nên VNPay không cần gọi vào service; return URL là redirect của trình duyệt nên chạy `localhost` vẫn được.

**Khi nào cần server public:** khi client system chạy ở nơi khác cần gọi PGS và nhận webhook, hoặc khi bật IPN (VNPay cần URL HTTPS cố định, luôn bật). Nền tảng free tự ngủ khi rảnh sẽ làm IPN chậm hoặc timeout, nên phương án A phù hợp hơn C.

| Phương án | Chi phí | Ưu điểm | Nhược điểm |
| --- | --- | --- | --- |
| **A. Oracle Always Free VM** + Docker Compose + Cloudflare Tunnel (đề xuất) | 0 đồng | Luôn bật, không hết hạn; ARM hiện còn 2 OCPU / 12 GB RAM, dư cho API + Postgres | Đăng ký cần thẻ để xác minh; tự quản trị server và backup; Oracle vừa giảm một nửa hạn mức free (10/2026), có thể còn đổi |
| **B. Máy cá nhân** + Docker Compose + Cloudflare Tunnel | 0 đồng | Đơn giản nhất; dùng luôn cho môi trường dev | Máy phải bật liên tục; mất điện hoặc mạng là mất IPN |
| **C. PaaS free** (Render, Koyeb…) + Neon Postgres free | 0 đồng | Không quản trị server | Instance free ngủ khi rảnh; Neon free: 1 GB/project, 100 CU-giờ/tháng, compute ngủ sau 5 phút |

Cách dùng: sandbox chạy theo B (không cần tunnel nếu client cùng máy); khi cần public thì chuyển sang A. Code không phụ thuộc nền tảng, chuyển giữa A, B, C chỉ đổi biến môi trường.

**URL cố định (cần khi bật IPN):** Quick Tunnel của Cloudflare không cần domain nhưng đổi URL mỗi lần chạy, nên chỉ hợp để test nhanh. URL IPN cố định cần named tunnel gắn với một domain quản lý trên Cloudflare (VD `pay.<domain>`).

**Các bước triển khai:**

1. Dockerfile multi-stage cho API; `docker-compose.yml` gồm `api`, `postgres` (có volume), `cloudflared`.
2. Biến môi trường: `DATABASE_URL`, `VNP_TMN_CODE`, `VNP_HASH_SECRET`, `VNP_HOST` (sandbox), `ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `TUNNEL_TOKEN`.
3. Khi container khởi động chạy `prisma migrate deploy` rồi mới start API.
4. CI/CD: GitHub Actions build image → đẩy lên GitHub Container Registry → SSH vào VM chạy `docker compose pull && docker compose up -d`.
5. Backup: cron `pg_dump` hằng ngày, giữ 7 bản, sao chép ra ngoài VM.
6. Giám sát: endpoint `/health` + một dịch vụ uptime monitor miễn phí báo khi service chết.

**Lộ trình scale** khi có nhiều hệ thống: tách PostgreSQL sang dịch vụ managed → chạy nhiều bản API sau load balancer (API stateless, lock và hàng đợi nằm trong Postgres) → thêm Redis/RabbitMQ khi Postgres thành nút nghẽn.

### Nguồn

- [lehuygiang28/vnpay – GitHub](https://github.com/lehuygiang28/vnpay)
- [Neon pricing](https://neon.com/pricing)
- [FreeTierWatch – Oracle halved its free tier](https://buttondown.com/freetierwatch/archive/oracle-quietly-halved-its-famous-free-tier-and/)
