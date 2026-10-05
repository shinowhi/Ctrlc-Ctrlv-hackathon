const test = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('../api/analyze-evidence.js');

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

test('verified supplier aliases match while a registered tax-code conflict remains U1', () => {
  const registeredAlias = assess(request(), extraction(), { status: 'MATCH', method: 'VERIFIED_ALIAS' });
  assert.equal(registeredAlias.code, 'CLEAR');
  assert.deepEqual(registeredAlias.matching.vendor, { status: 'MATCH', verifiedAlias: true });

  const taxCodeConflict = assess(request(), extraction(), { status: 'MISMATCH', method: 'TAX_CODE_CONFLICT' });
  assert.equal(taxCodeConflict.code, 'U1');
  assert.equal(taxCodeConflict.matching.vendor.status, 'MISMATCH');
  assert.match(taxCodeConflict.reason, /nhà cung cấp trên hóa đơn không khớp form/i);
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
