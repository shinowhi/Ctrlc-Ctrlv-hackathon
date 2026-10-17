const test=require('node:test'),assert=require('node:assert/strict');
const {createFreshDatabase}=require('./helpers/fresh-database.cjs');
const {readForm,minimalSummary}=require('../shared/private-intake');
const {assess}=require('../api/analyze-evidence');
test('private intake stores exact currency cents without identities and blocks unconverted FX approval',async()=>{
 const user='11111111-1111-4111-8111-111111111111',db=await createFreshDatabase([user]);
 try{
 await db.query('insert into profiles values($1,$2,$3)',[user,'Applicant','applicant']);
 const path=user+'/22222222-2222-4222-8222-222222222222/invoice.pdf';
 await db.query('insert into storage.objects(name,bucket_id) values($1,$2)',[path,'evidence']);
 const payload={requesterType:'employee',requester:'PRIVATE NAME',department:'PRIVATE DEPT',buyerMode:'PERSON',buyerCompany:'李明',budgetCode:'PRIVATE',purpose:'PRIVATE PURPOSE',vendor:'测试电子有限公司',invoiceNumber:'26000000000025988000',invoiceDate:'2026-07-10',currency:'CNY',amount:51.94};
 const form=readForm({id:crypto.randomUUID(),expectedVersion:0,payload});
 const money=value=>({value,confidence:.99,evidence:String(value)+' CNY',currency:'CNY'});
 const extraction={fields:{invoiceKind:{value:'VAT',confidence:.99,evidence:'VAT'},invoiceDate:{value:'2026-07-10'},totalAmount:money(51.94),amountBeforeTax:money(47.22),vatAmount:money(4.72),discountAmount:money(0),amountDue:money(0)}};
 const summary=minimalSummary(form,extraction,assess({payload:form,amount:form.amount},extraction));
 assert.equal(summary.currency,'CNY');assert.equal(summary.totalsConsistent,true);
 assert.ok(!JSON.stringify(summary).includes('PRIVATE'));assert.ok(!JSON.stringify(summary).includes('26000000000025988000'));
 await db.exec('set role service_role');
 const submit=async(s)=>(await db.query('select * from submit_private_request($1,$2,0,$3,$4::jsonb)',[crypto.randomUUID(),user,path,JSON.stringify(s)])).rows[0];
 const r=await submit({...summary,requester:'SENSITIVE',evidence:'SENSITIVE'});
 assert.equal(Number(r.amount),51.94);assert.equal(r.payload.amount,51.94);assert.equal(r.payload.currency,'CNY');assert.equal(r.checks.ai.fields.totalAmount.value,51.94);
 assert.ok(!JSON.stringify(r).includes('SENSITIVE'));assert.equal(r.status,'TREASURER_REVIEW');
 assert.equal(Number((await submit({...summary,amount:.01})).amount),.01);
 const defaultCurrency={...summary,amount:52000};delete defaultCurrency.currency;
 assert.equal((await submit(defaultCurrency)).payload.currency,'VND');
 await assert.rejects(submit({...summary,amount:-1}),/Invalid amount/);
 await assert.rejects(submit({...summary,amount:51.945}),/Invalid amount/);
 await assert.rejects(submit({...summary,currency:'XYZ'}),/Invalid currency/);
 await assert.rejects(submit({...summary,currency:'VND'}),/VND/);
 await assert.rejects(db.query("update requests set status='APPROVED',approved_at=now() where id=$1",[r.id]),/Ngoại tệ cần tỷ giá/);
 await db.exec('reset role');await db.exec('set role authenticated');
 await assert.rejects(db.query('select * from submit_request($1,$2::jsonb,$3,null,0)',[crypto.randomUUID(),JSON.stringify(payload),path]),/permission denied/);
 }finally{await db.close();}
});
