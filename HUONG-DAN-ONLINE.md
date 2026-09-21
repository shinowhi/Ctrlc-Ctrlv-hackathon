# Đưa FinRef lên online — GitHub + Supabase + Vercel

## Bạn sẽ có gì?

- Một link HTTPS công khai do Vercel cấp.
- Ba tài khoản thật, mỗi tài khoản chỉ có một vai trò.
- Hồ sơ, minh chứng và nhật ký dùng chung giữa các máy.
- Trang demo riêng không cần đăng nhập ở `/demo.html`, chỉ dùng dữ liệu giả lập trên từng trình duyệt.

**Hiện tại chưa có project Supabase/Vercel của bạn được kết nối, nên tài khoản thật và live URL chưa được tạo.** Bộ mã và script bên dưới đã được chuẩn bị để bạn thực hiện việc đó. Bản này chưa có OCR/AI xác minh dấu/chữ ký; thủ quỹ trực tiếp mở file và kiểm tra.

## 1. Tạo project Supabase

1. Vào <https://supabase.com/dashboard>, đăng nhập bằng GitHub.
2. Tạo organization nếu được hỏi, rồi chọn **New project**.
3. Đặt tên `finref-hackathon`, chọn khu vực gần Việt Nam (ví dụ Singapore), đặt và lưu mật khẩu database. Chọn gói phù hợp, xem giới hạn hiện tại trong dashboard.
4. Đợi project sẵn sàng. Đây nên là **project mới**, vì schema bên dưới tạo các bảng mới và không phải script nâng cấp database cũ.
5. Vào **SQL Editor → New query**. Mở `supabase/schema.sql` trong thư mục dự án, copy toàn bộ nội dung, bấm **Run** một lần.
6. Khi thành công, kiểm tra có bảng `profiles`, `requests`, `audit_events` và bucket `evidence` **Private**.
7. Trong phần Authentication / sign-up settings, tắt cho người dùng tự đăng ký tài khoản mới nếu đang bật. Tài khoản của nhóm được tạo bằng script quản trị ở bước 2. Không tắt chức năng đăng nhập bằng email/password.

Tìm thông tin kết nối trong nút **Connect** hoặc **Project Settings → API / API Keys** (tên mục có thể thay đổi):

| Giá trị | Dùng ở đâu |
|---|---|
| Project URL: `https://xxx.supabase.co` | Vercel và script tạo tài khoản |
| Publishable key (`sb_publishable_…`) hoặc legacy `anon` key | Vercel; đây là khóa công khai cho frontend |
| Secret key (`sb_secret_…`) hoặc legacy `service_role` key | Chỉ nhập vào script quản trị chạy trên máy bạn |

Không dùng mật khẩu database thay cho API key. **Không đưa secret/service_role key lên GitHub, vào `config.js` hay vào biến frontend của Vercel.**

## 2. Tạo sẵn ba tài khoản

Cài **Node.js LTS phiên bản 22 trở lên** từ <https://nodejs.org> nếu máy chưa có. Sau khi cài, mở lại PowerShell và kiểm tra `node --version`.

Mở PowerShell tại thư mục dự án. Trên máy hiện tại:

```powershell
cd 'C:\Users\HP\Documents\Codex\2026-09-20\ba\outputs\finance-approval-mvp'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-accounts.ps1
```

Script hỏi lần lượt:

1. Project URL.
2. Secret/service_role key — nhập ẩn, không ghi vào mã nguồn. Lệnh này không thay đổi Execution Policy chung của máy.

Sau khi thành công, mở `.local/accounts.txt`. File chứa **mật khẩu ngẫu nhiên riêng** cho:

| Tài khoản | Vai trò |
|---|---|
| `nopdon@finref.test` | Người nộp đơn |
| `thuquy@finref.test` | Thủ quỹ |
| `gdtc@finref.test` | Giám đốc Tài chính |

Đây là địa chỉ đăng nhập thử nghiệm, không phải hộp thư nhận email. Script tạo tài khoản đã xác nhận email để nhóm đăng nhập ngay. Chia sẻ riêng từng mật khẩu cho người giữ vai trò tương ứng.

Script chạy lại sẽ giữ nguyên mật khẩu tài khoản đã có. Nếu chạy dở, có thể chạy lại để hoàn tất gán vai trò. Nếu tài khoản đã tồn tại từ trước nhưng không còn mật khẩu, đổi mật khẩu trong Authentication → Users hoặc dùng quy trình quản trị của Supabase; script không tự đặt lại.

**Không upload thư mục `.local` hoặc file `accounts.txt`.** `.gitignore` đã loại chúng khỏi Git. Tài khoản dùng thật sau hackathon nên dùng email thật để hỗ trợ khôi phục mật khẩu.

## 3. Đưa mã lên GitHub

Cách dễ nhất là dùng **GitHub Desktop**: <https://desktop.github.com>.

1. Đăng nhập GitHub Desktop bằng tài khoản GitHub của bạn.
2. **File → Add local repository**, chọn đúng thư mục `finance-approval-mvp`.
3. Nếu chưa phải Git repository, chọn **create a repository here** và kiểm tra đường dẫn cuối cùng vẫn là thư mục chứa `package.json`, không phải thư mục rỗng nằm bên trong.
4. Trong danh sách Changes, kiểm tra **không có `.local/accounts.txt`, `.env` hoặc khóa bí mật**.
5. Commit với nội dung `Prepare finance approval online MVP`.
6. Bấm **Publish repository**, đặt tên `finref-hackathon`. Chọn công khai khi cần đáp ứng yêu cầu repo public của cuộc thi.

Không kéo cả thư mục dự án lên trang Upload files của GitHub sau khi tạo tài khoản: thao tác thủ công có thể đưa nhầm `.local` lên mạng dù có `.gitignore`.

## 4. Deploy lên Vercel

1. Vào <https://vercel.com>, đăng nhập bằng GitHub.
2. Chọn **Add New → Project**, import repository `finref-hackathon`.
3. Framework Preset: **Other**. Root Directory là thư mục có `package.json` (nếu repo chính là thư mục trên, để mặc định).
4. Build Command: `node scripts/build.cjs`.
5. Output Directory: `dist`.
6. Thêm đúng hai Environment Variables cho Production (và Preview nếu dùng):

```text
SUPABASE_URL       https://xxx.supabase.co
SUPABASE_ANON_KEY  <publishable key hoặc legacy anon key>
```

7. Bấm **Deploy**. Script build sẽ chỉ đưa các file giao diện được phép lên website; script tạo tài khoản, SQL và mật khẩu không nằm trong `dist`.
8. Sao chép link HTTPS Vercel cấp. Đây là **live URL** để gửi cho đội và ban giám khảo.
9. Trong Supabase → Authentication → URL Configuration, đặt **Site URL** bằng link chính thức đó. Luồng email/password hiện tại không dùng email redirect; thiết lập này chuẩn bị cho các chức năng email sau này.

Sau này sửa code, commit rồi push GitHub là Vercel build lại. Nếu đổi biến môi trường, cần **Redeploy** để `config.js` được tạo lại. Hai biến này chỉ chứa dữ liệu công khai. Không thêm admin key vào Vercel cho bản này.

## 5. Thử trên ba máy

1. Máy A đăng nhập `nopdon@finref.test`. Điền form, đính kèm hai file mẫu và gửi.
2. Máy B đăng nhập `thuquy@finref.test`. Đơn sẽ xuất hiện sau tối đa khoảng 10 giây hoặc bấm **Làm mới**. Mở cả hai minh chứng; kiểm tra rồi tích các xác nhận phù hợp.
3. Thử đơn **20.000.000 đồng**: thủ quỹ có thể duyệt.
4. Thử đơn **20.000.001 đồng**: nút xử lý của thủ quỹ chuyển đơn sang GĐTC, chưa duyệt ngay.
5. Máy C đăng nhập `gdtc@finref.test`, mở đơn đã chuyển và duyệt hoặc từ chối.
6. Máy A kiểm tra trạng thái và nhật ký. Thử thêm **yêu cầu bổ sung → người nộp tải lại hai file → gửi lại → thủ quỹ kiểm tra**.
7. Giám khảo mở live URL không có tài khoản vẫn truy cập được trang đầu; chọn **Trải nghiệm demo không cần tài khoản** để xem luồng mẫu độc lập. Demo này không ghi vào hồ sơ online.

Có thể thử cùng một máy bằng các trình duyệt hoặc cửa sổ riêng. Mỗi tab lưu phiên đăng nhập riêng; khi dùng chung máy, nên đăng xuất sau khi thử.

## 6. Kiểm tra trước khi nộp

Kiểm tra logic local, không cần cài thư viện:

```powershell
node --test tests/*.test.cjs
```

Kiểm tra luồng thật trên Supabase sau khi tạo tài khoản (sẽ tạo các hồ sơ có tên `TEST ONLINE` và file giả lập, **không phải hóa đơn hợp lệ**):

```powershell
$env:SUPABASE_URL = 'https://xxx.supabase.co'
$env:SUPABASE_ANON_KEY = '<publishable key hoặc anon key>'
node scripts/test-online.cjs
```

Bài kiểm tra thật xác nhận: quyền theo vai trò, chống sửa trực tiếp trạng thái/role, riêng tư minh chứng, chặn thiếu xác nhận, mốc 20 triệu, xử lý đồng thời, bổ sung hồ sơ và nhật ký. Chạy trên project thử nghiệm trước khi nhập dữ liệu thật. Không xóa các hồ sơ test tự động để giữ lịch sử kiểm tra.

Muốn chạy frontend local với Supabase đã cấu hình:

```powershell
node scripts/build.cjs
node scripts/serve.cjs
```

Mở <http://127.0.0.1:8124>. Dùng cùng hai biến môi trường ở trên.

## Khi gặp lỗi

- **Chưa kết nối Supabase:** kiểm tra hai biến môi trường Vercel rồi Redeploy. Mở file HTML trực tiếp dùng cấu hình trống mặc định, nên chưa đăng nhập online được.
- **Invalid login credentials:** dùng mật khẩu trong `.local/accounts.txt`, kiểm tra script đã chạy với đúng project URL.
- **Tài khoản chưa được gán vai trò:** chạy lại script tạo tài khoản, kiểm tra bảng `profiles`.
- **relation profiles does not exist / RPC not found:** chạy `supabase/schema.sql` trên đúng project mới.
- **Key không hợp lệ:** tạo tài khoản cần secret/service_role; build frontend cần publishable/anon. Hai loại khác nhau.
- **Hồ sơ đã thay đổi:** người khác đã xử lý cùng phiên bản; làm mới và xem trạng thái mới.
- **Tải file thất bại:** kiểm tra bucket Private `evidence`, MIME PDF/JPG/PNG và kích thước tối đa 10 MB; kiểm tra policies đã được tạo.
- **Link minh chứng hết hạn:** bấm “Xem hóa đơn”/“Xem đơn đề nghị” lần nữa để tạo link 60 giây mới.

## Giới hạn đã biết

Chưa tích hợp OCR/VLM, email thông báo, khôi phục mật khẩu qua giao diện, tạm ứng hoặc nhân sự. Không tự chuyển tiền. UI hiển thị 200 hồ sơ mới nhất và 50 sự kiện mới nhất của hồ sơ được chọn; database vẫn giữ các bản ghi cũ. Nếu upload xong mà gửi form thất bại, file chưa gắn hồ sơ có thể còn trong bucket riêng tư, cần quản trị dọn sau. Nhật ký chặn sửa bằng tài khoản người dùng, không phải chứng nhận chống sửa bởi quản trị viên database.
