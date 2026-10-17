'use strict';
const {moneyMinorUnits}=require('../shared/invoice-matching');

// Structured fallback for Chinese invoice labels. Values must come from Azure
// OCR lines and their geometry, never from the submitted form or exchange notes.
function extractChineseInvoice(result) {
  const pages=result?.analyzeResult?.pages||[], fields={};
  const lines=[];
  for(const page of pages) for(const line of page.lines||[]) {
    if(!Array.isArray(line.polygon)||line.polygon.length<8||!page.width||!page.height) continue;
    const xs=line.polygon.filter((_,i)=>i%2===0),ys=line.polygon.filter((_,i)=>i%2===1);
    const box={left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
    const words=(page.words||[]).filter(word=>{
      if(line.spans?.length&&word.span) return line.spans.some(s=>word.span.offset>=s.offset&&word.span.offset+word.span.length<=s.offset+s.length);
      if(!word.polygon?.length) return false;
      const x=(word.polygon[0]+word.polygon[4])/2,y=(word.polygon[1]+word.polygon[5])/2;
      return x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom;
    });
    lines.push({...box,page,line,text:String(line.content||'').normalize('NFKC').trim(),confidence:words.length?Math.min(...words.map(w=>Number(w.confidence)||0)):0});
  }
  const field=(value,source,currency)=>({value,confidence:Math.min(.99,...source.map(l=>l.confidence)),evidence:source.map(l=>l.text).join(' ').slice(0,240),regions:source.map(l=>({pageNumber:l.page.pageNumber,pageWidth:l.page.width,pageHeight:l.page.height,polygon:l.line.polygon.reduce((a,n,i)=>{if(i%2===0)a.push([n,l.line.polygon[i+1]]);return a;},[])})),...(currency?{currency}:{})});
  const row=l=>lines.filter(other=>other.page===l.page&&Math.abs((other.top+other.bottom-l.top-l.bottom)/2)<=Math.max(l.bottom-l.top,other.bottom-other.top)*.65).sort((a,b)=>a.left-b.left);
  const unique=(key,candidates)=>{
    const values=new Set(candidates.map(c=>String(c.value)));
    if(values.size===1) fields[key]=candidates.sort((a,b)=>b.confidence-a.confidence)[0];
  };
  const titles=lines.filter(l=>/电子发票|增值税.*发票/.test(l.text)&&l.top/l.page.height<.3);
  if(!titles.length) return {fields};
  fields.invoiceKind=field('VAT',[titles[0]]);
  const currencyLines=lines.filter(l=>l.top/l.page.height<.3&&/(?:\bCNY\b|人民币|Renminbi)/i.test(l.text));
  if(currencyLines.length) fields.currency=field('CNY',[currencyLines[0]]);
  const currency=fields.currency?.value;
  for(const [key,label,pattern] of [
    ['invoiceNumber',/发票号码\s*[:：]?/,/\d{8,30}/],
    ['invoiceDate',/开票日期\s*[:：]?/,/\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}/]
  ]){
    const candidates=[];
    for(const l of lines.filter(l=>l.top/l.page.height<.3&&label.test(l.text))){
      const source=row(l).filter(other=>other.left>=l.left);
      const value=source.map(x=>x.text).join(' ').split(label)[1]?.match(pattern)?.[0];
      if(value)candidates.push(field(key==='invoiceDate'?value.replace(/[年/.]/g,'-'):value,source));
    }
    unique(key,candidates);
  }
  // On a standard Chinese invoice the buyer and seller occupy opposite columns.
  // Require two distinct name labels in the header, and preserve original script.
  const names=lines.filter(l=>/^名称\s*[:：]/.test(l.text)&&l.top/l.page.height<.4);
  const nameCandidates=names.map(l=>{
    const half=l.left/l.page.width<.5?0:1;
    const source=row(l).filter(o=>o.left>=l.left&&(o.left/o.page.width<.5?0:1)===half);
    const value=source.map(x=>x.text).join(' ').replace(/^名称\s*[:：]\s*/,'').trim();
    return {half,source,value};
  }).filter(x=>x.value);
  if(nameCandidates.length===2&&new Set(nameCandidates.map(x=>x.half)).size===2){
    const buyer=nameCandidates.find(x=>x.half===0),seller=nameCandidates.find(x=>x.half===1);
    fields.vendor=field(seller.value,seller.source);
    fields.buyerCandidate=field(buyer.value,buyer.source);
    if(/公司|企业|集团|合作社|有限公司/.test(buyer.value)) fields.buyerOrganizationName=field(buyer.value,buyer.source);
    else if(/^[\p{Script=Han}]{2,4}$/u.test(buyer.value)) fields.buyerPersonName=field(buyer.value,buyer.source);
  }
  const parseDecimal=text=>{
    const matches=[...text.matchAll(/(?:[¥￥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)/g)];
    return matches.map(m=>Number(m[1].replace(/,/g,''))).filter(n=>moneyMinorUnits(n)!==null);
  };
  if(currency){
    const totals=[];
    for(const label of lines.filter(l=>/价税合计/.test(l.text)&&l.top/l.page.height<.8)){
      const source=row(label),values=parseDecimal(source.map(l=>l.text).join(' '));
      if(values.length===1)totals.push(field(values[0],source,currency));
    }
    unique('totalAmount',totals);
    const subtotals=[],taxes=[];
    for(const label of lines.filter(l=>/^合\s*计$/.test(l.text))){
      const source=row(label),values=parseDecimal(source.map(l=>l.text).join(' '));
      if(values.length===2){subtotals.push(field(values[0],source,currency));taxes.push(field(values[1],source,currency));}
    }
    unique('amountBeforeTax',subtotals);unique('vatAmount',taxes);
  }
  // Chinese issuer tax id, restricted to seller header; never copy a buyer id.
  const taxLines=lines.filter(l=>l.left/l.page.width>=.5&&l.top/l.page.height<.4&&/^\d{10,18}(?:\s|$)/.test(l.text));
  unique('taxCode',taxLines.map(l=>field(l.text.match(/^\d+/)[0],[l])));
  return {fields};
}
module.exports={extractChineseInvoice};
