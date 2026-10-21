# ADR 0001 — Express.js + PostgreSQL (Prisma) + pg-boss

- **Trạng thái:** Accepted
- **Ngày:** 2026-10-21

## Bối cảnh

PGS là backend thuần (không UI) đứng giữa client systems và các cổng thanh toán; bản đầu chỉ VNPay sandbox, chạy local bằng Docker Compose trên máy cá nhân, chi phí 0 đồng (SRS mục 7, 8). Yêu cầu chính ảnh hưởng tới lựa chọn công nghệ:

- Thư viện VNPay được chọn là `lehuygiang28/vnpay`, **chỉ chạy trên Node.js**.
- Cần transaction ACID cho đổi trạng thái payment + ghi webhook event cùng lúc (outbox, NFR-REL-01), lock theo payment (NFR-REL-02), idempotency key lưu 24h.
- Cần hàng đợi bền cho webhook retry (8 lần trong ~22 giờ), job queryDr mỗi phút và job expire.
- Service stateless, scale ngang khi cần (NFR-REL-03); một người phát triển, hạ tầng tối thiểu.

## Quyết định

- **Runtime:** Node.js 22 LTS + TypeScript strict.
- **HTTP framework:** Express.js, phân lớp route → controller → service → repository; adapter provider cài `IPaymentProvider`. Validate bằng zod.
- **CSDL:** PostgreSQL, truy cập qua Prisma (schema + migration). Idempotency, advisory lock / `SELECT ... FOR UPDATE` đều nằm trong Postgres.
- **Hàng đợi/job:** pg-boss (dùng schema `pgboss` trong cùng Postgres) cho webhook dispatch, queryDr PENDING, expire payment.
- **Không** dùng Redis/RabbitMQ ở MVP. Thư viện được phép: theo danh sách trong [`CLAUDE.md`](../../CLAUDE.md); phần không có thư viện (log JSON có mask, retry/timeout/circuit breaker) tự viết.

## Hệ quả

Tích cực:

- Một thành phần hạ tầng duy nhất (Postgres) → Docker Compose đơn giản, backup một chỗ, chạy được trên VM free (phương án A) hoặc máy cá nhân.
- Outbox thực hiện được trong cùng transaction với dữ liệu nghiệp vụ, vì hàng đợi nằm cùng DB → không mất sự kiện khi service chết giữa chừng.
- Tận dụng trực tiếp thư viện `vnpay` (tạo URL, verify return, queryDr, refund).
- Express ít "phép thuật", dễ cho AI agent và người đọc lần theo luồng request; dễ test bằng Supertest.

Tiêu cực / rủi ro:

- Express không áp đặt cấu trúc: phải giữ kỷ luật phân lớp bằng quy ước (`CLAUDE.md`, `.claude/rules/`) và review.
- Postgres gánh cả dữ liệu lẫn hàng đợi; khi tải lớn có thể thành nút nghẽn → lộ trình scale (SRS mục 8) là tách Postgres managed, rồi mới thêm Redis/RabbitMQ.
- Không dùng helmet/opossum/pino → phải tự viết và test các phần: header bảo mật cần thiết, log có mask, retry/timeout/circuit breaker. NFR-REL-04 (opossum) được thay bằng cài đặt tự viết.
- Prisma không hỗ trợ partial unique index trực tiếp trong schema → ràng buộc FR-PM-04 cần migration SQL viết tay.

## Các phương án đã cân nhắc

| Phương án | Lý do không chọn |
| --- | --- |
| NestJS | Nặng, nhiều decorator/DI; user đã chốt Express. Lợi ích cấu trúc có thể đạt bằng quy ước phân lớp. |
| Fastify | Nhanh hơn nhưng không cần cho tải MVP; Express phổ biến hơn, SRS đã chốt Express. |
| Ngôn ngữ khác (Go, Java, .NET) | Thư viện `vnpay` chỉ chạy trên Node.js; phải tự cài ký/verify VNPay. |
| TypeORM / Knex / Drizzle thay Prisma | Prisma có migration và type an toàn tốt, đã ghi trong SRS. Raw query vẫn dùng được qua `$queryRaw` có tham số. |
| Redis + BullMQ | Thêm một hạ tầng phải vận hành; không làm được outbox trong cùng transaction với Postgres. |
| RabbitMQ | Như trên, còn nặng hơn; quá mức cần cho tải MVP. |
| MySQL / MongoDB | Postgres có advisory lock, partial index, JSONB cho metadata và là nền của pg-boss. |
