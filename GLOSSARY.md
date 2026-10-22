# Payment Gateway Service

PGS đứng giữa các hệ thống cá nhân và các cổng thanh toán bên ngoài: nhận yêu cầu thu tiền, chuyển sang cổng, xác nhận kết quả và báo lại.

## Bên tham gia

**Client**:
Một hệ thống cá nhân dùng chung instance PGS; mọi dữ liệu thuộc về đúng một client.
_Avoid_: tenant, merchant, user

**Provider**:
Cổng thanh toán bên ngoài (VNPay, MoMo…) nơi người trả tiền thực sự thanh toán.
_Avoid_: gateway, cổng (trong code)

**Payer**:
Người trả tiền trên trang của provider; không tương tác trực tiếp với PGS.
_Avoid_: customer, end user

## Thanh toán

**Order**:
Đơn hàng thuộc về client, chỉ được PGS biết qua `order_id`; một order có thể có nhiều payment nhưng tối đa một payment đã thanh toán.
_Avoid_: invoice, đơn

**Payment**:
Một yêu cầu thu một số tiền cố định cho một order, có thời hạn và đi qua vòng đời trạng thái.
_Avoid_: transaction, charge

**Transaction**:
Một lần thử thực hiện payment trên một provider.
_Avoid_: payment, attempt

**Provider reference**:
Mã do PGS sinh và gửi cho provider để định danh payment, duy nhất toàn hệ thống (với VNPay là `vnp_TxnRef`).
_Avoid_: order id, txn id

**Paid**:
Payment đã được provider xác nhận thu tiền; gồm cả payment sau đó bị hoàn tiền.
_Avoid_: completed, done

**Needs review**:
Đánh dấu payment có kết quả từ provider không khớp dữ liệu PGS hoặc không xác định, phải được người xử lý tay.
_Avoid_: error, suspicious state

## Nhận kết quả

**Return**:
Lượt trình duyệt của payer được provider chuyển về PGS sau khi thanh toán; chỉ là gợi ý, không phải kết quả.
_Avoid_: callback, IPN, redirect result

**Confirmation**:
Việc PGS hỏi lại provider để biết kết quả thật của payment trước khi đổi trạng thái.
_Avoid_: verify, check

**Event**:
Thông báo một thay đổi của payment mà PGS sẽ gửi cho client, có định danh duy nhất.
_Avoid_: webhook (là kênh gửi, không phải thứ được gửi), notification
