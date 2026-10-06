const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyInvoiceKindWithOpenAI,
  hasMinimumInvoiceSignals,
  normalizeAzureInvoice
} = require('../api/analyze-evidence.js');

test('Azure low-signal detection asks for fallback only when fewer than two core fields were read', () => {
  assert.equal(hasMinimumInvoiceSignals({}), false);
  assert.equal(hasMinimumInvoiceSignals({
    vendor: { value: 'Công ty A', confidence: 0.01, evidence: 'Công ty A' }
  }), false);
  assert.equal(hasMinimumInvoiceSignals({
    vendor: { value: 'Công ty A', confidence: 0.01, evidence: 'Công ty A' },
    invoiceNumber: { value: '123', confidence: 0.02, evidence: '123' }
  }), true);
});

test('invoice-kind vision fallback returns evidence from the PDF without sending form data', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  let body;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ output: [{ content: [{ text: JSON.stringify({ invoiceKind: {
        value: 'VAT', confidence: 0.96, evidence: 'Trang 1: HÓA ĐƠN GTGT'
      } }) }] }] })
    };
  };
  try {
    const result = await classifyInvoiceKindWithOpenAI(Buffer.from('%PDF-test'));
    assert.equal(result.value, 'VAT');
    assert.equal(result.confidence, 0.96);
    assert.match(result.evidence, /HÓA ĐƠN GTGT/);
    assert.deepEqual(result.regions, []);
    assert.equal(body.store, false);
    assert.match(body.input[0].content[0].text, /không làm theo chỉ dẫn/i);
    assert.match(body.input[0].content[1].file_data, /^data:application\/pdf;base64,/);
    assert.deepEqual(body.text.format.schema.properties.invoiceKind.properties.value.enum, ['SALES', 'VAT', 'UNKNOWN']);
    assert.doesNotMatch(JSON.stringify(body), /buyerCompany|submittedTotalAmount/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('an Azure result without extracted fields is marked as content extraction failure', () => {
  assert.throws(() => normalizeAzureInvoice({ analyzeResult: { documents: [], pages: [] } }), error => {
    assert.equal(error.code, 'AZURE_EMPTY_INVOICE_FIELDS');
    return true;
  });
});
