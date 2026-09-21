const test=require('node:test');
const assert=require('node:assert/strict');
const rules=require('../rules.js');
for(const row of rules.verify()) test(row.name,()=>assert.equal(row.actual,row.expected));
test('A truthy string does not count as reviewer confirmation',()=>assert.equal(rules.assess(100,{paper:'true',stamp:true,signature:true,match:true,budget:true,policy:true}),'U1'));
test('NaN and Infinity do not pass',()=>{assert.equal(rules.assess(NaN),'U1');assert.equal(rules.assess(Infinity),'U1');});
