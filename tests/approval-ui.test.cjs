const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const appSource=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');

function appFunction(name,nextName,async=false){
  const prefix=async?'async function ':'function ';
  const start=appSource.indexOf(prefix+name+'(');
  const end=appSource.indexOf('\nfunction '+nextName+'(',start);
  assert.notEqual(start,-1,`${name} should exist in app.js`);
  assert.notEqual(end,-1,`${nextName} should follow ${name}`);
  return appSource.slice(start,end);
}

function renderApprovalTools(role,dailySummary,reason){
  const noopClassList={toggle(){}};
  const elements={
    approvalTools:{classList:noopClassList},
    approvalQueueCount:{textContent:''},
    batchReasonField:{classList:noopClassList},
    approvalSummaryText:{textContent:''},
    approveAllButton:{textContent:'',disabled:false},
    batchReason:{value:reason}
  };
  const context={
    profile:{role},busy:false,dailySummary,
    approvalQueue:()=>[{amount:25000001}],
    money:value=>String(value),
    $:id=>elements[id]
  };
  vm.runInNewContext(appFunction('renderApprovalTools','workflowDetails')+'\nrenderApprovalTools();',context);
  return elements;
}

test('CFO batch approval stays enabled with a reason when daily summary is unavailable',()=>{
  const elements=renderApprovalTools('cfo',null,'Cho phép theo quyết định của Giám đốc');
  assert.equal(elements.approveAllButton.disabled,false);
  assert.match(elements.approvalSummaryText.textContent,/vẫn có thể gửi/i);
});

test('CFO batch approval still requires a reason without a daily summary',()=>{
  const elements=renderApprovalTools('cfo',null,'   ');
  assert.equal(elements.approveAllButton.disabled,true);
});

test('manager batch approval remains disabled when daily summary is unavailable',()=>{
  const elements=renderApprovalTools('treasurer',null,'');
  assert.equal(elements.approveAllButton.disabled,true);
});

test('CFO batch submission reaches the database when the daily summary is unavailable',async()=>{
  let rpcCall=null;
  const elements={batchReason:{value:'Lý do duyệt ngoại lệ'}};
  const context={
    profile:{role:'cfo'},busy:false,dailySummary:null,
    api:{rpc:async(name,args)=>{rpcCall={name,args};return {status:'APPROVED',invoice_count:1,requested_total:25000001};}},
    setBusy(){},notify(){},money:value=>String(value),$ :id=>elements[id],refresh:async()=>{}
  };
  const submission=vm.runInNewContext(
    appFunction('submitApprovalBatch','approveQueueItem',true)+
    "\nsubmitApprovalBatch([{id:'request-1',version:3,amount:25000001}],'Lý do duyệt ngoại lệ');",
    context
  );
  await submission;
  assert.equal(rpcCall.name,'review_requests_batch');
  assert.equal(rpcCall.args.p_reason,'Lý do duyệt ngoại lệ');
});
