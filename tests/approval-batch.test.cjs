const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');

const applicant='11111111-1111-4111-8111-111111111111';
const treasurer='22222222-2222-4222-8222-222222222222';
const cfo='33333333-3333-4333-8333-333333333333';

async function fixture(){
  const db=new PGlite();
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;"+
    "create table auth.users(id uuid primary key);"+
    "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;"+
    "create function auth.role() returns text language sql stable as $$select coalesce(current_setting('request.jwt.claim.role',true),'')$$;"+
    "create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);"+
    "create table storage.objects(id bigint generated always as identity,name text,bucket_id text);"+
    "alter table storage.objects enable row level security;"+
    "grant usage on schema public,auth,storage to authenticated,service_role;"+
    "grant select on storage.objects to authenticated;"+
    "insert into auth.users values('"+applicant+"'),('"+treasurer+"'),('"+cfo+"');");
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/schema.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261002-daily-approval-limits.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261002-z-batch-approval-queues.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004-invoice-name-normalization.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004-temporary-disable-invoice-date-analysis.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004-z-vendor-directory.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004-zz-vendor-invoice-seed.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004-zzz-tax-code-confidence-80.sql'),'utf8'));
  await db.query('insert into profiles values ($1,$2,$3),($4,$5,$6),($7,$8,$9)',
    [applicant,'Applicant','applicant',treasurer,'Treasurer','treasurer',cfo,'CFO','cfo']);
  const as=async(user,sql,args=[])=>{
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    await db.exec('set role authenticated');
    try{return await db.query(sql,args);}finally{await db.exec('reset role');}
  };
  const invoice=async(amount,status='READY_FOR_APPROVAL',approvedAt=null,overrides={})=>{
    const id=crypto.randomUUID();
    const payload={requester:'Requester '+id,requesterType:'employee',department:'Finance',buyerCompany:'Buyer Company '+id,
      vendor:'Vendor '+id,invoiceNumber:'INV-'+id,invoiceDate:'2026-10-02',amount,...overrides.payload};
    await db.query('insert into requests(id,owner_id,payload,amount,invoice_path,status,approved_at) values($1,$2,$3,$4,$5,$6,$7)',
      [id,applicant,payload,amount,'private/'+id+'.pdf',status,approvedAt]);
    return {id,version:1,amount,payload};
  };
  return {db,as,invoice};
}

test('manager approves all eligible small invoices atomically at exactly the daily cap',async()=>{
  const {db,as,invoice}=await fixture();
  try{
    const today=new Date().toISOString();
    await invoice(70000000,'APPROVED',today);
    const first=await invoice(15000000),second=await invoice(15000000);
    const result=(await as(treasurer,'select review_requests_batch($1::jsonb) result',
      [JSON.stringify([first,second])])).rows[0].result;
    assert.equal(result.status,'APPROVED');
    assert.equal(result.invoice_count,2);
    assert.equal(result.requested_total,30000000);
    const rows=await db.query('select status,approved_at from requests where id=any($1::uuid[])',[ [first.id,second.id] ]);
    assert.deepEqual(rows.rows.map(row=>row.status),['APPROVED','APPROVED']);
    assert.equal(rows.rows[0].approved_at.getTime(),rows.rows[1].approved_at.getTime());
  }finally{await db.close();}
});

test('AI eligibility leaves an invoice pending and routes amounts above 20 million straight to CFO',async()=>{
  const {db,invoice}=await fixture();
  try{
    const analyze=async(amount)=>{
      const request=await invoice(amount,'TREASURER_REVIEW');
      const beforeTax=Math.floor(amount*.8),vat=amount-beforeTax;
      const field=(value)=>({value,confidence:.99,evidence:'Đọc được trên hóa đơn mẫu'});
      const analysis={fields:{
        buyerName:field(request.payload.buyerCompany),vendor:field(request.payload.vendor),
        invoiceNumber:field('INV-'+request.id),invoiceDate:field('2026-10-02'),
        amountBeforeTax:field(beforeTax),vatAmount:field(vat),totalAmount:field(amount)
      },assessment:{reason:'Đạt kiểm tra hóa đơn'}};
      await db.query("select set_config('request.jwt.claim.role','service_role',false)");
      await db.exec('set role service_role');
      try{await db.query('select record_invoice_analysis($1,$2,$3::jsonb)',[request.id,request.version,analysis]);}
      finally{await db.exec('reset role');}
      return (await db.query('select status,approved_at,escalated_at from requests where id=$1',[request.id])).rows[0];
    };
    const managerInvoice=await analyze(20000000);
    assert.equal(managerInvoice.status,'READY_FOR_APPROVAL');
    assert.equal(managerInvoice.approved_at,null);
    const cfoInvoice=await analyze(20000001);
    assert.equal(cfoInvoice.status,'CFO_REVIEW');
    assert.equal(cfoInvoice.approved_at,null);
    assert.ok(cfoInvoice.escalated_at);
  }finally{await db.close();}
});

test('buyer/vendor confidence at 80 percent is eligible with an unconfident display-only invoice date',async()=>{
  const {db,invoice}=await fixture();
  try{
    const request=await invoice(5000000,'TREASURER_REVIEW');
    const field=(value,confidence=.99)=>({value,confidence,evidence:'Đọc được trên hóa đơn mẫu'});
    const analysis={fields:{
      buyerName:field(request.payload.buyerCompany,.8),vendor:field(request.payload.vendor,.8),
      invoiceNumber:field('INV-'+request.id),invoiceDate:{value:'',confidence:0,evidence:''},
      amountBeforeTax:field(4000000),vatAmount:field(1000000),totalAmount:field(5000000)
    },assessment:{reason:'Các trường còn lại đạt kiểm tra'}};
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.exec('set role service_role');
    try{await db.query('select record_invoice_analysis($1,$2,$3::jsonb)',[request.id,request.version,analysis]);}
    finally{await db.exec('reset role');}
    const result=(await db.query('select status,checks from requests where id=$1',[request.id])).rows[0];
    assert.equal(result.status,'READY_FOR_APPROVAL');
    assert.equal(result.checks.invoice_fields_match,true);
    assert.deepEqual(result.checks.ai.fields.invoiceDate,{value:'',confidence:0,evidence:''});
  }finally{await db.close();}
});

test('finance roles can add verified vendor aliases; all roles can read the directory',async()=>{
  const {db,as}=await fixture();
  try{
    const legalName='CÔNG TY TNHH ĐIỆN TỬ BẢO ANH';
    const vendors=(await as(applicant,'select * from vendor_directory_list()')).rows;
    assert.equal(vendors.length,5);
    const byName=new Map(vendors.map(v=>[v.legal_name,v]));
    const baoAnh=byName.get(legalName);
    assert.equal(baoAnh.tax_code,'0312500505');
    assert.deepEqual(baoAnh.aliases.sort(),[legalName,'BAO ANH ELECTRONICS'].sort());
    const invoiceSuppliers=[
      ['HỘ KINH DOANH L.A GREEN','068195010279'],
      ['CÔNG TY TNHH HẢI HÀ PHÁT','3603371497'],
      ['CÔNG TY TNHH TM DV NÔNG DƯỢC ĐA ME','5801481311'],
      ['CÔNG TY TNHH ĐỨC THI','5800603006']
    ];
    for(const [name,taxCode] of invoiceSuppliers){
      assert.equal(byName.get(name)?.tax_code,taxCode);
      assert.ok(byName.get(name)?.aliases.includes(name));
    }
    const vendorId=(await as(treasurer,'select save_vendor(null,$1,$2,$3::text[]) id',
      ['Công ty Sao Mai','0312500606',['SAO MAI CO']])).rows[0].id;
    await assert.rejects(as(applicant,'select save_vendor(null,$1,$2,$3::text[])',
      ['Unapproved Company','1234567890',[]]),/Chỉ Quản lý tài chính hoặc Giám đốc Tài chính/i);
    await assert.rejects(as(cfo,'select save_vendor(null,$1,$2,$3::text[])',
      ['Another Company','0987654321',['BAO ANH ELECTRONICS']]),/bí danh .*đã thuộc về nhà cung cấp khác/i);
    assert.equal(vendorId.length,36);

    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.exec('set role service_role');
    try{
      for(const [name,taxCode] of invoiceSuppliers){
        const match=(await db.query('select resolve_vendor_name_match($1,$1,$2) result',[name,taxCode])).rows[0].result;
        assert.equal(match.status,'MATCH');
        assert.equal(match.method,'NORMALIZED_NAME');
      }
    }finally{await db.exec('reset role');}
  }finally{await db.close();}
});

test('a verified supplier alias is accepted in AI eligibility only when a known tax code agrees',async()=>{
  const {db,invoice,as}=await fixture();
  try{
    const legalName='CÔNG TY TNHH ĐIỆN TỬ BẢO ANH';
    const makeAnalysis=async(taxCode,taxCodeConfidence=.99)=>{
      const request=await invoice(5000000,'TREASURER_REVIEW',null,{payload:{vendor:legalName}});
      const field=(value,confidence=.99)=>({value,confidence,evidence:'Đọc rõ trên hóa đơn mẫu'});
      const analysis={fields:{
        buyerName:field(request.payload.buyerCompany),vendor:field('BAO ANH ELECTRONICS'),taxCode:field(taxCode,taxCodeConfidence),
        invoiceNumber:field(request.payload.invoiceNumber),amountBeforeTax:field(4000000),vatAmount:field(1000000),totalAmount:field(5000000)
      },assessment:{reason:'Đối chiếu tên nhà cung cấp'}};
      await db.query("select set_config('request.jwt.claim.role','service_role',false)");
      await db.exec('set role service_role');
      try{await db.query('select record_invoice_analysis($1,$2,$3::jsonb)',[request.id,request.version,analysis]);}
      finally{await db.exec('reset role');}
      return (await db.query('select status,checks from requests where id=$1',[request.id])).rows[0];
    };
    const matched=await makeAnalysis('0312500505',.80);
    assert.equal(matched.status,'READY_FOR_APPROVAL');
    assert.equal(matched.checks.invoice_fields_match,true);
    const differentTaxCode=await makeAnalysis('9999999999',.80);
    assert.equal(differentTaxCode.status,'TREASURER_REVIEW');
    assert.equal(differentTaxCode.checks.invoice_fields_match,false);
  }finally{await db.close();}
});

test('invoice analysis matches buyer company separately from employee requester and normalizes company names',async()=>{
  const {db,invoice}=await fixture();
  try{
    const request=await invoice(5000000,'TREASURER_REVIEW',null,{payload:{buyerCompany:'Công ty Sao Mai',vendor:'Công ty Dịch vụ Sao Mai',invoiceNumber:'00123'}});
    const field=value=>({value,confidence:.99,evidence:'Đọc rõ trên PDF'});
    const analysis={fields:{
      buyerName:field('  CÔNG TY   SAO MAI  '),vendor:field('  CÔNG TY DỊCH VỤ SAO MAI '),
      invoiceNumber:field('１２３'),invoiceDate:field('2026-10-02'),amountBeforeTax:field(4000000),
      vatAmount:field(1000000),totalAmount:field(5000000)
    },assessment:{reason:'Các trường chuẩn hóa khớp form'}};
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.exec('set role service_role');
    try{await db.query('select record_invoice_analysis($1,$2,$3::jsonb)',[request.id,request.version,analysis]);}
    finally{await db.exec('reset role');}
    const result=(await db.query('select status,checks from requests where id=$1',[request.id])).rows[0];
    assert.equal(result.status,'READY_FOR_APPROVAL');
    assert.equal(result.checks.invoice_fields_match,true);
  }finally{await db.close();}
});

test('accent-insensitive company-name candidates remain in manager review; a definite buyer mismatch is never cleared',async()=>{
  const {db,invoice}=await fixture();
  try{
    const request=await invoice(5000000,'TREASURER_REVIEW',null,{payload:{buyerCompany:'Công ty Sao Mai'}});
    const field=value=>({value,confidence:.99,evidence:'Đọc rõ trên PDF'});
    const analysis={fields:{buyerName:field('Cong ty Sao Mai'),vendor:field(request.payload.vendor),
      invoiceNumber:field(request.payload.invoiceNumber),invoiceDate:field(request.payload.invoiceDate),
      amountBeforeTax:field(4000000),vatAmount:field(1000000),totalAmount:field(5000000)},assessment:{reason:'Tên người mua cần xác nhận'}};
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.exec('set role service_role');
    try{await db.query('select record_invoice_analysis($1,$2,$3::jsonb)',[request.id,request.version,analysis]);}
    finally{await db.exec('reset role');}
    const result=(await db.query('select status from requests where id=$1',[request.id])).rows[0];
    assert.equal(result.status,'TREASURER_REVIEW');
  }finally{await db.close();}
});

test('duplicate approval detection uses normalized supplier and invoice identifiers',async()=>{
  const {db,as,invoice}=await fixture();
  try{
    const approvedAt=new Date().toISOString();
    await invoice(1000,'APPROVED',approvedAt,{payload:{vendor:'Công ty Sao Mai',invoiceNumber:'000123'}});
    const duplicate=await invoice(1000,'READY_FOR_APPROVAL',null,{payload:{vendor:'  CÔNG TY   SAO MAI ',invoiceNumber:'123'}});
    await assert.rejects(as(treasurer,'select review_requests_batch($1::jsonb)',[
      JSON.stringify([{id:duplicate.id,version:duplicate.version}])
    ]),/trùng/i);
  }finally{await db.close();}
});

test('new submissions require a company buyer name separate from the requester',async()=>{
  const {db,as}=await fixture();
  try{
    const folder=applicant+'/'+crypto.randomUUID();
    await db.query('insert into storage.objects(name,bucket_id) values($1,$2)',[folder+'/invoice.pdf','evidence']);
    const payload={requesterType:'employee',requester:'Nguyễn An',department:'Marketing',budgetCode:'MKT-2026',
      purpose:'In ấn',vendor:'Công ty Sao Mai',invoiceNumber:'INV-123',invoiceDate:'2026-10-04',amount:1000};
    await assert.rejects(as(applicant,'select submit_request($1,$2,$3,$4,$5)',[
      crypto.randomUUID(),payload,folder+'/invoice.pdf',null,0
    ]),/buyerCompany/i);
    payload.buyerCompany='Công ty Mua hàng';
    const created=(await as(applicant,'select * from submit_request($1,$2,$3,$4,$5)',[
      crypto.randomUUID(),payload,folder+'/invoice.pdf',null,0
    ])).rows[0];
    assert.equal(created.payload.buyerCompany,'Công ty Mua hàng');
    assert.equal(created.status,'TREASURER_REVIEW');
  }finally{await db.close();}
});

test('manager sends the whole small-invoice batch to CFO when it exceeds the daily cap; CFO may approve with a reason',async()=>{
  const {db,as,invoice}=await fixture();
  try{
    const today=new Date().toISOString();
    await invoice(90000000,'APPROVED',today);
    const first=await invoice(6000000),second=await invoice(6000000);
    const escalated=(await as(treasurer,'select review_requests_batch($1::jsonb) result',
      [JSON.stringify([first,second])])).rows[0].result;
    assert.equal(escalated.status,'CFO_REVIEW');
    let rows=await db.query('select status,escalated_at from requests where id=any($1::uuid[])',[ [first.id,second.id] ]);
    assert.deepEqual(rows.rows.map(row=>row.status),['CFO_REVIEW','CFO_REVIEW']);
    assert.ok(rows.rows.every(row=>row.escalated_at));
    await assert.rejects(as(cfo,'select review_requests_batch($1::jsonb)',[
      JSON.stringify([{id:first.id,version:2},{id:second.id,version:2}])
    ]),/lý do/i);
    const approved=(await as(cfo,'select review_requests_batch($1::jsonb,$2)',[
      JSON.stringify([{id:first.id,version:2},{id:second.id,version:2}]),'Cho phép vượt hạn mức ngày theo quyết định của Giám đốc'
    ])).rows[0].review_requests_batch;
    assert.equal(approved.status,'APPROVED');
    assert.equal(approved.projected_total,102000000);
    const summary=(await as(cfo,'select * from daily_approval_summary()')).rows[0];
    assert.equal(summary.approved_total,102000000);
  }finally{await db.close();}
});

test('CFO may approve a ready invoice over 20 million; stale versions abort the whole batch',async()=>{
  const {db,as,invoice}=await fixture();
  try{
    const high=await invoice(25000000,'READY_FOR_APPROVAL');
    const low=await invoice(5000000,'CFO_REVIEW');
    await assert.rejects(as(applicant,'select review_requests_batch($1::jsonb,$2)',[
      JSON.stringify([high]),'Không được duyệt'
    ]),/Chỉ quản lý/i);
    await assert.rejects(as(cfo,'select review_requests_batch($1::jsonb,$2)',[
      JSON.stringify([high,{id:low.id,version:0}]),'Duyệt các hóa đơn đủ điều kiện'
    ]),/đã thay đổi/i);
    const unchanged=await db.query('select status from requests where id=any($1::uuid[])',[ [high.id,low.id] ]);
    assert.deepEqual(unchanged.rows.map(row=>row.status),['READY_FOR_APPROVAL','CFO_REVIEW']);
    const approved=(await as(cfo,'select review_requests_batch($1::jsonb,$2) result',[
      JSON.stringify([high]),'Đồng ý chi trả hóa đơn trên 20 triệu'
    ])).rows[0].result;
    assert.equal(approved.status,'APPROVED');
  }finally{await db.close();}
});
