# Trạng thái kiểm tra — 22/09/2026

> **Lưu ý:** kết quả bên dưới ghi nhận phiên bản trước thay đổi ngày 25/09/2026. Chúng không chứng minh phiên bản hiện tại đã qua test, SQL mới đã chạy trên Supabase, hoặc API đã được deploy.

## Thay đổi mã nguồn ngày 25/09/2026

- Đổi phân tích AI sang trích xuất PDF theo trường, confidence và evidence; kiểm tra đối chiếu form và tổng trước thuế + VAT.
- Thêm trạng thái `READY_FOR_APPROVAL`; AI không tạo `APPROVED`. Người có quyền bấm duyệt cuối.
- Tính ngưỡng 20.000.000 VND theo tổng thanh toán gồm VAT; U1 hỏi bổ sung, trên ngưỡng chuyển cấp U3.
- Không ghi đạt ngân sách/chính sách; U2 và các đối chiếu NCC/MST công ty/PO/lịch sử thanh toán vẫn chưa hỗ trợ.
- Cập nhật UI/demo, SQL và bộ tài liệu theo phạm vi PDF hiện hành.

Các thay đổi này **chưa được chạy kiểm thử**, chưa chạy SQL trên Supabase thật, chưa thử OpenAI với hóa đơn mẫu và chưa xác minh deployment. Chỉ dùng project thử nghiệm sau khi nhóm đã rà schema mới.

Đã chạy `node --test tests/*.test.cjs`: **27/27 đạt**.

Đã chạy `node scripts/smoke-local.cjs`: **5/5 đạt**. Năm ca gồm hồ sơ trong hạn mức, đúng mốc 20 triệu, vượt mốc và chuyển U3, thiếu minh chứng U1, và số tiền không hợp lệ U1.

Bao gồm mốc 20 triệu, dữ kiện thiếu, ngoài ngân sách/chính sách, kiểu dữ liệu số tiền, làm mới phiên đăng nhập đồng thời, lỗi ghi dữ liệu, đăng xuất khi mất mạng, chặn khóa quản trị trong build và chỉ đóng gói file công khai.

Ghi nhận từ báo cáo ngày 20/09/2026: đã chạy trình duyệt Chrome headless với **API giả lập**, kiểm tra các mục dưới đây. Chưa chạy lại các kiểm tra trình duyệt này trong lần rà soát 22/09/2026; kết quả cũ không xác nhận luồng AI mới.

- Đăng nhập và hiển thị ba cổng riêng.
- Upload hai file, gửi form, hiển thị hồ sơ.
- Chặn duyệt khi chưa tích đủ xác nhận.
- Tạo link minh chứng, thủ quỹ chuyển hồ sơ trên 20 triệu lên GĐTC.
- GĐTC duyệt; người nộp thấy kết quả.
- Tải lại trang giữ phiên đăng nhập trong tab.
- Verify UI thực thi 15 ca, kết quả 15/15.
- Không tràn chiều ngang toàn trang ở màn hình 390 px; bảng có vùng cuộn riêng.
- Không phát sinh JavaScript page error trong luồng trên.

**Chưa kiểm tra được trên Supabase thật:** chưa có project URL/key của người dùng. SQL chưa được chạy trên PostgreSQL/Supabase trong phiên này. Kiểm tra trình duyệt giả lập không chứng minh RLS, Storage hoặc RPC thực tế đã hoạt động.

Frontend có thể được serve tại localhost sau khi build; backend nghiệp vụ hiện là Supabase Auth/Storage/RPC, không phải một server backend chạy độc lập trong localhost. Vì vậy cần chạy `scripts/test-online.cjs` trên project Supabase thật trước khi tuyên bố acceptance online.

Sau khi tạo project và ba tài khoản, chạy `scripts/test-online.cjs` theo hướng dẫn. Script kiểm tra quyền server, riêng tư file, tranh chấp cập nhật, hạn mức, bổ sung và nhật ký với dữ liệu TEST. Chỉ kết luận hệ thống online hoạt động sau khi bước đó và thử trên ba máy thành công.

Ngày 22/09/2026: build bằng cấu hình public mẫu thành công; server trả HTTP 200 cho `/index.html`, `/demo.html`, HTTP 404 cho `/package.json`. Đây chỉ là kiểm tra build/static HTTP, không xác nhận đăng nhập hoặc backend. Endpoint `/api/analyze-evidence` không được phục vụ bởi `scripts/serve.cjs`.

Bản mã đang rà là thư mục trích từ ZIP; Git workspace chưa có commit/remote. Chưa xác minh được trạng thái repository GitHub, tài khoản thật hoặc Vercel deployment của nhóm từ bản local này. Bộ tạo tài khoản sinh mật khẩu trên máy người dùng khi được kết nối vào project.
