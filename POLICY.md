# FIN-APPROVAL-1 · Hạn mức quyền phê duyệt

Các mức bên dưới là hạn mức quyền duyệt của quy trình FinRef cho bản hackathon; không đại diện cho ngân sách thật của phòng ban.

1. Tổng tiền xét duyệt là tổng thanh toán hóa đơn đã gồm VAT.
2. Hồ sơ có cờ nghi vấn hoặc dữ kiện chưa chắc luôn được chuyển **Quản lý Tài chính** kiểm tra trước. AI không được tự duyệt.
3. Quản lý Tài chính có thể duyệt cuối nếu hồ sơ đã được kiểm tra, số tiền không quá **20.000.000 ₫/hồ sơ**, và tổng các hồ sơ đã duyệt trong ngày sau khi cộng hồ sơ này không quá **100.000.000 ₫**.
4. Nếu số tiền hồ sơ **trên 20.000.000 ₫** hoặc tổng duyệt trong ngày sau khi cộng hồ sơ sẽ **trên 100.000.000 ₫**, Quản lý Tài chính ghi nhận đã kiểm tra; hồ sơ chuyển **Giám đốc Tài chính** cấp quyền. Giám đốc có thể xem mọi hồ sơ trên 20 triệu trong suốt quy trình và là người quyết định cuối cho hồ sơ được chuyển cấp.
5. Giám đốc phải ghi lý do khi cấp quyền. Hồ sơ được Giám đốc duyệt vẫn cộng vào tổng duyệt trong ngày, kể cả khi khiến tổng vượt 100 triệu. Các hồ sơ sau trong ngày tiếp tục được đối chiếu với tổng đã duyệt mới.
6. Tổng duyệt trong ngày gồm các hồ sơ có thời điểm phê duyệt trong cùng ngày lịch **Asia/Bangkok**, trên tất cả mã ngân sách và bộ phận. Tổng bắt đầu lại lúc 00:00 giờ Bangkok.
7. Khi tổng duyệt trong ngày **vượt 80.000.000 ₫**, giao diện Quản lý Tài chính hiển thị tổng đã duyệt và số còn lại trên hạn mức 100 triệu. Nếu Giám đốc đã cấp quyền cho khoản vượt, số còn lại là 0 và giao diện nêu mức vượt.
8. Trùng hóa đơn vẫn bị chặn. Giám đốc không thể bỏ qua nghi vấn chưa được Quản lý Tài chính xử lý, hoặc duyệt trùng hóa đơn đã được duyệt.
9. Quyết định duyệt chỉ ghi nhận phê duyệt; hệ thống không thực hiện chuyển tiền.
10. Hạn mức ngày không thay thế việc đối chiếu ngân sách theo mã, chính sách chi tiêu, MST công ty, nhà cung cấp được duyệt, PO hoặc lịch sử thanh toán. Các nguồn dữ liệu đó chưa được kết nối.
