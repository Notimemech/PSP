# Payment Gateway Service (PGS)

Backend service cung cấp một REST API thống nhất (`/api/v1`) để các client system tạo payment, hoàn tiền, truy vấn và nhận webhook, không cần tích hợp riêng từng cổng thanh toán. Bản đầu: VNPay sandbox, chạy local bằng Docker Compose, chưa có IPN.

Stack: Node.js 22 + TypeScript + Express, PostgreSQL + Prisma, pg-boss.

## Quick start

```bash
cp .env.example .env              # điền VNP_TMN_CODE, VNP_HASH_SECRET (sandbox), ENCRYPTION_KEY, ADMIN_API_KEY
docker compose up -d postgres     # chỉ chạy Postgres
npm install
npx prisma migrate dev
npm run seed:client -- --name demo
npm run dev

# hoặc chạy cả stack bằng Docker
docker compose up --build
```

Kiểm tra: `curl http://localhost:3000/api/v1/health`

Chạy test: `npm test` (cần Postgres). Test dùng DB riêng từ `DATABASE_URL_TEST`; nếu chưa đặt thì mặc định là `postgresql://pgs:change_me@localhost:5433/pgs_test`.

Lưu ý: hook bảo vệ của Claude Code chặn mọi lệnh đụng tới `.env` (kể cả `cp` ở trên), nên bạn tự tạo `.env` bằng tay.

## Chạy audit bảo mật trên local

Agent `security-auditor`/`security-verifier` gọi API local bằng 2 client test (để kiểm tra cách ly tenant). Agent bị cấm đọc `.env`, nên **không** đặt các biến dưới đây trong `.env`; export trong shell trước khi mở Claude Code:

```bash
npm run seed:client -- --name audit-a   # ghi lại client_id + secret in ra
npm run seed:client -- --name audit-b

export PGS_TEST_CLIENT_ID=<client_id của audit-a>
export PGS_TEST_SECRET=<secret của audit-a>
export PGS_TEST_CLIENT_ID_B=<client_id của audit-b>
export PGS_TEST_SECRET_B=<secret của audit-b>
# PowerShell: $env:PGS_TEST_CLIENT_ID = "..."
```

Sau đó chạy app (`npm run dev`) và yêu cầu Claude chạy `security-auditor`. Báo cáo nằm trong `docs/security/reports/`.

## Tài liệu

- [SRS](docs/srs.md): yêu cầu (nguồn đúng duy nhất)
- [Kiến trúc](docs/architecture.md) · [ADR](docs/adr/)
- [CLAUDE.md](CLAUDE.md): quy tắc cho AI/dev · [.claude/rules/](.claude/rules/)
- Báo cáo bảo mật: [docs/security/reports/](docs/security/reports/)
