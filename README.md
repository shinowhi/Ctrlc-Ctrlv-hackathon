# FinRef — MVP rà soát đề nghị thanh toán

**Cập nhật:** 12/10/2026

FinRef hỗ trợ tiếp nhận và rà soát đề nghị thanh toán dựa trên hóa đơn PDF, trích xuất dữ kiện bằng AI, chuyển các điểm chưa chắc cho người phụ trách, và lưu quyết định cùng nhật ký. FinRef không thực hiện chuyển tiền.

## Liên kết

- **Ứng dụng chính thức:** [ctrlc-ctrlv-hackathon-two.vercel.app](https://ctrlc-ctrlv-hackathon-two.vercel.app/)
- **Mã nguồn:** [shinowhi/Ctrlc-Ctrlv-hackathon](https://github.com/shinowhi/Ctrlc-Ctrlv-hackathon)
- **Thư mục Drive do nhóm cung cấp:** [Mở thư mục](https://drive.google.com/drive/folders/1lYAtANlfRtEfsqp-cihvlo8kT-dxD3tJ?usp=sharing). Chưa xác minh thư mục hiện có video thuyết trình/demo.

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
- Mã nguồn hiện có không tự chứng minh rằng production đã chạy đúng cùng commit hoặc đã áp dụng mọi migration. Lần rà soát gần nhất và các giới hạn xác minh được ghi tại [VALIDATION.md](VALIDATION.md).

## Trạng thái kiểm tra gần nhất

Ngày 12/10/2026, ứng dụng chính thức và các giao diện vai trò đã được xem trong phiên đăng nhập. Bộ **17 ca Verify** hiển thị đạt, nhưng đây là preview `FinRefRules.verify()` phía trình duyệt, không phải kiểm thử end-to-end. Khi chuyển sang hồ sơ Quản lý khác để mở PDF, giao diện gặp lỗi; cần khắc phục và kiểm tra lại trước khi trình diễn. Chi tiết nằm trong [VALIDATION.md](VALIDATION.md).

Người dùng xác nhận ba tài khoản được dùng để rà soát thuộc về ba nhân sự thật. Chưa thu thập trích dẫn phỏng vấn hoặc tài liệu độc lập để xác minh mức độ sử dụng/tổ chức.

## Database và cấu hình

- Chuỗi migration trong nhánh hiện đến `supabase/migrations/20261012-restore-single-buyer-name.sql`. Đối chiếu lịch sử của đúng Supabase project và chỉ chạy các migration còn thiếu; không xem riêng migration mới nhất là đủ.
- Trạng thái migration trên production chưa được xác minh trực tiếp trong lần rà soát. Không suy ra trạng thái database production chỉ từ mã nguồn hoặc giao diện đang chạy.
- API hỗ trợ cấu hình `INVOICE_ANALYSIS_PROVIDER=azure` hoặc `openai`. Biến môi trường và provider đang dùng trên production chưa được xác minh trong lần rà soát.
