# Đưa FinRef lên online — GitHub + Supabase + Vercel

## Bạn sẽ có gì?

- Một link HTTPS công khai do Vercel cấp.
- Ba tài khoản thật, mỗi tài khoản chỉ có một vai trò.
- Hồ sơ, minh chứng và nhật ký dùng chung giữa các máy.
- Trang mô phỏng riêng `/demo.html` dùng dữ liệu giả lập trên từng trình duyệt; theo cập nhật của nhóm, luồng chấm điểm dùng tài khoản đăng nhập.

**Trạng thái sử dụng:** ứng dụng có live URL và nhóm sẽ dùng tài khoản đăng nhập theo vai trò khi chấm điểm. Các bước bên dưới mô tả cách khởi tạo hoặc khôi phục môi trường. Trước khi chạy SQL hoặc migration trên project đang dùng, hãy đối chiếu lịch sử migration của đúng Supabase project; không chạy lại `schema.sql` trên production hiện hữu. Endpoint AI đọc hóa đơn PDF cần các biến môi trường server.

## 1. Tạo project Supabase

1. Vào <https://supabase.com/dashboard>, đăng nhập bằng GitHub.
2. Tạo organization nếu được hỏi, rồi chọn **New project**.
3. Đặt tên `finref-hackathon`, chọn khu vực gần Việt Nam (ví dụ Singapore), đặt và lưu mật khẩu database. Chọn gói phù hợp, xem giới hạn hiện tại trong dashboard.
4. Đợi project sẵn sàng. Đây nên là **project mới**, vì schema bên dưới tạo các bảng mới và không phải script nâng cấp database cũ.
5. Vào **SQL Editor → New query**. Mở `supabase/schema.sql` trong thư mục dự án, copy toàn bộ nội dung, bấm **Run** một lần.
6. Sau khi chạy schema, kiểm tra có bảng `profiles`, `requests`, `audit_events` và bucket `evidence` **Private**. Với database mới, chạy lần lượt từng file trong [`supabase/fresh-install-migrations.txt`](supabase/fresh-install-migrations.txt), theo đúng thứ tự trong danh sách. Đây là danh sách hậu-baseline đã được kiểm thử bằng PGlite trên PostgreSQL rỗng; không thay thế việc kiểm tra project Supabase thật hay lịch sử migration của database đang sử dụng. Chạy xong trước khi deploy frontend/API.
   - Nếu database đã tồn tại, **không chạy lại `schema.sql` và không chạy toàn bộ danh sách fresh-install**. Đối chiếu lịch sử migration và cấu trúc RPC của đúng project; chỉ chạy các migration còn thiếu theo thứ tự trong danh sách đã xác minh.
   - Nếu cấu trúc project đã được xác nhận tương đương baseline `schema.sql`, dùng manifest trên làm thứ tự tham chiếu và chỉ chạy mục chưa được ghi nhận là đã áp dụng. Nếu lịch sử chỉ cho biết đã đến `20260930`, hãy đối chiếu cấu trúc thực tế với baseline trước; không mặc định hai trạng thái tương đương.
   - Với project cũ hơn, project đã chạy `sprint1.sql`, hoặc project không có lịch sử migration đáng tin cậy, không suy ra phiên bản chỉ từ tên bảng. Các migration `20260925`–`20260930` là bước nâng cấp tiền đề; xác định đúng trạng thái hiện tại và hoàn tất nhánh nâng cấp tương ứng trước khi dùng manifest. Nếu không xác định được baseline, dừng và kiểm tra database trước khi chạy SQL; không dùng `schema.sql`, `sprint1.sql` hay `rollback-sprint1.sql` để thử.
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

Mở PowerShell tại thư mục dự án (thư mục có `package.json`):

```powershell
cd '<đường-dẫn-tới-thư-mục-repo>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-accounts.ps1
```

Script hỏi lần lượt:

1. Project URL.
2. Secret/service_role key — nhập ẩn, không ghi vào mã nguồn. Lệnh này không thay đổi Execution Policy chung của máy.

Sau khi thành công, mở `.local/accounts.txt`. File chứa **mật khẩu ngẫu nhiên riêng** cho:

| Tài khoản | Vai trò |
|---|---|
| `nopdon@finref.test` | Người nộp đơn |
| `thuquy@finref.test` | Quản lý tài chính (`treasurer`) |
| `gdtc@finref.test` | Người đứng đầu nhánh tài chính (`cfo`) |

Đây là địa chỉ đăng nhập thử nghiệm, không phải hộp thư nhận email. Script tạo tài khoản đã xác nhận email để nhóm đăng nhập ngay. Chia sẻ riêng từng mật khẩu cho người giữ vai trò tương ứng.

Script chạy lại sẽ giữ nguyên mật khẩu tài khoản đã có. Nếu chạy dở, có thể chạy lại để hoàn tất gán vai trò. Nếu tài khoản đã tồn tại từ trước nhưng không còn mật khẩu, đổi mật khẩu trong Authentication → Users hoặc dùng quy trình quản trị của Supabase; script không tự đặt lại.

**Không upload thư mục `.local` hoặc file `accounts.txt`.** `.gitignore` đã loại chúng khỏi Git. Tài khoản dùng thật sau hackathon nên dùng email thật để hỗ trợ khôi phục mật khẩu.

## 3. Đưa mã lên GitHub

Cách dễ nhất là dùng **GitHub Desktop**: <https://desktop.github.com>.

1. Đăng nhập GitHub Desktop bằng tài khoản GitHub của bạn.
2. **File → Add local repository**, chọn đúng thư mục repo (thư mục có `package.json`).
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
6. Thêm các Environment Variables cần thiết cho Production (và Preview nếu dùng):

```text
SUPABASE_URL       https://xxx.supabase.co
SUPABASE_ANON_KEY  <publishable key hoặc legacy anon key>
SUPABASE_SERVICE_ROLE_KEY <chỉ đặt ở backend/Vercel, không đưa vào GitHub>
INVOICE_ANALYSIS_PROVIDER azure
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT <endpoint trong Keys and Endpoint của resource Shino>
AZURE_DOCUMENT_INTELLIGENCE_KEY <Key 1 hoặc Key 2; chỉ đặt ở backend/Vercel>
OPENAI_API_KEY     <tuỳ chọn nếu muốn chọn OpenAI thay cho Azure>
OPENAI_VISION_MODEL <tuỳ chọn, mặc định gpt-4.1-mini>
```

Đặt `INVOICE_ANALYSIS_PROVIDER=azure` để dùng Azure. Nếu bỏ biến này, backend chọn Azure khi thấy có một trong hai biến Azure; cần đủ endpoint và key, thiếu một sẽ báo lỗi cấu hình chứ không tự gửi hóa đơn sang nhà cung cấp khác. Khi không cấu hình Azure, backend dùng OpenAI; cũng có thể chọn rõ `INVOICE_ANALYSIS_PROVIDER=openai` với `OPENAI_API_KEY`. Endpoint và key Azure chỉ nằm trong Environment Variables server, không đưa vào `config.js`, GitHub hay trình duyệt.

7. Bấm **Deploy**. Script build sẽ chỉ đưa các file giao diện được phép lên website; script tạo tài khoản, SQL và mật khẩu không nằm trong `dist`.
8. Sao chép link HTTPS Vercel cấp. Đây là **live URL** để gửi cho đội và ban giám khảo.
9. Trong Supabase → Authentication → URL Configuration, đặt **Site URL** bằng link chính thức đó. Luồng email/password hiện tại không dùng email redirect; thiết lập này chuẩn bị cho các chức năng email sau này.

Sau này sửa code, commit rồi push GitHub là Vercel build lại. Nếu đổi biến môi trường, cần **Redeploy** để `config.js` được tạo lại. Chỉ `SUPABASE_URL` và `SUPABASE_ANON_KEY` được đưa vào frontend; các khóa admin/AI chỉ đặt ở backend Vercel khi bật endpoint tùy chọn.

## 5. Thử trên ba máy

1. Máy A đăng nhập `nopdon@finref.test`. Điền form, đính kèm hóa đơn PDF và gửi.
2. Máy B đăng nhập `thuquy@finref.test`. Đơn sẽ xuất hiện sau tối đa khoảng 10 giây hoặc bấm **Làm mới**. Mở hồ sơ; hóa đơn PDF hiện sẵn trong trang để đối chiếu.
3. Thử đơn **20.000.000 đồng đã gồm VAT** khi tổng duyệt ngày sau đó không quá 100 triệu: Quản lý Tài chính kiểm tra và có thể duyệt cuối.
4. Thử đơn **20.000.001 đồng đã gồm VAT**: Quản lý Tài chính kiểm tra trước; nếu xác nhận hồ sơ ổn thì chuyển Giám đốc Tài chính cấp quyền. Giám đốc cũng xem được hồ sơ trên 20 triệu trong lúc Quản lý Tài chính đang kiểm tra.
5. Tạo tổng duyệt trong ngày vượt **80 triệu**: Quản lý Tài chính thấy thông báo tổng đã duyệt và số còn lại trên hạn mức 100 triệu.
6. Thử hồ sơ làm tổng duyệt ngày vượt **100 triệu**: Quản lý Tài chính kiểm tra trước, sau đó chuyển Giám đốc cấp quyền; khoản Giám đốc duyệt vẫn tính vào tổng ngày.
7. Máy C đăng nhập `gdtc@finref.test`, mở hồ sơ đã chuyển và cấp quyền hoặc từ chối; thử cả hồ sơ đang chờ Quản lý Tài chính nhưng có số tiền trên 20 triệu để xác nhận quyền xem.
8. Máy A kiểm tra trạng thái và nhật ký. Thử thêm **yêu cầu bổ sung → người nộp tải lại hóa đơn PDF → gửi lại → quản lý tài chính kiểm tra**.
9. Giám khảo mở live URL và đăng nhập bằng tài khoản do nhóm cấp. Kiểm tra luồng theo đúng vai trò Người nộp đơn, Quản lý Tài chính và Giám đốc Tài chính. Luồng chấm điểm dùng tài khoản đăng nhập.

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
- **relation profiles does not exist / RPC not found:** kiểm tra Vercel đang trỏ đúng Supabase project và database đã chạy đúng schema/migration. Project mới cần hoàn tất bước 5–6; project đang dùng cần đối chiếu lịch sử migration và chỉ chạy migration còn thiếu. Không chạy lại `schema.sql` trên database hiện hữu.
- **Key không hợp lệ:** tạo tài khoản cần secret/service_role; build frontend cần publishable/anon. Hai loại khác nhau.
- **Hồ sơ đã thay đổi:** người khác đã xử lý cùng phiên bản; làm mới và xem trạng thái mới.
- **Tải file thất bại:** kiểm tra bucket Private `evidence`, MIME PDF/JPG/PNG và kích thước tối đa 10 MB; kiểm tra policies đã được tạo.
- **Không hiện hóa đơn trong hồ sơ:** kiểm tra bucket `evidence` đang Private và các policy Storage đã được tạo từ `supabase/schema.sql`.

## AI đọc hóa đơn PDF

Hóa đơn trong phiên bản này phải là PDF (PDF có chữ chọn/copy hoặc PDF scan); không cần tải file đơn đề nghị. Mọi trường form người nộp đều tùy chọn lúc gửi; nếu thiếu trường sau khi nộp, hồ sơ vào U1, đánh dấu tím và trả người nộp bổ sung. PDF vẫn bắt buộc. Người nộp chọn tên cá nhân, tên đơn vị hoặc xác nhận “Hóa đơn không ghi tên người mua”. Endpoint `/api/analyze-evidence` dùng Azure Document Intelligence `prebuilt-invoice` để trích xuất loại hóa đơn, người mua, nhà cung cấp, MST nhà cung cấp, số/ngày hóa đơn, tiền trước thuế, VAT, chiết khấu, tổng thanh toán và số tiền còn phải thanh toán, kèm confidence và bằng chứng. Có thể chọn OpenAI Responses API bằng `INVOICE_ANALYSIS_PROVIDER=openai`. Nếu không phân loại đủ chắc, hệ thống áp dụng rule VAT mà không gắn cờ riêng. Sales cần confidence tổng thanh toán ≥81%; VAT cần tiền trước thuế và tổng sau thuế ≥90%, VAT khác 0 ≥90%, VAT=0 ≥70% kèm bằng chứng dòng VAT thể hiện 0. Chiết khấu nếu có cần confidence ≥85%; công thức VAT là tiền trước thuế − chiết khấu + VAT. Nếu confidence tổng thanh toán Azure thấp hơn ngưỡng, API thử đọc lại riêng trường tổng bằng OpenAI; chỉ chấp nhận khi kết quả khớp Azure, có bằng chứng và đạt ngưỡng. Không khớp hoặc vẫn thấp thì chuyển Quản lý kiểm tra. Tổng trên form phải khớp tổng PDF; số tiền/ngày hóa đơn AI trích chỉ để tham khảo và không tự gắn cờ.

Tên bên được chuẩn hóa Unicode NFKC, chữ thường và khoảng trắng. Khác biệt dấu tiếng Việt là ứng viên cần Quản lý xác nhận, không tự động được duyệt. Nhà cung cấp đã xác minh cần MST confidence ≥85% và tên khớp bí danh đã xác minh với confidence ≥70%; nhà cung cấp mới cần tên khớp form và cả tên/MST ≥80%, được lưu ghi chú chỉ CFO xem và không tự thêm vào danh mục. Số hóa đơn cần confidence ≥80%; sai khác cần Quản lý kiểm tra. Trùng cả MST và số hóa đơn với hồ sơ đã duyệt thì từ chối trực tiếp. Số hóa đơn chỉ bỏ số 0 đầu khi mã chỉ gồm chữ số; dấu phân cách và số 0 trong mã chữ-số được giữ nguyên. Database mới nhận các quy tắc này qua danh sách [`fresh-install-migrations.txt`](supabase/fresh-install-migrations.txt). Với database đang dùng, không chạy riêng migration `20261007-z-agreed-payment-rules.sql` ở cuối một chuỗi đã nâng cấp; hãy đối chiếu migration đã áp dụng và chỉ chạy phần thiếu theo đúng thứ tự. Migration `20261015-cfo-read-high-value-manager-review.sql` cấp CFO quyền xem chỉ đọc các hồ sơ trên 20 triệu còn chờ Quản lý.

Quy tắc mới từ chối trực tiếp khi MST và số hóa đơn cùng trùng hồ sơ đã duyệt; confidence thấp đơn lẻ không phải lý do từ chối. Mâu thuẫn rõ ở người mua/NCC có thể bị từ chối và hồ sơ vẫn lưu để tra cứu. Các trường chưa đủ chắc cùng sai lệch tiền/số hóa đơn chuyển vàng cho Quản lý.

AI clear dưới 20 triệu vào danh sách duyệt của Quản lý; AI clear trên 20 triệu chuyển CFO. CFO xem được chỉ đọc hồ sơ trên 20 triệu trong lúc Quản lý xác minh; hồ sơ vàng vẫn phải qua Quản lý trước khi CFO có quyền quyết định. Nếu không tải được tổng đã duyệt trong ngày, CFO vẫn có thể gửi quyết định khi đã ghi lý do; database tự tính tổng trong giao dịch duyệt. Quản lý vẫn cần tải được tổng này trước khi duyệt. `APPROVED` chỉ được tạo bởi thao tác của người có role phù hợp. Mốc 20.000.000 đồng tính theo tổng thanh toán cuối cùng trên hóa đơn; với hóa đơn VAT, số này đã gồm VAT.

Ngân sách/chính sách, MST công ty, NCC được duyệt, PO và lịch sử thanh toán chưa có dữ liệu để đối chiếu. Hệ thống không đánh dấu các mục này là đạt, chưa thể phân loại U2, và không xác nhận tính xác thực/nguồn phát hành hay chữ ký số của hóa đơn.

Để bật luồng Azure trên Vercel, đặt `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, `AZURE_DOCUMENT_INTELLIGENCE_KEY`, `INVOICE_ANALYSIS_PROVIDER=azure` và `SUPABASE_SERVICE_ROLE_KEY` ở Environment Variables của Production/Preview. Tài liệu F0 hiện giới hạn file tối đa 4 MB và chỉ phân tích hai trang đầu; nếu PDF có nhiều hơn hai trang, người duyệt cần xem toàn bộ PDF trước khi quyết định. Luồng Azure có thể mất vài giây để xử lý và endpoint Vercel được cấu hình thời gian tối đa 60 giây. Chạy `supabase/schema.sql` trên Supabase project mới theo hướng dẫn đầu tài liệu. Không đưa key vào `config.js`, mã nguồn hoặc trình duyệt.

## Giới hạn đã biết

AI có thể đọc sai PDF scan hoặc tài liệu không chuẩn; confidence chỉ là bộ lọc hỗ trợ, không phải chứng nhận pháp lý. Không tự chuyển tiền. UI hiển thị 200 hồ sơ mới nhất và 50 sự kiện mới nhất của hồ sơ được chọn; database vẫn giữ các bản ghi cũ. Nếu upload xong mà gửi form thất bại, file chưa gắn hồ sơ có thể còn trong bucket riêng tư, cần quản trị dọn sau. Nhật ký chặn sửa bằng tài khoản người dùng, không phải chứng nhận chống sửa bởi quản trị viên database.
