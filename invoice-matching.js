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

const organizationLegalPrefixes=[
  'cong ty trach nhiem huu han mot thanh vien','cong ty tnhh mot thanh vien','cong ty tnhh mtv',
  'cty trach nhiem huu han mot thanh vien','cty tnhh mot thanh vien','cty tnhh mtv',
  'cty trach nhiem huu han','cty tnhh','cong ty trach nhiem huu han','cong ty tnhh',
  'cty co phan','cong ty co phan','cty cp','cong ty cp','cty','cong ty',
  'ho kinh doanh','doanh nghiep tu nhan','dntn','hop tac xa','htx'
];

function buyerNameKey(value, isOrganization) {
  let key=accentInsensitiveKey(value)
    .replace(/[^\p{L}\p{N}]+/gu,' ')
    .trim()
    .replace(/\s+/gu,' ');
  if(isOrganization) {
    let changed=true;
    while(changed) {
      changed=false;
      for(const prefix of organizationLegalPrefixes) {
        if(key===prefix) {key='';changed=true;break;}
        if(key.startsWith(prefix+' ')) {key=key.slice(prefix.length).trim();changed=true;break;}
      }
    }
  }
  return key;
}

function editDistance(left, right) {
  const previous=Array.from({length:right.length+1},(_,index)=>index);
  for(let i=1;i<=left.length;i++) {
    let diagonal=previous[0];
    previous[0]=i;
    for(let j=1;j<=right.length;j++) {
      const above=previous[j];
      previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+(left[i-1]===right[j-1]?0:1));
      diagonal=above;
    }
  }
  return previous[right.length];
}

// Returns a 0–1 character-edit similarity for one typed buyer field.
// Exact/high-similarity names match at >=90%; 80–<90% is reviewable; <=80% mismatches.
function compareBuyerName(actual, expected, fieldKey) {
  if(!['buyerPersonName','buyerOrganizationName'].includes(fieldKey)) return {status:'UNVERIFIED',similarity:null};
  const organization=fieldKey==='buyerOrganizationName';
  const actualKey=buyerNameKey(actual,organization),expectedKey=buyerNameKey(expected,organization);
  if(!actualKey||!expectedKey) return {status:'UNVERIFIED',similarity:null};
  const similarity=1-editDistance(actualKey,expectedKey)/Math.max(actualKey.length,expectedKey.length);
  if(similarity>=0.90) return {status:'MATCH',similarity};
  if(similarity>0.80) return {status:'POSSIBLE_MATCH',similarity};
  return {status:'MISMATCH',similarity};
}

const matchingApi = { normalizeInvoiceNumber, normalizePartyName, comparePartyName, compareBuyerName };

if (typeof module !== 'undefined' && module.exports) module.exports = matchingApi;
if (root) root.FinRefInvoiceMatching = matchingApi;
})(typeof window === 'undefined' ? null : window);
