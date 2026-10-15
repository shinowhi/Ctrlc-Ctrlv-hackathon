const test=require('node:test');
const assert=require('node:assert/strict');
const {createFreshDatabase,migrationFiles}=require('./helpers/fresh-database.cjs');

test('PostgreSQL: fresh-install migrations expose current invoice and CFO rules',async()=>{
  const db=await createFreshDatabase();
  try{
    assert.ok(migrationFiles.includes('20261012-restore-single-buyer-name.sql'));
    assert.ok(migrationFiles.includes('20261015-cfo-read-high-value-manager-review.sql'));

    const analysis=(await db.query(
      "select pg_get_functiondef('public.record_invoice_analysis(uuid,integer,jsonb)'::regprocedure) as definition"
    )).rows[0].definition;
    assert.match(analysis,/buyerPersonName/);
    assert.match(analysis,/buyerOrganizationName/);

    const submit=(await db.query(
      "select pg_get_functiondef('public.submit_request(uuid,jsonb,text,text,integer)'::regprocedure) as definition"
    )).rows[0].definition;
    assert.match(submit,/buyerCompany/);
    assert.match(submit,/TREASURER_REVIEW/);

    const cfoRead=(await db.query(
      "select pg_get_functiondef('public.can_read_request(uuid)'::regprocedure) as definition"
    )).rows[0].definition;
    assert.match(cfoRead,/TREASURER_REVIEW/);
    assert.match(cfoRead,/20000000/);

    const approvalConstraint=await db.query(
      "select convalidated from pg_constraint where conname='requests_approval_timestamp_required' and conrelid='public.requests'::regclass"
    );
    assert.equal(approvalConstraint.rows[0]?.convalidated,true);
  }finally{
    await db.close();
  }
});
