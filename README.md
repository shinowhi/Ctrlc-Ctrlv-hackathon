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
- Phân loại rõ hóa đơn bán hàng/VAT. Hóa đơn bán hàng chỉ đối chiếu tổng thanh toán cuối cùng; hóa đơn VAT mới kiểm tra phép cộng tiền trước thuế và VAT. Chiết khấu được trích xuất riêng; chỉ trừ khỏi phép tính VAT khi hóa đơn ghi rõ tiền trước thuế là trước chiết khấu. Số tiền còn phải thanh toán chỉ hiển thị thông tin.
- Chuẩn hóa số hóa đơn và tên bên bằng Unicode NFKC, chữ thường và khoảng trắng. Chỉ bỏ số 0 đầu của mã số thuần; biến thể khác dấu hoặc tên viết tắt chưa cấu hình cần Quản lý xác nhận.
- Hàng chờ động theo trạng thái chưa duyệt, không chia đợt theo ngày nộp: Quản lý xử lý hóa đơn đủ điều kiện đến 20 triệu; Giám đốc xử lý hóa đơn trên 20 triệu và hồ sơ vượt ngân sách ngày được chuyển cấp.
- AI đánh giá tính đủ điều kiện của hóa đơn; người có thẩm quyền quyết định cuối. `APPROVED` là chấp thuận khoản phải trả theo quy ước hackathon; ứng dụng không chuyển tiền.
- Demo offline và các bộ testcase/kiểm tra luật để hỗ trợ trình bày MVP.

### Cần tiếp tục kiểm thử và hoàn thiện

- Deployment báo **Ready** xác nhận build đã triển khai; cần tiếp tục kiểm thử luồng end-to-end trên môi trường production với cấu hình Supabase/Azure (hoặc OpenAI) và tài khoản thử nghiệm.
- Chưa kết nối dữ liệu ngân sách, chính sách chi tiêu, danh sách nhà cung cấp, PO và lịch sử thanh toán; do đó phân loại `U2` chưa được hỗ trợ.
- Cơ chế hiện tại không xác minh tính xác thực của hóa đơn, nguồn phát hành hay chữ ký số.
- Phân hệ nhân sự và các quy trình ngoài đề nghị thanh toán sẽ được xem xét ở giai đoạn tiếp theo.

## Quy trình MVP

Người dùng gửi đề nghị và minh chứng → hệ thống trích xuất và đánh giá dữ kiện hóa đơn → hóa đơn đủ điều kiện được tự đưa vào hàng chờ theo thẩm quyền và hạn mức → người có thẩm quyền duyệt riêng hoặc duyệt tất cả danh sách; hồ sơ thiếu hoặc mâu thuẫn được Quản lý Tài chính xử lý trước.

Quản lý mở hồ sơ để xem hóa đơn PDF ngay trong trang; đơn đề nghị PDF không còn là file bắt buộc.

> Demo offline chỉ mô phỏng giao diện và rules trên trình duyệt; không đọc file thật, không gọi AI/backend và không đại diện cho dữ liệu production.
