// Optional acceptance test against your configured Supabase project.
// Creates labelled test requests and evidence; it does not delete business records.
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');const Api=require('../api.js');
const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
async function main(){
  const text=fs.readFileSync(path.resolve(__dirname,'../.local/accounts.txt'),'utf8');
  const credentials=[...text.matchAll(/Project: (.+)\nEmail: (.+)\nRole: (.+)\nPassword: (.+)/g)].map(m=>({url:m[1].trim(),email:m[2].trim(),role:m[3].trim(),password:m[4].trim()}));
  const config={supabaseUrl:process.env.SUPABASE_URL,supabaseAnonKey:process.env.SUPABASE_ANON_KEY};
  if(!config.supabaseUrl||!config.supabaseAnonKey)throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY first.');
  const clients={};const profiles={};
  for(const role of ['applicant','treasurer','cfo']){
    const c=credentials.findLast(c=>c.role===role&&c.url===config.supabaseUrl);
    if(!c)throw new Error('Missing local credentials for '+role);
    const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
    clients[role]=new Api(config,storage); profiles[role]=await clients[role].login(c.email,c.password);
    assert.equal(profiles[role].role,role);
  }
  const {applicant,treasurer,cfo}=clients;
  async function submit(amount,id=randomUUID(),version=0){
    const folder=profiles.applicant.id+'/'+randomUUID();
    const body=new Blob(['%PDF-1.4\n% Synthetic test fixture; no genuine invoice\n%%EOF'],{type:'application/pdf'});
    await applicant.upload(folder+'/invoice.pdf',body);await applicant.upload(folder+'/request.pdf',body);
    return applicant.rpc('submit_request',{p_id:id,p_expected_version:version,p_invoice_path:folder+'/invoice.pdf',p_request_path:folder+'/request.pdf',p_payload:{requesterType:'employee',requester:'TEST ONLINE',department:'TEST',budgetCode:'MKT-OPS-2026',category:'printing',purpose:'TEST ONLY - synthetic evidence',vendor:'TEST',invoiceNumber:randomUUID(),invoiceDate:new Date().toISOString().slice(0,10),invoiceType:'paper',amount}});
  }
  const review=(client,r,action='resolve',checks=all,reason='TEST: đã kiểm tra và trả lời câu hỏi')=>client.rpc('review_request',{p_id:r.id,p_expected_version:r.version,p_action:action,p_checks:checks,p_reason:reason});
  let r=await submit(20000000);assert.equal(r.status,'TREASURER_REVIEW');
  assert.ok(!(await cfo.list()).some(x=>x.id===r.id),'CFO must not see un-escalated requests');
  await assert.rejects(review(cfo,r));await assert.rejects(review(applicant,r));
  await assert.rejects(applicant.request('/rest/v1/profiles?id=eq.'+profiles.applicant.id,{method:'PATCH',body:JSON.stringify({role:'cfo'})}));
  await assert.rejects(applicant.request('/rest/v1/requests?id=eq.'+r.id,{method:'PATCH',body:JSON.stringify({status:'APPROVED'})}));
  await assert.rejects(cfo.signedUrl(r.invoice_path));
  await assert.rejects(review(treasurer,r,'approve',{...all,stamp:false}));
  await assert.rejects(review(treasurer,r,'resolve',{...all,match:false},'TEST chưa giải quyết nghi vấn'));
  const race=await Promise.allSettled([review(treasurer,r),review(treasurer,r)]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'Only one reviewer decision may commit');
  assert.equal(race.find(x=>x.status==='fulfilled').value.status,'APPROVED');
  r=await submit(20000001);r=await review(treasurer,r);assert.equal(r.status,'CFO_REVIEW');
  assert.ok((await cfo.list()).some(x=>x.id===r.id));await cfo.signedUrl(r.invoice_path);
  r=await review(cfo,r,'approve',all,'TEST: đồng ý khoản vượt quyền');assert.equal(r.status,'APPROVED');
  const logs=await applicant.audit(r.id);assert.ok(logs.length>=3);assert.equal(logs[0].actor_role,'cfo');
  r=await submit(5000000);r=await review(treasurer,r,'clarify',{},'TEST: bổ sung dấu đỏ.');assert.equal(r.status,'NEEDS_INFO');
  r=await submit(5000000,r.id,r.version);assert.equal(r.status,'TREASURER_REVIEW');
  r=await review(treasurer,r,'reject',{},'TEST: từ chối hồ sơ mẫu.');assert.equal(r.status,'REJECTED');
  await assert.rejects(review(treasurer,r));
  console.log('PASS: role isolation, private evidence, U1/U2, 20m boundary, race, escalation, supplementation and audit.');
  for(const client of Object.values(clients)) await client.logout();
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
