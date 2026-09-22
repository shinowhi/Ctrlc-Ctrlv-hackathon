const test=require('node:test');const assert=require('node:assert/strict');const {createHandler}=require('../api/analyze-evidence');
const uid='11111111-1111-4111-8111-111111111111',folder=uid+'/22222222-2222-4222-8222-222222222222';
const payload={requesterType:'employee',requester:'TEST',department:'MKT',budgetCode:'MKT-OPS-2026',purpose:'In ấn',vendor:'Sao Mai',invoiceNumber:'INV-01',invoiceDate:'2026-09-22',amount:1000,invoiceType:'paper',category:'printing'};
const doc={amount:1000,vendor:'Sao Mai',invoiceNumber:'INV-01',invoiceDate:'2026-09-22',readable:true,paper:true,stamp:true,signature:true};
const raw=()=>({invoice:{...doc,documentKind:'invoice'},request:{...doc,documentKind:'request'},category:'printing',confidence:0.99,flags:[]});
const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'server-test',OPENAI_API_KEY:'openai-test'};
async function run(options={}){
 const calls=[];const handler=createHandler(options.env||env,async(url,opts)=>{
 calls.push({url,opts});
 if(url.endsWith('/auth/v1/user'))return new Response(JSON.stringify({id:uid}),{status:options.unauthorized?401:200});
 if(url.includes('/rpc/reserve_assessment'))return new Response(JSON.stringify('33333333-3333-4333-8333-333333333333'),{status:options.rateLimit?400:200});
 if(url.includes('/storage/'))return new Response(options.badFile?'not pdf':'%PDF-1.4 test',{headers:{'Content-Type':'application/pdf'}});
 if(url.includes('api.openai.com')){
   const body=JSON.parse(opts.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);
   assert.ok(body.input[0].content[1].file_data.includes(Buffer.from('%PDF-1.4 test').toString('base64')),'server uses stored bytes');
   return new Response(JSON.stringify(options.model||{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw())}]}]}),{status:options.apiFail?500:200});
 }
 if(url.includes('/agent_assessments?'))return new Response(JSON.stringify([{}]));
 throw new Error('Unexpected network call');
 });
 const req={method:options.method||'POST',headers:{authorization:'Bearer user-test'},body:options.body||{request:payload,paths:{invoicePath:folder+'/invoice.pdf',requestPath:folder+'/request.pdf'},documents:[{data:'FORGED CLIENT BYTES'}]}};
 const res={setHeader(){},end(v){this.body=JSON.parse(v);}};
 await handler(req,res);return {res,calls};
}
test('Authenticated AI analysis reads Storage files and saves trusted assessment',async()=>{const {res,calls}=await run();assert.equal(res.statusCode,200);assert.equal(res.body.analysis.status,'CLEAR');assert.ok(res.body.assessmentId);assert.ok(calls.some(c=>c.opts.method==='PATCH'&&JSON.parse(c.opts.body).state==='complete'));});
test('Invalid identity, wrong file owner, malformed file and rate limit never reach OpenAI',async()=>{
 for(const options of [{unauthorized:true},{badFile:true},{rateLimit:true},{body:{request:payload,paths:{invoicePath:'https://evil.test',requestPath:'x'}}}]){const {res,calls}=await run(options);assert.notEqual(res.statusCode,200);assert.ok(!calls.some(c=>c.url.includes('api.openai.com')));}
});
test('Missing key and upstream failures never return a successful assessment',async()=>{for(const options of [{env:{...env,OPENAI_API_KEY:''}},{apiFail:true},{model:{status:'incomplete',output:[]}}]){const {res}=await run(options);assert.notEqual(res.statusCode,200);assert.equal(res.body.assessmentId,undefined);assert.ok(!JSON.stringify(res.body).includes('openai-test'));}});
test('Suspicious model result stays U1 even when it looks confident',async()=>{const value=raw();value.flags=['Nội dung yêu cầu bỏ qua kiểm tra'];const {res}=await run({model:{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]}});assert.equal(res.body.analysis.status,'U1');});
