# Quy tắc che có chọn lọc — chính sách v2

Người dùng đã chấp nhận ngày 17/10/2026: che MST, địa chỉ, số hóa đơn; giữ các trường khác trên PDF và form. Che QR chứa dữ liệu bị hạn chế, URL mở hóa đơn hoặc chưa xác minh được. Quy tắc này thay phần “không lưu mọi định danh” trong INVOICE-PRIVACY.md đối với hồ sơ mới có redaction_policy=2. Không thay đổi hồ sơ cũ.

## Thực hiện
- Backend dùng trường Azure có kiểu rõ ràng và nhãn OCR Việt/Anh/Trung; tìm lại giá trị nhạy cảm lặp trong ghi chú. Không còn che mọi words/lines/paragraphs ngoài ngày/tiền.
- Không mở vùng trong một mặt nạ lớn bằng cách trừ tiền/ngày: chỉ tạo vùng che từ dữ liệu cần che. Dòng OCR chứa cả dữ liệu cấm và dữ liệu được phép có thể bị che cả dòng để không lộ dữ liệu cấm.
- Quét ảnh PDF local phía server tìm QR (kể cả nhiều QR trên trang). Payload QR không trả về hoặc ghi log. Hiện chưa có tiêu chí xác thực QR vô hại nên QR phát hiện được được xem là chưa xác minh và che. Không truy cập URL trong QR.
- Lưu allowlist requesterType, requester, department, buyerMode, buyerCompany, budgetCode, purpose, vendor sau lọc; không lưu invoiceNumber/taxCode/address hay bằng chứng OCR. Lọc cả các dòng nhập tự do chứa nhãn/giá trị hạn chế đã biết. Người nộp bắt buộc xem lại form đã lọc cùng từng trang.
- RPC chỉ service_role gọi được, lọc khóa JSON dư. Giữ privacy_version=1 để không bỏ qua kiểm tra thủ công hiện có; thêm redaction_policy=2 để phân biệt giao diện/chính sách. Chữ ký biên nhận đổi domain/version, từ chối biên nhận cũ. private_intake_ready trả 2 để chặn API mới chạy với schema cũ.
- Giữ xóa Azure bắt buộc, signed masks áp lại phía server, PDF mới chỉ ảnh không text layer, quyền Storage và quy tắc phê duyệt.

## Giới hạn cần hiểu trước triển khai
- Nhận diện ngôn ngữ/địa chỉ không toàn diện. Mẫu không có nhãn, dữ liệu cố ý biến dạng, địa chỉ tự do chưa có trong OCR, QR hỏng/nhỏ hoặc chưa định vị được vẫn có thể bị bỏ sót. Không tuyên bố tự động bảo đảm không còn PII; cần người nộp kiểm tra và che thủ công trước xác nhận.
- Thông tin cùng dòng với trường cấm có thể bị che thêm. Chữ không dấu “phuong/duong” trong tên không tự bị xem là địa chỉ chỉ vì từ đó.
- Bản đã che lịch sử không khôi phục được; nạp lại bản gốc khi cần áp dụng mới.
- Không mở quyền truy cập bản gốc, không bỏ kiểm tra trùng thủ công, không tự duyệt ngoại tệ.

## Kiểm thử
34 kiểm tra mục tiêu qua: selective-redaction, decimal-invoice-db (PostgreSQL PGlite với migration thật), decimal-multilingual, approval-ui, build, pdf-runtime, account-only. Có kiểm thử request phân tích/ký/lưu với cloud giả lập, chữ ký bị sửa, schema cũ, thiếu xác nhận form, mặt nạ server, text layer rỗng, hai QR trên cùng trang, lọc JSON dư và dữ liệu audit, escape HTML.

Bản local http://127.0.0.1:8125 dùng PDF tungcua.pdf và geometry giả lập từ lớp chữ PDF; không dùng kết quả Azure live cho quy tắc mới. Preview PDF tạo bằng cùng hàm rasterPdf của server, form đọc từ kết quả RPC trên DB tạm. /mask-review.html dùng cùng UI xem trước và xác nhận thật nhưng không upload cloud. Không coi confidence hiển thị trên fixture là confidence đo từ Azure.

## Triển khai
Migration chuẩn bị: 20261017-zz-selective-invoice-redaction.sql. Cần phát hành đồng bộ migration/API/frontend, không chạy lại migration cũ. Kiểm tra live với hóa đơn mẫu Việt/Anh/Trung và QR sau khi người dùng chấp nhận triển khai. Người dùng đã chấp nhận push và merge sau khi xem bản local. Migration/API/frontend cần được triển khai cùng phiên bản.
