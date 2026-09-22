# FIN-DEMO-1 · Chính sách mẫu cho hackathon

Được xây dựng từ phạm vi người dùng chốt ngày 22/09/2026. Hạn mức 20 triệu là quyền tự động của tác tử trong bản mẫu. Các ngân sách dưới đây là số giả định để demo, không phải số liệu thật.

1. Chỉ nhận bản chụp/scan hóa đơn giấy và đơn đề nghị; mỗi file tối đa 10 MB, PDF/JPG/PNG.
2. Hai chứng từ phải đọc được, có hình dấu và chữ ký, ghi số tiền, nhà cung cấp, số/ngày hóa đơn nhất quán với form. Không suy diễn dữ kiện không đọc được. Không xác nhận thật/giả từ hình dấu/chữ ký.
3. Danh mục: `printing` trong `MKT-OPS-2026`; `office_supplies` trong `OPS-2026`; `training` trong `HR-2026`. Mỗi ngân sách 100 triệu. Danh mục khác/mã khác được chuyển U2.
4. `committed` là tổng tiền đã phê duyệt. Mỗi phê duyệt trừ phần khả dụng trong cùng transaction. Migration tính các phê duyệt cũ thuộc ngân sách này để tránh coi ngân sách cũ là chưa sử dụng.
5. Không còn nghi vấn, danh mục hợp lệ, đủ ngân sách, số tiền 1..20.000.000 VNĐ → tự phê duyệt. Trên 20 triệu → U3 gửi GĐTC. Hóa đơn đã được duyệt có cùng nhà cung cấp/số hóa đơn → U1, không duyệt lại.
6. U1: người nộp bổ sung đúng chứng từ hoặc thủ quỹ kiểm tra và ghi câu trả lời/căn cứ, xác nhận đủ bốn kiểm tra minh chứng. Sau đó SQL đánh giá lại. Thủ quỹ không được bỏ qua ngân sách hoặc tự duyệt khoản trên 20 triệu.
7. U2: GĐTC có thể chấp nhận ngoại lệ cho **riêng hồ sơ** với lý do bắt buộc. Nếu mã ngân sách tồn tại, số tiền vẫn tính vào `committed` kể cả vượt trần theo ngoại lệ; các ca thường quy sau đó bị chặn. Ngoại lệ không sửa chính sách chung. Mã chưa có chỉ được phê duyệt riêng với ngoại lệ và nhật ký.
8. U3: GĐTC trả lời đồng ý/từ chối/yêu cầu bổ sung. Mỗi lần quyết định kiểm lại nghi vấn, hóa đơn trùng và ngân sách hiện tại.
9. U1 được kiểm tra trước U2 rồi U3. Câu hỏi nêu dữ kiện, hồ sơ, số tiền hoặc điều kiện chính sách vướng mắc. Ca thường quy không có câu hỏi.
10. Dừng ở phê duyệt; không có lệnh chuyển tiền. Trước sử dụng thực tế cần chính sách thật, dữ liệu ngân sách tin cậy, xác thực chứng từ và đánh giá mô hình trên bộ chứng từ đại diện.
