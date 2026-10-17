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

function moneyMinorUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>999999999999.99) return null;
  const scaled=value*100, rounded=Math.round(scaled);
  return Math.abs(scaled-rounded)<=Math.max(1e-7,Number.EPSILON*Math.abs(scaled)*2) ? rounded : null;
}
function parseAmountInput(raw,currency='VND') {
  const text=String(raw??'').trim();
  if(!text) return null;
  // A comma or dot is a decimal separator; grouping and exponent notation are rejected.
  if(!/^\d{1,12}(?:[.,]\d{1,2})?$/.test(text)) throw new Error('Nhập số tiền như 51.94 hoặc 51,94; không dùng dấu phân cách hàng nghìn.');
  const value=Number(text.replace(',','.'));
  if(value<=0||moneyMinorUnits(value)===null) throw new Error('Số tiền phải lớn hơn 0 và có tối đa 2 chữ số thập phân.');
  if(currency==='VND'&&!Number.isSafeInteger(value)) throw new Error('VND dùng số nguyên; USD, CNY và EUR cho phép tối đa 2 chữ số thập phân.');
  return value;
}
const matchingApi = { normalizeInvoiceNumber, normalizePartyName, comparePartyName, moneyMinorUnits, parseAmountInput };

if (typeof module !== 'undefined' && module.exports) module.exports = matchingApi;
if (root) root.FinRefInvoiceMatching = matchingApi;
})(typeof window === 'undefined' ? null : window);
