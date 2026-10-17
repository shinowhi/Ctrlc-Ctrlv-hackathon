const test=require('node:test'),assert=require('node:assert/strict');
const {createFreshDatabase}=require('./helpers/fresh-database.cjs');
test('database preserves cents, rejects excess precision, compares decimals and blocks unconverted FX approval',async()=>{
 const user='11111111-1111-4111-8111-111111111111';const db=await createFreshDatabase([user]);
 try{
 await db.query('insert into profiles values($1,$2,$3)',[user,'Applicant','applicant']);
 const invoicePath=user+'/22222222-2222-4222-8222-222222222222/invoice.pdf';
 await db.query('insert into storage.objects(name,bucket_id) values($1,$2)',[invoicePath,'evidence']);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
 const payload={requesterType:'employee',requester:'Tester',department:'QA',buyerMode:'PERSON',buyerCompany:'李明',budgetCode:'TEST',purpose:'Test',vendor:'测试电子有限公司',invoiceNumber:'26000000000025988000',invoiceDate:'2026-07-10',currency:'CNY',amount:51.94};
 const submit=async(p)=>(await db.query('select * from submit_request($1,$2::jsonb,$3,null,0)',[crypto.randomUUID(),JSON.stringify(p),invoicePath])).rows[0];
 const r=await submit(payload);assert.equal(Number(r.amount),51.94);assert.equal(r.payload.amount,51.94);
 assert.equal(Number((await submit({...payload,amount:.01})).amount),.01);
 await assert.rejects(submit({...payload,amount:51.945}),/Số tiền/);
 await assert.rejects(submit({...payload,amount:'51,94'}),/Số tiền/);
 await assert.rejects(submit({...payload,currency:'VND'}),/VND/);
 await db.exec('reset role');await db.query("select set_config('request.jwt.claim.role','service_role',false)");await db.exec('set role service_role');
 const money=value=>({value,confidence:.99,evidence:String(value)+' CNY',currency:'CNY'});
 const fields={invoiceKind:{value:'VAT',confidence:.99,evidence:'VAT'},totalAmount:money(51.94),amountBeforeTax:money(47.22),vatAmount:money(4.72)};
 const analyzed=(await db.query('select * from record_invoice_analysis($1,$2,$3::jsonb)',[r.id,r.version,JSON.stringify({fields,assessment:{code:'CLEAR',fieldIssues:[]}})])).rows[0];
 assert.equal(analyzed.checks.ai.fields.totalAmount.value,51.94);assert.equal(analyzed.checks.invoice_totals_consistent,true);assert.equal(analyzed.status,'TREASURER_REVIEW');
 await assert.rejects(db.query("update requests set status='APPROVED',approved_at=now() where id=$1",[r.id]),/Ngoại tệ cần tỷ giá/);
 }finally{await db.close();}
});
