# FinRef — MVP rà soát đề nghị thanh toán

**Cập nhật:** 15/10/2026

FinRef hỗ trợ tiếp nhận và rà soát đề nghị thanh toán dựa trên hóa đơn PDF, trích xuất dữ kiện bằng AI, chuyển các điểm chưa chắc cho người phụ trách, và lưu quyết định cùng nhật ký. FinRef không thực hiện chuyển tiền.

## Liên kết

- **Ứng dụng chính thức:** [ctrlc-ctrlv-hackathon-two.vercel.app](https://ctrlc-ctrlv-hackathon-two.vercel.app/)
- **Mã nguồn:** [shinowhi/Ctrlc-Ctrlv-hackathon](https://github.com/shinowhi/Ctrlc-Ctrlv-hackathon)
- **Thư mục Drive do nhóm cung cấp:** [Mở thư mục](https://drive.google.com/drive/folders/1lYAtANlfRtEfsqp-cihvlo8kT-dxD3tJ?usp=sharing). Chưa xác minh thư mục hiện có video thuyết trình/demo.

## Cấu trúc repo

- `web/`: mã nguồn giao diện chính và trang demo.
- `shared/`: tiện ích được dùng chung giữa giao diện và API.
- `api/`: endpoint serverless của Vercel; giữ nguyên đường dẫn endpoint.
- `scripts/`: build, chạy local, thiết lập tài khoản và kiểm tra.
- `tests/`: kiểm thử tự động và helper dành cho test.
- `supabase/`: schema, thứ tự migration và SQL migrations.
- `docs/`: chính sách, đặc tả, hướng dẫn, testcase, validation và kế hoạch.

Build vẫn xuất các file giao diện với tên và URL hiện có vào `dist/`.

## Phạm vi sản phẩm

- Người nộp gửi đề nghị và hóa đơn PDF; các trường thông tin có thể để trống để hệ thống trả về yêu cầu bổ sung (U1). Hóa đơn PDF là tệp bắt buộc.
- API đọc các trường hóa đơn, confidence và bằng chứng bằng Azure Document Intelligence hoặc OpenAI Responses API theo cấu hình. Các kiểm tra hiện có đối chiếu thông tin trên form, nhà cung cấp trong danh mục nội bộ, số hóa đơn và tổng tiền.
- Hồ sơ đủ điều kiện được đưa vào hàng chờ phê duyệt; điểm thiếu hoặc chưa chắc chuyển Quản lý Tài chính xem xét (U2); hồ sơ đủ điều kiện trên 20 triệu đồng chuyển Giám đốc Tài chính (U3/CFO).
- Người có thẩm quyền quyết định cuối. Hạn mức phê duyệt ngày được tính khi duyệt; `APPROVED` là chấp thuận khoản phải trả theo quy ước hackathon, không phải lệnh chuyển tiền.
- Hệ thống có danh mục nhà cung cấp và bí danh nội bộ. Đây không phải xác minh độc lập với cơ quan thuế hay nguồn dữ liệu bên ngoài.

## Giới hạn

- Hệ thống chưa đối chiếu ngân sách thực theo mã, chính sách chi tiêu, PO hoặc lịch sử thanh toán. Hạn mức ngày là giới hạn phê duyệt, không chứng minh hồ sơ nằm trong ngân sách.
- AI không xác nhận tính xác thực của hóa đơn, nguồn phát hành hoặc chữ ký số.
- `demo.html` chỉ mô phỏng giao diện và preview luật trên trình duyệt; không đọc PDF thật, không gọi AI/backend và không đại diện cho dữ liệu production.
- Mã nguồn hiện có không tự chứng minh rằng production đã chạy đúng cùng commit hoặc đã áp dụng mọi migration. Lần rà soát gần nhất và các giới hạn xác minh được ghi tại [VALIDATION.md](docs/VALIDATION.md).

## Trạng thái xác minh

Lần kiểm tra trực tiếp ứng dụng production gần nhất được ghi nhận ngày 12/10/2026. Khi đó, bộ **17 ca Verify** hiển thị đạt; đây là preview `FinRefRules.verify()` phía trình duyệt, không phải kiểm thử end-to-end. Lần kiểm tra đó cũng ghi nhận lỗi khi chuyển giữa các PDF ở vai trò Quản lý. Chưa xác minh lại lỗi này trên production sau các thay đổi mã nguồn tiếp theo. Chi tiết nằm trong [VALIDATION.md](docs/VALIDATION.md).

Người dùng xác nhận ba tài khoản được dùng để rà soát thuộc về ba nhân sự thật. Chưa thu thập trích dẫn phỏng vấn hoặc tài liệu độc lập để xác minh mức độ sử dụng/tổ chức.

## Database và cấu hình

- Checkout này đã quay về baseline chỉ đăng nhập trước khi thêm chế độ khách. Project Supabase mới dùng `supabase/schema.sql`, sau đó chạy đúng thứ tự trong [`supabase/fresh-install-migrations.txt`](supabase/fresh-install-migrations.txt), kết thúc ở `20261017-invoice-currency.sql`. Không dùng SQL rollback guest từng chạy lỗi để dựng project mới hoặc sửa project cũ.
- Database đang dùng phải đối chiếu lịch sử của đúng project và chỉ chạy migration còn thiếu; không chạy lại `schema.sql` hoặc xem riêng migration mới nhất là đủ. Việc chuyển dữ liệu/tài khoản từ project cũ sang project mới là bước riêng, không được thực hiện bằng các migration trong manifest.
- Trạng thái migration trên production chưa được xác minh trực tiếp trong lần rà soát. Không suy ra trạng thái database production chỉ từ mã nguồn hoặc giao diện đang chạy.
- API hỗ trợ cấu hình `INVOICE_ANALYSIS_PROVIDER=azure` hoặc `openai`. Biến môi trường và provider đang dùng trên production chưa được xác minh trong lần rà soát.
