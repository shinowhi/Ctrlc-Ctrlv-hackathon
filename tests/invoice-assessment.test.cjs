const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, buildVendorMatchPayload } = require('../api/analyze-evidence.js');

const request = () => ({
  amount: 5000,
  payload: {
    requesterType: 'employee', requester: 'Nguyễn Minh An', department: 'Marketing',
    buyerCompany: 'Công ty Mua Hàng', vendor: 'Công ty Sao Mai',
    invoiceNumber: '123', invoiceDate: '2026-10-04'
  }
});

const extraction = () => {
  const field = value => ({ value, confidence: 0.99, evidence: 'Đọc rõ trên hóa đơn' });
  return { fields: {
    invoiceKind: field('VAT'),
    buyerName: field('  CÔNG TY   MUA HÀNG '), vendor: field('  CÔNG TY SAO MAI '),
    invoiceNumber: field('００１２３'), invoiceDate: field('2026-10-04'),
    amountBeforeTax: field(4000), vatAmount: field(1000), discountAmount: { value: 0, confidence: 0, evidence: '' }, totalAmount: field(5000)
  } };
};

test('buyer company is matched separately from the employee requester', () => {
  const assessment = assess(request(), extraction());
  assert.equal(assessment.code, 'CLEAR');
  assert.equal(assessment.matching.buyerCompany.status, 'MATCH');
  assert.equal(assessment.matching.vendor.status, 'MATCH');
  assert.equal(assessment.matching.invoiceNumber, 'MATCH');
});

test('accent-insensitive company name is only a possible match and remains U1', () => {
  const result = extraction();
  result.fields.buyerName.value = 'Cong ty Mua Hang';
  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'U1');
  assert.equal(assessment.matching.buyerCompany.status, 'POSSIBLE_MATCH');
  assert.match(assessment.reason, /gần khớp/i);
});

test('a different company buyer remains a definite mismatch', () => {
  const result = extraction();
  result.fields.buyerName.value = 'Công ty Khác';
  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'U1');
  assert.equal(assessment.matching.buyerCompany.status, 'MISMATCH');
  assert.match(assessment.reason, /không khớp/i);
});

test('buyer and vendor confidence at 80 percent meets the lower threshold', () => {
  const result = extraction();
  result.fields.buyerName.confidence = 0.8;
  result.fields.vendor.confidence = 0.8;

  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'CLEAR');
  assert.doesNotMatch(assessment.reason, /độ tin cậy khi đọc (tên người mua|nhà cung cấp)/i);
});

test('buyer and vendor confidence below 80 percent remains flagged', () => {
  const result = extraction();
  result.fields.buyerName.confidence = 0.79;
  result.fields.vendor.confidence = 0.79;

  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'U1');
  assert.match(assessment.reason, /độ tin cậy khi đọc tên người mua.*dưới 80%/i);
  assert.match(assessment.reason, /độ tin cậy khi đọc nhà cung cấp.*dưới 80%/i);
});

test('an absent buyer name is exempt only when the separate classification meets 85 percent with evidence', () => {
  const result = extraction();
  result.fields.buyerName = { value: '', confidence: 0, evidence: '' };
  result.fields.buyerRequirement = {
    value: 'NOT_REQUIRED', confidence: 0.85,
    evidence: 'Trang 1: mục người mua để trống trên hóa đơn bán lẻ.'
  };

  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'CLEAR');
  assert.equal(assessment.matching.buyerCompany.status, 'NOT_REQUIRED');
  assert.equal(assessment.checks.formFieldsMatch, true);
});

test('an absent buyer name stays flagged for uncertain, low-confidence, or unsupported exemption classifications', () => {
  for (const buyerRequirement of [
    { value: 'NOT_REQUIRED', confidence: 0.849, evidence: 'Mục người mua để trống.' },
    { value: 'NOT_REQUIRED', confidence: 0.95, evidence: '' },
    { value: 'UNKNOWN', confidence: 0.99, evidence: 'Không rõ quy định người mua.' }
  ]) {
    const result = extraction();
    result.fields.buyerName = { value: '', confidence: 0, evidence: '' };
    result.fields.buyerRequirement = buyerRequirement;

    const assessment = assess(request(), result);
    assert.equal(assessment.code, 'U1');
    assert.notEqual(assessment.matching.buyerCompany.status, 'NOT_REQUIRED');
  }
});

test('a non-empty buyer name must still match even if the classifier says it is not required', () => {
  const result = extraction();
  result.fields.buyerName.value = 'Công ty khác';
  result.fields.buyerRequirement = {
    value: 'NOT_REQUIRED', confidence: 0.99, evidence: 'Trang 1: hóa đơn bán lẻ.'
  };

  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'U1');
  assert.equal(assessment.matching.buyerCompany.status, 'MISMATCH');
});

test('verified supplier aliases match while a registered tax-code conflict remains U1', () => {
  const registeredAlias = assess(request(), extraction(), { status: 'MATCH', method: 'VERIFIED_ALIAS' });
  assert.equal(registeredAlias.code, 'CLEAR');
  assert.deepEqual(registeredAlias.matching.vendor, { status: 'MATCH', verifiedAlias: true });

  const taxCodeConflict = assess(request(), extraction(), { status: 'MISMATCH', method: 'TAX_CODE_CONFLICT' });
  assert.equal(taxCodeConflict.code, 'U1');
  assert.equal(taxCodeConflict.matching.vendor.status, 'MISMATCH');
  assert.match(taxCodeConflict.reason, /nhà cung cấp trên hóa đơn không khớp form/i);
});

test('an exact registered alias verifies supplier identity even when OCR confidence is below 80 percent', () => {
  const result = extraction();
  result.fields.vendor = { value: 'BAO ANH ELECTRONICS', confidence: 0.65, evidence: 'BAO ANH ELECTRONICS' };

  const assessment = assess(request(), result, { status: 'MATCH', method: 'VERIFIED_ALIAS' });
  assert.equal(assessment.code, 'CLEAR');
  assert.equal(assessment.matching.vendor.verifiedAlias, true);
  assert.equal(assessment.checks.vendorIdentityMethod, 'VERIFIED_ALIAS');
  assert.doesNotMatch(assessment.reason, /độ tin cậy khi đọc nhà cung cấp/i);
});

test('vendor directory lookup receives evidenced OCR aliases below the confidence threshold', () => {
  const result = extraction();
  result.fields.vendor = { value: 'HỌ KINH DOANH L.A GREEN', confidence: 0.65, evidence: 'HỌ KINH DOANH L.A GREEN' };
  result.fields.taxCode = { value: '068195010279', confidence: 0.75, evidence: 'MST 068195010279' };

  assert.deepEqual(buildVendorMatchPayload(request(), result), {
    p_form_name: 'Công ty Sao Mai',
    p_invoice_name: 'HỌ KINH DOANH L.A GREEN',
    p_invoice_name_confidence: 0.65,
    p_invoice_tax_code: null
  });
});

test('sales invoices do not require or compare the OCR buyer-name field', () => {
  for (const buyerName of ['', 'A name that does not match the form']) {
    const result = extraction();
    result.fields.invoiceKind = { value: 'SALES', confidence: 0.99, evidence: 'HÓA ĐƠN BÁN HÀNG' };
    result.fields.buyerName = { value: buyerName, confidence: buyerName ? 0.99 : 0, evidence: buyerName || '' };
    result.fields.buyerRequirement = { value: 'UNKNOWN', confidence: 0, evidence: '' };

    const assessment = assess(request(), result);
    assert.equal(assessment.code, 'CLEAR');
    assert.equal(assessment.matching.buyerCompany.status, 'NOT_REQUIRED');
    assert.equal(assessment.checks.buyerNameRequirement, 'NOT_REQUIRED');
  }
});

test('a registered tax-code match can independently verify the supplier when seller-name OCR is below 80 percent', () => {
  const result = extraction();
  result.fields.vendor = { value: 'Công ty Sao Mai', confidence: 0.7, evidence: 'Tên mờ trên PDF' };
  result.fields.taxCode = { value: '0312500505', confidence: 0.8, evidence: 'Mã số thuế: 0312500505' };

  const assessment = assess(request(), result, { status: 'MATCH', method: 'VERIFIED_TAX_CODE' });
  assert.equal(assessment.code, 'CLEAR');
  assert.equal(assessment.matching.vendor.verifiedTaxCode, true);
});

test('tax-code verification below 80 percent or without evidence cannot replace a low-confidence supplier name', () => {
  for (const taxCode of [
    { value: '0312500505', confidence: 0.799, evidence: 'Mã số thuế: 0312500505' },
    { value: '0312500505', confidence: 0.99, evidence: '' }
  ]) {
    const result = extraction();
    result.fields.vendor = { value: 'Công ty Sao Mai', confidence: 0.7, evidence: 'Tên mờ trên PDF' };
    result.fields.taxCode = taxCode;

    const assessment = assess(request(), result, { status: 'MATCH', method: 'VERIFIED_TAX_CODE' });
    assert.equal(assessment.code, 'U1');
    assert.match(assessment.reason, /độ tin cậy khi đọc nhà cung cấp dưới 80%/i);
  }
});

test('invoice date stays out of approval assessment even when missing or low confidence', () => {
  const result = extraction();
  result.fields.invoiceDate = { value: '', confidence: 0, evidence: '' };

  const assessment = assess(request(), result);
  assert.equal(assessment.code, 'CLEAR');
  assert.equal(assessment.matching.invoiceDate, undefined);
  assert.equal(assessment.checks.formFieldsMatch, true);
  assert.doesNotMatch(assessment.reason, /ngày hóa đơn/i);

  result.fields.invoiceDate = { value: '2026-09-23', confidence: 0, evidence: 'Ngày trên PDF' };
  assert.equal(assess(request(), result).code, 'CLEAR');
});
