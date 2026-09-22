// Set PGLITE_PATH to an installed @electric-sql/pglite module (no production dependency).
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const applicant='11111111-1111-4111-8111-111111111111',treasurer='22222222-2222-4222-8222-222222222222',cfo='33333333-3333-4333-8333-333333333333';
const all={paper:true,stamp:true,signature:true,match:true};
test('PostgreSQL: auto approval, escalation, ownership, flags, reuse and budget limits',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id bigint generated always as identity,name text,bucket_id text);alter table storage.objects enable row level security;grant usage on schema public,auth,storage to authenticated,service_role;grant select on storage.objects to authenticated;
 insert into auth.users values('${applicant}'),('${treasurer}'),('${cfo}');`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/schema.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/sprint1.sql'),'utf8'));
 await db.query('insert into profiles values ($1,$2,$3),($4,$5,$6),($7,$8,$9)',[applicant,'Applicant','applicant',treasurer,'Treasurer','treasurer',cfo,'CFO','cfo']);
 const as=async(user,sql,args=[])=>{await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');try{return await db.query(sql,args);}finally{await db.exec('reset role');}};
 let seq=0;
 async function submit(amount,opts={}){
  const id=crypto.randomUUID(),folder=applicant+'/'+crypto.randomUUID();
  const payload={requesterType:'employee',requester:'TEST',department:'MKT',budgetCode:opts.budget||'MKT-OPS-2026',purpose:'In tài liệu',vendor:'TEST VENDOR',invoiceNumber:opts.invoice||'TEST-'+(++seq),invoiceDate:'2026-09-22',amount,invoiceType:'paper',category:opts.category||'printing'};
  await db.query('insert into storage.objects(name,bucket_id) values($1,$3),($2,$3)',[folder+'/invoice.pdf',folder+'/request.pdf','evidence']);
  const analysis={checks:all,flags:opts.flags||[],status:opts.flags?.length?'U1':'CLEAR',confidence:1};
  const reserve=await as(applicant,'select reserve_assessment($1,$2,$3) id',[payload,folder+'/invoice.pdf',folder+'/request.pdf']);
  const aid=reserve.rows[0].id;
  await db.query("update agent_assessments set state='complete',analysis=$2,created_at=now()-interval '2 minutes' where id=$1",[aid,analysis]);
  const args=[id,payload,folder+'/invoice.pdf',folder+'/request.pdf',0,aid];
  const row=(await as(applicant,'select * from submit_request($1,$2,$3,$4,$5,$6)',args)).rows[0];
  return {row,args,aid};
 }
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260922_ai_under_20m.sql'),'utf8'));
 let {row:r,args}=await submit(19999999);assert.equal(r.status,'APPROVED');assert.equal(r.decision_actor,'agent');
 await assert.rejects(as(applicant,'select submit_request($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),...args.slice(1)]),/đã dùng|hết hạn/);
 await assert.rejects(as(applicant,"update requests set status='APPROVED' where id=$1",[r.id]),/permission/);
 await assert.rejects(as(applicant,'select apply_referee($1)',[r.id]),/permission/);
 await assert.rejects(as(applicant,"insert into agent_assessments(owner_id,payload,invoice_path,request_path) values($1,'{}','x','y')",[applicant]),/permission/);
 ({row:r}=await submit(20000000));assert.equal(r.code,'U3');assert.equal(r.status,'CFO_REVIEW');
 assert.equal((await db.query("select committed from demo_budgets where code='MKT-OPS-2026'")).rows[0].committed,19999999);
 ({row:r}=await submit(20000001));assert.equal(r.code,'U3');assert.equal(r.status,'CFO_REVIEW');
 await assert.rejects(as(applicant,"select review_request($1,$2,'approve','yes','{}')",[r.id,r.version]),/Không có quyền/);
 r=(await as(cfo,"select * from review_request($1,$2,'approve','Đồng ý khoản vượt hạn mức','{}')",[r.id,r.version])).rows[0];assert.equal(r.status,'APPROVED');
 ({row:r}=await submit(1000,{flags:['Không đọc được số tiền']}));assert.equal(r.code,'U1');assert.notEqual(r.status,'APPROVED');
 await assert.rejects(as(treasurer,"select review_request($1,$2,'approve','yes',$3)",[r.id,r.version,all]),/giải quyết/);
 r=(await as(treasurer,"select * from review_request($1,$2,'resolve','Đã đối chiếu bản gốc số tiền 1000',$3)",[r.id,r.version,all])).rows[0];assert.equal(r.status,'APPROVED');
 ({row:r}=await submit(1000,{category:'other'}));assert.equal(r.code,'U2');assert.match(r.question,/ngoại lệ/);
 r=(await as(cfo,"select * from review_request($1,$2,'approve','Chấp nhận ngoại lệ cho ca mẫu','{}')",[r.id,r.version])).rows[0];assert.equal(r.status,'APPROVED');
 const first=await submit(1000,{invoice:'DUP'});({row:r}=await submit(1000,{invoice:'DUP'}));assert.equal(first.row.status,'APPROVED');assert.equal(r.code,'U1');assert.match(r.question,/đã có/);
 await db.exec("update demo_budgets set committed=ceiling-10 where code='MKT-OPS-2026'");
 ({row:r}=await submit(11));assert.equal(r.code,'U2');assert.match(r.question,/còn 10/);
  const logs=await as(applicant,'select * from audit_events where request_id=$1',[r.id]);assert.ok(logs.rows.length>0);
  // An assessment cannot approve modified form values, another user's files, or after expiry.
  const source=await submit(1,{budget:'HR-2026',category:'training'});
  await db.query('update agent_assessments set used_at=null where id=$1',[source.aid]);
  const forged=[crypto.randomUUID(),{...source.args[1],amount:2},...source.args.slice(2)];
  await assert.rejects(as(applicant,'select * from submit_request($1,$2,$3,$4,$5,$6)',forged),/không khớp/);
  await assert.rejects(as(treasurer,'select * from submit_request($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),...source.args.slice(1)]),/không khớp/);
  await db.query("update agent_assessments set expires_at=now()-interval '1 second' where id=$1",[source.aid]);
  await assert.rejects(as(applicant,'select * from submit_request($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),...source.args.slice(1)]),/hết hạn/);
  const requestArgs=[source.args[1],source.args[2],source.args[3]];
  for(let i=0;i<6;i++)await as(applicant,'select reserve_assessment($1,$2,$3)',requestArgs);
  await assert.rejects(as(applicant,'select reserve_assessment($1,$2,$3)',requestArgs),/6 lượt/);
  await assert.rejects(as(treasurer,"select review_request($1,$2,'resolve','Stale',$3)",[r.id,r.version-1,all]),/đã thay đổi/);
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/rollback-sprint1.sql'),'utf8'));
  assert.ok((await db.query('select count(*) from requests')).rows[0].count>0,'rollback preserves business rows');
 }finally{await db.close();}
});
