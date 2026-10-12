(function (root) {
'use strict';

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('vi');
}

function normalizeInvoiceNumber(value) {
  const text = normalizeText(value);
  return /^\d+$/u.test(text) ? text.replace(/^0+(?=\d)/u, '') : text;
}

function normalizePartyName(value) {
  return normalizeText(value);
}

function accentInsensitiveKey(value) {
  return normalizePartyName(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/gu, 'd')
    .normalize('NFKC');
}

function comparePartyName(actual, expected, verifiedAliases = []) {
  const actualKey = normalizePartyName(actual);
  const expectedKeys = [expected, ...verifiedAliases]
    .map(normalizePartyName)
    .filter(Boolean);

  if (!actualKey || expectedKeys.length === 0) return { status: 'UNVERIFIED' };
  if (expectedKeys.includes(actualKey)) return { status: 'MATCH' };

  const actualAccentInsensitive = accentInsensitiveKey(actualKey);
  if (expectedKeys.some(key => accentInsensitiveKey(key) === actualAccentInsensitive)) {
    return { status: 'POSSIBLE_MATCH' };
  }
  return { status: 'MISMATCH' };
}

const matchingApi = { normalizeInvoiceNumber, normalizePartyName, comparePartyName };

if (typeof module !== 'undefined' && module.exports) module.exports = matchingApi;
if (root) root.FinRefInvoiceMatching = matchingApi;
})(typeof window === 'undefined' ? null : window);
