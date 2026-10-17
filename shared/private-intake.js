'use strict';

const { createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { inflateSync, deflateSync } = require('node:zlib');
const { comparePartyName } = require('./invoice-matching.js');
const MAX_BODY = 4 * 1024 * 1024 + 65540;
const MAX_PAGES = 2; // Current Azure F0 limit: never silently accept a partial analysis.
const MONEY = ['amountBeforeTax', 'vatAmount', 'discountAmount', 'totalAmount', 'amountDue'];
const FORM_FIELDS = ['requesterType', 'requester', 'department', 'buyerMode', 'buyerCompany', 'budgetCode', 'purpose', 'vendor', 'invoiceNumber', 'invoiceDate'];
const fail = (status, message) => Object.assign(new Error(message), { status, safe: true });
const json = (res, status, data) => {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
};
const authHeaders = token => token && !token.startsWith('sb_') ? { Authorization: `Bearer ${token}` } : {};
async function database(path, options = {}, token = process.env.SUPABASE_SERVICE_ROLE_KEY, key = process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const response = await fetch(process.env.SUPABASE_URL + path, {
    ...options, headers: { apikey: key, ...authHeaders(token), 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(10000), redirect: 'error'
  });
  if (!response.ok) throw fail(response.status === 409 ? 409 : 422, 'Không hoàn tất được thao tác lưu hồ sơ. Hãy tải lại trạng thái trước khi thử lại.');
  return response.status === 204 ? null : response.json();
}
function signingKey() {
  const key = process.env.INVOICE_PRIVACY_SIGNING_KEY || '';
  if (!/^[a-f0-9]{64,}$/i.test(key)) throw fail(503, 'Luồng bảo mật chưa được cấu hình đầy đủ.');
  return Buffer.from(key, 'hex');
}
async function authenticate(req) {
  signingKey();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw fail(503, 'Luồng bảo mật chưa được cấu hình đầy đủ.');
  const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization || ''))?.[1];
  if (!token) throw fail(401, 'Vui lòng đăng nhập.');
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const user = await database('/auth/v1/user', {}, token, key);
  const profiles = await database(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, {}, token, key);
  if (profiles[0]?.role !== 'applicant') throw fail(403, 'Chỉ người nộp được gửi hóa đơn.');
  const ready = await database('/rest/v1/rpc/private_intake_ready', { method: 'POST', body: '{}' });
  if (ready !== 1) throw fail(503, 'Cần cập nhật luồng bảo mật trước khi gửi hóa đơn.');
  return user.id;
}
async function readEnvelope(req) {
  if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/octet-stream') throw fail(415, 'Định dạng tải lên không hỗ trợ.');
  let bytes;
  if (Buffer.isBuffer(req.body)) bytes = req.body;
  else {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw fail(413, 'Dữ liệu vượt giới hạn 4 MB.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > MAX_BODY || bytes.length < 5) throw fail(413, 'Kích thước dữ liệu không hợp lệ.');
  const length = bytes.readUInt32BE(0);
  if (!length || length > 65536 || length + 4 >= bytes.length) throw fail(400, 'Dữ liệu tải lên không hợp lệ.');
  let meta;
  try { meta = JSON.parse(bytes.subarray(4, length + 4).toString('utf8')); }
  catch { throw fail(400, 'Dữ liệu tải lên không hợp lệ.'); }
  if (!meta || Array.isArray(meta) || typeof meta !== 'object') throw fail(400, 'Dữ liệu tải lên không hợp lệ.');
  return { meta, bytes: bytes.subarray(length + 4) };
}
function sign(value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = body + '.' + createHmac('sha256', signingKey()).update('finref-private-intake-v1.' + body).digest('base64url');
  if (token.length > 60000) throw fail(422, 'Bố cục quá phức tạp để xử lý an toàn trong giới hạn hiện tại. Không lưu file.');
  return token;
}
function verify(token, owner) {
  if (typeof token !== 'string' || token.length > 60000) throw fail(400, 'Phiên kiểm tra không hợp lệ.');
  const parts = token.split('.');
  const expected = createHmac('sha256', signingKey()).update('finref-private-intake-v1.' + parts[0]).digest();
  const actual = Buffer.from(parts[1] || '', 'base64url');
  if (parts.length !== 2 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail(400, 'Phiên kiểm tra không hợp lệ.');
  const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (value.owner !== owner || value.expires < Date.now() || value.version !== 1) throw fail(409, 'Phiên kiểm tra đã hết hạn. Hãy chọn hóa đơn và kiểm tra lại.');
  return value;
}
function readForm(meta) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.id || '') || !Number.isInteger(meta.expectedVersion) || meta.expectedVersion < 0) throw fail(400, 'Mã hoặc phiên bản hồ sơ không hợp lệ.');
  if (meta.payload?.currency !== undefined && meta.payload.currency !== 'VND') throw fail(422, 'Hiện chỉ nhận hóa đơn VND. Chưa hỗ trợ nộp hóa đơn ngoại tệ hoặc quy đổi tỷ giá.');
  const form = {};
  for (const field of FORM_FIELDS) {
    const value = meta.payload?.[field] ?? '';
    if (typeof value !== 'string' || value.length > 1000) throw fail(400, 'Thông tin form không hợp lệ.');
    form[field] = value.trim();
  }
  form.amount = Number.isSafeInteger(meta.payload?.amount) && meta.payload.amount > 0 && meta.payload.amount <= 999999999999 ? meta.payload.amount : null;
  return form;
}
function minimalSummary(form, extraction, assessment) {
  const fields = {};
  for (const key of MONEY) {
    const field = extraction.fields[key];
    fields[key] = {
      value: Number.isSafeInteger(field?.value) && field.value >= 0 && field.value <= 999999999999 ? field.value : 0,
      confidence: Number.isFinite(field?.confidence) && field.confidence >= 0 && field.confidence <= 1 ? field.confidence : 0
    };
  }
  const date = extraction.fields.invoiceDate?.value;
  fields.invoiceDate = { value: typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' };
  fields.invoiceKind = { value: ['SALES', 'VAT'].includes(extraction.fields.invoiceKind?.value) ? extraction.fields.invoiceKind.value : 'UNKNOWN' };
  const status = value => ['MATCH', 'MISMATCH'].includes(value) ? value : 'UNKNOWN';
  const missing = FORM_FIELDS.filter(key => key !== 'buyerCompany' && !form[key]);
  if (!['employee', 'department'].includes(form.requesterType) && !missing.includes('requesterType')) missing.push('requesterType');
  if (!['PERSON', 'ORGANIZATION', 'NO_NAME'].includes(form.buyerMode) && !missing.includes('buyerMode')) missing.push('buyerMode');
  if (['PERSON', 'ORGANIZATION'].includes(form.buyerMode) && !form.buyerCompany) missing.push('buyerCompany');
  if (!form.amount) missing.push('amount');
  const vendor = extraction.fields.vendor;
  return {
    fields, amount: form.amount, currency: 'VND', missing,
    matching: {
      buyer: status(assessment.matching.buyerIdentity?.status),
      vendor: vendor?.confidence >= 0.8 ? status(comparePartyName(vendor.value, form.vendor).status) : 'UNKNOWN',
      invoiceNumber: extraction.fields.invoiceNumber?.confidence >= 0.8 ? status(assessment.matching.invoiceNumber) : 'UNKNOWN',
      total: fields.totalAmount.confidence >= 0.9 ? status(assessment.matching.totalAmount) : 'UNKNOWN'
    },
    totalsConsistent: typeof assessment.checks.totalsConsistent === 'boolean' ? assessment.checks.totalsConsistent : null,
    duplicateCheck: 'MANUAL_REQUIRED', vendorDirectoryCheck: 'MANUAL_REQUIRED'
  };
}
function maskPlan(result, documentPages) {
  const pages = result.analyzeResult?.pages;
  if (!Array.isArray(pages) || pages.length !== documentPages.length) throw fail(422, 'Azure chưa đọc đủ các trang. Không lưu file.');
  if (result.analyzeResult?.documents?.length !== 1) throw fail(422, 'Chỉ xử lý một hóa đơn trong mỗi file. Không lưu file.');
  const moneyNames = new Set(['SubTotal', 'TotalTax', 'InvoiceTotal', 'AmountDue', 'DiscountAmount', 'TotalDiscount', 'Discount', 'InvoiceDate']);
  const documentFields = result.analyzeResult?.documents?.[0]?.fields || {};
  function bounds(polygon, page) {
    if (!Array.isArray(polygon) || polygon.length < 6 || polygon.length % 2 || polygon.some((n, i) => !Number.isFinite(n) || n < 0 || n > (i % 2 ? page.height : page.width))) throw fail(422, 'Vị trí OCR không đầy đủ. Không lưu file.');
    const xs = polygon.filter((_, i) => i % 2 === 0), ys = polygon.filter((_, i) => i % 2 === 1);
    if (Math.max(...xs) <= Math.min(...xs) || Math.max(...ys) <= Math.min(...ys)) throw fail(422, 'Vùng OCR không có diện tích. Không lưu file.');
    return [Math.floor(Math.min(...xs) / page.width * 10000) / 10000, Math.floor(Math.min(...ys) / page.height * 10000) / 10000,
      Math.ceil(Math.max(...xs) / page.width * 10000) / 10000, Math.ceil(Math.max(...ys) / page.height * 10000) / 10000];
  }
  return pages.map((page, index) => {
    if (page.pageNumber !== index + 1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 || !['inch', 'pixel'].includes(page.unit) || !Array.isArray(page.words) || !page.words.length || page.words.length > 20000 || (page.angle !== undefined && !Number.isFinite(page.angle))) throw fail(422, 'Không xác định đủ nội dung và vị trí từng trang. Không lưu file.');
    if (Math.abs(page.width / page.height - documentPages[index].width / documentPages[index].height) > 0.02 || Math.abs(page.angle || 0) > 5) throw fail(422, 'Trang bị xoay hoặc lệch; hãy xoay thẳng bản PDF rồi thử lại. Không lưu file.');
    const allowed = Object.entries(documentFields).filter(([name]) => moneyNames.has(name)).flatMap(([, field]) => (field.boundingRegions || []).filter(r => r.pageNumber === page.pageNumber).map(r => bounds(r.polygon, page)));
    const rectangles = [];
    for (const word of page.words) {
      const box = bounds(word.polygon, page);
      const insideFinancialField = allowed.some(a => box[0] >= a[0] - 0.001 && box[1] >= a[1] - 0.001 && box[2] <= a[2] + 0.001 && box[3] <= a[3] + 0.001);
      // Conservative: mask every OCR word except numeric/date/currency tokens
      // inside explicitly selected financial fields. Human review handles images.
      if (!insideFinancialField || !/^[\d\s.,/():+%₫$€¥₩₹-]+$/.test(word.content || '')) rectangles.push(box);
    }
    // Cover field regions as well as OCR words, including nonstandard/nested
    // identity and payment fields. Missing detected geometry fails closed.
    function maskField(field, depth = 0) {
      if (!field || depth > 10) throw fail(422, 'Cấu trúc trường OCR không hỗ trợ. Không lưu file.');
      if (field.content && !field.boundingRegions?.length) throw fail(422, 'Thiếu vị trí trường OCR. Không lưu file.');
      for (const region of field.boundingRegions || []) {
        if (!Number.isInteger(region.pageNumber) || region.pageNumber < 1 || region.pageNumber > pages.length) throw fail(422, 'Vị trí trường OCR không hợp lệ.');
        if (region.pageNumber === page.pageNumber) rectangles.push(bounds(region.polygon, page));
      }
      for (const child of field.valueArray || []) maskField(child, depth + 1);
      for (const child of Object.values(field.valueObject || {})) maskField(child, depth + 1);
    }
    for (const [name, field] of Object.entries(documentFields)) if (!moneyNames.has(name)) maskField(field);
    for (const line of page.lines || []) {
      const box = bounds(line.polygon, page);
      const financial = allowed.some(a => box[0] >= a[0] - 0.001 && box[1] >= a[1] - 0.001 && box[2] <= a[2] + 0.001 && box[3] <= a[3] + 0.001);
      if (!financial || !/^[\d\s.,/():+%₫$€¥₩₹-]+$/.test(line.content || '')) rectangles.push(box);
    }
    for (const barcode of page.barcodes || []) rectangles.push(bounds(barcode.polygon, page));
    for (const paragraph of result.analyzeResult.paragraphs || []) {
      if (paragraph.content && !paragraph.boundingRegions?.length) throw fail(422, 'Thiếu vị trí đoạn OCR. Không lưu file.');
      for (const region of paragraph.boundingRegions || []) {
        if (!Number.isInteger(region.pageNumber) || region.pageNumber < 1 || region.pageNumber > pages.length) throw fail(422, 'Vị trí đoạn OCR không hợp lệ.');
        if (region.pageNumber !== page.pageNumber) continue;
        const box = bounds(region.polygon, page);
        const financial = allowed.some(a => box[0] >= a[0] - 0.001 && box[1] >= a[1] - 0.001 && box[2] <= a[2] + 0.001 && box[3] <= a[3] + 0.001);
        if (!financial || !/^[\d\s.,/():+%₫$€¥₩₹-]+$/.test(paragraph.content || '')) rectangles.push(box);
      }
    }
    // Merge nearby words on the same line to keep the signed receipt bounded.
    rectangles.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const merged = [];
    for (const box of rectangles) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last[1] - box[1]) < 0.005 && Math.abs(last[3] - box[3]) < 0.005 && box[0] <= last[2] + 0.015 && box[2] >= last[0]) {
        last[0] = Math.min(last[0], box[0]); last[1] = Math.min(last[1], box[1]); last[2] = Math.max(last[2], box[2]); last[3] = Math.max(last[3], box[3]);
      } else merged.push([...box]);
    }
    return { width: documentPages[index].width, height: documentPages[index].height, rectangles: merged };
  });
}
async function inspectPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw fail(422, 'Cấu hình Azure F0 hiện chỉ xử lý đầy đủ tối đa 2 trang. Hãy tách hóa đơn phù hợp trước khi gửi.');
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), view = page.getViewport({ scale: 1 });
      if (!Number.isFinite(view.width) || !Number.isFinite(view.height) || view.width < 1 || view.height < 1 || view.width > 5000 || view.height > 5000) throw fail(422, 'Kích thước trang không hỗ trợ.');
      pages.push({ width: view.width, height: view.height });
    }
    return pages;
  } finally { await task.destroy(); }
}
function createAnalyzeHandler({ analyzeWithAzure, assess }) {
  return async (req, res) => {
    const started = Date.now();
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    try {
      const owner = await authenticate(req);
      if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || !process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || !['', 'azure'].includes(process.env.INVOICE_ANALYSIS_PROVIDER || '')) throw fail(503, 'Luồng bảo mật chỉ hỗ trợ Azure.');
      const { meta, bytes } = await readEnvelope(req);
      const form = readForm(meta);
      if (bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw fail(422, 'Cần PDF hợp lệ, tối đa 4 MB.');
      const documentPages = await inspectPdf(bytes);
      const request = { payload: form, amount: form.amount };
      const budget = Math.min(35000, 50000 - (Date.now() - started));
      if (budget < 3000) throw fail(503, 'Chưa đủ thời gian xử lý an toàn. Hãy thử lại.');
      const { extraction, result } = await analyzeWithAzure(request, bytes, budget);
      const pages = maskPlan(result, documentPages);
      const summary = minimalSummary(form, extraction, assess(request, extraction));
      const receipt = sign({ version: 1, owner, id: meta.id, expectedVersion: meta.expectedVersion, nonce: randomUUID(), expires: Date.now() + 30 * 60000, summary, pages });
      return json(res, 200, { receipt, pages, summary, cleanup: 'CONFIRMED' });
    } catch (error) { return json(res, error.safe ? error.status : 422, { error: error.safe ? error.message : 'Không xử lý được hóa đơn an toàn. Không lưu file; hãy kiểm tra PDF và thử lại.' }); }
  };
}

// Accept only bounded RGB pixels, never a client PDF/JPEG/PNG container. Rebuild
// a new PDF with image streams: no original text layer, scripts or metadata.
function rasterPdf(meta, bytes, receipt) {
  if (meta.confirmed !== true || !Array.isArray(meta.pages) || meta.pages.length !== receipt.pages.length || meta.pages.length > MAX_PAGES) throw fail(422, 'Cần kiểm tra và xác nhận mọi trang.');
  const objects = [null, null]; let offset = 0, pixels = 0;
  const pageIds = [];
  for (let i = 0; i < meta.pages.length; i++) {
    const p = meta.pages[i];
    if (p.confirmed !== true || !Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 100 || p.height < 100 || p.width > 3000 || p.height > 3000 || !Number.isInteger(p.length) || p.length < 1 || offset + p.length > bytes.length) throw fail(422, 'Dữ liệu trang không hợp lệ.');
    pixels += p.width * p.height;
    if (pixels > 12000000 || Math.abs(p.width / p.height - receipt.pages[i].width / receipt.pages[i].height) > 0.02) throw fail(422, 'Số trang hoặc kích thước không khớp bản đã kiểm tra.');
    const rgb = inflateSync(bytes.subarray(offset, offset + p.length), { maxOutputLength: p.width * p.height * 3 + 1 });
    if (rgb.length !== p.width * p.height * 3) throw fail(422, 'Ảnh trang không hợp lệ.');
    offset += p.length;
    // Reapply server-signed masks even if the client bypasses the preview UI.
    for (const [x1, y1, x2, y2] of receipt.pages[i].rectangles) {
      const left = Math.max(0, Math.floor(x1 * p.width) - 3), top = Math.max(0, Math.floor(y1 * p.height) - 3);
      const right = Math.min(p.width, Math.ceil(x2 * p.width) + 3), bottom = Math.min(p.height, Math.ceil(y2 * p.height) + 3);
      for (let y = top; y < bottom; y++) rgb.fill(0, (y * p.width + left) * 3, (y * p.width + right) * 3);
    }
    const compressed = deflateSync(rgb);
    const pageId = objects.length + 1, imageId = pageId + 1, contentId = pageId + 2;
    pageIds.push(pageId);
    const w = Number(receipt.pages[i].width.toFixed(3)), h = Number(receipt.pages[i].height.toFixed(3));
    const commands = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]));
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from('\nendstream')]));
  }
  if (offset !== bytes.length) throw fail(422, 'Dữ liệu trang dư không được hỗ trợ.');
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(n => `${n} 0 R`).join(' ')}] >>`);
  const output = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let size = output[0].length;
  objects.forEach((obj, index) => { offsets.push(size); const block = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')]); output.push(block); size += block.length; });
  output.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(output);
}
async function submitHandler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const owner = await authenticate(req);
    const { meta, bytes } = await readEnvelope(req);
    const receipt = verify(meta.receipt, owner);
    const pdf = rasterPdf(meta, bytes, receipt);
    if (pdf.length > 4 * 1024 * 1024) throw fail(413, 'Bản đã che vượt 4 MB. Không lưu file.');
    const path = `${owner}/${receipt.nonce}/invoice.pdf`;
    await database(`/storage/v1/object/evidence/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: pdf });
    // A failed database write can leave only a redacted orphan, never a raw file.
    // Do not delete on an ambiguous timeout: the transaction may have committed.
    const result = await database('/rest/v1/rpc/submit_private_request', { method: 'POST', body: JSON.stringify({
      p_id: receipt.id, p_owner: owner, p_expected_version: receipt.expectedVersion,
      p_path: path, p_summary: receipt.summary
    }) });
    return json(res, 200, { id: result.id, status: result.status });
  } catch (error) { return json(res, error.safe ? error.status : 422, { error: error.safe ? error.message : 'Không lưu được bản đã che. Hãy tải lại trạng thái trước khi thử lại.' }); }
}
module.exports = { createAnalyzeHandler, submitHandler };
