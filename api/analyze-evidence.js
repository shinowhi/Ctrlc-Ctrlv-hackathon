'use strict';

const { normalizeInvoiceNumber, comparePartyName } = require('../invoice-matching.js');

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
const confidenceThresholds = { buyerName: 0.85, vendor: 0.85, invoiceNumber: 0.90, invoiceDate: 0.85, amountBeforeTax: 0.90, vatAmount: 0.90, totalAmount: 0.90 };
function assess(request, analysis) {
  const data = analysis.fields || {};
  const issues = [];
  const required = ['buyerName', 'vendor', 'invoiceNumber', 'invoiceDate', 'amountBeforeTax', 'vatAmount', 'totalAmount'];
  for (const key of required) {
    const field = data[key] || {};
    const valueMissing = typeof field.value === 'string' ? !field.value.trim() : !Number.isSafeInteger(field.value) || field.value < 0;
    if (valueMissing || (key !== 'vatAmount' && field.value === 0)) issues.push(`Không đọc rõ ${labels[key]}.`);
    const threshold = confidenceThresholds[key];
    if (!Number.isFinite(field.confidence) || field.confidence < threshold) issues.push(`Độ tin cậy khi đọc ${labels[key]} dưới ${Math.round(threshold * 100)}%.`);
    if (!String(field.evidence || '').trim()) issues.push(`Thiếu bằng chứng đọc ${labels[key]}.`);
  }
  const date = data.invoiceDate?.value || '';
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) issues.push('Ngày hóa đơn không có định dạng YYYY-MM-DD hợp lệ.');
  if (Number.isSafeInteger(data.amountBeforeTax?.value) && Number.isSafeInteger(data.vatAmount?.value) && Number.isSafeInteger(data.totalAmount?.value)
    && data.amountBeforeTax.value + data.vatAmount.value !== data.totalAmount.value) issues.push('Tiền trước thuế cộng VAT không khớp tổng thanh toán.');
  const vendorMatch = comparePartyName(data.vendor?.value, request.payload.vendor);
  const buyerMatch = comparePartyName(data.buyerName?.value, request.payload.buyerCompany);
  const invoiceNumberMatch = normalizeInvoiceNumber(data.invoiceNumber?.value) === normalizeInvoiceNumber(request.payload.invoiceNumber);
  const invoiceDateMatch = (data.invoiceDate?.value || '') === (request.payload.invoiceDate || '');
  const totalAmountMatch = data.totalAmount?.value === Number(request.amount);
  if (vendorMatch.status === 'POSSIBLE_MATCH') issues.push('Tên nhà cung cấp gần khớp nhưng khác dấu/ký tự; Quản lý cần đối chiếu trên hóa đơn.');
  else if (vendorMatch.status === 'UNVERIFIED') issues.push('Chưa đủ dữ liệu để đối chiếu nhà cung cấp.');
  else if (vendorMatch.status === 'MISMATCH') issues.push('Nhà cung cấp trên hóa đơn không khớp form.');
  if (buyerMatch.status === 'POSSIBLE_MATCH') issues.push('Tên công ty mua gần khớp nhưng khác dấu/ký tự; Quản lý cần đối chiếu trên hóa đơn.');
  else if (buyerMatch.status === 'UNVERIFIED') issues.push('Chưa có tên công ty mua trên form để đối chiếu với hóa đơn.');
  else if (buyerMatch.status === 'MISMATCH') issues.push('Tên công ty mua trên hóa đơn không khớp form.');
  if (!invoiceNumberMatch) issues.push('Số hóa đơn trên PDF không khớp form.');
  if (!invoiceDateMatch) issues.push('Ngày hóa đơn trên PDF không khớp form.');
  if (!totalAmountMatch) issues.push('Tổng thanh toán đã gồm VAT không khớp số tiền trên form.');

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
    matching: { vendor: vendorMatch, buyerCompany: buyerMatch,
      invoiceNumber: invoiceNumberMatch ? 'MATCH' : 'MISMATCH', invoiceDate: invoiceDateMatch ? 'MATCH' : 'MISMATCH',
      totalAmount: totalAmountMatch ? 'MATCH' : 'MISMATCH' },
    checks: { formFieldsMatch: vendorMatch.status === 'MATCH' && buyerMatch.status === 'MATCH' && invoiceNumberMatch && invoiceDateMatch,
      totalsConsistent: uniqueIssues.every(item => !item.includes('không khớp tổng thanh toán')) }
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
    { type: 'input_text', text: `Đọc hóa đơn PDF đính kèm. PDF có thể chứa chữ máy hoặc trang scan. Trích xuất đúng các trường schema; mỗi trường phải có giá trị, độ tin cậy từ 0 đến 1 và bằng chứng ngắn (trích chữ hoặc số trang). Không đoán và không kết luận hóa đơn/chữ ký số là xác thực. buyerName là tên công ty/pháp nhân tại mục người mua hoặc đơn vị nhận hóa đơn (ví dụ Người mua hàng, Khách hàng, Bill To); không nhầm với người đề nghị, phòng ban hay nhà cung cấp. amountDue chỉ là số tiền còn phải thanh toán được ghi rõ trên hóa đơn sau các khoản đã trả; nếu không có thông tin này thì trả 0, không tự suy ra từ tổng tiền. Trường chữ không thấy trả chuỗi rỗng; số tiền không đọc được trả 0; confidence=0 và evidence rỗng. Ngày dùng YYYY-MM-DD; tiền là số nguyên VND. Dữ liệu form để đối chiếu: ${JSON.stringify({ buyerCompany: request.payload.buyerCompany, vendor: request.payload.vendor, invoiceNumber: request.payload.invoiceNumber, invoiceDate: request.payload.invoiceDate, totalAmountIncludingVat: request.amount })}. Không dùng dữ liệu form để điền trường bị thiếu trên hóa đơn. Phép tính tiền trước thuế + VAT phải được thực hiện riêng bởi hệ thống.` },
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

const azureRegions = (field, pages) => {
  if (!Array.isArray(field?.boundingRegions) || !Array.isArray(pages)) return [];
  return field.boundingRegions.slice(0, 4).flatMap(region => {
    const pageNumber = Number(region?.pageNumber);
    const page = pages.find(item => Number(item?.pageNumber) === pageNumber);
    const pageWidth = Number(page?.width);
    const pageHeight = Number(page?.height);
    const polygon = region?.polygon;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isFinite(pageWidth) || pageWidth <= 0
      || !Number.isFinite(pageHeight) || pageHeight <= 0 || !Array.isArray(polygon)
      || polygon.length < 8 || polygon.length > 32 || polygon.length % 2 !== 0) return [];
    const points = [];
    for (let index = 0; index < polygon.length; index += 2) {
      const x = Number(polygon[index]);
      const y = Number(polygon[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > pageWidth * 1.02 || y > pageHeight * 1.02) return [];
      points.push([Number(x.toFixed(4)), Number(y.toFixed(4))]);
    }
    return [{ pageNumber, pageWidth, pageHeight, polygon: points }];
  });
};

const toIsoDate = (year, month, day) => {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1000 || y > 9999) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const invoiceDateCandidates = value => {
  const text = String(value || '');
  if (!text.trim()) return [];
  const candidates = [];
  const addDate = (date, match, start) => {
    if (date) candidates.push({ value: date, start, end: match.index + match[0].length });
  };
  for (const match of text.matchAll(/(?:^|\D)(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?=\D|$)/g)) {
    const start = match.index + match[0].indexOf(match[1]);
    addDate(toIsoDate(match[1], match[2], match[3]), match, start);
  }
  for (const match of text.matchAll(/(?:^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?=\D|$)/g)) {
    const first = Number(match[1]), second = Number(match[2]);
    const date = second > 12 && first <= 12
      ? toIsoDate(match[3], first, second)
      : toIsoDate(match[3], second, first);
    const start = match.index + match[0].indexOf(match[1]);
    addDate(date, match, start);
  }
  for (const match of text.matchAll(/(\d{1,2})\s+th(?:á|a)ng\s+(\d{1,2})\s+n(?:ă|a)m\s+(\d{4})/giu)) {
    addDate(toIsoDate(match[3], match[2], match[1]), match, match.index);
  }
  return candidates;
};

const parseInvoiceDate = value => {
  const dates = [...new Set(invoiceDateCandidates(value).map(candidate => candidate.value))];
  return dates.length === 1 ? dates[0] : '';
};

const normalizeDateText = value => String(value || '').normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const hasInvoiceDateLabel = value => /(?:^|\b)(?:ngay\s*(?:(?:lap|xuat)\s+)?hoa\s+don|invoice\s+date|date\s+of\s+(?:the\s+)?invoice|issue\s+date|date\s+issued?)(?:\b|:)/u.test(normalizeDateText(value));
const hasLeadingDate = value => /^ngay\s*[:\-]?\s*\d/u.test(normalizeDateText(value));

const layoutWordConfidence = (page, line, candidate) => {
  const lineStart = Number(line?.spans?.[0]?.offset);
  if (!Number.isInteger(lineStart) || !Array.isArray(page?.words)) return 0;
  const start = lineStart + candidate.start;
  const end = lineStart + candidate.end;
  const confidences = page.words.flatMap(word => {
    const spans = [word?.span, ...(Array.isArray(word?.spans) ? word.spans : [])].filter(Boolean);
    const overlapsDate = spans.some(span => {
      const wordStart = Number(span.offset), wordEnd = wordStart + Number(span.length);
      return Number.isInteger(wordStart) && Number.isFinite(wordEnd) && wordStart < end && wordEnd > start;
    });
    return overlapsDate && Number.isFinite(word.confidence) ? [word.confidence] : [];
  });
  return confidences.length ? Math.min(...confidences) : 0;
};

const normalizeAzureInvoiceDateFromLayout = result => {
  const analyzeResult = result?.analyzeResult;
  const pages = Array.isArray(analyzeResult?.pages) ? analyzeResult.pages : [];
  const candidates = [];
  const addLineCandidates = (page, line, evidence = line?.content, allowUnlabeledDate = false) => {
    const content = String(line?.content || '');
    const matches = invoiceDateCandidates(content);
    const anchored = hasInvoiceDateLabel(content) || hasLeadingDate(content);
    if ((!anchored && !allowUnlabeledDate) || !matches.length) return false;
    for (const match of matches) {
      candidates.push({
        value: match.value,
        confidence: layoutWordConfidence(page, line, match),
        evidence: String(evidence || content).slice(0, 240),
        regions: azureRegions({ boundingRegions: [{ pageNumber: page?.pageNumber, polygon: line?.polygon }] }, pages)
      });
    }
    return true;
  };

  for (const page of pages) {
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (addLineCandidates(page, line)) continue;
      if (hasInvoiceDateLabel(line?.content) && lines[index + 1]) {
        addLineCandidates(page, lines[index + 1], `${line.content} ${lines[index + 1].content || ''}`, true);
      }
    }
  }

  if (!pages.some(page => Array.isArray(page?.lines) && page.lines.length) && typeof analyzeResult?.content === 'string') {
    for (const content of analyzeResult.content.split(/\r?\n/)) addLineCandidates(null, { content });
  }

  const byDate = new Map();
  for (const candidate of candidates) {
    const existing = byDate.get(candidate.value);
    if (!existing || candidate.confidence > existing.confidence) byDate.set(candidate.value, candidate);
  }
  if (byDate.size !== 1) return { value: '', confidence: 0, evidence: '', regions: [] };
  return [...byDate.values()][0];
};

const normalizeVndAmount = (amount, evidence) => {
  if (!Number.isFinite(amount)) return null;

  // Azure can interpret a Vietnamese thousands separator as a decimal point.
  // Only repair it when the printed value is unambiguously grouped in threes
  // and the parsed groups agree with Azure's numeric value.
  const tokens = String(evidence || '').normalize('NFKC').match(/\d[\d.,]*/g) || [];
  if (tokens.length !== 1) return Number.isSafeInteger(amount) ? amount : null;
  const token = tokens[0];
  const separators = [...token.matchAll(/[.,]/g)].map(([separator]) => separator);
  if (!separators.length || separators.some(separator => separator !== separators[0])) {
    return Number.isSafeInteger(amount) ? amount : null;
  }
  const groups = token.split(separators[0]);
  if (groups[0].length < 1 || groups[0].length > 3 || groups.slice(1).some(group => group.length !== 3)) {
    return Number.isSafeInteger(amount) ? amount : null;
  }

  const groupedValue = Number(groups.join(''));
  const scale = 1000 ** (groups.length - 1);
  if (!Number.isSafeInteger(groupedValue) || !Number.isFinite(scale)) return null;
  if (amount === groupedValue || Math.round(amount * scale) === groupedValue) return groupedValue;
  return null;
};

const azureField = (fields, names, kind, pages) => {
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
        const normalizedAmount = normalizeVndAmount(currency.amount, field.content);
        if (normalizedAmount !== null) {
          value = normalizedAmount;
          confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
        }
      }
    } else if (kind === 'date') {
      const parsedDate = [field.valueDate, field.valueString, field.content].map(parseInvoiceDate).find(Boolean);
      if (parsedDate) {
        value = parsedDate;
        confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
      }
    } else if (kind === 'string' && typeof field.valueString === 'string') {
      value = field.valueString;
      confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
    }
    evidence = typeof field.content === 'string' ? field.content.slice(0, 240) : '';
  }
  return { value, confidence, evidence, regions: azureRegions(field, pages) };
};

const normalizeAzureInvoice = result => {
  const analyzeResult = result?.analyzeResult;
  const fields = analyzeResult?.documents?.[0]?.fields;
  const pages = analyzeResult?.pages;
  if (!fields || typeof fields !== 'object') throw new Error('Azure không trích xuất được dữ liệu hóa đơn.');
  const invoiceNumber = azureField(fields, ['InvoiceId'], 'string', pages);
  const invoiceNumberEvidence = invoiceNumber.evidence.trim();
  if (/^0+\d+$/.test(invoiceNumberEvidence) && /^\d+$/.test(invoiceNumber.value)) {
    invoiceNumber.value = invoiceNumberEvidence;
  }
  return { fields: {
    buyerName: azureField(fields, ['CustomerName', 'CustomerAddressRecipient', 'BillingAddressRecipient'], 'string', pages),
    vendor: azureField(fields, ['VendorName'], 'string', pages),
    taxCode: azureField(fields, ['VendorTaxId'], 'string', pages),
    invoiceNumber,
    invoiceDate: azureField(fields, ['InvoiceDate'], 'date', pages),
    amountBeforeTax: azureField(fields, ['SubTotal'], 'money', pages),
    vatAmount: azureField(fields, ['TotalTax'], 'money', pages),
    totalAmount: azureField(fields, ['InvoiceTotal'], 'money', pages),
    amountDue: azureField(fields, ['AmountDue'], 'money', pages)
  } };
};

const retryDelay = headers => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds * 1000) : 1000;
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const analyzeAzureModel = async (base, modelId, invoiceBytes, apiVersion, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  const requestTimeout = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  const analyzeUrl = new URL(`${base}/documentintelligence/documentModels/${modelId}:analyze`);
  analyzeUrl.searchParams.set('api-version', apiVersion);
  analyzeUrl.searchParams.set('locale', 'vi');
  if (modelId === 'prebuilt-layout') analyzeUrl.searchParams.set('stringIndexType', 'utf16CodeUnit');
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY };
  let accepted;
  try {
    accepted = await fetch(analyzeUrl, {
      method: 'POST', headers, body: JSON.stringify({ base64Source: invoiceBytes.toString('base64') }),
      signal: AbortSignal.timeout(requestTimeout()), redirect: 'error'
    });
  } catch { throw new Error('Không kết nối được Azure Document Intelligence.'); }
  if (accepted.status !== 202) throw new Error('Azure Document Intelligence từ chối phân tích hóa đơn.');

  const location = accepted.headers.get('operation-location');
  let operation;
  try { operation = new URL(location); }
  catch { throw new Error('Azure trả về thông tin xử lý không hợp lệ.'); }
  const operationPrefix = `/documentintelligence/documentModels/${modelId}/analyzeResults/`;
  if (operation.origin !== base || operation.username || operation.password || !operation.pathname.startsWith(operationPrefix) || operation.searchParams.get('api-version') !== apiVersion) {
    throw new Error('Azure trả về thông tin xử lý không hợp lệ.');
  }

  let delay = retryDelay(accepted.headers);
  while (Date.now() < deadline) {
    await wait(Math.min(delay, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    let response;
    try {
      response = await fetch(operation, { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY }, signal: AbortSignal.timeout(requestTimeout()), redirect: 'error' });
    } catch { throw new Error('Không lấy được kết quả từ Azure Document Intelligence.'); }
    if (!response.ok) throw new Error('Không lấy được kết quả từ Azure Document Intelligence.');
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Azure trả về dữ liệu hóa đơn không hợp lệ.'); }
    if (result.status === 'succeeded') return result;
    if (result.status === 'failed') throw new Error('Azure không phân tích được hóa đơn.');
    if (!['running', 'notStarted'].includes(result.status)) throw new Error('Azure trả về trạng thái phân tích không hợp lệ.');
    delay = retryDelay(response.headers);
  }
  throw Object.assign(new Error('Azure xử lý hóa đơn quá lâu; hãy thử lại sau.'), { status: 504 });
};

const analyzeWithAzure = async invoiceBytes => {
  let endpoint;
  try { endpoint = new URL(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT); }
  catch { throw new Error('Azure Document Intelligence endpoint chưa hợp lệ.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
    throw new Error('Azure Document Intelligence endpoint chưa hợp lệ.');
  }
  const apiVersion = '2024-11-30';
  // Microsoft REST v4.0: submit base64Source and poll Operation-Location; Layout returns page lines, words, spans, and confidence.
  // Sources: https://learn.microsoft.com/en-us/rest/api/aiservices/document-models/analyze-document?view=rest-aiservices-v4.0+(2024-11-30)
  // https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response?view=doc-intel-4.0.0
  // Vietnamese OCR support: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/ocr?view=doc-intel-4.0.0
  const invoiceResult = await analyzeAzureModel(endpoint.origin, 'prebuilt-invoice', invoiceBytes, apiVersion, 35000);
  const extraction = normalizeAzureInvoice(invoiceResult);
  const invoiceDate = extraction.fields.invoiceDate;
  if (!invoiceDate.value || invoiceDate.confidence < confidenceThresholds.invoiceDate || !invoiceDate.evidence.trim()) {
    try {
      const layoutResult = await analyzeAzureModel(endpoint.origin, 'prebuilt-layout', invoiceBytes, apiVersion, 12000);
      const layoutDate = normalizeAzureInvoiceDateFromLayout(layoutResult);
      if (layoutDate.value && (!invoiceDate.value || layoutDate.confidence > invoiceDate.confidence)) {
        extraction.fields.invoiceDate = layoutDate;
      }
    } catch (error) {
      console.warn('Azure Layout date fallback failed:', error.message);
    }
  }
  return extraction;
};

const handler = async (req, res) => {
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

module.exports = handler;
module.exports.assess = assess;
module.exports.normalizeAzureInvoice = normalizeAzureInvoice;
