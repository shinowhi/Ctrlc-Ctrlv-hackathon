const test = require('node:test');
const assert = require('node:assert/strict');
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
