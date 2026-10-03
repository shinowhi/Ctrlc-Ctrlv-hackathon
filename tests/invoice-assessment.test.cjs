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
    buyerName: field('  CÔNG TY   MUA HÀNG '), vendor: field('  CÔNG TY SAO MAI '),
    invoiceNumber: field('００１２３'), invoiceDate: field('2026-10-04'),
    amountBeforeTax: field(4000), vatAmount: field(1000), totalAmount: field(5000)
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
