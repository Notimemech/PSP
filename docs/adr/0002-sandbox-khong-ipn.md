# ADR 0002 — Bản sandbox không làm IPN; xác nhận bằng return URL + queryDr

- **Trạng thái:** Accepted
- **Ngày:** 2026-10-21

## Bối cảnh

VNPay báo kết quả giao dịch qua hai kênh:

- **Return URL:** VNPay redirect *trình duyệt người dùng* về PGS kèm tham số `vnp_*` có chữ ký `vnp_SecureHash`.
- **IPN:** VNPay gọi *server-to-server* tới một URL HTTPS cố định, công khai, luôn bật của merchant.

Bản MVP chạy local bằng Docker Compose trên máy cá nhân (SRS mục 8, phương án B), không có domain và URL public cố định (câu hỏi mở về domain trong SRS mục 7 chưa chốt). Return URL là redirect của trình duyệt nên `localhost` vẫn hoạt động; IPN thì không thể nhận được.

## Quyết định

- Bản sandbox **không có endpoint IPN**. Không mount `POST /api/v1/callbacks/{provider}/ipn` (FR-CB-07 để giai đoạn 2).
- Kết quả giao dịch được xác nhận bằng:
  1. `GET /api/v1/callbacks/vnpay/return`: verify chữ ký (`verifyReturnUrl`) → gọi **queryDr** → đối chiếu số tiền, `vnp_TxnRef`, `vnp_TmnCode` → cập nhật trạng thái + ghi webhook event trong cùng transaction (FR-CB-01..05).
  2. **Job queryDr** chạy mỗi phút cho payment `PENDING` quá 5 phút (FR-CB-06), và một lần cuối trước khi job expire đánh dấu `EXPIRED`.
- Không bao giờ cập nhật trạng thái chỉ dựa vào tham số redirect, kể cả khi chữ ký hợp lệ.

## Hệ quả

Rủi ro khi không có IPN và cách giảm thiểu:

| Rủi ro | Giảm thiểu |
| --- | --- |
| Người dùng đóng trình duyệt, mất mạng hoặc không quay lại sau khi trả tiền → PGS không nhận redirect | Job queryDr chủ động hỏi VNPay mỗi phút cho payment PENDING quá 5 phút; job expire gọi queryDr một lần cuối trước khi EXPIRED. Kết quả đến chậm hơn (vài phút thay vì tức thì). |
| Redirect đi qua trình duyệt nên **có thể bị giả mạo/sửa** (đổi `vnp_Amount`, `vnp_ResponseCode`, `vnp_TxnRef`, phát lại URL cũ) | Luôn verify chữ ký; chữ ký hợp lệ vẫn phải gọi queryDr và lấy kết quả từ queryDr làm căn cứ; đối chiếu số tiền/mã với dữ liệu đã lưu, sai lệch → cờ `needs_review`; cập nhật idempotent (chỉ chuyển từ PENDING, có lock). |
| Tăng số lần gọi queryDr tới VNPay (mỗi redirect + job định kỳ) | Job chỉ chọn payment PENDING quá N phút và chưa hết hạn, xử lý theo lô; timeout + retry có giới hạn. Tải sandbox thấp. |
| Payment đã EXPIRED nhưng VNPay thực ra đã thu tiền (người dùng trả tiền sát hạn) | queryDr cuối trước khi expire; nếu vẫn lọt → `needs_review`, xử lý tay (sau này có đối soát FR-RC-01). |
| Webhook tới client trễ hơn so với khi có IPN | Chấp nhận ở sandbox; client có thể gọi `GET /api/v1/payments/{id}` sau khi người dùng quay về `return_url`. |

Tích cực: không cần server public, tunnel hay domain; chi phí 0 đồng; bề mặt tấn công nhỏ hơn (không có endpoint server-to-server công khai).

## Điều kiện để bật IPN

Theo SRS mục 8, bật IPN (giai đoạn 2) khi đủ các điều kiện:

1. Có **URL HTTPS cố định, luôn bật**: named Cloudflare Tunnel gắn với một domain quản lý trên Cloudflare (vd `pay.<domain>`) — cần chốt câu hỏi mở về mua domain. Quick Tunnel đổi URL mỗi lần chạy nên chỉ dùng để thử nhanh.
2. Chạy trên hạ tầng luôn bật, ưu tiên **phương án A** (Oracle Always Free VM + Docker Compose + Cloudflare Tunnel); tránh PaaS free tự ngủ (phương án C) vì IPN sẽ chậm hoặc timeout; phương án B (máy cá nhân) mất IPN khi tắt máy/mất mạng.
3. Đăng ký URL IPN với VNPay (sandbox trước, production ở giai đoạn 3).
4. Cài endpoint `POST /api/v1/callbacks/vnpay/ipn` theo FR-CB-07: verify chữ ký, lưu nguyên văn vào `provider_callbacks`, xử lý idempotent dùng chung service với return URL, trả response đúng định dạng VNPay; cân nhắc IP allowlist (NFR-SEC-03).
5. Có audit bảo mật (`security-auditor` + `security-verifier`) cho endpoint IPN trước khi bật.

Khi đã có IPN: return URL chỉ còn nhiệm vụ verify + redirect người dùng; IPN thay cho bước 6–7 của luồng chuẩn; job queryDr vẫn giữ làm lưới an toàn.

## Các phương án đã cân nhắc

| Phương án | Lý do không chọn |
| --- | --- |
| Làm IPN ngay với Quick Tunnel | URL đổi mỗi lần chạy, phải cập nhật cấu hình VNPay liên tục; không ổn định. |
| Làm IPN ngay trên VM public | Tốn công vận hành sớm khi chưa có client ở nơi khác; chưa chốt domain. |
| Chỉ tin return URL (verify chữ ký, không queryDr) | Không xử lý được người dùng không quay lại; phụ thuộc vào kênh do trình duyệt kiểm soát; vi phạm FR-CB-02. |
| Chỉ dùng job queryDr, bỏ xử lý ở return URL | Kết quả trễ tới vài phút cho cả trường hợp bình thường; trải nghiệm client kém. |
