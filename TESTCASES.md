# Kịch bản kiểm tra FinRef

## Phạm vi

- Hóa đơn đầu vào: PDF có chữ chọn/copy hoặc PDF scan dạng ảnh. Chỉ hóa đơn là file đính kèm bắt buộc; tối đa 10 MB.
- Form bắt buộc có `buyerCompany` là tên công ty/pháp nhân trên hóa đơn; không dùng tên người đề nghị hoặc phòng ban làm giá trị người mua.
- So khớp chính xác sau Unicode NFKC, chữ thường và gộp khoảng trắng. Mã số hóa đơn thuần bỏ số 0 đầu; mã có chữ giữ số 0, dấu `/`, `-`, `.`. Khác biệt dấu ở tên nhà cung cấp/người mua cần Quản lý xác nhận.
- Tổng thanh toán trên form phải là tổng cuối cùng trên hóa đơn. AI đánh giá hóa đơn đạt điều kiện thì hóa đơn **≤20.000.000 VND** vào hàng chờ Quản lý; hóa đơn **>20.000.000 VND** vào hàng Giám đốc. Hồ sơ gắn cờ cần Quản lý xử lý trước.
- Hóa đơn bán hàng chỉ cần tổng cuối cùng khớp form. Hóa đơn VAT mới bắt buộc cộng tiền trước thuế + VAT; chiết khấu chỉ được trừ trong phép tính khi hóa đơn ghi rõ tiền trước thuế là trước chiết khấu.
- Hàng chờ động gồm các hóa đơn đã đủ điều kiện nhưng chưa duyệt, không gom theo ngày nộp. Tổng **100.000.000 VND/ngày** tính chung toàn công ty, theo giờ Bangkok. `APPROVED` là chấp thuận khoản phải trả theo quy ước cuộc thi, không có chuyển khoản thật.
- Quản lý và Giám đốc có thể duyệt từng hóa đơn hoặc duyệt tất cả trong hàng của mình. Nếu toàn bộ đợt của Quản lý vượt hạn mức ngày, toàn bộ đợt chuyển `CFO_REVIEW`; Giám đốc cần ghi lý do khi duyệt.
- Hạn mức quyền duyệt không đồng nghĩa với ngân sách thật: ngân sách theo mã và chính sách chi tiêu vẫn chưa được đối chiếu. CLEAR chỉ xác nhận các kiểm tra hiện có.
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
| SC-01 | Mở `demo.html`, chọn ba role và chạy Verify | Demo ghi rõ đang mô phỏng; không báo AI đã đọc file hoặc đã kiểm tra policy/budget. |
| SC-02 | Đăng nhập ba tài khoản mẫu, xem danh sách và quyền đọc file | Applicant chỉ thấy hồ sơ của mình; treasurer thấy hàng chờ đủ điều kiện ≤20 triệu; CFO thấy hàng chờ >20 triệu và các hồ sơ được chuyển cấp. |
| SC-03 | Gửi hồ sơ với PDF đọc rõ, các trường và tổng cuối cùng khớp; chạy OpenAI analysis, số tiền ≤20 triệu | Hồ sơ vào `READY_FOR_APPROVAL`; Quản lý thấy trong hàng chờ mà không cần kiểm tra lại từng hóa đơn. Chưa có quyết định `APPROVED` cho tới khi người quản lý duyệt. |
| SC-04 | Gửi hồ sơ có tổng thanh toán gồm VAT là 20.000.001 | Nếu AI đánh giá đạt, hồ sơ vào `CFO_REVIEW` thẳng; Giám đốc duyệt và ghi lý do. Nếu dữ kiện bị gắn cờ, Quản lý xử lý trước rồi mới chuyển cấp. |
| SC-05 | Dùng PDF mờ, thiếu trường, sai số/ngày hoặc tổng VAT không khớp | Hồ sơ vào `TREASURER_REVIEW`; Quản lý Tài chính kiểm tra trước, có thể yêu cầu bổ sung, từ chối, hoặc duyệt/chuyển Giám đốc theo hạn mức. |
| SC-06 | Tắt cấu hình AI và gửi hồ sơ | Hồ sơ vẫn được lưu ở `TREASURER_REVIEW`; quản lý tài chính có thể kiểm tra thủ công các dữ kiện hóa đơn trước khi duyệt/chuyển cấp. |
| SC-07 | Tổng đã duyệt hôm nay là 80.000.000 ₫ rồi duyệt thêm 1 ₫ | Tổng đã vượt 80 triệu; Quản lý Tài chính thấy cảnh báo và số dư còn lại 19.999.999 ₫. |
| SC-08 | Tổng công ty đã duyệt hôm nay là 90 triệu; hàng Quản lý chờ một hóa đơn 10 triệu | Duyệt riêng hoặc duyệt tất cả được chấp nhận; tổng đúng 100 triệu. |
| SC-09 | Tổng công ty đã duyệt hôm nay là 90 triệu; hàng Quản lý chờ hai hóa đơn 6 triệu | Duyệt tất cả chuyển nguyên đợt lên `CFO_REVIEW`. Quản lý vẫn có thể duyệt riêng một hóa đơn 6 triệu trong phần ngân sách còn lại. |
| SC-10 | Giám đốc duyệt danh sách làm tổng ngày vượt 100 triệu | Bắt buộc có lý do; các hóa đơn được duyệt và vẫn cộng vào tổng toàn công ty trong ngày. |
| SC-11 | Một phần tử trong lệnh duyệt tất cả có phiên bản cũ, sai vai trò hoặc không đủ điều kiện | Toàn bộ lệnh thất bại; không hóa đơn nào được duyệt một phần. Tải lại danh sách để dùng phiên bản mới. |
| SC-12 | Hai yêu cầu duyệt gần như đồng thời khi tổng ngày sát 100 triệu | RPC tuần tự hóa quyết định; không thể có hai lượt cùng dùng một số dư cũ. |
| SC-13 | Người đề nghị là nhân viên A, công ty mua trên form và hóa đơn cùng là Công ty B; tên hóa đơn khác hoa/thường hoặc khoảng trắng | Buyer khớp `buyerCompany`, không so với nhân viên; tên và mã được chuẩn hóa nhất quán ở API, giao diện và database. |
| SC-14 | Tên công ty chỉ khác dấu tiếng Việt hoặc là tên viết tắt chưa khai báo | Hồ sơ ở `TREASURER_REVIEW` với chú thích cần xác nhận; không tự động coi là khớp. |
| SC-15 | Số hóa đơn `00123` và `123`; sau đó thử `INV-00123` và `INV-123` | Hai mã số thuần khớp theo quy tắc bỏ số 0 đầu; hai mã chữ-số không tự khớp vì số 0 có thể có ý nghĩa. |
| SC-16 | Gửi hồ sơ thiếu tên công ty mua | Database từ chối gửi hồ sơ; hệ thống không dùng tên người đề nghị/phòng ban thay thế. |
| SC-17 | Hóa đơn bán hàng 12903 ghi 1.655.000 trước chiết khấu, chiết khấu 477.000, tổng cuối cùng 1.178.000; form khai 1.178.000 | Không bắt buộc cộng tiền trước thuế với VAT; chỉ đối chiếu tổng cuối cùng. Nếu loại hóa đơn/tổng đều đọc chắc và các trường bắt buộc khác khớp, hồ sơ có thể đạt `READY_FOR_APPROVAL`. |
| SC-18 | Hóa đơn VAT đọc chắc nhưng tiền trước thuế + VAT không bằng tổng cuối cùng; hoặc chiết khấu VAT không rõ đã trừ trước thuế chưa | Hồ sơ vào `TREASURER_REVIEW`; nêu phép tính/chiết khấu cần xác minh, không tự kết luận đạt. |

SC-03–SC-05 cần PDF mẫu được phép sử dụng, OpenAI API và Supabase thử nghiệm. Kết quả từng ca cần được ghi lại riêng; bộ luật cục bộ không thay thế các ca này.

## 15 ca luật cục bộ

Các ca tương ứng với `FinRefRules.verify()`. Hàm nhận tổng thanh toán (số nguyên VND) và các cờ `pdf`, `fieldsMatch`, `totalsConsistent`, `confidenceSufficient`. Hệ thống ưu tiên U1 khi thiếu/không chắc dữ kiện; nếu các kiểm tra hiện có đều đạt thì tổng trên 20 triệu là U3, còn lại là CLEAR.

| Nhóm | Ca cần có |
|---|---|
| CLEAR | Số tiền dương; đúng 20 triệu; PDF scan có thể đọc được khi đủ confidence và trường khớp. |
| U3 | Tổng thanh toán lớn hơn 20 triệu, gồm VAT. |
| U1 | Thiếu/không khớp tên người mua, nhà cung cấp, số hóa đơn, ngày hóa đơn hoặc tổng form; phép tính tiền trước thuế + VAT sai; confidence dưới 95%; không phải PDF; số tiền không hợp lệ. |
| Chưa hỗ trợ | U2 không thể chạy thành kết luận cho đến khi có dữ liệu policy/ngân sách. |

Verify trong UI là preview luật; nó không gửi PDF đến AI, không mô phỏng tổng đã duyệt trong ngày và không ghi quyết định vào database.

## Acceptance với Supabase thật

Sau khi tạo Supabase project và ba tài khoản thử nghiệm, cấu hình `SUPABASE_URL` và `SUPABASE_ANON_KEY`, sau đó chạy:

```powershell
node scripts/test-online.cjs
```

Script kiểm tra RLS, file riêng tư, chặn người dùng tự sửa role/status, phiên bản đồng thời, ngưỡng tiền, chuyển cấp, bổ sung và audit log. Nó không kiểm tra độ chính xác OCR/LLM. Không chạy trên dữ liệu nghiệp vụ thật; chỉ dùng fixture tổng hợp.

Mỗi lần chạy cần lưu ngày giờ, mã hồ sơ, trạng thái thực tế và ảnh/output liên quan. Không dùng dữ liệu đánh giá cuối để điều chỉnh ngưỡng confidence.
