const test=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const handler=require('../api/analyze-evidence');

const uid='11111111-1111-4111-8111-111111111111';
const requestId='22222222-2222-4222-8222-222222222222';
const folder=uid+'/'+requestId;
const buyerCompany='CÔNG TY SAO MAI';
const payload={requesterType:'employee',requester:'TEST',department:'MKT',buyerMode:'ORGANIZATION',buyerCompany,
  budgetCode:'MKT-OPS-2026',purpose:'In ấn',vendor:'Sao Mai',invoiceNumber:'INV-01',invoiceDate:'2026-09-22',amount:1000};
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'server-test',OPENAI_API_KEY:'openai-test'};
const runtimeEnvKeys=['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY','OPENAI_VISION_MODEL',
  'INVOICE_ANALYSIS_PROVIDER','AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT','AZURE_DOCUMENT_INTELLIGENCE_KEY'];
const field=(value,confidence=0.99,evidence='Đọc được trên PDF trang 1')=>({value,confidence,evidence});
const clearFields=()=>({
  invoiceKind:field('VAT',0.99,'HÓA ĐƠN GIÁ TRỊ GIA TĂNG'),
  buyerPersonName:field('',0,''),
  buyerOrganizationName:field(buyerCompany),
  vendor:field('Sao Mai'),
  taxCode:field('0123456789',0.99,'MST: 0123456789'),
  invoiceNumber:field('INV-01',0.99,'Số hóa đơn: INV-01'),
  invoiceDate:field('2026-09-22'),
  amountBeforeTax:field(1000,0.99,'Tiền trước thuế: 1.000 đ'),
  vatAmount:field(0,0.99,'VAT: 0 đ'),
  discountAmount:field(0,0,''),
  totalAmount:field(1000,0.99,'Tổng thanh toán: 1.000 đ'),
  amountDue:field(0,0,'')
});

// The production handler reads process.env and global fetch directly. Keep those test-only overrides scoped to each serialized invocation.
function createHandler(testEnv,fetchImplementation){
  return async(req,res)=>{
    const scopedEnvKeys=[...new Set([...runtimeEnvKeys,...Object.keys(testEnv)])];
    const previousEnv=new Map(scopedEnvKeys.map(key=>[key,process.env[key]]));
    const previousFetch=globalThis.fetch;
    for(const key of scopedEnvKeys)delete process.env[key];
    Object.assign(process.env,testEnv);
    globalThis.fetch=fetchImplementation;
    try{return await handler(req,res);}
    finally{
      for(const key of scopedEnvKeys){
        delete process.env[key];
        const value=previousEnv.get(key);
        if(value!==undefined)process.env[key]=value;
      }
      globalThis.fetch=previousFetch;
    }
  };
}

async function run(options={}){
  const calls=[];
  let savedAnalysis=null;
  const request={id:requestId,owner_id:options.ownerId||uid,status:options.status||'TREASURER_REVIEW',
    invoice_path:options.invoicePath||folder+'/invoice.pdf',version:3,amount:payload.amount,payload};
  const requestHandler=createHandler(options.env||env,async(input,fetchOptions={})=>{
    const url=String(input);
    calls.push({url,options:fetchOptions});
    if(url.endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:uid}),{status:options.unauthorized?401:200});
    if(url.includes('/rest/v1/requests?'))return new Response(JSON.stringify([request]));
    if(url.includes('/rest/v1/profiles?'))return new Response(JSON.stringify([{role:options.role||'applicant'}]));
    if(url.includes('/storage/v1/object/evidence/'))return new Response(options.badFile?'not a PDF':'%PDF-1.4 test');
    if(url.includes('api.openai.com')){
      const body=JSON.parse(fetchOptions.body);
      assert.equal(body.store,false);
      assert.equal(body.text.format.strict,true);
      const pdf=body.input[0].content.find(part=>part.type==='input_file');
      assert.ok(pdf.file_data.includes(Buffer.from('%PDF-1.4 test').toString('base64')),'server uses bytes from Supabase Storage');
      const model=options.model||{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({fields:options.fields||clearFields()})}]}]};
      return new Response(JSON.stringify(model),{status:options.apiFail?500:200});
    }
    if(url.includes('/rpc/resolve_vendor_name_match_with_confidence'))
      return new Response(JSON.stringify({status:'MATCH',method:'VERIFIED_ALIAS'}));
    if(url.includes('/rpc/record_invoice_analysis')){
      savedAnalysis=JSON.parse(fetchOptions.body);
      return new Response(JSON.stringify({status:'READY_FOR_APPROVAL'}));
    }
    throw new Error('Unexpected network call: '+url);
  });
  const req=Readable.from([JSON.stringify(options.body||{requestId})]);
  req.method=options.method||'POST';
  req.headers={authorization:options.noToken?'':'Bearer user-test'};
  const res={status(code){this.statusCode=code;return this;},setHeader(){return this;},end(value){this.body=JSON.parse(value);}};
  await requestHandler(req,res);
  return {res,calls,savedAnalysis};
}

test('authenticated analysis reads the stored PDF and records the current assessment RPC',async()=>{
  const {res,calls,savedAnalysis}=await run();
  assert.equal(res.statusCode,200);
  assert.equal(res.body.status,'READY_FOR_APPROVAL');
  assert.equal(res.body.analysis.assessment.code,'CLEAR');
  assert.equal(savedAnalysis.p_id,requestId);
  assert.equal(savedAnalysis.p_expected_version,3);
  assert.equal(savedAnalysis.p_analysis.policyChecked,false);
  assert.ok(calls.some(call=>call.url.includes('/storage/v1/object/evidence/')));
});

test('secret API keys stay in apikey while the user session remains a bearer token',async()=>{
  const {res,calls}=await run({env:{...env,SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test'}});
  assert.equal(res.statusCode,200);
  const userCall=calls.find(call=>call.url.endsWith('/auth/v1/user'));
  assert.equal(userCall.options.headers.apikey,'public-test');
  assert.equal(userCall.options.headers.Authorization,'Bearer user-test');
  for(const call of calls.filter(call=>call.url.includes('/storage/v1/object/evidence/')||call.url.includes('/rpc/record_invoice_analysis'))){
    assert.equal(call.options.headers.apikey,'sb_secret_test');
    assert.equal(call.options.headers.Authorization,undefined);
  }
});

test('legacy service_role JWT remains in the bearer header',async()=>{
  const {res,calls}=await run();
  assert.equal(res.statusCode,200);
  const recordCall=calls.find(call=>call.url.includes('/rpc/record_invoice_analysis'));
  assert.equal(recordCall.options.headers.apikey,'server-test');
  assert.equal(recordCall.options.headers.Authorization,'Bearer server-test');
});

test('unauthorized, inaccessible, stale, non-applicant, and invalid-PDF requests never reach OpenAI',async()=>{
  for(const options of [
    {unauthorized:true},
    {ownerId:'33333333-3333-4333-8333-333333333333'},
    {status:'APPROVED'},
    {role:'treasurer'},
    {badFile:true}
  ]){
    const {res,calls}=await run(options);
    assert.notEqual(res.statusCode,200);
    assert.ok(!calls.some(call=>call.url.includes('api.openai.com')));
  }
});

test('missing provider key and upstream/model errors never record a successful assessment',async()=>{
  for(const options of [
    {env:{...env,OPENAI_API_KEY:''}},
    {apiFail:true},
    {model:{status:'incomplete',output:[]}}
  ]){
    const {res,savedAnalysis}=await run(options);
    assert.notEqual(res.statusCode,200);
    assert.equal(savedAnalysis,null);
    assert.ok(!JSON.stringify(res.body).includes('openai-test'));
  }
});

test('uncertain OCR fields are recorded as manager review instead of clear',async()=>{
  const fields=clearFields();
  fields.buyerOrganizationName=field('',0,'');
  const {res,savedAnalysis}=await run({fields});
  assert.equal(res.statusCode,200);
  assert.equal(savedAnalysis.p_analysis.assessment.code,'U2');
  assert.match(savedAnalysis.p_analysis.assessment.reason,/AI chưa đọc tên doanh nghiệp\/đơn vị người mua/);
});
