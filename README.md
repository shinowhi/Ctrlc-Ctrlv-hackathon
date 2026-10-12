# Báo cáo tiến độ dự án FinRef

**Phiên bản:** MVP quản lý đề nghị thanh toán
**Cập nhật:** 25/09/2026

FinRef hỗ trợ số hóa bước tiếp nhận và rà soát đề nghị thanh toán, tập trung vào hóa đơn và quy trình phân quyền phê duyệt.

## Liên kết dành cho Ban Tổ chức

- **Ứng dụng production:** [https://ctrlc-ctrl-hackathon-two.vercel.app](https://ctrlc-ctrl-hackathon-two.vercel.app)
- **Mã nguồn:** [shinowhi/Ctrlc-Ctrlv-hackathon](https://github.com/shinowhi/Ctrlc-Ctrlv-hackathon)
- **Video giới thiệu:** [Mở video demo](https://drive.google.com/drive/folders/1lYAtANlfRtEfsqp-cihvlo8kT-dxD3tJ?usp=sharing)

## Tiến độ hiện tại

Bản production hiện đang chạy trên Vercel. Tích hợp Azure trong working tree cần được cấu hình biến môi trường và deploy riêng trước khi production sử dụng. MVP tập trung vào quy trình đề nghị thanh toán hóa đơn; phân hệ nhân sự chưa nằm trong phạm vi phiên bản này.

Checkout hiện tại thực hiện hàng chờ và thẩm quyền theo [chính sách FIN-APPROVAL-2](POLICY.md): hóa đơn AI đánh giá đạt điều kiện được tự gom vào danh sách chưa duyệt; Quản lý duyệt riêng hoặc cả danh sách hóa đơn tối đa 20 triệu; Giám đốc có danh sách tương tự cho hóa đơn trên 20 triệu và các khoản được chuyển cấp. Hạn mức 100 triệu tính trên tổng hóa đơn toàn công ty đã duyệt trong ngày theo giờ Bangkok. Nếu yêu cầu duyệt cả danh sách làm vượt mức, toàn bộ đợt được đưa lên Giám đốc; Giám đốc ghi lý do khi duyệt. Những thay đổi này mới nằm trong mã nguồn cục bộ: cần chạy migration Supabase và deploy giao diện trước khi production áp dụng.

### Đã xây dựng

- Giao diện web cho người nộp đơn và các vai trò tài chính: Quản lý tài chính (`treasurer`) và Người đứng đầu nhánh tài chính (`cfo`).
- Luồng tạo hồ sơ thanh toán, nhập tổng thanh toán cuối cùng, tên công ty mua trên hóa đơn và gửi hóa đơn PDF.
- Tích hợp luồng đọc hóa đơn bằng Azure Document Intelligence `prebuilt-invoice` (có thể chọn OpenAI Responses API) và lưu trữ/xử lý hồ sơ qua Supabase Auth, Storage và RPC.
- Mọi trường trên form người nộp đều tùy chọn; PDF vẫn bắt buộc. Thiếu dữ liệu sau khi gửi sẽ vào U1, tô tím các mục thiếu và trả hồ sơ cho người nộp. Tên người mua chỉ bỏ trống khi lựa chọn “Hóa đơn không ghi tên người mua”.
- Hóa đơn không phân loại đủ chắc mặc định áp dụng rule VAT mà không gắn cờ riêng. Sales cần tổng thanh toán confidence ≥81%; VAT cần tiền trước thuế và tổng sau thuế ≥90%, VAT khác 0 ≥90%, còn VAT = 0 cần ≥70% và bằng chứng thể hiện số 0. Nếu có chiết khấu, confidence cần ≥85%; phép tính VAT là tiền trước thuế − chiết khấu + VAT. Nếu tổng tính không khớp, chuyển Quản lý kiểm tra.
- Nhà cung cấp đã có trong danh mục cần MST confidence ≥85% và tên OCR khớp bí danh đã xác minh với confidence ≥70%. Nhà cung cấp mới cần tên khớp form và cả tên/MST confidence ≥80%; hồ sơ đủ điều kiện tiếp tục, đồng thời PDF/tên/MST được lưu ở ghi chú chỉ CFO xem được, không tự thêm vào danh mục.
- Số hóa đơn cần confidence ≥80%; số không khớp form được chuyển Quản lý kiểm tra. Trùng đồng thời MST và số hóa đơn với hồ sơ đã duyệt bị từ chối trực tiếp. Các mâu thuẫn rõ ở người mua/NCC bị từ chối; điểm chưa chắc, gồm tiền và số hóa đơn, chuyển vàng cho Quản lý.
- Chuẩn hóa số hóa đơn và tên bên bằng Unicode NFKC, chữ thường và khoảng trắng. Chỉ bỏ số 0 đầu của mã số thuần; biến thể khác dấu hoặc tên viết tắt chưa cấu hình cần Quản lý xác nhận.
- Hàng chờ động theo trạng thái chưa duyệt, không chia đợt theo ngày nộp: Quản lý xử lý hóa đơn đủ điều kiện đến 20 triệu; Giám đốc xử lý hóa đơn trên 20 triệu và hồ sơ vượt ngân sách ngày được chuyển cấp.
- AI đánh giá tính đủ điều kiện của hóa đơn; người có thẩm quyền quyết định cuối. `APPROVED` là chấp thuận khoản phải trả theo quy ước hackathon; ứng dụng không chuyển tiền.
- Demo offline và các bộ testcase/kiểm tra luật để hỗ trợ trình bày MVP.

### Cần tiếp tục kiểm thử và hoàn thiện

- Deployment báo **Ready** xác nhận build đã triển khai; cần tiếp tục kiểm thử luồng end-to-end trên môi trường production với cấu hình Supabase/Azure (hoặc OpenAI) và tài khoản thử nghiệm.
- Chưa kết nối dữ liệu ngân sách, chính sách chi tiêu, PO và lịch sử thanh toán. U2 hiện được dùng cho kiểm tra thủ công bởi Quản lý tài chính; khi đã xác minh mà vượt hạn mức hồ sơ/ngày thì chuyển CFO.
- Cơ chế hiện tại không xác minh tính xác thực của hóa đơn, nguồn phát hành hay chữ ký số.
- Phân hệ nhân sự và các quy trình ngoài đề nghị thanh toán sẽ được xem xét ở giai đoạn tiếp theo.

## Quy trình MVP

Người dùng gửi đề nghị và minh chứng → hệ thống trích xuất và đánh giá dữ kiện hóa đơn → hóa đơn đủ điều kiện được tự đưa vào hàng chờ theo thẩm quyền và hạn mức → người có thẩm quyền duyệt riêng hoặc duyệt tất cả danh sách; hồ sơ thiếu hoặc mâu thuẫn được Quản lý Tài chính xử lý trước.

Quản lý mở hồ sơ để xem hóa đơn PDF ngay trong trang; đơn đề nghị PDF không còn là file bắt buộc.

> Demo offline chỉ mô phỏng giao diện và rules trên trình duyệt; không đọc file thật, không gọi AI/backend và không đại diện cho dữ liệu production.

### Cấu hình cập nhật đánh giá hóa đơn

- Database đã có danh mục nhà cung cấp: chạy `supabase/migrations/20261007-z-agreed-payment-rules.sql` một lần sau migration cuối hiện có. Database mới tạo từ `supabase/schema.sql` cần lần lượt thêm `20261004-z-vendor-directory.sql`, `20261004-zz-vendor-invoice-seed.sql`, `20261005-vendor-invoice-aliases.sql`, `20261005-vendor-unaccented-aliases.sql`, rồi migration `20261007-z-agreed-payment-rules.sql`. Hoàn tất database trước khi deploy frontend/API.
- Với `INVOICE_ANALYSIS_PROVIDER=azure`, đặt `OPENAI_API_KEY` trên Vercel để phân loại loại hóa đơn khi Azure không đọc rõ tiêu đề. Khi confidence tổng tiền dưới ngưỡng áp dụng, Azure được đọc lại riêng trường tổng tiền; nếu hai kết quả khác nhau hoặc vẫn chưa đủ chắc, hồ sơ chuyển Quản lý. Fallback đọc toàn hóa đơn hiện có vẫn dùng khi tín hiệu OCR cốt lõi quá yếu.
- Với `INVOICE_ANALYSIS_PROVIDER=openai`, các trường hóa đơn được đọc trong cùng lượt; confidence, bằng chứng và các ngưỡng được đánh giá ở API lẫn database.
