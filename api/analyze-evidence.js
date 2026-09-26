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

const tooLarge = message => Object.assign(new Error(message), { status: 413 });
const readLimitedBytes = async (response, maxBytes, message) => {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel();
    throw tooLarge(message);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không đọc được file minh chứng.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(message);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
};

const asInvoiceBytes = async (path, maxBytes, sizeMessage) => {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/evidence/${path}`, {
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY },
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (!response.ok) throw new Error('Không đọc được file minh chứng.');
  const bytes = await readLimitedBytes(response, maxBytes, sizeMessage);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('File hóa đơn không có cấu trúc PDF hợp lệ.');
  return bytes;
};

const outputText = result => result.output?.flatMap(item => item.content || []).map(part => part.text || '').join('') || '';
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

const analyzeWithOpenAI = async (request, invoiceBytes) => {
  const content = [
    { type: 'input_text', text: `Đọc hóa đơn PDF đính kèm. PDF có thể chứa chữ máy hoặc trang scan. Trích xuất đúng các trường schema; mỗi trường phải có giá trị, độ tin cậy từ 0 đến 1 và bằng chứng ngắn (trích chữ hoặc số trang). Không đoán và không kết luận hóa đơn/chữ ký số là xác thực. buyerName là người mua hoặc đơn vị được xuất hóa đơn (ví dụ trường Người mua hàng, Khách hàng, Bill To); không nhầm với nhà cung cấp. amountDue chỉ là số tiền còn phải thanh toán được ghi rõ trên hóa đơn sau các khoản đã trả; nếu không có thông tin này thì trả 0, không tự suy ra từ tổng tiền. Trường chữ không thấy trả chuỗi rỗng; số tiền không đọc được trả 0; confidence=0 và evidence rỗng. Ngày dùng YYYY-MM-DD; tiền là số nguyên VND. Hệ thống sẽ đối chiếu với dữ liệu nhập sau: ${JSON.stringify({ buyerName: request.payload.requester, vendor: request.payload.vendor, invoiceNumber: request.payload.invoiceNumber, invoiceDate: request.payload.invoiceDate, totalAmountIncludingVat: request.amount })}. Phép tính tiền trước thuế + VAT phải được thực hiện riêng bởi hệ thống.` },
    { type: 'input_file', filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${invoiceBytes.toString('base64')}`, detail: 'high' }
  ];
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
      store: false,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'invoice_extraction', strict: true, schema: responseSchema } }
    }),
    signal: AbortSignal.timeout(30000), redirect: 'error'
  });
  if (!response.ok) throw new Error('OpenAI không đọc được minh chứng.');
  return JSON.parse(outputText(await response.json()));
};

const azureField = (fields, names, kind) => {
  const field = names.map(name => fields?.[name]).find(Boolean);
  let value = kind === 'money' ? 0 : '';
  let confidence = 0;
  let evidence = '';
  if (field) {
    const currency = field.valueCurrency;
    // FinRef amounts are VND; unknown and foreign currencies must not be compared as VND.
    const currencyCode = String(currency?.currencyCode || '').toUpperCase();
    const knownForeignCurrency = Boolean(currencyCode && currencyCode !== 'VND');
    const isVnd = currencyCode === 'VND'
      || /(?:VND|VNĐ|₫|đ)/i.test(`${currency?.currencySymbol || ''} ${field.content || ''}`);
    if (kind === 'money' && typeof currency?.amount === 'number' && Number.isFinite(currency.amount)) {
      if (knownForeignCurrency || !isVnd) {
        confidence = 0;
      } else {
        value = currency.amount;
        confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
      }
    } else if (kind === 'date' && typeof field.valueDate === 'string') {
      value = field.valueDate;
      confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
    } else if (kind === 'string' && typeof field.valueString === 'string') {
      value = field.valueString;
      confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
    }
    evidence = typeof field.content === 'string' ? field.content.slice(0, 240) : '';
  }
  return { value, confidence, evidence };
};

const normalizeAzureInvoice = result => {
  const fields = result?.analyzeResult?.documents?.[0]?.fields;
  if (!fields || typeof fields !== 'object') throw new Error('Azure không trích xuất được dữ liệu hóa đơn.');
  return { fields: {
    buyerName: azureField(fields, ['CustomerName', 'CustomerAddressRecipient', 'BillingAddressRecipient'], 'string'),
    vendor: azureField(fields, ['VendorName'], 'string'),
    taxCode: azureField(fields, ['VendorTaxId'], 'string'),
    invoiceNumber: azureField(fields, ['InvoiceId'], 'string'),
    invoiceDate: azureField(fields, ['InvoiceDate'], 'date'),
    amountBeforeTax: azureField(fields, ['SubTotal'], 'money'),
    vatAmount: azureField(fields, ['TotalTax'], 'money'),
    totalAmount: azureField(fields, ['InvoiceTotal'], 'money'),
    amountDue: azureField(fields, ['AmountDue'], 'money')
  } };
};

const retryDelay = headers => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds * 1000) : 1000;
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const analyzeWithAzure = async invoiceBytes => {
  let endpoint;
  try { endpoint = new URL(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT); }
  catch { throw new Error('Azure Document Intelligence endpoint chưa hợp lệ.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
    throw new Error('Azure Document Intelligence endpoint chưa hợp lệ.');
  }
  const base = endpoint.origin;
  const apiVersion = '2024-11-30';
  // Microsoft REST v4.0 uses base64Source, then Operation-Location polling at >=1 second intervals.
  // Source: https://learn.microsoft.com/rest/api/aiservices/document-models/analyze-document?view=rest-aiservices-v4.0+(2024-11-30)
  const analyzeUrl = `${base}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=${apiVersion}`;
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY };
  let accepted;
  try {
    accepted = await fetch(analyzeUrl, {
      method: 'POST', headers, body: JSON.stringify({ base64Source: invoiceBytes.toString('base64') }),
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
  } catch { throw new Error('Không kết nối được Azure Document Intelligence.'); }
  if (accepted.status !== 202) throw new Error('Azure Document Intelligence từ chối phân tích hóa đơn.');

  const location = accepted.headers.get('operation-location');
  let operation;
  try { operation = new URL(location); }
  catch { throw new Error('Azure trả về thông tin xử lý không hợp lệ.'); }
  const operationPrefix = '/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/';
  if (operation.origin !== base || operation.username || operation.password || !operation.pathname.startsWith(operationPrefix) || operation.searchParams.get('api-version') !== apiVersion) {
    throw new Error('Azure trả về thông tin xử lý không hợp lệ.');
  }

  const deadline = Date.now() + 45000;
  let delay = retryDelay(accepted.headers);
  while (Date.now() + delay < deadline) {
    await wait(delay);
    let response;
    try {
      response = await fetch(operation, { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY }, signal: AbortSignal.timeout(10000), redirect: 'error' });
    } catch { throw new Error('Không lấy được kết quả từ Azure Document Intelligence.'); }
    if (!response.ok) throw new Error('Không lấy được kết quả từ Azure Document Intelligence.');
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Azure trả về dữ liệu hóa đơn không hợp lệ.'); }
    if (result.status === 'succeeded') return normalizeAzureInvoice(result);
    if (result.status === 'failed') throw new Error('Azure không phân tích được hóa đơn.');
    if (!['running', 'notStarted'].includes(result.status)) throw new Error('Azure trả về trạng thái phân tích không hợp lệ.');
    delay = retryDelay(response.headers);
  }
  throw Object.assign(new Error('Azure xử lý hóa đơn quá lâu; hãy thử lại sau.'), { status: 504 });
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const requestedProvider = String(process.env.INVOICE_ANALYSIS_PROVIDER || '').trim().toLowerCase();
  const azureConfigured = Boolean(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY);
  const provider = requestedProvider || (azureConfigured ? 'azure' : 'openai');
  if (!['azure', 'openai'].includes(provider)) return json(res, 503, { error: 'INVOICE_ANALYSIS_PROVIDER phải là azure hoặc openai.' });
  const providerConfigured = provider === 'azure'
    ? Boolean(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY)
    : Boolean(process.env.OPENAI_API_KEY);
  if (!providerConfigured || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(res, 503, { error: 'AI backend chưa được cấu hình.' });
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
    const invoiceMaxBytes = provider === 'azure' ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
    const sizeMessage = provider === 'azure'
      ? 'Azure Document Intelligence F0 chỉ nhận file tối đa 4 MB.'
      : 'File hóa đơn vượt giới hạn 10 MB.';
    const invoiceBytes = await asInvoiceBytes(request.invoice_path, invoiceMaxBytes, sizeMessage);
    const extraction = provider === 'azure'
      ? await analyzeWithAzure(invoiceBytes)
      : await analyzeWithOpenAI(request, invoiceBytes);
    const assessment = assess(request, extraction);
    const analysis = { ...extraction, assessment, policyChecked: false, budgetChecked: false };
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const result = await supabase('/rest/v1/rpc/record_invoice_analysis', {
      method: 'POST', body: JSON.stringify({ p_id: request.id, p_expected_version: request.version, p_analysis: analysis })
    }, serviceKey, serviceKey);
    return json(res, 200, { status: result.status, analysis });
  } catch (error) { return json(res, error.status || 422, { error: error.message || 'Không đọc được minh chứng.' }); }
};
