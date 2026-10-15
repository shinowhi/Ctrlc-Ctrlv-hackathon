# Trải nghiệm không cần tài khoản

Chế độ khách dùng **cùng Supabase project** với bản đăng nhập, nhưng lưu hồ sơ trong scope riêng. Các khách chia sẻ một hàng đợi demo; tài khoản thường chỉ đọc/ghi hồ sơ tài khoản. Khách tự chọn Người nộp đơn, Quản lý tài chính hoặc CFO.

## Hành vi và giới hạn

- Không cần tạo tài khoản: Supabase tạo anonymous identity và ứng dụng lưu phiên ở `sessionStorage` riêng với phiên đăng nhập thường.
- Hồ sơ, audit, tệp minh chứng, danh mục nhà cung cấp và kiểm tra trùng được cách ly bằng scope database. Tài khoản có thể có tên nhà cung cấp trùng với danh mục khách.
- Bất kỳ khách nào cũng có thể tự chọn Quản lý hoặc CFO để xem/xử lý hàng đợi demo. Tên vai trò, audit và quyết định này **không xác thực danh tính hoặc thẩm quyền**, không phải phê duyệt thật. Không tải hóa đơn hay thông tin cá nhân thật.
- Mỗi anonymous identity có tối đa 5 lượt OCR/AI mỗi ngày theo giờ Bangkok. Người dùng có thể tạo identity mới; tổng lượt và chi phí AI toàn project **không có trần**.
- Không bật CAPTCHA trong Supabase Auth vì cài đặt này áp dụng cho cả đăng nhập email/mật khẩu hiện tại. Anonymous Sign-Ins vì vậy có mức chống bot yếu hơn.
- Nếu khách đăng xuất, xóa dữ liệu trình duyệt hoặc đổi thiết bị thì không khôi phục được identity cũ. Dữ liệu server vẫn tồn tại cho đến khi quản trị viên tự dọn; hiện chưa đặt thời hạn lưu trữ hay lịch xóa tự động.

## Cấu hình Supabase

1. Dùng đúng Supabase project đang phục vụ tài khoản. Không tạo project khác và không thay `SUPABASE_URL`, `SUPABASE_ANON_KEY` hay `SUPABASE_SERVICE_ROLE_KEY`.
2. Trong Authentication → Sign In / Providers, bật **Allow anonymous sign-ins**. Giữ CAPTCHA protection tắt để không thay đổi luồng đăng nhập hiện có.
3. Trước khi triển khai phiên bản code này, xác nhận database đã có `supabase/schema.sql` và toàn bộ migration theo thứ tự của `supabase/fresh-install-migrations.txt` (với database đang dùng, đối chiếu migration history của đúng project).
4. Chạy migration cuối `supabase/migrations/20261016-guest-shared-project.sql` một lần trong SQL Editor trên project dùng chung. Migration này cũng cần cho API phân tích hóa đơn ở bản code mới, kể cả khi chưa bật link guest. Nó cần vai trò database có quyền tạo role và đổi owner function. Không chạy migration guest cũ `20261015-guest-anonymous-sandbox.sql` nếu còn ở checkout cũ; nó được thiết kế cho project riêng.
5. Không chạy `20261004-zz-vendor-invoice-seed.sql` để tạo dữ liệu khách. Các nhà cung cấp đã có trong project giữ scope tài khoản; danh mục khách bắt đầu riêng.

Migration thêm scope `is_guest` vào requests và vendor data, dùng JWT để xác định scope, và chuyển các RPC nội bộ sang role PostgreSQL không bypass RLS. Nó cũng cài trigger tạo profile anonymous và giới hạn mỗi identity 5 lượt phân tích/ngày. Đăng nhập thường nhận mặc định scope tài khoản.

## Cấu hình build và API

Giữ các biến `SUPABASE_URL`, `SUPABASE_ANON_KEY` và `SUPABASE_SERVICE_ROLE_KEY` đang dùng. `SUPABASE_SERVICE_ROLE_KEY` chỉ ở backend/Vercel, không đưa vào frontend. Đặt thêm:

| Biến | Giá trị | Nơi dùng |
|---|---|---|
| `GUEST_MODE_ENABLED` | `true` để bật, `false` hoặc bỏ trống để tắt | Build |

Các khóa AI/OCR vẫn dùng chung backend hiện tại. `config.js` chỉ xuất Supabase URL, public anon key và cờ bật guest; service-role và khóa AI không xuất vào trình duyệt. Sau khi cấu hình migration và biến build, redeploy để hiện link **Trải nghiệm không cần tài khoản**. Có thể mở `/?mode=guest` để vào màn chọn vai trò.

## Dọn dữ liệu guest

Chế độ này không tự xóa hồ sơ hoặc tệp và hiện không có retention period. Khi quản trị viên dọn dữ liệu thử nghiệm, cần giới hạn thao tác ở `requests.is_guest=true`, xóa tệp qua Supabase Storage API (kể cả upload mồ côi), rồi xóa ghi chú/audit/hồ sơ theo thứ tự khóa ngoại. Không xóa trực tiếp metadata từ `storage.objects`. Không xóa Auth user trước khi xử lý các request tham chiếu đến profile.

Để tắt guest, đặt `GUEST_MODE_ENABLED=false` hoặc bỏ biến rồi redeploy. Bản đăng nhập tiếp tục dùng cùng project và các biến hiện tại.
