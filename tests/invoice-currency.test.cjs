const test=require('node:test');
const assert=require('node:assert/strict');
const {createFreshDatabase}=require('./helpers/fresh-database.cjs');

test('invoice currency survives submission and supplementation, defaults to VND, and rejects unsupported codes',async()=>{
  const user='11111111-1111-4111-8111-111111111111';
  const db=await createFreshDatabase([user]);
  try {
    await db.query('insert into profiles values ($1,$2,$3)',[user,'Applicant','applicant']);
    const invoicePath=user+'/currency-test/invoice.pdf';
    await db.query('insert into storage.objects(name,bucket_id) values ($1,$2)',[invoicePath,'evidence']);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    await db.exec('set role authenticated');
    const submit=async(id,payload,version=0)=>(await db.query(
      'select * from public.submit_request($1,$2::jsonb,$3,null,$4)',
      [id,JSON.stringify(payload),invoicePath,version])).rows[0];
    for(const currency of ['VND','USD','CNY','EUR']) {
      const id=crypto.randomUUID();
      const row=await submit(id,{currency,amount:12345});
      assert.equal(row.payload.currency,currency);
      assert.equal(Number(row.amount),12345);
      const updated=await submit(id,{currency:'EUR',amount:12345},row.version);
      assert.equal(updated.payload.currency,'EUR');
    }
    assert.equal((await submit(crypto.randomUUID(),{})).payload.currency,'VND');
    await assert.rejects(submit(crypto.randomUUID(),{currency:'INVALID'}),/Đơn vị tiền tệ không hợp lệ/);
  } finally { await db.close(); }
});
