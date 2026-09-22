const test=require('node:test');
const assert=require('node:assert/strict');
const rules=require('../rules.js');
for(const row of rules.verify()) test(row.name,()=>assert.equal(row.actual,row.expected));
test('A truthy string does not count as reviewer confirmation',()=>assert.equal(rules.assess(100,{paper:'true',stamp:true,signature:true,match:true,budget:true,policy:true}),'U1'));
test('NaN and Infinity do not pass',()=>{assert.equal(rules.assess(NaN),'U1');assert.equal(rules.assess(Infinity),'U1');});
test('A clear request is auto-approved up to and including 20 million',()=>{
  const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
  assert.deepEqual(rules.decide(20000000,all),{action:'AUTO_APPROVE',code:'CLEAR',receiver:null,question:null});
});
test('A request above 20 million is escalated to the CFO with a direct question',()=>{
  const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
  assert.deepEqual(rules.decide(20000001,all),{action:'ESCALATE',code:'U3',receiver:'cfo',question:'Khoản chi 20.000.001 ₫ vượt hạn mức tự động 20.000.000 ₫. Giám đốc Tài chính có phê duyệt khoản này không?'});
});
test('A flagged request is never auto-approved and asks for the missing evidence',()=>{
  const checks={paper:true,stamp:false,signature:true,match:true,budget:true,policy:true};
  const result=rules.decide(12000000,checks);
  assert.equal(result.action,'ESCALATE');
  assert.equal(result.code,'U1');
  assert.equal(result.receiver,'treasurer');
  assert.match(result.question,/dấu đỏ/);
});
test('The first five Verify cases contain three automatic decisions and two escalations',()=>{
  const first=rules.verify().slice(0,5);
  assert.equal(first.filter(r=>r.decision.action==='AUTO_APPROVE').length,3);
  assert.equal(first.filter(r=>r.decision.action==='ESCALATE').length,2);
  assert.ok(first.every(r=>r.pass));
});
