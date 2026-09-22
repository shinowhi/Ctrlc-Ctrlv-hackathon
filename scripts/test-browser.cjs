// Real browser + PostgreSQL WASM; external Supabase/OpenAI network is simulated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {PGlite}=require('@electric-sql/pglite');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {normalizeAnalysis}=require('../ai');
const root=path.resolve(__dirname,'..');
async function main(){
 const db=new PGlite();let browser,server;const errors=[];
 const ids={applicant:'11111111-1111-4111-8111-111111111111',treasurer:'22222222-2222-4222-8222-222222222222',cfo:'33333333-3333-4333-8333-333333333333'};
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(name text,bucket_id text);alter table storage.objects enable row level security;grant usage on schema public,auth,storage to authenticated;grant select on storage.objects to authenticated;`);
 await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));await db.exec(fs.readFileSync(path.join(root,'supabase/sprint1.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20260922_ai_under_20m.sql'),'utf8'));
 for(const [role,id] of Object.entries(ids)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into profiles values($1,$2,$3)',[id,role,role]);}
 let gate=Promise.resolve();
 function locked(fn){const next=gate.then(fn);gate=next.catch(()=>{});return next;}
 async function as(role,sql,params=[]){return locked(async()=>{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[role]]);await db.exec('set role authenticated');try{return (await db.query(sql,params)).rows;}finally{await db.exec('reset role');}});}
 server=http.createServer((req,res)=>{const file=new URL(req.url,'http://local').pathname.slice(1)||'index.html';if(!['index.html','app.js','api.js','rules.js','verify-ui.js','styles.css','config.js','demo.html','demo.js'].includes(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(file==='config.js'?'window.FINREF_CONFIG={supabaseUrl:"https://test.supabase.co",supabaseAnonKey:"sb_publishable_test"};':fs.readFileSync(path.join(root,file)));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 let aiFlags=[],aiFailure=false;
 await page.route('https://test.supabase.co/**',async route=>{
  const req=route.request(),u=new URL(req.url()),role=(req.headers().authorization||'Bearer applicant').replace('Bearer ','');
  let data,status=200;
  try{
   if(u.pathname==='/auth/v1/token'){const login=req.postDataJSON().email.split('@')[0];data={access_token:login,refresh_token:login,expires_in:3600};}
   else if(u.pathname==='/auth/v1/user')data={id:ids[role]};
   else if(u.pathname==='/auth/v1/logout')data={};
   else if(u.pathname==='/rest/v1/profiles')data=await as(role,'select * from profiles');
   else if(u.pathname==='/rest/v1/requests')data=await as(role,'select * from requests order by created_at desc');
   else if(u.pathname==='/rest/v1/audit_events')data=await as(role,'select * from audit_events where request_id=$1 order by id desc',[u.searchParams.get('request_id').slice(3)]);
   else if(u.pathname.startsWith('/rest/v1/rpc/')){
    const b=req.postDataJSON();if(u.pathname.endsWith('submit_request'))data=(await as(role,'select * from submit_request($1,$2,$3,$4,$5,$6)',[b.p_id,b.p_payload,b.p_invoice_path,b.p_request_path,b.p_expected_version,b.p_agent_assessment_id]))[0];
    else data=(await as(role,'select * from review_request($1,$2,$3,$4,$5)',[b.p_id,b.p_expected_version,b.p_action,b.p_reason,b.p_checks]))[0];
   }else if(u.pathname.startsWith('/storage/v1/object/evidence/')){await locked(()=>db.query('insert into storage.objects values($1,$2)',[decodeURIComponent(u.pathname.split('/evidence/')[1]),'evidence']));data={};}
   else throw new Error('Unhandled route '+u.pathname);
  }catch(e){status=400;data={message:e.message};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.route('**/api/analyze-evidence',async route=>{
   if(aiFailure){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'AI test outage'})});return;}
   const b=route.request().postDataJSON();const p=b.request;const doc={amount:p.amount,vendor:p.vendor,invoiceNumber:p.invoiceNumber,invoiceDate:p.invoiceDate,paper:true,readable:true,stamp:true,signature:true};
   const analysis=normalizeAnalysis({invoice:{...doc,documentKind:'invoice'},request:{...doc,documentKind:'request'},category:p.category,confidence:0.99,flags:aiFlags},p);
   const aid=(await as('applicant','select reserve_assessment($1,$2,$3) id',[p,b.paths.invoicePath,b.paths.requestPath]))[0].id;
   await locked(()=>db.query("update agent_assessments set state='complete',analysis=$2,created_at=now()-interval '2 minutes' where id=$1",[aid,analysis]));
   await route.fulfill({contentType:'application/json',body:JSON.stringify({analysis,assessmentId:aid})});
 });
 async function login(role){await page.goto(origin);await page.locator('#email').fill(role+'@test.local');await page.locator('#password').fill('test-only');await page.locator('#loginForm button').click();await page.locator('#appShell').waitFor({state:'visible'});}
 let seq=0;
 async function submit(amount,category='printing'){
   await page.locator('#requester').fill('TEST');await page.locator('#department').fill('MKT');await page.locator('#purpose').fill('In tài liệu thử nghiệm');await page.locator('#vendor').fill('TEST Vendor');await page.locator('#invoiceNumber').fill('UI-'+(++seq));await page.locator('#invoiceDate').fill('2026-09-22');await page.locator('#amount').fill(String(amount));await page.locator('#category').selectOption(category);
   for(const id of ['invoiceFile','requestFile'])await page.locator('#'+id).setInputFiles({name:id+'.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 TEST')});
   await page.locator('#paperConfirm').check();await page.locator('#submitButton').click();await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('Đã gửi:'));await page.locator('#decisionResult .decision-banner').waitFor();
   return await page.locator('#decisionResult').innerText();
 }
 await login('applicant');assert.match(await submit(12500000),/Đã duyệt/);assert.match(await submit(19999999),/Đã duyệt/);assert.match(await submit(20000000),/U3/);
 assert.match(await submit(20000001),/U3/);
 await page.locator('#logoutButton').click();await login('cfo');await page.locator('#queueBody button').first().click();await page.locator('#reviewReason').fill('Đồng ý khoản vượt quyền trong demo');await page.locator('[data-action="approve"]').click();await page.waitForFunction(()=>document.getElementById('decisionResult').textContent.includes('Đã duyệt'));
 await page.locator('#logoutButton').click();await login('applicant');aiFlags=['Số tiền trên hóa đơn chưa đọc rõ'];assert.match(await submit(1000),/U1/);await page.locator('#supplementButton').click();aiFlags=[];assert.match(await submit(1000),/Đã duyệt/);
 assert.match(await submit(1000,'other'),/U2/);
 aiFailure=true;assert.match(await submit(1000),/U1/);assert.match(await page.locator('#message').innerText(),/AI test outage/);
 await page.locator('#logoutButton').click();await login('treasurer');await page.locator('#queueBody button').first().click();await page.locator('#reviewReason').fill('Đã đối chiếu chứng từ gốc trong ca kiểm thử');for(const input of await page.locator('#reviewForm input').all())await input.check();await page.locator('[data-action="approve"]').click();await page.waitForFunction(()=>document.getElementById('decisionResult').textContent.includes('Đã duyệt'));
 await page.locator('.verification summary').click();await page.locator('#verifyButton').click();assert.match(await page.locator('#verifyResult').innerText(),/5\/5 PASS · 2 tự xử lý · 3 chuyển tiếp/);await page.locator('#verifyAll').click();assert.match(await page.locator('#verifyResult').innerText(),/15\/15 PASS/);
 for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'online overflow '+width);}
 await page.goto(origin+'/demo.html');await page.locator('[data-enter-role="applicant"]').click();await page.locator('#verifyButton').click();assert.match(await page.locator('#verifyResult').innerText(),/5\/5 PASS/);
 await page.locator('#hasStamp').uncheck();await page.locator('#paymentForm button[type="submit"]').click();await page.locator('[data-action="supplement"]').click();await page.locator('#hasStamp').check();await page.locator('#paymentForm button[type="submit"]').click();assert.match(await page.locator('#decisionResult').innerText(),/Đã duyệt/);
 if(process.env.QA_SCREENSHOT)await page.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS browser: auto <20m, exactly 20m escalates, U1 supplement, U2, U3 + CFO approval, AI outage, manual resolution, Verify 5/15, four widths, zero page errors.');
 }finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
