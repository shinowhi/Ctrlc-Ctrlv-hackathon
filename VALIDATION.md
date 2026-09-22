# Kiểm chứng tích hợp AI Shop · 22/09/2026

## Đã thực hiện trên máy phát triển

- `node --test tests/*.test.cjs`: **45/45 test đạt**, không bỏ qua test.
- SQL gốc + migration chạy trên **PostgreSQL WASM PGlite 0.5.8**, không chỉ so khớp chuỗi SQL. Các assertion kiểm tra phê duyệt 19.999.999 đồng, chuyển từ đúng 20 triệu, U1 cần giải quyết, U2 ngoại lệ, RLS/quyền RPC, assessment bị sửa/đã dùng/hết hạn, hóa đơn trùng, ngân sách, giới hạn lượt AI và phiên bản cũ.
- Rollback SQL chạy được trên database kiểm thử và giữ các hồ sơ hiện có.
- AI Shop: đã kiểm thử đúng endpoint/model, không theo redirect, không gửi khóa tới host ngoài allowlist; lỗi xác thực/hạn mức/model không lộ phản hồi chứa khóa. `codex-auto-review` chưa được xác nhận hỗ trợ ảnh/PDF và JSON Schema qua API thật.
- Local HTTP: route dùng chung handler online; chặn origin khác, JSON sai, body quá lớn và truy cập file riêng tư.
- API phân tích kiểm thử với transport giả lập: identity, rate limit và file header sai không gọi dịch vụ AI; chỉ lấy byte từ Storage; lỗi dịch vụ/incomplete không tạo assessment thành công; cờ nghi vấn của mô hình giữ U1.
- Chrome headless + PostgreSQL cục bộ, mạng Supabase/AI Shop giả lập: đăng nhập ba vai trò; gửi hai file; tự duyệt 12,5 triệu và 19.999.999 đồng; đúng 20 triệu chuyển U3; U3 → GĐTC duyệt; U1 → bổ sung → đánh giá lại; U2; lỗi AI → U1; thủ quỹ xác minh có lý do → đánh giá lại; Verify 5/15; không lỗi JavaScript.
- Giao diện online không tràn ngang toàn trang ở 320, 768, 1024, 1440 px trong luồng kiểm thử; bảng có vùng cuộn riêng.
- Build tạo đủ tài nguyên công khai, không đóng gói AI key/service role key. Không thêm dependency sản xuất; dependency kiểm thử cài đúng lockfile với `--ignore-scripts`.

## Chưa xác minh trên dịch vụ thật

- Chưa cấu hình AI Shop key, chưa gọi model thật, chưa đo độ chính xác trên PDF/ảnh thật. Chưa có bằng chứng chất lượng OCR hoặc tỷ lệ chuyển tiếp trên tập dữ liệu thực tế.
- Chưa chạy migration trên Supabase của người dùng, chưa xác minh Storage/RLS trong deployment thật hay tranh chấp transaction trên nhiều kết nối thật. PGlite chạy SQL nhưng không thay thế toàn bộ Supabase.
- Chưa push/merge GitHub hoặc deploy Vercel. Website hiện có chưa được thay đổi.
- Chưa chạy `scripts/test-online.cjs` do chưa có cấu hình/tài khoản của project thử nghiệm.

## Chạy lại

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

Browser test dùng Playwright đã cài (mặc định tìm `playwright`, hoặc đặt `PLAYWRIGHT_PATH` tới thư viện có sẵn) và Chrome (mặc định channel `chrome`, hoặc `CHROME_PATH` tới executable):

```sh
node scripts/test-browser.cjs
```

`QA_SCREENSHOT` tùy chọn chỉ định đường dẫn ảnh chụp. Script dùng cổng localhost ngẫu nhiên và tự đóng trình duyệt/server sau kiểm thử. Không truy cập database thật và không gửi chứng từ tới AI Shop.

Để nghiệm thu online: hoàn tất [HUONG-DAN-ONLINE.md](HUONG-DAN-ONLINE.md), kiểm tra với chứng từ giả, rồi chạy kiểm thử quyền trên project thử. Không gọi demo checkbox là đã xác minh chứng từ thật.
