const test=require('node:test');
const assert=require('node:assert/strict');
const rules=require('../rules.js');
for(const row of rules.verify()) test(row.name,()=>assert.equal(row.actual,row.expected));
test('A truthy string does not count as reviewer confirmation',()=>assert.equal(rules.assess(100,{paper:'true',stamp:true,signature:true,match:true,budget:true,policy:true}),'U1'));
test('NaN and Infinity do not pass',()=>{assert.equal(rules.assess(NaN),'U1');assert.equal(rules.assess(Infinity),'U1');});
test('A clear request is auto-approved strictly below 20 million',()=>{
  const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
  assert.deepEqual(rules.decide(19999999,all),{action:'AUTO_APPROVE',code:'CLEAR',receiver:null,question:null});
  assert.equal(rules.decide(20000000,all).code,'U3');
});
test('A request above 20 million is escalated to the CFO with a direct question',()=>{
  const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
  assert.deepEqual(rules.decide(20000001,all),{action:'ESCALATE',code:'U3',receiver:'cfo',question:'Khoản chi 20.000.001 ₫ đạt hoặc vượt ngưỡng 20.000.000 ₫. Giám đốc Tài chính có phê duyệt khoản này không?'});
});
test('A flagged request is never auto-approved and asks for the missing evidence',()=>{
  const checks={paper:true,stamp:false,signature:true,match:true,budget:true,policy:true};
  const result=rules.decide(12000000,checks);
  assert.equal(result.action,'ESCALATE');
  assert.equal(result.code,'U1');
  assert.equal(result.receiver,'treasurer');
  assert.match(result.question,/dấu đỏ/);
});
test('The first five Verify cases contain two automatic decisions and three escalations',()=>{
  const first=rules.verify().slice(0,5);
  assert.equal(first.filter(r=>r.decision.action==='AUTO_APPROVE').length,2);
  assert.equal(first.filter(r=>r.decision.action==='ESCALATE').length,3);
  assert.ok(first.every(r=>r.pass));
});
