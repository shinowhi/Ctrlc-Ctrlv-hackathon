const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAzureInvoice, normalizeAzureInvoiceDateFromLayout } = require('../api/analyze-evidence.js');

test('invoice date is extracted for display from bilingual Vietnamese OCR without approval gating', () => {
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

  assert.deepEqual(result.fields.invoiceDate, {
    value: '2026-09-24', confidence: 0.98,
    evidence: 'Ngày (Date) 24 tháng (month) 09 năm (year) 2026', regions: []
  });
});

test('invoice date layout fallback can display a date with zero OCR confidence', () => {
  const result = normalizeAzureInvoiceDateFromLayout({
    analyzeResult: {
      pages: [{ pageNumber: 1, width: 100, height: 100, lines: [{
        content: 'Ngày 24 tháng 09 năm 2026', spans: [{ offset: 0, length: 25 }],
        polygon: [1, 1, 20, 1, 20, 5, 1, 5]
      }] }]
    }
  });

  assert.equal(result.value, '2026-09-24');
  assert.equal(result.confidence, 0);
  assert.equal(result.evidence, 'Ngày 24 tháng 09 năm 2026');
});
