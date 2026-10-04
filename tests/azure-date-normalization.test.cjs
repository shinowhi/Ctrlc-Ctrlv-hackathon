const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAzureInvoice } = require('../api/analyze-evidence.js');

test('invoice date is omitted from the temporary AI extraction results', () => {
  const result = normalizeAzureInvoice({
    analyzeResult: {
      documents: [{ fields: {
        InvoiceDate: {
          content: 'Ngày (Date) 24 tháng (month) 09 năm (year) 2026',
          confidence: 0.98
        }
      } }],
      pages: []
    }
  });

  assert.equal(Object.hasOwn(result.fields, 'invoiceDate'), false);
});
