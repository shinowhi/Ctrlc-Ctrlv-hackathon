
Web quản trị nhân sự và tài chính cho doanh nghiệp

URL: https://ctrlc-ctrlv-hackathon-two.vercel.app/

Tiến độ:
Hiện đang tập trung phát triển nhánh tài chính và nhánh nhân sự sẽ được phát triển trong thời gian tới

Nhóm đã xây dựng MVP cho quy trình đề nghị và phê duyệt thanh toán hóa đơn. Hệ thống hỗ trợ đăng nhập theo 3 vai trò (người nộp đơn, thủ quỹ, Giám đốc Tài chính), tạo hồ sơ và tải lên hóa đơn/chứng từ, kiểm tra ngân sách – chính sách, tự chuyển các khoản trên 20 triệu đồng lên Giám đốc Tài chính, đồng thời hỗ trợ phê duyệt, từ chối, yêu cầu bổ sung và theo dõi nhật ký xử lý.



main

## AI đọc minh chứng và tự duyệt dưới 20 triệu

Hỗ trợ AI Shop qua API phía máy chủ. Hai chứng từ được đọc và đối chiếu; database chỉ tự duyệt khoản dưới 20.000.000 VNĐ khi không còn nghi vấn, đúng chính sách và đủ ngân sách. Từ 20 triệu chuyển GĐTC.

Cấu hình khóa, model, Vercel và migration: [Hướng dẫn kết nối AI](HUONG-DAN-ONLINE.md). Kết quả kiểm thử và phần chưa kiểm chứng thật: [VALIDATION.md](VALIDATION.md).
