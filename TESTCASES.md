# Kịch bản kiểm tra FinRef

## Phạm vi

- Hóa đơn đầu vào: PDF có chữ chọn/copy hoặc PDF scan dạng ảnh. Chỉ hóa đơn là file đính kèm bắt buộc; tối đa 10 MB.
- Các trường form người nộp đều tùy chọn trước khi gửi; thiếu dữ liệu sau khi gửi phải vào `NEEDS_INFO` (U1), đánh dấu tím và trả người nộp. PDF vẫn bắt buộc. `buyerCompany` được bỏ trống khi người nộp chọn “Hóa đơn không ghi tên người mua”.
- So khớp chính xác sau Unicode NFKC, chữ thường và gộp khoảng trắng. Mã số hóa đơn thuần bỏ số 0 đầu; mã có chữ giữ số 0, dấu `/`, `-`, `.`. Khác biệt dấu ở tên nhà cung cấp/người mua cần Quản lý xác nhận.
- Sales cần confidence tổng thanh toán ≥82%; VAT cần tiền trước thuế, VAT khác 0 và tổng cuối cùng ≥90%; VAT=0 cần ≥70% cùng bằng chứng thể hiện 0. Chiết khấu nếu có cần ≥85%; tính VAT theo tiền trước thuế − chiết khấu + VAT, giả định chiết khấu trước thuế.
- Tổng thanh toán trên form phải là tổng cuối cùng trên hóa đơn. Sai lệch tiền/số hóa đơn và confidence quyết định thấp chuyển vàng cho Quản lý; chỉ mâu thuẫn rõ ở người mua/NCC mới tự từ chối, trùng cả MST và số hóa đơn với hồ sơ đã duyệt cũng bị từ chối trực tiếp.
- Nhà cung cấp đã xác minh cần MST ≥85% và tên khớp bí danh đã xác minh ≥70%; nhà cung cấp mới cần tên khớp form và cả tên/MST ≥80%, lưu PDF/tên/MST trong mục ghi chú chỉ CFO xem nhưng không tự thêm vào danh mục.
- Hóa đơn không phân loại đủ chắc mặc định theo rule VAT mà không gắn cờ riêng. Confidence ngày hóa đơn và tiền còn phải trả chỉ để tham khảo, không tạo ghi chú/cờ.
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
| SC-05 | Dùng PDF mờ, thiếu confidence, sai số hóa đơn hoặc tổng VAT không khớp phép tính/form | Điểm thiếu chắc/sai lệch tiền hoặc số hóa đơn vào `TREASURER_REVIEW` màu vàng. Chỉ mâu thuẫn rõ ở người mua/NCC bị từ chối trực tiếp; Quản lý xử lý các điểm vàng trước khi duyệt/chuyển Giám đốc. |
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
| SC-16 | Gửi form thiếu một hay nhiều trường (kèm PDF), rồi bổ sung; thử lựa chọn `NO_NAME` | Lượt đầu lưu `NEEDS_INFO` (U1), trường thiếu màu tím và trả người nộp. Khi bổ sung đủ thì phân tích hóa đơn. Chỉ `NO_NAME` cho phép bỏ tên người mua; nếu AI đọc thấy tên rõ thì là mâu thuẫn. |
| SC-17 | Hóa đơn bán hàng 12903 ghi 1.655.000 trước chiết khấu, chiết khấu 477.000, tổng cuối cùng 1.178.000; form khai 1.178.000 | Không bắt buộc cộng tiền trước thuế với VAT; chỉ đối chiếu tổng cuối cùng. Nếu loại hóa đơn/tổng đều đọc chắc và các trường bắt buộc khác khớp, hồ sơ có thể đạt `READY_FOR_APPROVAL`. |
| SC-18 | Hóa đơn VAT đọc chắc nhưng tiền trước thuế − chiết khấu + VAT không bằng tổng cuối cùng; hoặc chiết khấu confidence <85% | Hồ sơ vào `TREASURER_REVIEW`; dùng giả định chiết khấu trước thuế và giao Quản lý xác minh nếu tổng tính không khớp. |

SC-03–SC-05 cần PDF mẫu được phép sử dụng, OpenAI API và Supabase thử nghiệm. Kết quả từng ca cần được ghi lại riêng; bộ luật cục bộ không thay thế các ca này.

## Preview luật cục bộ

17 ca trong `FinRefRules.verify()` minh họa các trạng thái U1, U2, U3, CLEAR và REJECTED. Đây chỉ là preview trạng thái: nó không đọc PDF, áp dụng ngưỡng confidence từng trường, xác minh nhà cung cấp hay thay thế quyết định API/database.

| Nhóm | Ca cần có |
|---|---|
| CLEAR | Số tiền dương; đúng 20 triệu; loại không rõ mặc định VAT; hóa đơn không tên người mua; ngày/tiền còn phải trả chỉ tham khảo. |
| U3 | Tổng thanh toán lớn hơn 20 triệu, gồm VAT. |
| U1 | Thiếu trường form sau khi gửi, thiếu PDF hoặc số tiền form không hợp lệ. |
| U2 | Confidence thấp, sai lệch tiền/số hóa đơn hoặc phép tính VAT không khớp cần Quản lý xác minh. |
| REJECTED | Mâu thuẫn rõ ở người mua/NCC hoặc trùng MST và số hóa đơn với hồ sơ đã duyệt. |

Verify trong UI là preview luật; nó không gửi PDF đến AI, không mô phỏng tổng đã duyệt trong ngày và không ghi quyết định vào database.

## Acceptance với Supabase thật

Sau khi tạo Supabase project và ba tài khoản thử nghiệm, cấu hình `SUPABASE_URL` và `SUPABASE_ANON_KEY`, sau đó chạy:

```powershell
node scripts/test-online.cjs
```

Script kiểm tra RLS, file riêng tư, chặn người dùng tự sửa role/status, phiên bản đồng thời, ngưỡng tiền, chuyển cấp, bổ sung và audit log. Nó không kiểm tra độ chính xác OCR/LLM. Không chạy trên dữ liệu nghiệp vụ thật; chỉ dùng fixture tổng hợp.

Mỗi lần chạy cần lưu ngày giờ, mã hồ sơ, trạng thái thực tế và ảnh/output liên quan. Không dùng dữ liệu đánh giá cuối để điều chỉnh ngưỡng confidence.
