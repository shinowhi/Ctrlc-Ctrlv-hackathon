# Báo cáo tiến độ dự án FinRef

**Phiên bản:** MVP quản lý đề nghị thanh toán
**Cập nhật:** 25/09/2026

FinRef hỗ trợ số hóa bước tiếp nhận và rà soát đề nghị thanh toán, tập trung vào hóa đơn và quy trình phân quyền phê duyệt.

## Liên kết dành cho Ban Tổ chức

- **Ứng dụng production:** [https://ctrlc-ctrl-hackathon-two.vercel.app](https://ctrlc-ctrl-hackathon-two.vercel.app)
- **Mã nguồn:** [shinowhi/Ctrlc-Ctrlv-hackathon](https://github.com/shinowhi/Ctrlc-Ctrlv-hackathon)
- **Video giới thiệu:** [Mở video demo](https://drive.google.com/drive/folders/1lYAtANlfRtEfsqp-cihvlo8kT-dxD3tJ?usp=sharing)

## Tiến độ hiện tại

Bản build mới nhất đã được triển khai thành công trên Vercel Production. MVP hiện tập trung vào quy trình đề nghị thanh toán hóa đơn; phân hệ nhân sự chưa nằm trong phạm vi phiên bản này.

### Đã xây dựng

- Giao diện web cho người nộp đơn và các vai trò tài chính: Quản lý tài chính (`treasurer`) và Người đứng đầu nhánh tài chính (`cfo`).
- Luồng tạo hồ sơ thanh toán, nhập tổng tiền đã gồm VAT và gửi hóa đơn PDF cùng đơn đề nghị.
- Tích hợp luồng đọc minh chứng bằng OpenAI Responses API và lưu trữ/xử lý hồ sơ qua Supabase Auth, Storage và RPC.
- Kiểm tra các trường hóa đơn, phép cộng trước thuế + VAT và đối chiếu tổng thanh toán với dữ liệu người dùng nhập.
- Phân luồng hồ sơ: cần bổ sung thông tin (`U1`), chuyển cấp khi tổng tiền vượt 20.000.000 đồng (`U3`), hoặc đưa vào hàng đợi chờ người có thẩm quyền quyết định.
- Quyết định duyệt cuối do người có thẩm quyền thực hiện; AI không tự phê duyệt và hệ thống không chuyển tiền.
- Demo offline và các bộ testcase/kiểm tra luật để hỗ trợ trình bày MVP.

### Cần tiếp tục kiểm thử và hoàn thiện

- Deployment báo **Ready** xác nhận build đã triển khai; cần tiếp tục kiểm thử luồng end-to-end trên môi trường production với cấu hình Supabase/OpenAI và tài khoản thử nghiệm.
- Nhánh cập nhật bổ sung hạn mức demo 200.000.000 đồng/tháng, cảnh báo từ 160.000.000 đồng và chỉ tính hồ sơ đã duyệt; luồng online cần áp dụng migration `supabase/migrations/20260925_001_monthly_approval_budget.sql` trước khi sử dụng. Chính sách chi tiết/U2, nhà cung cấp, PO và lịch sử thanh toán chưa được đối chiếu.
- Cơ chế hiện tại không xác minh tính xác thực của hóa đơn, nguồn phát hành hay chữ ký số.
- Phân hệ nhân sự và các quy trình ngoài đề nghị thanh toán sẽ được xem xét ở giai đoạn tiếp theo.

## Quy trình MVP

Người dùng gửi đề nghị và minh chứng → hệ thống trích xuất, đối chiếu các trường hóa đơn và tổng tiền → hồ sơ thiếu hoặc mâu thuẫn được yêu cầu bổ sung; hồ sơ vượt ngưỡng được chuyển cấp → người có thẩm quyền xem xét và quyết định cuối.

> Demo offline chỉ mô phỏng giao diện và rules trên trình duyệt; không đọc file thật, không gọi AI/backend và không đại diện cho dữ liệu production.