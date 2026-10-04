const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  normalizeInvoiceNumber,
  normalizePartyName,
  comparePartyName
} = require('../invoice-matching.js');

test('invoice numbers normalize Unicode, case and spacing without erasing meaningful separators', () => {
  assert.equal(normalizeInvoiceNumber('  ００１２３  '), '123');
  assert.equal(normalizeInvoiceNumber(' inv - 00123 '), 'inv - 00123');
  assert.notEqual(normalizeInvoiceNumber('INV/00123'), normalizeInvoiceNumber('INV-00123'));
  assert.notEqual(normalizeInvoiceNumber('INV-00123'), normalizeInvoiceNumber('INV-123'));
});

test('party names normalize Unicode form, case and repeated whitespace', () => {
  assert.equal(normalizePartyName('  CÔNG   TY   Sao Mai  '), 'công ty sao mai');
  assert.equal(normalizePartyName('Co\u0302ng ty Sao Mai'), 'công ty sao mai');
});

test('party comparison distinguishes exact matches, possible OCR variants and missing references', () => {
  assert.equal(comparePartyName('CÔNG TY Sao Mai', 'Công ty Sao Mai').status, 'MATCH');
  assert.equal(comparePartyName('Cong ty Sao Mai', 'Công ty Sao Mai').status, 'POSSIBLE_MATCH');
  assert.equal(comparePartyName('Công ty Sao Mai', '').status, 'UNVERIFIED');
  assert.equal(comparePartyName('Công ty Sao Mai', 'Công ty Sao Bắc').status, 'MISMATCH');
});

test('verified party aliases count as exact matches', () => {
  assert.equal(comparePartyName('CTY Sao Mai', 'Công ty Sao Mai', ['CTY Sao Mai']).status, 'MATCH');
});

test('browser helper does not collide with app.js global declarations', () => {
  const context = vm.createContext({});
  context.window = context;
  context.document = { getElementById: () => null };
  context.FinRefApi = class {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../invoice-matching.js'), 'utf8'), context, { filename: 'invoice-matching.js' });
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const declarationsEnd = appSource.indexOf('const normalized = normalizePartyName;');
  assert.notEqual(declarationsEnd, -1, 'app.js declaration block should include its matching helper binding');
  const appDeclarations = appSource.slice(0, declarationsEnd + 'const normalized = normalizePartyName;'.length);
  assert.doesNotThrow(() => vm.runInContext(appDeclarations, context, { filename: 'app.js' }));
});

test('invoice date is shown as reference data and is not included in AI review requirements', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.match(appSource, /invoiceDate:'Ngày hóa đơn \(tham khảo\)'/);
  assert.match(appSource, /key:'invoiceDate',label:'Ngày hóa đơn',reviewNote:'AI trích xuất để tham khảo; không dùng ngày này làm điều kiện đối chiếu hoặc duyệt\.'/);
  assert.match(appSource, /const requiredInvoiceFields=\['buyerName','vendor','invoiceNumber','amountBeforeTax','vatAmount','totalAmount'\]/);
  assert.doesNotMatch(appSource, /const aiConfidenceThresholds=\{[^}]*invoiceDate/s);
});

test('vendor directory UI supports supplier creation, verified aliases and invoice-form suggestions', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const apiSource = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
  assert.match(html, /id="vendorDirectoryNav"/);
  assert.match(html, /id="vendorCreateForm"/);
  assert.match(html, /id="vendorAliasForm"/);
  assert.match(html, /id="vendorAliasVerified" type="checkbox" required/);
  assert.match(html, /list="vendorDirectoryOptions"/);
  assert.match(appSource, /const canManageVendors=\['treasurer','cfo'\]\.includes\(p\.role\)/);
  assert.match(apiSource, /vendorDirectory\(\) \{ return this\.rpc\('vendor_directory_list'/);
  assert.match(apiSource, /saveVendor\(vendorId,legalName,taxCode,aliases\)/);
});
