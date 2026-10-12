# Trạng thái kiểm tra FinRef

**Cập nhật:** 12/10/2026

**Mã nguồn được rà soát:** branch `fix/restore-single-buyer-name`, HEAD `14423bd`
**Lưu ý:** chưa xác nhận production đang chạy đúng commit này hoặc đã áp dụng đầy đủ migration.

## Rà soát ứng dụng chính thức — 12/10/2026

Phạm vi là đọc giao diện đã đăng nhập và mã nguồn hiện có. Không tạo hồ sơ mới, không duyệt/từ chối hồ sơ, không chạy thanh toán và không thay đổi dữ liệu production.

### Đã quan sát

- Mở được [ứng dụng chính thức](https://ctrlc-ctrlv-hackathon-two.vercel.app/) và xem được giao diện người nộp, Quản lý Tài chính và Giám đốc Tài chính trong các phiên đăng nhập có sẵn.
- Tại thời điểm xem, danh sách có 15 hồ sơ: 9 chờ Quản lý, 3 chờ CFO, 3 sẵn sàng duyệt và 0 cần bổ sung. Đây là ảnh chụp tại một thời điểm, không phải số liệu cố định.
- Mở được hồ sơ CFO trên 20 triệu đồng; trang thể hiện kết quả AI và dấu vết tạo hồ sơ. Một hồ sơ Quản lý cho thấy PDF cùng các dữ kiện OCR.
- Nút **Chạy 17 ca kiểm tra** hiển thị 17/17 đạt. Nút gọi `FinRefRules.verify()` phía trình duyệt trong `rules.js`; nó không đọc PDF, không gọi AI/API, không truy vấn database và không chứng minh luồng online chạy đầu-cuối.
- Người dùng xác nhận ba tài khoản đăng nhập thuộc về ba nhân sự thật. Việc này được ghi nhận theo xác nhận của người dùng; chưa có phỏng vấn, trích dẫn hoặc tài liệu tổ chức độc lập để xác minh cách họ sử dụng sản phẩm.

### Lỗi và giới hạn còn lại

- Khi chuyển sang một hồ sơ Quản lý khác để mở PDF, trang gặp `TypeError: documentProxy.destroy is not a function` tại `app.js:442`. Lỗi này chặn việc rà tiếp các hồ sơ PDF trong cùng phiên. Cần sửa và xác nhận lại trên bản production trước khi dùng luồng này làm demo.
- Trang CFO từng hiện thông báo không tải được tổng đã duyệt trong ngày và vô hiệu hóa nút duyệt. Người dùng xác nhận chưa có lượt duyệt trong ngày là bình thường; vì vậy số 0 không bị xem là vi phạm hạn mức. Nguyên nhân thông báo tải dữ liệu chưa được chẩn đoán, nên chưa thể xác nhận phần hiển thị tổng ngày hoạt động ổn định.
- Mã nguồn và giao diện nêu rõ chưa kiểm tra ngân sách thực, chính sách chi tiêu, PO và lịch sử thanh toán. Migration cũng lưu `budget_checked=false` và `policy_checked=false`; không được diễn giải kết quả AI `CLEAR` thành xác nhận các mục này.
- Có danh mục nhà cung cấp/bí danh nội bộ, nhưng lần rà soát không xác minh dữ liệu danh mục trên production hoặc nguồn ngoài.
- Chưa xác nhận được video thuyết trình/demo trong thư mục Drive đã cung cấp. Chỉ có đường dẫn thư mục là chưa đủ để chấm nội dung trình bày.
- Chưa kiểm tra một hóa đơn mới được tải lên và xử lý đầu-cuối trong phiên rà soát này; không tạo hồ sơ mới để tránh ghi thêm dữ liệu vào production.
- Không đọc được trạng thái migration thực tế của Supabase production hoặc mã commit đang chạy trên Vercel. Migrations trong checkout hiện có đến `20261012-restore-single-buyer-name.sql`.

## Ghi chú điểm theo rubric (nội bộ, không phải điểm Ban Tổ chức)

Đánh giá dựa trên bằng chứng hiện có trong lần rà soát là **63/100**. Con số **72/100** chỉ là kịch bản giả định nếu phần thuyết trình được chấm 9/10; chưa xem video/bài trình bày nên không phải điểm đã xác minh. Không dùng các con số này thay cho kết quả chính thức của Ban Tổ chức.

## Kết quả cũ — chỉ để tham khảo lịch sử

Phiên bản trước của tài liệu ghi nhận:

- `node --test tests/*.test.cjs`: 27/27 đạt.
- `node scripts/smoke-local.cjs`: 5/5 đạt.
- Kiểm tra Chrome headless với API giả lập; Verify UI khi đó có 15 ca và hiển thị 15/15.

Các kết quả này thuộc bản rà soát cũ, trước nhiều thay đổi sau đó và không được chạy lại trên HEAD `14423bd`. Chúng không chứng minh AI, Supabase thật, migration hoặc deployment hiện tại hoạt động đúng.

## Phân biệt các loại kiểm tra

- `npm run smoke` chạy năm ca preview luật từ `scripts/smoke-local.cjs`; không gọi OpenAI hoặc Supabase.
- `node --test tests/*.test.cjs` chạy unit/integration tests theo cấu hình của từng test; chưa chạy trong lần cập nhật tài liệu này.
- `TESTCASES.md` mô tả kịch bản và kết quả mong đợi. Một kịch bản được ghi trong đó không có nghĩa là đã chạy qua acceptance trên production.
- Verify UI hiện có 17 ca trạng thái luật; nó không thay thế kiểm tra upload PDF, OCR, quyền Supabase, RPC, audit và quyết định thật.
