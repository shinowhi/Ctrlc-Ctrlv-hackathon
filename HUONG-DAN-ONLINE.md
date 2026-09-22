# Cấu hình FinRef Sprint 1 · Supabase, OpenAI, Vercel

Bản Vercel trước đây không tự nhận các thay đổi trong thư mục local này. Cần đưa nhánh code lên repo và triển khai sau khi cấu hình bên dưới. Hãy thử bằng Supabase dành riêng cho hackathon và chứng từ giả.

## 1. Nâng cấp database

- **Đã có database MVP:** sao lưu trước, mở Supabase SQL Editor và chạy **`supabase/sprint1.sql` một lần**. Không chạy lại `schema.sql`.
- **Project mới:** chạy `supabase/schema.sql` trước, rồi `supabase/sprint1.sql`, mỗi file một lần.
- Kiểm tra có `profiles`, `requests`, `audit_events`, `agent_assessments`, `demo_budgets`; bucket `evidence` là Private. Assessment không được đọc/ghi trực tiếp từ người dùng.
- Tắt tự đăng ký tài khoản trong Supabase nếu chỉ dùng tài khoản nhóm. Giữ đăng nhập email/password.
- Nếu cần quay về MVP, dùng `supabase/rollback-sprint1.sql` và triển khai lại frontend/API của phiên bản cũ. Rollback giữ dữ liệu bổ sung, không xóa hồ sơ/ngân sách/nhật ký.

## 2. Ba tài khoản

Nếu đã có đủ người nộp, thủ quỹ, GĐTC thì tiếp tục dùng. Nếu chưa có, mở PowerShell tại thư mục chứa `package.json`, chạy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-accounts.ps1
```

Nhập Project URL và secret/service_role key khi script hỏi. Mật khẩu được lưu riêng trong `.local/accounts.txt` (đã gitignore). Không gửi file này lên GitHub. Script giữ tài khoản có sẵn, không tự đổi mật khẩu.

## 3. Tạo và cấu hình OpenAI key

1. Mở <https://platform.openai.com/api-keys> trong tài khoản của bạn. Tạo key cho project hackathon, kiểm tra billing và giới hạn chi tiêu trong dashboard. Quyền sử dụng API/billing được quản lý riêng với ứng dụng chat.
2. Trong Vercel → project hiện có → **Settings → Environment Variables**, thêm các biến dưới đây cho môi trường Preview/Production bạn muốn dùng. Không gửi khóa vào chat hoặc commit vào mã nguồn.

| Biến | Giá trị | Phạm vi |
|---|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` | URL công khai |
| `SUPABASE_ANON_KEY` | Publishable hoặc legacy anon key | Được đóng gói vào frontend |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy service_role JWT từ Supabase | **Chỉ máy chủ** ghi assessment sau khi xác thực tài khoản |
| `OPENAI_API_KEY` | Key vừa tạo | **Chỉ máy chủ** gọi OpenAI |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Có thể đổi sang model hỗ trợ ảnh/PDF và Structured Outputs trong project của bạn |

Biến server không có tiền tố `PUBLIC_`, `VITE_` hoặc `NEXT_PUBLIC_`. `config.js`/`dist` chỉ chứa URL và khóa Supabase công khai. Không dùng service_role thay cho `SUPABASE_ANON_KEY`.

3. Lưu biến rồi **Redeploy** sau khi code mới đã có trên Vercel. Không cần cung cấp key cho Codex. Nếu thiếu hoặc sai key, hồ sơ vẫn đi U1; không tự duyệt.
4. Để dùng local với `vercel dev`, copy `.env.example` thành `.env.local` và điền trên máy của bạn; file thật được gitignore. Giữ API route ở thư mục `api/`, không copy nó vào `dist`.

## 4. Thiết lập build

- Node.js 22 trở lên; package manager đã ghim `pnpm@11.19.0`.
- Install: `pnpm install --frozen-lockfile --ignore-scripts`.
- Build: `node scripts/build.cjs`.
- Output directory: `dist`.
- Framework: Other. `vercel.json` đặt tối đa 120 giây cho API phân tích; kiểm tra giới hạn gói Vercel thực tế.
- Root Directory là thư mục chứa `package.json`, `api/` và `supabase/` của bản này.

## 5. Thử nghiệm sau deploy

1. Đăng nhập người nộp, chọn ngân sách MKT-OPS-2026 và danh mục In ấn. Tạo hai chứng từ **giả** có số tiền, nhà cung cấp, số/ngày hóa đơn khớp form, hình dấu/chữ ký rõ.
2. Gửi hồ sơ 12,5 triệu và đúng 20 triệu, dùng số hóa đơn khác nhau. Kỳ vọng tự duyệt nếu AI đọc đủ và ngân sách còn đủ; nhật ký ghi tác tử.
3. Gửi 20 triệu + 1: kỳ vọng U3 và câu hỏi cho GĐTC.
4. Làm số tiền trên một chứng từ không khớp: kỳ vọng U1 và câu hỏi chỉ ra lệch số. Bổ sung lại hai file → đánh giá lại. Thủ quỹ có thể xác minh với lý do nhưng không được vượt quyền/ngân sách.
5. Chọn danh mục `other` có nội dung khớp file: kỳ vọng U2. GĐTC có thể phê duyệt ngoại lệ cho riêng hồ sơ, yêu cầu bổ sung hoặc từ chối, đều có câu trả lời/lý do.
6. Tắt key trên Preview để thử lỗi AI: hồ sơ phải chờ U1. Không được thấy trạng thái đã duyệt do lỗi đọc.
7. Verify 5 ca (và 15 ca trên bản online) chạy độc lập với AI, hiển thị đủ trạng thái, lý do, người nhận, câu hỏi. Đây là bộ dữ kiện mẫu, không phải kiểm thử chất lượng OCR thật.

Có thể chạy `node scripts/test-online.cjs` trên project thử với ba tài khoản trong `.local/accounts.txt`. Script tạo hồ sơ `TEST ONLINE`, không chuyển tiền và không gọi AI. Không tự xóa dữ liệu test để giữ nhật ký.

## Sự cố thường gặp

- **RPC/column không tồn tại:** migration Sprint 1 chưa chạy hoặc frontend đang dùng nhầm Supabase project.
- **AI chưa cấu hình:** kiểm tra cả OpenAI key, model và service_role key trong Vercel rồi redeploy.
- **Chưa thể phân tích:** kiểm tra file đã tải lên, migration và giới hạn 6 lượt/phút hoặc 100 lượt/ngày/tài khoản.
- **AI không đọc được:** ảnh mờ, thiếu thông tin, model không hỗ trợ định dạng, key/model/billing không hợp lệ, timeout hoặc dịch vụ gián đoạn. Xem Vercel/OpenAI dashboard; hồ sơ sẽ giữ U1.
- **Assessment không khớp/hết hạn/đã dùng:** gửi lại để lấy đánh giá mới; kết quả chỉ dùng một lần trong 15 phút, ràng buộc cả nội dung form và hai đường dẫn.
- **Hồ sơ đã thay đổi:** tải lại trước khi quyết định; chỉ một quyết định được ghi cho một phiên bản.
- **Ngoài ngân sách:** xem `demo_budgets`. Không đặt `committed` về 0 khi đã có phê duyệt; ngoại lệ phải qua GĐTC.

Tài liệu OpenAI đã đối chiếu: [File inputs](https://developers.openai.com/api/docs/guides/file-inputs), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). `store:false` được dùng cho Responses; điều đó không thay thế việc xem chính sách lưu giữ dữ liệu của nhà cung cấp trước sử dụng thật.
