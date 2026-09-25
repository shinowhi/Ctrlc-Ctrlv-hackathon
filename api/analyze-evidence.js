'use strict';

const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 20000) reject(new Error('Payload quá lớn.')); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON không hợp lệ.')); } });
  req.on('error', reject);
});

const supabase = (path, options = {}, token, key) => fetch(process.env.SUPABASE_URL + path, {
  ...options,
  headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
}).then(async response => {
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.msg || data?.error || 'Supabase request failed.');
  return data;
});

const asDataUrl = async path => {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/evidence/${path}`, {
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!response.ok) throw new Error('Không đọc được file minh chứng.');
  const mime = path.endsWith('.pdf') ? 'application/pdf' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (mime === 'application/pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('File hóa đơn không có cấu trúc PDF hợp lệ.');
  return `data:${mime};base64,${bytes.toString('base64')}`;
};

const outputText = result => result.output?.flatMap(item => item.content || []).map(part => part.text || '').join('') || '';
const evidencePart = (name, path, dataUrl) => path.endsWith('.pdf')
  ? { type: 'input_file', filename: name + '.pdf', file_data: dataUrl, detail: 'high' }
  : { type: 'input_image', image_url: dataUrl, detail: 'high' };
const fields = ['buyerName', 'vendor', 'taxCode', 'invoiceNumber', 'invoiceDate', 'amountBeforeTax', 'vatAmount', 'totalAmount', 'amountDue'];
const labels = { buyerName: 'tên người mua/đơn vị nhận hóa đơn', vendor: 'nhà cung cấp', invoiceNumber: 'số hóa đơn', invoiceDate: 'ngày hóa đơn', amountBeforeTax: 'tiền trước thuế', vatAmount: 'tiền VAT', totalAmount: 'tổng thanh toán' };
const normalized = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');

function assess(request, analysis) {
  const data = analysis.fields || {};
  const issues = [];
  const required = ['buyerName', 'vendor', 'invoiceNumber', 'invoiceDate', 'amountBeforeTax', 'vatAmount', 'totalAmount'];
  for (const key of required) {
    const field = data[key] || {};
    const valueMissing = typeof field.value === 'string' ? !field.value.trim() : !Number.isSafeInteger(field.value) || field.value < 0;
    if (valueMissing || (key !== 'vatAmount' && field.value === 0)) issues.push(`Không đọc rõ ${labels[key]}.`);
    if (!Number.isFinite(field.confidence) || field.confidence < 0.95) issues.push(`Độ tin cậy khi đọc ${labels[key]} dưới 95%.`);
    if (!String(field.evidence || '').trim()) issues.push(`Thiếu bằng chứng đọc ${labels[key]}.`);
  }
  const date = data.invoiceDate?.value || '';
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) issues.push('Ngày hóa đơn không có định dạng YYYY-MM-DD hợp lệ.');
  if (Number.isSafeInteger(data.amountBeforeTax?.value) && Number.isSafeInteger(data.vatAmount?.value) && Number.isSafeInteger(data.totalAmount?.value)
    && data.amountBeforeTax.value + data.vatAmount.value !== data.totalAmount.value) issues.push('Tiền trước thuế cộng VAT không khớp tổng thanh toán.');
  if (normalized(data.vendor?.value) !== normalized(request.payload.vendor)) issues.push('Nhà cung cấp trên hóa đơn không khớp form.');
  if (normalized(data.buyerName?.value) !== normalized(request.payload.requester)) issues.push('Tên người mua trên hóa đơn không khớp họ tên/phòng ban trên form.');
  if (normalized(data.invoiceNumber?.value) !== normalized(request.payload.invoiceNumber)) issues.push('Số hóa đơn trên PDF không khớp form.');
  if ((data.invoiceDate?.value || '') !== (request.payload.invoiceDate || '')) issues.push('Ngày hóa đơn trên PDF không khớp form.');
  if (data.totalAmount?.value !== Number(request.amount)) issues.push('Tổng thanh toán đã gồm VAT không khớp số tiền trên form.');

  const uniqueIssues = [...new Set(issues)];
  const code = uniqueIssues.length ? 'U1' : Number(request.amount) > 20000000 ? 'U3' : 'CLEAR';
  const reason = code === 'U1'
    ? uniqueIssues.join(' ')
    : code === 'U3'
      ? `Tổng thanh toán ${new Intl.NumberFormat('vi-VN').format(request.amount)} ₫ đã gồm VAT, vượt ngưỡng 20.000.000 ₫.`
      : 'Các trường hóa đơn đang kiểm tra và phép tính tổng đã khớp form; chờ người có thẩm quyền bấm duyệt.';
  return {
    code,
    reason,
    question: code === 'U1' ? `Vui lòng kiểm tra và bổ sung/cập nhật: ${uniqueIssues.join(' ')}` : '',
    checks: { formFieldsMatch: uniqueIssues.every(item => !item.includes('không khớp form')), totalsConsistent: uniqueIssues.every(item => !item.includes('không khớp tổng thanh toán')) }
  };
}

const fieldSchema = (type, description) => ({
  type: 'object', additionalProperties: false,
  properties: {
    value: { type, description },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string', description: 'Trích ngắn nội dung đã thấy hoặc số trang; để trống nếu không thấy.' }
  },
  required: ['value', 'confidence', 'evidence']
});
const invoiceSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(fields.map(key => [key,
    fieldSchema(['amountBeforeTax', 'vatAmount', 'totalAmount', 'amountDue'].includes(key) ? 'integer' : 'string',
      ['amountBeforeTax', 'vatAmount', 'totalAmount', 'amountDue'].includes(key) ? 'VND, số nguyên; trả 0 nếu hóa đơn không có hoặc không đọc được.' : 'Trả chuỗi rỗng nếu không đọc được.')
  ])),
  required: fields
};
const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: { fields: invoiceSchema },
  required: ['fields']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(res, 503, { error: 'AI backend chưa được cấu hình.' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(res, 401, { error: 'Vui lòng đăng nhập.' });
  try {
    const { requestId } = await readBody(req);
    if (!/^[0-9a-f-]{36}$/i.test(String(requestId || ''))) return json(res, 400, { error: 'Mã hồ sơ không hợp lệ.' });
    const publicKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const user = await supabase('/auth/v1/user', {}, token, publicKey);
    const rows = await supabase(`/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&select=*`, {}, token, publicKey);
    const request = rows[0];
    if (!request || request.owner_id !== user.id) return json(res, 403, { error: 'Không có quyền đọc hồ sơ này.' });
    if (request.status !== 'TREASURER_REVIEW') return json(res, 409, { error: 'Hồ sơ không còn chờ phân tích. Hãy làm mới để xem trạng thái mới nhất.' });
    const profile = (await supabase(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, {}, token, publicKey))[0];
    if (profile?.role !== 'applicant') return json(res, 403, { error: 'Chỉ người nộp đơn được yêu cầu đọc minh chứng.' });
    if (!request.invoice_path?.endsWith('/invoice.pdf')) return json(res, 422, { error: 'Đợt này chỉ phân tích hóa đơn PDF.' });
    const invoice = await asDataUrl(request.invoice_path);
    const content = [
      { type: 'input_text', text: `Đọc hóa đơn PDF đính kèm. PDF có thể chứa chữ máy hoặc trang scan. Trích xuất đúng các trường schema; mỗi trường phải có giá trị, độ tin cậy từ 0 đến 1 và bằng chứng ngắn (trích chữ hoặc số trang). Không đoán và không kết luận hóa đơn/chữ ký số là xác thực. buyerName là người mua hoặc đơn vị được xuất hóa đơn (ví dụ trường Người mua hàng, Khách hàng, Bill To); không nhầm với nhà cung cấp. amountDue chỉ là số tiền còn phải thanh toán được ghi rõ trên hóa đơn sau các khoản đã trả; nếu không có thông tin này thì trả 0, không tự suy ra từ tổng tiền. Trường chữ không thấy trả chuỗi rỗng; số tiền không đọc được trả 0; confidence=0 và evidence rỗng. Ngày dùng YYYY-MM-DD; tiền là số nguyên VND. Hệ thống sẽ đối chiếu với dữ liệu nhập sau: ${JSON.stringify({ buyerName: request.payload.requester, vendor: request.payload.vendor, invoiceNumber: request.payload.invoiceNumber, invoiceDate: request.payload.invoiceDate, totalAmountIncludingVat: request.amount })}. Phép tính tiền trước thuế + VAT phải được thực hiện riêng bởi hệ thống.` },
      evidencePart('invoice', request.invoice_path, invoice)
    ];
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
        store: false,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name: 'invoice_extraction', strict: true, schema: responseSchema } }
      })
    });
    if (!response.ok) throw new Error('OpenAI không đọc được minh chứng.');
    const extraction = JSON.parse(outputText(await response.json()));
    const assessment = assess(request, extraction);
    const analysis = { ...extraction, assessment, policyChecked: false, budgetChecked: false };
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const result = await supabase('/rest/v1/rpc/record_invoice_analysis', {
      method: 'POST', body: JSON.stringify({ p_id: request.id, p_expected_version: request.version, p_analysis: analysis })
    }, serviceKey, serviceKey);
    return json(res, 200, { status: result.status, analysis });
  } catch (error) { return json(res, 422, { error: error.message || 'Không đọc được minh chứng.' }); }
};
