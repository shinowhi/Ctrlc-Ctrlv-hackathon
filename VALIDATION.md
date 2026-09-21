# Trạng thái kiểm tra — 20/09/2026

Đã chạy `node --test tests/*.test.cjs`: **24/24 đạt**.

Bao gồm mốc 20 triệu, dữ kiện thiếu, ngoài ngân sách/chính sách, kiểu dữ liệu số tiền, làm mới phiên đăng nhập đồng thời, lỗi ghi dữ liệu, đăng xuất khi mất mạng, chặn khóa quản trị trong build và chỉ đóng gói file công khai.

Đã chạy trình duyệt Chrome headless với **API giả lập**, kiểm tra:

- Đăng nhập và hiển thị ba cổng riêng.
- Upload hai file, gửi form, hiển thị hồ sơ.
- Chặn duyệt khi chưa tích đủ xác nhận.
- Tạo link minh chứng, thủ quỹ chuyển khoản trên 20 triệu lên GĐTC.
- GĐTC duyệt; người nộp thấy kết quả.
- Tải lại trang giữ phiên đăng nhập trong tab.
- Verify UI thực thi 15 ca, kết quả 15/15.
- Không tràn chiều ngang toàn trang ở màn hình 390 px; bảng có vùng cuộn riêng.
- Không phát sinh JavaScript page error trong luồng trên.

**Chưa kiểm tra được trên Supabase thật:** chưa có project URL/key của người dùng. SQL chưa được chạy trên PostgreSQL/Supabase trong phiên này. Kiểm tra trình duyệt giả lập không chứng minh RLS, Storage hoặc RPC thực tế đã hoạt động.

Sau khi tạo project và ba tài khoản, chạy `scripts/test-online.cjs` theo hướng dẫn. Script kiểm tra quyền server, riêng tư file, tranh chấp cập nhật, hạn mức, bổ sung và nhật ký với dữ liệu TEST. Chỉ kết luận hệ thống online hoạt động sau khi bước đó và thử trên ba máy thành công.

Chưa tạo tài khoản thật, repository GitHub hoặc Vercel deployment thay người dùng. Bộ tạo tài khoản sinh mật khẩu trên máy người dùng khi được kết nối vào project.
