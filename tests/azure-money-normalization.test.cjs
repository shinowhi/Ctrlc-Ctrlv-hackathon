const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAzureInvoice } = require('../api/analyze-evidence.js');

const normalizeSubtotal = ({ amount, content, currencyCode = 'VND', currencySymbol = '₫' }) => {
  const result = normalizeAzureInvoice({
    analyzeResult: {
      documents: [{ fields: {
        SubTotal: {
          valueCurrency: { amount, currencyCode, currencySymbol },
          content,
          confidence: 0.99
        }
      } }],
      pages: []
    }
  });
  return result.fields.amountBeforeTax;
};

test('Vietnamese VND thousands notation from Azure becomes an integer amount', () => {
  const amount = normalizeSubtotal({ amount: 72.727, content: '72.727 ₫' });
  assert.equal(amount.value, 72727);
  assert.equal(amount.confidence, 0.99);
  assert.equal(amount.evidence, '72.727 ₫');
});

test('already integral VND values keep Azure amount unchanged', () => {
  const amount = normalizeSubtotal({ amount: 72727, content: '72.727 ₫' });
  assert.equal(amount.value, 72727);
  assert.equal(amount.confidence, 0.99);
});

test('VND thousands separators are restored when Azure has already dropped them', () => {
  const amount = normalizeSubtotal({ amount: 80, content: '80.000 ₫' });
  assert.equal(amount.value, 80000);
  assert.equal(amount.confidence, 0.99);
});

test('ambiguous fractional VND values are saved as unreadable instead of sent to bigint casts', () => {
  const amount = normalizeSubtotal({ amount: 72.72, content: '72,72 ₫' });
  assert.equal(amount.value, 0);
  assert.equal(amount.confidence, 0);
  assert.equal(amount.evidence, '72,72 ₫');
});

test('foreign currency amounts are never normalized as VND', () => {
  const amount = normalizeSubtotal({ amount: 72.727, content: '72.727 $', currencyCode: 'USD', currencySymbol: '$' });
  assert.equal(amount.value, 0);
  assert.equal(amount.confidence, 0);
});
