const test=require('node:test'),assert=require('node:assert/strict');
const {selectivePlan,sanitizedForm}=require('../shared/invoice-redaction');
const {rasterPdf}=require('../shared/private-intake');
const {deflateSync,inflateSync}=require('node:zlib');
const polygon=(x,y,w=30)=>[x,y,x+w,y,x+w,y+3,x,y+3];
function fixture(){
 const rows=[['Tên nhà cung cấp: Công ty Hoa Mai',5,5],['Tên người mua: Nguyễn An',5,12],['Mã số thuế: 1234567890',5,19],['Địa chỉ: 12 Đường Hoa, Quận 1',5,26],['Số hóa đơn: INV-12345',5,33],['Điện thoại: 0901234567',5,40],['Nội dung: Mua thiết bị',5,47],['Tổng tiền: 51.94 CNY',5,54],['Email: an@example.test',5,61],['Tài khoản: 9988776655',5,68]];
 const lines=rows.map(([content,x,y])=>({content,polygon:polygon(x,y)}));
 return {analyzeResult:{documents:[{fields:{VendorTaxId:{content:'1234567890',valueString:'1234567890',boundingRegions:[{pageNumber:1,polygon:polygon(5,19)}]},InvoiceId:{content:'INV-12345',valueString:'INV-12345',boundingRegions:[{pageNumber:1,polygon:polygon(5,33)}]}}}],pages:[{pageNumber:1,width:100,height:100,unit:'pixel',angle:0,lines,words:lines.map(x=>({...x,confidence:.99}))}]}};
}
const covered=(boxes,x,y)=>boxes.some(b=>x>b[0]&&x<b[2]&&y>b[1]&&y<b[3]);
test('selective masks preserve names, phone, account, email, items and totals; mask only restricted rows and QR',()=>{
 const result=fixture(),pages=selectivePlan(result,[{width:100,height:100}],{invoiceNumber:'INV-12345'},{},[[[.7,.7,.9,.9]]]);
 for(const y of [.20,.27,.34])assert.ok(covered(pages[0].rectangles,.1,y));
 for(const y of [.06,.13,.41,.48,.55,.62,.69])assert.ok(!covered(pages[0].rectangles,.1,y));
 assert.ok(covered(pages[0].rectangles,.8,.8));
});
test('layout fallback with empty fields uses multilingual labels without blanket masking',()=>{
 const r=fixture();r.analyzeResult.documents[0].fields={};
 r.analyzeResult.pages[0].lines[2].content='纳税人识别号：1234567890';
 r.analyzeResult.pages[0].lines[3].content='地址：12 Main Road';
 r.analyzeResult.pages[0].lines[4].content='发票号码：INV-12345';
 const boxes=selectivePlan(r,[{width:100,height:100}])[0].rectangles;
 for(const y of [.20,.27,.34])assert.ok(covered(boxes,.1,y));
 assert.ok(!covered(boxes,.1,.55));
});
test('field regions without geometry fail closed and malformed coordinates are rejected',()=>{
 const r=fixture();delete r.analyzeResult.documents[0].fields.VendorTaxId.boundingRegions;
 assert.throws(()=>selectivePlan(r,[{width:100,height:100}]),/Thiếu vị trí/);
 const bad=fixture();bad.analyzeResult.pages[0].words[0].polygon[0]=-1;
 assert.throws(()=>selectivePlan(bad,[{width:100,height:100}]),/Vị trí/);
});
test('free-text form removes known forbidden values and labelled data but retains allowed names',()=>{
 const result=fixture();
 const form={requester:'Nguyễn An',vendor:'Công ty Hoa Mai',buyerCompany:'Nguyễn An',purpose:'Mua thiết bị\nTham chiếu INV-12345\nMST: 1234567890\nĐịa chỉ: 12 Đường Hoa',invoiceNumber:'INV-12345',department:'Kỹ thuật',email:'ignored',taxCode:'ignored'};
 const saved=sanitizedForm(form,result,{});
 assert.equal(saved.requester,'Nguyễn An');assert.equal(saved.vendor,'Công ty Hoa Mai');
 assert.equal(saved.purpose,'Mua thiết bị\n[Đã che]\n[Đã che]\n[Đã che]');
 assert.ok(!('invoiceNumber' in saved));assert.ok(!('taxCode' in saved));assert.ok(!('email' in saved));
});
test('server reapplies signed masks to RGB and emitted PDF has no original text layer',async()=>{
 const width=100,height=100,rgb=Buffer.alloc(width*height*3,255),bytes=deflateSync(rgb);
 const pdf=rasterPdf({confirmed:true,pages:[{confirmed:true,width,height,length:bytes.length}]},bytes,{pages:[{width,height,rectangles:[[.1,.1,.3,.3]]}]});
 const start=pdf.indexOf(Buffer.from('stream\n'))+7,end=pdf.indexOf(Buffer.from('\nendstream'),start);
 const output=inflateSync(pdf.subarray(start,end));assert.equal(output[(20*width+20)*3],0);assert.equal(output[(80*width+80)*3],255);
 const pdfjs=await require('../shared/pdf-runtime').loadPdfRuntime();const task=pdfjs.getDocument({data:new Uint8Array(pdf),verbosity:0});
 try{const doc=await task.promise;assert.equal((await (await doc.getPage(1)).getTextContent()).items.length,0);}finally{await task.destroy();}
});
test('QR scanner masks multiple invoice-link QR codes and never returns their payload',async()=>{
 const {loadImage}=require('@napi-rs/canvas');const image=await loadImage(require('node:path').join(__dirname,'fixtures/qr-invoice-test.png'));
 const page={getViewport:({scale})=>({width:500*scale,height:300*scale}),render:({canvasContext:ctx,viewport})=>({promise:(async()=>{ctx.fillStyle='white';ctx.fillRect(0,0,viewport.width,viewport.height);const scale=viewport.width/500;ctx.drawImage(image,10*scale,20*scale,180*scale,180*scale);ctx.drawImage(image,290*scale,20*scale,180*scale,180*scale);})()})};
 const boxes=await require('../shared/qr-regions').scanQrRegions(page);assert.equal(boxes.length,2);assert.ok(boxes.every(b=>b.length===4&&b.every(n=>typeof n==='number')));assert.ok(!JSON.stringify(boxes).includes('TEST-12345'));
});
test('analyze/sign/submit retains only allowed fields, requires current schema and rejects tampered receipts',async()=>{
 const {createAnalyzeHandler,submitHandler}=require('../shared/private-intake');const {assess}=require('../api/analyze-evidence');
 const savedFetch=global.fetch,env={...process.env};const owner='11111111-1111-4111-8111-111111111111';
 Object.assign(process.env,{INVOICE_PRIVACY_SIGNING_KEY:'ab'.repeat(32),SUPABASE_URL:'https://db.example.test',SUPABASE_SERVICE_ROLE_KEY:'test',SUPABASE_ANON_KEY:'public',AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:'https://azure.example.test',AZURE_DOCUMENT_INTELLIGENCE_KEY:'test',INVOICE_ANALYSIS_PROVIDER:'azure'});
 let ready=2,uploads=0,persisted;
 global.fetch=async(url,options={})=>{const path=new URL(url).pathname;let data;if(path==='/auth/v1/user')data={id:owner};else if(path==='/rest/v1/profiles')data=[{role:'applicant'}];else if(path==='/rest/v1/rpc/private_intake_ready')data=ready;else if(path.startsWith('/storage/v1/object/evidence/')){uploads++;data={};}else if(path==='/rest/v1/rpc/submit_private_request'){persisted=JSON.parse(options.body);data={id:persisted.p_id,status:'TREASURER_REVIEW'};}else throw Error('Unexpected external call');return new Response(JSON.stringify(data),{status:200});};
 const envelope=(meta,bytes)=>{const head=Buffer.from(JSON.stringify(meta)),len=Buffer.alloc(4);len.writeUInt32BE(head.length);return Buffer.concat([len,head,bytes]);};
 const call=async(handler,body)=>{const res={code:0,status(n){this.code=n;return this},setHeader(){},end(s){this.data=JSON.parse(s)}};await handler({method:'POST',headers:{authorization:'Bearer user','content-type':'application/octet-stream'},body},res);return res;};
 try{
 const rgb=deflateSync(Buffer.alloc(100*100*3,255));const meta={confirmed:true,pages:[{confirmed:true,width:100,height:100,length:rgb.length}]};
 const pdf=rasterPdf(meta,rgb,{pages:[{width:100,height:100,rectangles:[]}]});
 const form={requesterType:'employee',requester:'Nguyễn An',department:'Kỹ thuật',buyerMode:'PERSON',buyerCompany:'Nguyễn An',budgetCode:'DEV',purpose:'Mua thiết bị\nSố hóa đơn: INV-12345',vendor:'Công ty Hoa Mai',invoiceNumber:'INV-12345',invoiceDate:'2026-07-10',amount:51.94,currency:'CNY'};
 const f=v=>({value:v,confidence:.99,evidence:String(v),currency:'CNY'});const extraction={fields:{invoiceNumber:f('INV-12345'),taxCode:f('1234567890'),vendor:f(form.vendor),invoiceKind:f('VAT'),invoiceDate:f('2026-07-10'),totalAmount:f(51.94),amountBeforeTax:f(47.22),vatAmount:f(4.72),discountAmount:f(0),amountDue:f(0)}};
 let azureCalls=0;const handler=createAnalyzeHandler({assess,analyzeWithAzure:async()=>{azureCalls++;return {extraction,result:fixture()}}});
 const body=envelope({id:crypto.randomUUID(),expectedVersion:0,payload:form},pdf);
 ready=1;assert.equal((await call(handler,body)).code,503);assert.equal(azureCalls,0);ready=2;
 const response=await call(handler,body);assert.equal(response.code,200);assert.equal(uploads,0);
 const receipt=JSON.parse(Buffer.from(response.data.receipt.split('.')[0],'base64url'));
 assert.equal(receipt.version,2);assert.equal(receipt.summary.displayForm.requester,'Nguyễn An');assert.ok(!JSON.stringify(receipt).includes('INV-12345'));assert.ok(!JSON.stringify(receipt).includes('1234567890'));
 assert.equal((await call(submitHandler,envelope({...meta,receipt:response.data.receipt+'x'},rgb))).code,400);assert.equal(uploads,0);
 assert.equal((await call(submitHandler,envelope({...meta,receipt:response.data.receipt},rgb))).code,422);assert.equal(uploads,0);
 const saved=await call(submitHandler,envelope({...meta,formConfirmed:true,receipt:response.data.receipt},rgb));assert.equal(saved.code,200);assert.equal(uploads,1);assert.equal(persisted.p_summary.displayForm.purpose,'Mua thiết bị\n[Đã che]');
 }finally{global.fetch=savedFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
test('Chinese product descriptions and referenced dates are not mistaken for addresses or identifiers',()=>{
 const r=fixture();r.analyzeResult.pages[0].lines[6].content='免焊面包板（电路实验板） SYB-170';
 r.analyzeResult.pages[0].lines.push({content:'原发票：12345678；日期：2026-07-10；原价税合计：187,000 VND。',polygon:polygon(5,76)});
 r.analyzeResult.pages[0].lines.push({content:'开票日期：2026-07-10',polygon:polygon(5,83)});
 const boxes=selectivePlan(r,[{width:100,height:100}])[0].rectangles;
 assert.ok(!covered(boxes,.1,.48));assert.ok(!covered(boxes,.1,.84));assert.ok(covered(boxes,.1,.77));
});
test('Vietnamese names containing Phương and Dương remain visible',()=>{
 const result=fixture();const saved=sanitizedForm({requester:'Nguyễn Phương Nam',buyerCompany:'Dương Văn Minh',vendor:'Công ty Phương Nam'},result,{});
 assert.equal(saved.requester,'Nguyễn Phương Nam');assert.equal(saved.buyerCompany,'Dương Văn Minh');assert.equal(saved.vendor,'Công ty Phương Nam');
});
