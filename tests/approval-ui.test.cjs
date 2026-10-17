const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const appSource=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');

function appFunction(name,nextName,async=false){
  const prefix=async?'async function ':'function ';
  const start=appSource.indexOf(prefix+name+'(');
  const endCandidates=[
    appSource.indexOf('\nfunction '+nextName+'(',start),
    appSource.indexOf('\nasync function '+nextName+'(',start)
  ].filter(index=>index!==-1);
  const end=endCandidates.length?Math.min(...endCandidates):-1;
  assert.notEqual(start,-1,`${name} should exist in app.js`);
  assert.notEqual(end,-1,`${nextName} should follow ${name}`);
  return appSource.slice(start,end);
}

function asyncAppFunction(name,nextName){
  const start=appSource.indexOf('async function '+name+'(');
  const end=appSource.indexOf('\nasync function '+nextName+'(',start);
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
    batchReason:{value:reason,disabled:false},
    statusFilter:{value:''},
    showApprovalQueueButton:{classList:noopClassList,textContent:'',setAttribute(){}}
  };
  const context={
    profile:{role,id:'test-cfo'},busy:false,loading:false,dailySummary,approvalBatchPreflight:false,epoch:1,
    api:{session:{user:{id:'test-cfo'}}},
    rows:[],
    approvalQueue:()=>[{id:'request-1',version:3,status:'READY_FOR_APPROVAL',amount:25000001}],
    cfoHasViewed:()=>true,
    document:{querySelectorAll:()=>[]},
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
    profile:{role:'cfo',id:'test-cfo'},busy:false,dailySummary:null,approvalBatchPreflight:false,epoch:1,
    cfoHasViewed:()=>true,
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

function combineReviewAnnotations(annotations,keys){
  const context={annotations,keys};
  return vm.runInNewContext(
    appFunction('combineReviewAnnotations','renderSubmittedForm')+
    '\ncombineReviewAnnotations(annotations,keys);',
    context
  );
}

test('review form renders NO_NAME records with buyer annotations',()=>{
  const context={
    formReviewFields:[{key:'buyerMode',label:'Thông tin người mua',read:value=>value}],
    buyerNameFields:['buyerPersonName','buyerOrganizationName'],
    request:{payload:{buyerMode:'NO_NAME'},checks:{}},
    annotations:{buyerPersonName:{state:'yellow',notes:['Cần kiểm tra tên người mua.']}},
    esc:value=>String(value)
  };
  assert.doesNotThrow(()=>vm.runInNewContext(
    appFunction('combineReviewAnnotations','renderSubmittedForm')+
    appFunction('renderSubmittedForm','renderInvoiceNotes')+
    '\nrenderSubmittedForm(request,annotations);',
    context
  ));
});

test('buyer annotations stay empty when there are no findings',()=>{
  assert.equal(combineReviewAnnotations({},['buyerPersonName','buyerOrganizationName']),null);
});

test('buyer annotation aggregation handles a single finding and missing notes',()=>{
  const result=combineReviewAnnotations({buyerPersonName:{state:'red'}},['buyerPersonName']);
  assert.equal(result.state,'red');
  assert.deepEqual(Array.from(result.notes),[]);
});

test('buyer annotation aggregation preserves notes and gives red findings precedence',()=>{
  const result=combineReviewAnnotations({
    buyerPersonName:{state:'yellow',notes:['Chưa đọc rõ tên cá nhân.']},
    buyerOrganizationName:{state:'red',notes:['Có tên doanh nghiệp trên hóa đơn.']}
  },['buyerPersonName','buyerOrganizationName']);
  assert.equal(result.state,'red');
  assert.deepEqual(Array.from(result.notes),['Chưa đọc rõ tên cá nhân.','Có tên doanh nghiệp trên hóa đơn.']);
});

test('opening a request reports rendering errors without replacing another selection',async()=>{
  const elements={decisionResult:{textContent:'Chi tiết hồ sơ hiện tại'},auditList:{textContent:'Nhật ký hiện tại'}};
  let loggedError=null,clearedPdf=false;
  const context={
    renderRequestDetails:async()=>{throw new Error('Render failed');},
    selected:{id:'another-request'},
    clearPdfViewer:()=>{clearedPdf=true;},
    console:{error:(...args)=>{loggedError=args;}},
    $:id=>elements[id]
  };
  await vm.runInNewContext(appFunction('openRequest','setBusy',true)+'\nopenRequest("request-1");',context);
  assert.match(loggedError[0],/Không thể mở chi tiết hồ sơ/);
  assert.equal(elements.decisionResult.textContent,'Chi tiết hồ sơ hiện tại');
  assert.equal(elements.auditList.textContent,'Nhật ký hiện tại');
  assert.equal(clearedPdf,false);
});

test('opening a selected request shows a safe fallback when rendering fails',async()=>{
  const elements={decisionResult:{textContent:'Chi tiết'},auditList:{textContent:'Nhật ký'}};
  const context={
    renderRequestDetails:async()=>{throw new Error('Render failed');},
    selected:{id:'request-1'},
    clearPdfViewer(){},
    console:{error(){}},
    $:id=>elements[id]
  };
  await vm.runInNewContext(appFunction('openRequest','setBusy',true)+'\nopenRequest("request-1");',context);
  assert.equal(elements.decisionResult.textContent,'Không thể hiển thị chi tiết hồ sơ. Vui lòng thử mở lại.');
  assert.equal(elements.auditList.textContent,'');
});

test('queue disclosure keeps its button label and accessible state in sync',()=>{
  const elements={
    queueContent:{hidden:false},
    toggleQueue:{textContent:'',attributes:{},setAttribute(name,value){this.attributes[name]=value;}}
  };
  const context={$:id=>elements[id]};
  vm.runInNewContext(appFunction('setQueueExpanded','syncApplicantCreateAction')+
    "\nsetQueueExpanded(false);",context);
  assert.equal(elements.queueContent.hidden,true);
  assert.equal(elements.toggleQueue.attributes['aria-expanded'],'false');
  assert.equal(elements.toggleQueue.textContent,'Xem hồ sơ');
  vm.runInNewContext('setQueueExpanded(true);',context);
  assert.equal(elements.queueContent.hidden,false);
  assert.equal(elements.toggleQueue.attributes['aria-expanded'],'true');
  assert.equal(elements.toggleQueue.textContent,'Thu gọn hồ sơ');
});

test('vendor directory and CFO notes lists are collapsible and initially expanded',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
  assert.match(html,/<details class="vendor-list-collapse" open>[\s\S]*?id="vendorDirectoryList"/);
  assert.match(html,/<details class="vendor-list-collapse" open>[\s\S]*?id="vendorReviewNotesList"/);
});

test('switching requests destroys the PDF loading task while the document is still loading',async()=>{
  let resolveDocument,notifyGetDocument;
  let destroyCount=0;
  const getDocumentCalled=new Promise(resolve=>{notifyGetDocument=resolve;});
  const loadingTask={
    promise:new Promise(resolve=>{resolveDocument=resolve;}),
    destroy(){destroyCount++;return Promise.resolve();}
  };
  const elements={
    reviewPdfStatus:{classList:{add(){},remove(){}}},
    reviewPdfStage:{},
    reviewPdfWrap:{removeEventListener(){}},
    reviewPdfToolbar:{classList:{add(){},remove(){}}}
  };
  const context={
    pdfViewToken:0,pdfViewCleanup:null,
    loadPdfJs:async()=>({getDocument(){notifyGetDocument();return loadingTask;}}),
    fetch:async()=>({ok:true,arrayBuffer:()=>new ArrayBuffer(0)}),
    document:{baseURI:'https://example.test/',removeEventListener(){}},window:{removeEventListener(){}},
    URL,Uint8Array,
    $:id=>elements[id]
  };
  const renderPromise=vm.runInNewContext(
    appFunction('clearPdfViewer','loadPdfJs')+
    asyncAppFunction('renderReviewPdf','renderRequestDetails')+
    '\nrenderReviewPdf("signed-url",{},0);',context
  );

  let timer;
  const reachedGetDocument=await Promise.race([
    getDocumentCalled.then(()=>true),
    renderPromise.then(()=>false,error=>{throw error;}),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})
  ]);
  clearTimeout(timer);
  assert.equal(reachedGetDocument,true,'PDF loading should start before switching requests');
  vm.runInNewContext('clearPdfViewer();',context);
  resolveDocument({});

  await assert.doesNotReject(renderPromise);
  assert.equal(destroyCount,1);
});
test('selective form shows permitted fields, escapes HTML and omits invoice number',()=>{
 const context={formReviewFields:[{key:'requester',label:'Người đề nghị'},{key:'invoiceNumber',label:'Số hóa đơn'},{key:'vendor',label:'Nhà cung cấp'}],request:{payload:{requester:'<img src=x>',invoiceNumber:'HIDDEN-123',vendor:'Hoa Mai'},checks:{privacy_version:1,redaction_policy:2}},annotations:{},esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
 const html=vm.runInNewContext(appFunction('renderSubmittedForm','renderInvoiceNotes')+'\nrenderSubmittedForm(request,annotations);',context);
 assert.ok(html.includes('Hoa Mai'));assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(!html.includes('HIDDEN-123'));assert.ok(!html.includes('<img'));
});
