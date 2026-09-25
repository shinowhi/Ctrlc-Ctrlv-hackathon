# Kịch bản kiểm tra FinRef

## Phạm vi

- Hóa đơn đầu vào: PDF có chữ chọn/copy hoặc PDF scan dạng ảnh. Đơn đề nghị: PDF/JPG/PNG. Mỗi file tối đa 10 MB.
- Tổng thanh toán trên form phải là tổng đã gồm VAT. Ngưỡng chuyển cấp là **lớn hơn 20.000.000 VND**; đúng 20 triệu vẫn ở quản lý tài chính.
- AI trích xuất dữ kiện, tính toán và gợi ý tuyến. Chỉ người có quyền mới tạo trạng thái `APPROVED`.
- Hạn mức demo 200.000.000 đồng/tháng, cảnh báo từ 160.000.000 đồng; chỉ hồ sơ đã duyệt mới được tính. Luồng online cần migration ngân sách; chính sách chi tiết/U2 vẫn chưa được đối chiếu. CLEAR chỉ xác nhận các kiểm tra hiện có.
- AI không xác nhận tính xác thực của hóa đơn, nguồn phát hành hoặc chữ ký số.

## Chạy kiểm tra cục bộ

```powershell
npm run smoke
node --test tests/*.test.cjs
```

`npm run smoke` chạy 5 ca luật cốt lõi; `npm test` chạy bộ unit test. Các lệnh này không xác nhận OpenAI, Supabase thật hoặc deployment đã hoạt động.

## Ca luồng online

| ID | Tiền điều kiện và thao tác | Kết quả mong đợi |
|---|---|---|
| SC-01 | Mở `demo.html`, chọn ba role và chạy Verify | Demo ghi rõ đang mô phỏng; không báo AI đã đọc file hoặc chính sách đã được kiểm tra. Phần ngân sách chỉ mô phỏng số liệu lưu trong trình duyệt. |
| SC-02 | Đăng nhập ba tài khoản mẫu, xem danh sách và quyền đọc file | Applicant chỉ thấy hồ sơ của mình; treasurer xử lý hàng đợi tài chính; CFO chỉ thấy hồ sơ đã chuyển cấp. |
| SC-03 | Gửi hồ sơ với PDF đọc rõ, các trường và tổng gồm VAT khớp; chạy OpenAI analysis | Hồ sơ vào `READY_FOR_APPROVAL`; chưa phải `APPROVED`. Quản lý tài chính bấm duyệt để chuyển thành `APPROVED`; nhật ký lưu người duyệt. |
| SC-04 | Gửi hồ sơ có tổng thanh toán gồm VAT là 20.000.001 | Hồ sơ vào `CFO_REVIEW`; chỉ người đứng đầu nhánh tài chính có thể bấm duyệt cuối. |
| SC-05 | Dùng PDF mờ, thiếu trường, sai số/ngày hoặc tổng VAT không khớp | Hồ sơ vào `NEEDS_INFO` với câu hỏi/lý do cụ thể; người nộp bổ sung và gửi lại. |
| SC-06 | Tắt cấu hình AI và gửi hồ sơ | Hồ sơ vẫn được lưu ở `TREASURER_REVIEW`; quản lý tài chính có thể kiểm tra thủ công các dữ kiện hóa đơn trước khi duyệt/chuyển cấp. |

SC-03–SC-05 cần PDF mẫu được phép sử dụng, OpenAI API và Supabase thử nghiệm. Kết quả từng ca cần được ghi lại riêng; bộ luật cục bộ không thay thế các ca này.

## 15 ca luật cục bộ

Các ca tương ứng với `FinRefRules.verify()`. Hàm nhận tổng thanh toán (số nguyên VND) và các cờ `pdf`, `fieldsMatch`, `totalsConsistent`, `confidenceSufficient`. Hệ thống ưu tiên U1 khi thiếu/không chắc dữ kiện; nếu các kiểm tra hiện có đều đạt thì tổng trên 20 triệu là U3, còn lại là CLEAR.

| Nhóm | Ca cần có |
|---|---|
| CLEAR | Số tiền dương; đúng 20 triệu; PDF scan có thể đọc được khi đủ confidence và trường khớp. |
| U3 | Tổng thanh toán lớn hơn 20 triệu, gồm VAT. |
| U1 | Thiếu/không khớp nhà cung cấp, số hóa đơn, ngày hóa đơn hoặc tổng form; phép tính tiền trước thuế + VAT sai; confidence dưới 95%; không phải PDF; số tiền không hợp lệ. |
| Chưa hỗ trợ | U2 không thể chạy thành kết luận cho đến khi có dữ liệu policy/ngân sách. |

Verify trong UI là preview luật; nó không gửi PDF đến AI và không ghi quyết định vào database.

## Acceptance với Supabase thật

Sau khi tạo Supabase project và ba tài khoản thử nghiệm, cấu hình `SUPABASE_URL` và `SUPABASE_ANON_KEY`, sau đó chạy:

```powershell
node scripts/test-online.cjs
```

Script kiểm tra RLS, file riêng tư, chặn người dùng tự sửa role/status, phiên bản đồng thời, ngưỡng tiền, chuyển cấp, bổ sung và audit log. Nó không kiểm tra độ chính xác OCR/LLM. Không chạy trên dữ liệu nghiệp vụ thật; chỉ dùng fixture tổng hợp.

Mỗi lần chạy cần lưu ngày giờ, mã hồ sơ, trạng thái thực tế và ảnh/output liên quan. Không dùng dữ liệu đánh giá cuối để điều chỉnh ngưỡng confidence.
