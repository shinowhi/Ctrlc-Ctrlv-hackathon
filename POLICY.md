# FIN-APPROVAL-2 · Hàng chờ và thẩm quyền duyệt

> Đây là quy ước nghiệp vụ của bản hackathon. `APPROVED` nghĩa là công ty đã chấp thuận khoản phải trả theo quy trình; ứng dụng không thực hiện chuyển tiền và không xác nhận giao dịch ngân hàng.

## Vai trò và trạng thái

1. AI trích xuất và đối chiếu hóa đơn với thông tin người nộp. `READY_FOR_APPROVAL` có nghĩa hóa đơn đã qua các kiểm tra hiện có, đủ điều kiện để người có thẩm quyền duyệt. Quản lý không cần kiểm tra lại từng hóa đơn đã ở trạng thái này.
2. Nếu dữ kiện thiếu, không chắc hoặc không khớp, hồ sơ vào `TREASURER_REVIEW`. Quản lý tài chính cần xử lý các điểm gắn cờ trước. Nếu quản lý xác nhận hồ sơ nhưng khoản chi vượt thẩm quyền, hồ sơ được đưa lên Giám đốc.
3. `CFO_REVIEW` là hàng chờ của Giám đốc Tài chính. Hàng này nhận hóa đơn trên 20 triệu đã đạt kiểm tra, hóa đơn quản lý chuyển lên do tổng ngày vượt hạn mức, và ngoại lệ khác được chuyển cấp.

## Hàng chờ và cách duyệt

4. Hàng chờ là danh sách động của mọi hóa đơn đủ điều kiện nhưng chưa được duyệt tại thời điểm xem. Hệ thống không gom theo ngày lập hóa đơn hay tạo đợt cố định.
5. Hàng của Quản lý tự gom mọi hóa đơn `READY_FOR_APPROVAL` có tổng thanh toán không quá **20.000.000 ₫/hóa đơn**, bất kể ngày gửi. Quản lý có nút duyệt từng hóa đơn và nút duyệt tất cả hóa đơn đang chờ.
6. Quản lý có thể duyệt từng hóa đơn hoặc cả danh sách khi tổng đã duyệt trong ngày cộng số tiền được duyệt không vượt **100.000.000 ₫**. Nếu duyệt tất cả làm vượt mức này, toàn bộ danh sách vừa yêu cầu được chuyển `CFO_REVIEW`; quản lý vẫn có thể duyệt từng hóa đơn để dùng phần ngân sách còn lại.
7. Hàng của Giám đốc có giao diện danh sách tương tự, gồm hóa đơn trên 20 triệu đủ điều kiện và các hồ sơ quản lý đã chuyển cấp. Giám đốc có thể duyệt riêng hoặc duyệt toàn bộ hàng chờ.
8. Giám đốc bắt buộc ghi lý do cho quyết định duyệt. Nếu tổng sau quyết định vượt 100 triệu/ngày, lý do đó ghi nhận việc chấp thuận ngoại lệ; khoản đã duyệt vẫn được cộng vào tổng ngày.
9. Duyệt hàng loạt là nguyên tử: nếu một hồ sơ đã đổi trạng thái/phiên bản hoặc không thuộc thẩm quyền, không hóa đơn nào trong yêu cầu đó được duyệt một phần. Máy chủ luôn tính lại hạn mức trước khi ghi quyết định.

## Hạn mức ngày

10. **100.000.000 ₫ là hạn mức chung của toàn công ty**, cộng mọi hóa đơn đã được duyệt, tất cả phòng ban và mã ngân sách; không phải hạn mức riêng từng danh mục.
11. Ngày được tính theo múi giờ `Asia/Bangkok`, từ 00:00 đến trước 00:00 ngày tiếp theo. Danh sách chờ không được chia theo ngày; chỉ tổng đã duyệt mới được tính theo ngày.
12. Giao diện tài chính hiển thị tổng đã duyệt hôm nay, số dư hạn mức, tổng tiền hàng chờ và dự kiến sau khi duyệt. Hệ thống tuần tự hóa thao tác duyệt để hai lượt đồng thời không cùng dùng một phần ngân sách.

## Ranh giới kiểm tra

13. Hóa đơn trùng nhà cung cấp và số hóa đơn không được duyệt lần nữa.
14. Duyệt không thay thế việc kiểm tra ngân sách kế toán theo mã, chính sách chi tiêu, mã số thuế công ty, danh sách nhà cung cấp được duyệt, PO hoặc lịch sử thanh toán; các nguồn dữ liệu này chưa được kết nối.
15. AI không xác nhận tính xác thực của hóa đơn, nguồn phát hành hoặc chữ ký số. Ngoại lệ hạn mức do Giám đốc chịu trách nhiệm ghi lý do trong nhật ký.
