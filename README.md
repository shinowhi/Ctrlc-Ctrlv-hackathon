# FinRef — Web quản trị tài chính và nhân sự

FinRef là nền tảng quản trị nội bộ giúp doanh nghiệp số hóa các quy trình tài chính và nhân sự trên một hệ thống tập trung. Dự án hướng đến việc giảm thao tác thủ công, tăng tính minh bạch và giúp doanh nghiệp dễ theo dõi tiến độ xử lý.

**Demo:** [Ứng dụng trực tuyến](https://ctrlc-ctrlv-hackathon-two.vercel.app/) · [Video giới thiệu](https://drive.google.com/drive/folders/1lYAtANlfRtEfsqp-cihvlo8kT-dxD3tJ?usp=sharing)

## Tiến độ dự án

Hiện nhóm đang tập trung phát triển phân hệ tài chính. Phân hệ nhân sự sẽ được triển khai trong giai đoạn tiếp theo.

## Phạm vi hiện tại của luồng hóa đơn

- Đăng nhập chung theo ba role đang có trong database: Người nộp đơn, Quản lý tài chính (`treasurer`) và Người đứng đầu nhánh tài chính (`cfo`). Chưa thêm role HR vì quyền và phân hệ nghỉ phép chưa được chốt.
- Người nộp đơn tạo hồ sơ, nhập tổng thanh toán đã gồm VAT và tải hóa đơn PDF (PDF có chữ chọn/copy hoặc scan) cùng đơn đề nghị.
- OpenAI Responses API trích xuất trường hóa đơn cùng độ tin cậy/bằng chứng. Rules đối chiếu nhà cung cấp, số/ngày hóa đơn, phép cộng trước thuế + VAT và tổng thanh toán với form.
- Nếu dữ kiện thiếu, độ tin cậy thấp hoặc có mâu thuẫn, hồ sơ chuyển `NEEDS_INFO` với câu hỏi cụ thể (`U1`). Nếu tổng thanh toán đã gồm VAT lớn hơn 20.000.000 đồng, hồ sơ chuyển người đứng đầu nhánh tài chính (`U3`). Hồ sơ còn lại vào `READY_FOR_APPROVAL`.
- AI không thể đặt hồ sơ thành `APPROVED`. Quản lý tài chính hoặc người đứng đầu nhánh tài chính phải bấm duyệt cuối theo thẩm quyền.
- Ngân sách/chính sách, MST công ty, danh sách NCC, PO và lịch sử thanh toán chưa được đối chiếu. Vì vậy hệ thống chưa thể phân loại U2; `CLEAR` chỉ nghĩa là các kiểm tra đang có đã đạt.
- Hệ thống không xác nhận tính xác thực của hóa đơn, nguồn phát hành hay chữ ký số và không thực hiện chuyển tiền.

## Quy trình chính

Người nộp gửi form và minh chứng → AI đọc PDF, kiểm tra trường và tổng gồm VAT → thiếu/lệch dữ kiện thì hỏi bổ sung; tổng trên 20 triệu thì chuyển người đứng đầu nhánh tài chính; trường hợp còn lại vào hàng đợi sẵn sàng duyệt → người có thẩm quyền bấm duyệt cuối.

## Những gì có trong Sprint 1

- Frontend online tại `index.html`, kết nối Supabase Auth, Storage và RPC.
- Backend dữ liệu và phân quyền tại `supabase/schema.sql` (RLS, Storage private, audit log, các RPC xử lý hồ sơ).
- Demo offline tại `demo.html` để trình diễn nhanh, không cần tài khoản.
- Smoke test 5 ca: `npm run smoke`.
- Bộ 15 testcase và format để BTC mở rộng: [`TESTCASES.md`](TESTCASES.md).
- Bộ test tự động: `npm test` (hoặc `node --test tests/*.test.cjs`).

## Chạy demo ngay

Mở file `demo.html` trong trình duyệt. Demo dùng `localStorage`, chỉ mô phỏng giao diện và rules engine, không đọc/lưu file minh chứng vào backend. Cách chạy qua HTTP localhost nằm ở phần bên dưới; bước build yêu cầu cấu hình Supabase.

Kiểm tra luật không cần Supabase hoặc cài thư viện (Node.js 22 trở lên):

```powershell
node scripts/smoke-local.cjs
node --test tests/*.test.cjs
```

## Chạy luồng online trên localhost

1. Tạo project Supabase và chạy toàn bộ [`supabase/schema.sql`](supabase/schema.sql).
2. Tạo ba tài khoản mẫu bằng `npm run setup:accounts` theo [`HUONG-DAN-ONLINE.md`](HUONG-DAN-ONLINE.md).
3. Đặt hai biến môi trường công khai cho frontend rồi build:

   ```powershell
   $env:SUPABASE_URL = 'https://your-project.supabase.co'
   $env:SUPABASE_ANON_KEY = '<publishable hoặc anon key>'
   node scripts/build.cjs
   node scripts/serve.cjs
   ```

4. Mở <http://127.0.0.1:8124> và chạy 5 smoke case trong `TESTCASES.md`.

Không đưa `service_role`, secret key, mật khẩu hoặc thư mục `.local` lên GitHub. `scripts/build.cjs` chỉ đóng gói các file frontend được phép và từ chối admin key.

## Kiểm tra online trước khi gửi BTC

Sau khi có Supabase thật và ba tài khoản, chạy:

```powershell
$env:SUPABASE_URL = 'https://your-project.supabase.co'
$env:SUPABASE_ANON_KEY = '<publishable hoặc anon key>'
node scripts/test-online.cjs
```

Lệnh này kiểm tra phân quyền, Storage private, mốc 20 triệu, tranh chấp cập nhật, bổ sung hồ sơ và audit log. Xem [`VALIDATION.md`](VALIDATION.md) để biết phần nào đã được kiểm tra và phần nào còn phụ thuộc project thật.
