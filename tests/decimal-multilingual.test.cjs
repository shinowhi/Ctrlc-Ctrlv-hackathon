const test=require('node:test'),assert=require('node:assert/strict');
const {parseAmountInput,moneyMinorUnits}=require('../shared/invoice-matching');
const {extractChineseInvoice}=require('../api/azure-layout');
const {normalizeAzureInvoice,analyzeWithAzure}=require('../api/analyze-evidence');
function layout(total='51.94',number='26000000000025988000'){
 const entries=[['电子发票（普通发票）',30,8],['CNY · 人民币 / Renminbi',30,14],['发票号码：'+number,70,8],['开票日期：2026-07-10',70,12],['名称：李明',8,24],['名称：测试电子有限公司',55,24],['4562137891 （越南税号）',55,30],['合 计',8,59],['¥47.22',69,59],['¥4.72',91,59],['价税合计（大写）',8,65],['（小写） ¥'+total,84,65],['原发票：25988000；原价税合计：187,000 VND。',8,76],['示例汇率：1 CNY = 3,600.00 VND',8,82]];
 let offset=0;
 const lines=entries.map(([content,x,y])=>{const line={content,polygon:[x,y,x+10,y,x+10,y+2,x,y+2],spans:[{offset,length:content.length}]};offset+=content.length+1;return line;});
 return {analyzeResult:{pages:[{pageNumber:1,width:100,height:100,lines,words:lines.map(l=>({content:l.content,confidence:.99,span:l.spans[0],polygon:l.polygon}))}]}};
}
test('decimal input accepts dot/comma but never interprets grouping or exponent notation',()=>{
 for(const value of ['51.94','51,94'])assert.equal(parseAmountInput(value,'CNY'),51.94);
 for(const value of ['1,000','1.000','1,234.56','1e3','NaN','-5','0','12.345'])assert.throws(()=>parseAmountInput(value,'USD'));
 assert.throws(()=>parseAmountInput('51.94','VND'));assert.equal(parseAmountInput('187000','VND'),187000);
 assert.equal(moneyMinorUnits(.1)+moneyMinorUnits(.2),moneyMinorUnits(.3));
});
test('Azure retains evidenced foreign currency cents without changing their denomination',()=>{
 for(const currencyCode of ['CNY','USD','EUR']){
 const f=normalizeAzureInvoice({analyzeResult:{documents:[{fields:{InvoiceTotal:{valueCurrency:{amount:51.94,currencyCode},confidence:.99,content:'51.94 '+currencyCode}}}],pages:[]}}).fields.totalAmount;
 assert.equal(f.value,51.94);assert.equal(f.currency,currencyCode);assert.equal(f.confidence,.99);
 }
});
test('Chinese OCR reads header identity and final decimal total, excluding reference invoice and exchange notes',()=>{
 const {fields:f}=extractChineseInvoice(layout());
 assert.equal(f.invoiceNumber.value,'26000000000025988000');assert.equal(typeof f.invoiceNumber.value,'string');
 assert.equal(f.invoiceDate.value,'2026-07-10');assert.equal(f.buyerPersonName.value,'李明');
 assert.equal(f.vendor.value,'测试电子有限公司');assert.equal(f.totalAmount.value,51.94);assert.equal(f.totalAmount.currency,'CNY');
 assert.equal(f.amountBeforeTax.value,47.22);assert.equal(f.vatAmount.value,4.72);assert.ok(f.totalAmount.regions.length);
 assert.equal(extractChineseInvoice(layout('72.35','12345678901234567890')).fields.totalAmount.value,72.35);
});
test('OCR fallback does not invent confidence or guess yuan currency from the yen symbol',()=>{
 const noWords=layout();noWords.analyzeResult.pages[0].words=[];
 assert.equal(extractChineseInvoice(noWords).fields.totalAmount.confidence,0);
 const ambiguous=layout();ambiguous.analyzeResult.pages[0].lines=ambiguous.analyzeResult.pages[0].lines.filter(l=>!l.content.startsWith('CNY'));
 assert.equal(extractChineseInvoice(ambiguous).fields.totalAmount,undefined);
});
test('Azure orchestration falls back to layout on an unsupported invoice model, without a forced Vietnamese locale',async()=>{
 const savedFetch=global.fetch,env={...process.env};
 process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT='https://example.cognitiveservices.azure.com';process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY='test';delete process.env.OPENAI_API_KEY;
 const calls=[];
 global.fetch=async(url,opts)=>{
 calls.push(String(url));if(opts?.method==='DELETE')return new Response(null,{status:204});assert.equal(new URL(url).searchParams.has('locale'),false);
 if(String(url).includes('prebuilt-invoice'))return new Response('{}',{status:400});
 if(opts?.method==='POST')return new Response('',{status:202,headers:{'operation-location':'https://example.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/123?api-version=2024-11-30'}});
 return new Response(JSON.stringify({status:'succeeded',...layout()}),{status:200});
 };
 try{
 const {extraction:result}=await analyzeWithAzure({payload:{currency:'CNY',buyerMode:'PERSON',buyerCompany:'李明'}},Buffer.from('%PDF-test'));
 assert.equal(result.fields.totalAmount.value,51.94);assert.equal(result.fields.buyerPersonName.value,'李明');assert.ok(calls.some(u=>u.includes('prebuilt-layout')));
 }finally{global.fetch=savedFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
test('Azure cleanup failure blocks intake and does not attempt another model',async()=>{
 const savedFetch=global.fetch,env={...process.env};const calls=[];
 process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT='https://example.cognitiveservices.azure.com';process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY='test';
 global.fetch=async(url,opts)=>{calls.push(String(url));if(opts?.method==='DELETE')return new Response('{}',{status:500});if(opts?.method==='POST')return new Response('',{status:202,headers:{'operation-location':'https://example.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/123?api-version=2024-11-30'}});return new Response(JSON.stringify({status:'succeeded',...layout()}),{status:200});};
 try{await assert.rejects(analyzeWithAzure({payload:{currency:'CNY'}},Buffer.from('%PDF-test')),e=>e.status===503&&e.safe===true);assert.ok(!calls.some(u=>u.includes('prebuilt-layout')));}finally{global.fetch=savedFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
