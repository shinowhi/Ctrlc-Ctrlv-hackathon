# FIN-APPROVAL-2 · Hàng chờ và thẩm quyền duyệt

> Đây là quy ước nghiệp vụ của bản hackathon. `APPROVED` nghĩa là công ty đã chấp thuận khoản phải trả theo quy trình; ứng dụng không thực hiện chuyển tiền và không xác nhận giao dịch ngân hàng.

## Vai trò và trạng thái

1. AI trích xuất hóa đơn và đối chiếu với form. Người nộp chọn trên hóa đơn có tên cá nhân, tên đơn vị hay “Hóa đơn không ghi tên người mua”. Hai lựa chọn có tên được so với trường tương ứng trên form. Nếu chọn không ghi tên nhưng AI đọc thấy tên rõ thì đây là mâu thuẫn.
2. Các trường thông tin trên form người nộp đều không bắt buộc lúc gửi; PDF vẫn bắt buộc. Thiếu trường sau khi gửi sẽ vào `NEEDS_INFO` (U1), được tô tím và trả lại người nộp. `buyerCompany` không bắt buộc khi đã chọn `NO_NAME`.
3. Nếu dữ kiện hóa đơn không chắc, sai số tiền/số hóa đơn hoặc có chi tiết cần xác minh, hồ sơ vào `TREASURER_REVIEW` (U2, vàng). Mâu thuẫn rõ ở tên người mua hoặc nhà cung cấp bị từ chối trực tiếp và vẫn lưu `REJECTED`. Quản lý xác nhận các điểm vàng; nếu hồ sơ sau xác minh vượt thẩm quyền, chuyển lên Giám đốc.
4. `READY_FOR_APPROVAL` có nghĩa AI đã đánh giá các trường cần thiết đạt ngưỡng, đủ điều kiện để người có thẩm quyền duyệt. Hóa đơn vượt ngưỡng hồ sơ nhưng AI clear vào `CFO_REVIEW` (U3, xanh dương); hóa đơn chờ CFO sau khi Quản lý xác minh cũng ở màu xanh dương.
5. `CFO_REVIEW` là hàng chờ của Giám đốc Tài chính. Hàng này nhận hóa đơn trên 20 triệu đã đạt kiểm tra, hóa đơn quản lý chuyển lên do tổng ngày vượt hạn mức, và ngoại lệ khác được chuyển cấp. Hồ sơ U2 chỉ được chuyển CFO sau khi Quản lý xác minh; CFO nhận dữ kiện đã xác minh và không còn cờ vàng mở.

## Quy tắc phân tích hóa đơn

- Loại hóa đơn là `SALES` hoặc `VAT`. Nếu confidence phân loại dưới 90% hoặc không đọc rõ, mặc định áp dụng rule VAT và không gắn cờ riêng vì phân loại.
- Sales cần tổng thanh toán confidence ≥81%. VAT cần tiền trước thuế ≥90%, VAT khác 0 ≥90%, và tổng cuối cùng ≥90%. VAT = 0 là ngoại lệ: confidence ≥70% cùng bằng chứng thể hiện số 0 trên PDF; trường trống/không đọc được không được hiểu là 0.
- Nếu có chiết khấu, confidence cần ≥85%. Phép tính VAT là tiền trước thuế − chiết khấu + VAT, giả định chiết khấu trước thuế. Nếu tổng tính không khớp tổng PDF hoặc form, chuyển vàng cho Quản lý.
- Tổng tiền dưới ngưỡng confidence được đọc lại riêng trường tổng tiền bằng OpenAI nếu có cấu hình. Nếu lần đọc lại bất đồng với Azure hoặc vẫn dưới ngưỡng, chuyển Quản lý kèm bằng chứng của hai lần đọc.
- Nhà cung cấp đã có trong danh mục cần MST confidence ≥85% và tên OCR khớp tên/bí danh đã xác minh với confidence ≥70%. Nhà cung cấp mới cần tên khớp form và confidence của cả tên/MST ≥80%; PDF, tên, MST và bằng chứng được ghi trong mục chỉ CFO xem. Hệ thống không tự thêm NCC mới vào danh mục.
- Số hóa đơn cần confidence ≥80%. Mọi ngưỡng confidence nêu trên tính cả trường hợp bằng ngưỡng. Ngày hóa đơn và số tiền còn phải trả chỉ để tham khảo, không dùng để gắn cờ hay duyệt.

## Hàng chờ và cách duyệt

6. Hàng chờ là danh sách động của mọi hóa đơn đủ điều kiện nhưng chưa được duyệt tại thời điểm xem. Hệ thống không gom theo ngày lập hóa đơn hay tạo đợt cố định.
7. Hàng của Quản lý tự gom mọi hóa đơn `READY_FOR_APPROVAL` có tổng thanh toán không quá **20.000.000 ₫/hóa đơn**, bất kể ngày gửi. Quản lý có nút duyệt từng hóa đơn và nút duyệt tất cả hóa đơn đang chờ.
8. Quản lý có thể duyệt từng hóa đơn hoặc cả danh sách khi tổng đã duyệt trong ngày cộng số tiền được duyệt không vượt **100.000.000 ₫**. Nếu duyệt tất cả làm vượt mức này, toàn bộ danh sách vừa yêu cầu được chuyển `CFO_REVIEW`; quản lý vẫn có thể duyệt từng hóa đơn để dùng phần ngân sách còn lại.
9. Hàng của Giám đốc có giao diện danh sách tương tự, gồm hóa đơn trên 20 triệu đủ điều kiện và các hồ sơ quản lý đã chuyển cấp. Giám đốc có thể duyệt riêng hoặc duyệt toàn bộ hàng chờ.
10. Giám đốc bắt buộc ghi lý do cho quyết định duyệt. Nếu tổng sau quyết định vượt 100 triệu/ngày, lý do đó ghi nhận việc chấp thuận ngoại lệ; khoản đã duyệt vẫn được cộng vào tổng ngày.
11. Duyệt hàng loạt là nguyên tử: nếu một hồ sơ đã đổi trạng thái/phiên bản hoặc không thuộc thẩm quyền, không hóa đơn nào trong yêu cầu đó được duyệt một phần. Máy chủ luôn tính lại hạn mức trước khi ghi quyết định.

## Hạn mức ngày

12. **100.000.000 ₫ là hạn mức chung của toàn công ty**, cộng mọi hóa đơn đã được duyệt, tất cả phòng ban và mã ngân sách; không phải hạn mức riêng từng danh mục.
13. Ngày được tính theo múi giờ `Asia/Bangkok`, từ 00:00 đến trước 00:00 ngày tiếp theo. Danh sách chờ không được chia theo ngày; chỉ tổng đã duyệt mới được tính theo ngày.
14. Giao diện tài chính hiển thị tổng đã duyệt hôm nay, số dư hạn mức, tổng tiền hàng chờ và dự kiến sau khi duyệt. Hệ thống tuần tự hóa thao tác duyệt để hai lượt đồng thời không cùng dùng một phần ngân sách.

## Ranh giới kiểm tra

15. Chuẩn hóa số hóa đơn bằng Unicode NFKC, chữ thường và khoảng trắng; chỉ bỏ số 0 đầu khi toàn bộ số hóa đơn là chữ số. Giữ nguyên dấu phân cách và số 0 trong mã chữ-số. Hồ sơ đã duyệt trùng đồng thời MST nhà cung cấp và số hóa đơn chuẩn hóa sẽ bị từ chối trực tiếp.
16. Tên nhà cung cấp và tên công ty mua được chuẩn hóa bằng Unicode NFKC, chữ thường và khoảng trắng. Bí danh nhà cung cấp chỉ được dùng để tự đối chiếu sau khi quản lý xác minh trong danh mục.
17. Duyệt không thay thế việc kiểm tra ngân sách kế toán theo mã, chính sách chi tiêu, mã số thuế công ty, danh sách nhà cung cấp được duyệt, PO hoặc lịch sử thanh toán; các nguồn dữ liệu này chưa được kết nối.
18. AI không xác nhận tính xác thực của hóa đơn, nguồn phát hành hoặc chữ ký số. Ngoại lệ hạn mức do Giám đốc chịu trách nhiệm ghi lý do trong nhật ký.
