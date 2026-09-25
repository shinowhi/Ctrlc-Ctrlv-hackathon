// Fast, dependency-free smoke check for the invoice decision preview.
// It does not call OpenAI or Supabase.
const assert = require('node:assert/strict');
const rules = require('../rules.js');

const all = {pdf: true, fieldsMatch: true, totalsConsistent: true, confidenceSufficient: true};
const cases = [
  ['LS-01 in-limit request', 12_500_000, all, 'CLEAR'],
  ['LS-02 exact limit', 20_000_000, all, 'CLEAR'],
  ['LS-03 escalation above limit', 20_000_001, all, 'U3'],
  ['LS-04 incomplete or conflicting invoice data', 1_000, {...all, fieldsMatch: false}, 'U1'],
  ['LS-05 invalid amount', 0, all, 'U1'],
];

let passed = 0;
for (const [name, amount, checks, expected] of cases) {
  const actual = rules.assess(amount, checks);
  try {
    assert.equal(actual, expected);
    passed += 1;
    console.log(`PASS ${name}: ${actual}`);
  } catch (error) {
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  }
}
console.log(`SMOKE ${passed}/${cases.length} PASS`);
if (passed !== cases.length) process.exitCode = 1;
