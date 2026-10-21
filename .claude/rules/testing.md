---
paths:
  - "tests/**"
---

# Quy tắc viết test

## Công cụ

- Vitest cho mọi test; Supertest gọi trực tiếp app tạo bằng `createApp(deps)` (export từ `src/app.ts`), không mở port.
- Không thêm thư viện test khác (nock, msw, testcontainers...) khi chưa hỏi user.

## Môi trường test

- Vitest setup đặt **giá trị giả cố định** cho `VNP_HASH_SECRET`, `VNP_TMN_CODE`, `ENCRYPTION_KEY`, `ADMIN_API_KEY` (≥ 32 ký tự) và các tham số vận hành. Không đọc `.env`.
- Chỉ `DATABASE_URL_TEST` được đọc từ biến môi trường của shell. Nếu chưa đặt, setup dùng mặc định `postgresql://pgs:change_me@localhost:5432/pgs_test` (khớp `DATABASE_URL_TEST` trong `.env.example`; docker compose ở Phase 2 phải dùng cùng user/password `pgs`/`change_me`).
- `globalSetup` chạy `prisma migrate deploy` trên DB test trước khi chạy test.

## Cơ sở dữ liệu

- Test integration/security chạy trên **Postgres thật**: `docker compose up -d postgres`.
- Dùng DB test riêng (`DATABASE_URL_TEST`); không bao giờ chạy test trên DB dev.
- Không mock Prisma/repository trong integration test.

## Chữ ký: không mock

- Không mock hoặc bỏ qua middleware HMAC. Helper ký request thật bằng secret của client test (seed trong test).
- Không mock `verifyReturnUrl` hay hàm hash của thư viện `vnpay`. Return URL giả lập phải được ký thật bằng hash secret sandbox giả dùng cho test.
- Chỉ được stub **tầng HTTP transport** (hàm `fetch`) mà `VnpayAdapter` nhận qua dependency injection. Không thay thế adapter/provider bằng bản giả.
  - Response queryDr/refund giả trả từ transport stub cũng phải được **ký thật** bằng hash secret test, để code verify chữ ký response chạy thật.
- Không bao giờ gọi host VNPay production (hook `guard.mjs` chặn).
- Test chữ ký phải có ca âm: sai chữ ký, sửa body sau khi ký, timestamp lệch > 5 phút, sửa `vnp_Amount`/`vnp_TxnRef`, response queryDr ký sai.

## Cấu trúc thư mục

```
tests/
  unit/                 # logic thuần: money, crypto, state machine, mapper; không cần DB
  integration/          # API qua Supertest + Postgres thật
  security/             # test tái hiện finding; giữ làm regression
    helpers/            # helper riêng cho test bảo mật
    open-findings.json  # do security-verifier quản lý
  helpers/              # sign-request, seed client/payment, vnpay-sign, db reset
```

- Tên file: `<đối-tượng>.test.ts`.
- Test bảo mật: `tests/security/<finding-id>.test.ts` (ví dụ `AUD-20261021-01.test.ts`); mô tả lỗ hổng đặt trong `describe('<finding-id>: <mô tả>')`.
- `npm run test:security` chỉ chạy `tests/security`.

## Cơ chế `open-findings.json`

- Danh sách finding **Medium/Low** đã CONFIRMED mà user chấp nhận để lại chưa sửa. Chỉ `security-verifier` được sửa file này. Không bao giờ chứa High/Critical.
- Định dạng: mảng object, vitest config đọc trường `.id`:
  ```json
  [{ "id": "AUD-20261021-01", "severity": "Medium", "accepted_by_user": "2026-10-21", "report": "docs/security/reports/<tên>-verification.md" }]
  ```
- Hiện tại (C4 chờ chốt) file phải là `[]`: mọi finding CONFIRMED phải được sửa.
- Test của các ID này vẫn fail có chủ đích (chứng minh lỗ hổng còn). Vitest config loại chúng khỏi `npm test`; `npm run test:security` vẫn chạy và chỉ được fail ở đúng các ID này.
- Sửa xong một finding → test phải PASS và verifier xóa ID khỏi file.

## Dữ liệu test

- Mỗi test tự tạo và tự dọn dữ liệu của mình (`beforeEach`/`afterEach`, hoặc truncate bảng trong helper). Không phụ thuộc thứ tự chạy hay dữ liệu test khác để lại.
- Dùng `client_id`, `order_id`, `Idempotency-Key` ngẫu nhiên cho mỗi test.
- Số tiền trong test là integer.
- Không đặt secret thật trong test; chỉ dùng giá trị giả cố định.

## Phạm vi tối thiểu

- Core (service, state machine) và từng adapter có unit test; coverage ≥ 70% (NFR-MNT-01).
- Mỗi mục kiểm được bằng code trong `.claude/rules/security.md` có ít nhất một test chứng minh.
