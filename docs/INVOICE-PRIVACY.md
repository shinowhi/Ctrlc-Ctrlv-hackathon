# MVP bảo vệ dữ liệu hóa đơn — 17/10/2026

## Phạm vi đã chốt

- Áp dụng cho cả dữ liệu form và OCR của hồ sơ mới: không lưu tên, mã định danh, nội dung nhập tự do hoặc đoạn trích OCR.
- Giữ bố cục bản đã che. Người nộp kiểm tra, bổ sung vùng che và xác nhận riêng từng trang trước khi lưu.
- Không lưu HMAC của MST/số hóa đơn để kiểm tra trùng. Kiểm tra trùng và danh tính nhà cung cấp chuyển sang người phụ trách, dùng chứng từ ngoài hệ thống.
- Chỉ sửa cục bộ; chưa commit, push, merge, chạy migration cloud hoặc deploy. Không sửa/xóa dữ liệu lịch sử hay tài khoản đăng nhập.

## Luồng mới

1. Trình duyệt gửi PDF cùng form trong body nhị phân tới `/api/analyze-evidence`, không upload bản gốc vào Supabase. API xác thực người nộp và kiểm tra migration đã sẵn sàng trước khi gọi Azure.
2. PDF.js đếm số trang và kiểm tra kích thước. MVP bám Azure F0: tối đa 4 MiB, 2 trang, một hóa đơn/file. Trang quá lớn, bị lệch/xoay không khớp, OCR thiếu trang hoặc geometry không hợp lệ thì dừng.
3. Azure đọc tài liệu tạm thời. Mọi đường OpenAI fallback/đọc lại PDF đã bị loại bỏ. Không còn ép locale `vi`; chưa mở rộng quy tắc tiền tệ, vẫn chỉ VND.
4. Sau khi lấy kết quả hoặc lỗi truy vấn, API gọi DELETE tới operation URL đã kiểm tra. Chỉ HTTP 204 được xem là xác nhận xóa; nếu không xác nhận được, API trả lỗi chung, không cấp phiên lưu và không upload. Log chỉ chứa mã cố định `azure_analysis_cleanup_unconfirmed`.
5. Backend tính đối chiếu tạm; trả danh sách vùng che, kết quả tối thiểu và biên nhận có chữ ký, thời hạn 30 phút. Biên nhận không có tên, mã định danh, OCR text hay hash định danh. Khóa ký này bảo vệ biên nhận khỏi bị sửa, không phải HMAC đối chiếu hóa đơn đã từ chối trong phạm vi.
6. Gợi ý che dùng fields và toàn bộ words/lines/paragraphs có polygon; mặc định che chữ ngoài các trường ngày/tiền được cho phép, kể cả bảng chi tiết. Đây là cách thận trọng, có thể che nhiều hơn cần thiết. QR/chữ ký/ảnh hoặc PII OCR bỏ sót vẫn cần người nộp kiểm tra, dùng kéo vùng, nhập tọa độ hoặc che cả trang. Không cho bỏ vùng che tự động. Sửa vùng che làm mất xác nhận của trang.
7. Trình duyệt render PDF, vẽ vùng đen đục, lấy RGB từ canvas và nén lossless. API lưu chỉ nhận RGB có kích thước giới hạn, kiểm tra chữ ký/người dùng/số trang/tỷ lệ trang và áp lại các vùng tự động đã ký. API tự dựng PDF mới chứa ảnh; không nhận container PDF/JPEG/PNG từ client để tránh mang theo text layer, metadata hoặc mã thực thi.
8. Chỉ PDF mới được ghi vào bucket private. RPC `submit_private_request` chỉ nhận kết quả theo allowlist và tự lọc lại: ngày, loại hóa đơn, tiền/confidence, trạng thái so khớp, mã trường thiếu. `requests.payload` chỉ có số tiền/ngày; nhật ký của hồ sơ mới chỉ sao chép dữ liệu tối thiểu này.
9. Hồ sơ mới đầy đủ chuyển Quản lý kiểm tra, chưa đủ chuyển người nộp bổ sung. Không tự đưa vào hàng chờ AI-clear. Duyệt riêng bắt buộc xác nhận đã xem chứng từ, đối chiếu trường, tổng tiền và kiểm tra trùng thủ công. Lý do là mã lựa chọn cố định, không lưu lời ghi chú tự do hoặc định danh nhập lại. Giữ ngưỡng 20 triệu/hồ sơ, 100 triệu/ngày và chuyển CFO khi vượt. Hồ sơ bảo mật không được duyệt hàng loạt.

## Các file chính

- `api/analyze-evidence.js`: Azure-only, cleanup, giữ các bộ chuẩn hóa/đối chiếu tạm.
- `shared/private-intake.js`: xác thực, body nhị phân có giới hạn, lọc kết quả, biên nhận, vùng che và dựng PDF mới.
- `api/submit-private-invoice.js`: endpoint lưu sau xác nhận.
- `web/invoice-privacy.js`: xem trước, bổ sung vùng che, xác nhận từng trang, xuất RGB.
- `web/app.js`, `web/api.js`, `web/index.html`, `web/styles.css`: nối luồng và trình bày hồ sơ không lưu định danh.
- `supabase/migrations/20261017-private-invoice-intake.sql`: chặn upload trực tiếp/RPC cũ, lưu allowlist và kiểm tra thủ công. Không xóa hoặc viết lại dữ liệu cũ.
- `package.json`, `pnpm-lock.yaml`: chuyển PDF.js đúng phiên bản hiện có sang dependency runtime vì backend cần đếm trang. Không thêm phiên bản/thư viện mới.

## Chuẩn bị triển khai (chưa thực hiện)

1. Xác minh đúng Vercel/Supabase project và baseline migration hiện tại. Với database đang dùng, chỉ áp migration `20261017-private-invoice-intake.sql` khi đã có toàn bộ baseline đến `20261015-cfo-read-high-value-manager-review.sql`; không chạy lại schema hoặc seed. Với database mới dùng manifest đầy đủ.
2. Tạo secret server-only `INVOICE_PRIVACY_SIGNING_KEY` bằng bộ sinh ngẫu nhiên mật mã: tối thiểu 32 byte dạng hex (64 ký tự). Không đưa vào config frontend, Git hoặc chat. Đặt `INVOICE_ANALYSIS_PROVIDER=azure` và cấu hình Azure/Supabase hiện có. Không cần OpenAI key cho luồng này.
3. Migration và API/frontend phải được phát hành phối hợp. Migration chặn client cũ để tránh lưu bản gốc; trong khoảng chuyển tiếp việc gửi hồ sơ cũ sẽ bị chặn. Đây không phải rollout không gián đoạn.
4. Kiểm tra trên staging Linux/Vercel bằng hóa đơn giả: PDF.js runtime, giới hạn Function, nhận binary body, quyền Storage/service role, DELETE Azure và mọi bước xác nhận. Chưa xác minh các điểm này trên cloud thật.
5. Không rollback bằng cách mở lại upload bản gốc. Nếu lỗi, tạm dừng nộp mới và sửa trong trạng thái đóng an toàn. Migration là forward-only, không tự tạo rollback làm yếu bảo mật.

## Kiểm tra đã thực hiện tại máy

- `node --check` cho JavaScript thay đổi và `git diff --check`.
- Nạp schema và toàn bộ manifest migration vào PostgreSQL PGlite trong bộ nhớ: thành công.
- Kiểm tra chức năng riêng bằng PDF/tên/mã giả; mọi request cloud được chặn và giả lập: trước xác nhận có 0 upload; thiếu xác nhận/sửa chữ ký bị từ chối; xóa Azure lỗi trả 503 và không tạo thêm upload.
- PDF dựng lại mở được với PDF.js, đúng 1 trang và 0 mục text layer. Tên/mã giả không xuất hiện trong hồ sơ hoặc snapshot audit mới. Dữ liệu thừa/định danh gửi trong quyết định không được lưu.
- Database từ chối duyệt khi thiếu xác nhận kiểm tra trùng; cho phép duyệt khi đủ xác nhận. Client authenticated không gọi được RPC upload-first và RPC duyệt lịch sử nội bộ. RLS chặn upload trực tiếp; OCR thiếu geometry bị từ chối. Luồng trên 20 triệu chuyển Quản lý → CFO, và duyệt hàng loạt hồ sơ bảo mật bị chặn.
- Trình duyệt thật trên localhost: mở bản xem trước, thêm vùng che làm mất xác nhận, xác nhận xuất được RGB nén; mở màn hình Quản lý với hồ sơ/API giả, không có lỗi console. Ở chiều rộng 320 px, hộp thoại không tràn ngang và hủy không lưu hoạt động. Đã xem cả màn hình CFO chặn duyệt hàng loạt. Không đăng nhập tài khoản thật.
- Build thành công bằng URL/public key giả; `dist/config.js` là cấu hình giả dùng cho kiểm tra local, không phải cấu hình production.
- Không chạy hoặc thêm test suite vào `tests/`; các script và fixture kiểm tra dùng dữ liệu giả nằm trong `.local/` đã được gitignore. Bộ test cũ chứa kỳ vọng OpenAI/upload-first và cần cập nhật riêng trước khi dùng làm gate phát hành; không tuyên bố suite cũ đang pass.

## Giới hạn còn lại

- Azure vẫn thấy bản gốc. Đây là giảm dữ liệu lưu và gửi tiếp, không phải che trước Azure, bảo mật tuyệt đối hoặc chứng nhận tuân thủ pháp luật.
- Kiểm tra thủ công có thể bỏ sót; hệ thống không chứng minh ảnh cuối hoàn toàn không còn PII. Client độc hại có thể thay đổi nội dung ảnh ngoài vùng tự động: chữ ký chỉ ràng buộc kết quả/vùng che, không chứng minh ảnh là cùng bản gốc. Bản lưu không xác thực nguồn phát hành/chữ ký số; không tự duyệt.
- OCR quốc tế, đa trang, chữ ký và QR thật chưa có bộ đo recall; kiểm tra trên hóa đơn giả chưa chứng minh hiệu quả với hóa đơn thật. Dữ liệu tổng hợp như ngày/số tiền vẫn có khả năng liên kết trong một số ngữ cảnh.
- Nếu POST Azure đã tới dịch vụ nhưng kết nối mất trước khi nhận operation URL, API không có ID hợp lệ để xóa; nếu runtime bị dừng đột ngột, `finally` có thể không chạy. Không lưu raw invoice ở ứng dụng, nhưng không thể cam kết Azure đã xóa trong các trường hợp này.
- Nếu upload bản đã che thành công nhưng giao dịch DB lỗi/timeout, có thể còn object đã che mồ côi. Không tự xóa khi chưa biết giao dịch đã commit hay chưa. Cần quy trình đối soát/retention riêng; chưa thêm automation cloud.
- Dữ liệu lịch sử, danh mục cũ, profile/auth và snapshot cũ vẫn tồn tại. Các RPC duyệt lịch sử giữ hành vi cũ; chính sách tối thiểu hóa mới áp dụng cho hồ sơ mới hoặc hồ sơ được gửi lại qua luồng mới. Việc dọn dữ liệu cũ cần phạm vi/ủy quyền riêng, không tự xóa.
- Chưa chạy trên Azure/Supabase/Vercel thật, chưa kiểm tra bundle/runtime Linux, audit dependency hoặc toàn bộ hồi quy. Không coi bản local này là xác minh production.
- Hướng tiếp theo nếu cần che trước cloud: OCR/PII cục bộ, ví dụ PaddleOCR 3.x / PP-OCRv5 với model recognition đúng nhóm ngôn ngữ; cần bộ dữ liệu được phép sử dụng và đo tỷ lệ bỏ sót trước khi thay đổi cam kết bảo mật.
