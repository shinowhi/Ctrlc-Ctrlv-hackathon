'use strict';

const POLICY = 2;
const DISPLAY_FIELDS = ['requesterType', 'requester', 'department', 'buyerMode', 'buyerCompany', 'budgetCode', 'purpose', 'vendor'];
const fail = message => Object.assign(new Error(message), { status: 422, safe: true });
const normalize = value => String(value || '').normalize('NFKC').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
const labels = /(?:\bma\s*so\s*thue\b|\bmst\b|\btax\s*(?:id|code|number)\b|\bvat\s*(?:id|number|no)\b|纳税人识别号|统一社会信用代码|税号|\bdia\s*chi\b|\baddress\b|地址|住所|\bso\s*(?:hoa\s*don|hd)\b|\binvoice\s*(?:number|no\.?|id|#)\b|发票号码|发票号|原发票)/iu;
const addressLike = /(?:\b\d+[\w/-]*\s+[^\n,;]{0,60}\b(?:street|road|avenue|lane|boulevard|st\.|rd\.)|\b(?:duong|phuong|quan|huyen|thi tran|xa)\s+(?:so\s+)?\d+\b[^\n;]*|[^\n;]{0,30}(?:省|市|区|县|街道|路)[^\n;]{0,40}\d+\s*号[^\n;]*)/iu;
const sensitiveName = name => /^(?:InvoiceId|InvoiceNumber|VendorTaxId|CustomerTaxId|TaxId|TaxCode|.*Address)$/i.test(name);

function bounds(polygon, page) {
  if (!Array.isArray(polygon) || polygon.length < 6 || polygon.length % 2 || polygon.some((n, i) => !Number.isFinite(n) || n < 0 || n > (i % 2 ? page.height : page.width))) throw fail('Vị trí OCR không đầy đủ. Không lưu file.');
  const x = polygon.filter((_, i) => i % 2 === 0), y = polygon.filter((_, i) => i % 2 === 1);
  if (Math.max(...x) <= Math.min(...x) || Math.max(...y) <= Math.min(...y)) throw fail('Vùng OCR không có diện tích. Không lưu file.');
  return [Math.floor(Math.min(...x)/page.width*10000)/10000, Math.floor(Math.min(...y)/page.height*10000)/10000,
    Math.ceil(Math.max(...x)/page.width*10000)/10000, Math.ceil(Math.max(...y)/page.height*10000)/10000];
}

// Detection values remain transient. Only normalized rectangles leave this module.
function sensitiveRegions(result, form = {}, extraction = {}) {
  const analysis = result?.analyzeResult || {}, pages = analysis.pages;
  if (!Array.isArray(pages) || !pages.length || analysis.documents?.length !== 1) throw fail('Chỉ xử lý một hóa đơn đầy đủ trong mỗi file.');
  const regions = pages.map(() => []), secrets = new Set();
  const remember = value => { if (typeof value === 'string' && value.trim()) secrets.add(value.trim()); };
  remember(form.invoiceNumber);
  remember(extraction.fields?.invoiceNumber?.value); remember(extraction.fields?.taxCode?.value);
  const add = region => {
    const index = region.pageNumber - 1;
    if (!Number.isInteger(index) || !pages[index]) throw fail('Vị trí trường cần che không hợp lệ.');
    regions[index].push(bounds(region.polygon, pages[index]));
  };
  function visit(field, name, inherited = false, depth = 0) {
    if (!field || depth > 12) throw fail('Cấu trúc OCR không hỗ trợ.');
    const sensitive = inherited || sensitiveName(name);
    if (sensitive) {
      remember(field.content); remember(field.valueString);
      if (field.content && !field.boundingRegions?.length) throw fail('Thiếu vị trí trường cần che. Không lưu file.');
      for (const region of field.boundingRegions || []) add(region);
      for (const value of Object.values(field.valueAddress || {})) remember(value);
    }
    for (const [key, child] of Object.entries(field.valueObject || {})) visit(child, key, sensitive, depth + 1);
    for (const child of field.valueArray || []) visit(child, name, sensitive, depth + 1);
  }
  for (const [name, field] of Object.entries(analysis.documents[0].fields || {})) visit(field, name);

  pages.forEach((page,index) => {
    const lines = page.lines || [];
    for (const line of lines) {
      const text = normalize(line.content), match = text.match(labels);
      if (!match && !addressLike.test(text)) continue;
      const box = bounds(line.polygon,page);
      regions[index].push(box); remember(line.content);
      if(match) {const value=String(line.content).normalize('NFKC').slice(match.index+match[0].length).replace(/^[\s:：#.-]+/,'').trim();remember(value.split(/[;；]/)[0]);for(const id of String(line.content).match(/(?<![\d.])\d{8,30}(?:-\d{3})?(?![\d.])/g)||[])remember(id);}
      if (match) {
        // Label-only OCR lines often have a separate value immediately to the right.
        const tail = text.slice(match.index + match[0].length).replace(/[\s:：#.-]/g,'');
        if (!tail) {
          const candidates = lines.filter(other => other !== line).map(other => ({other,box:bounds(other.polygon,page)}))
            .filter(item => item.box[0] >= box[2] - .005 && Math.abs(item.box[1]-box[1]) < .015 && item.box[0]-box[2] < .15 && !labels.test(normalize(item.other.content)))
            .sort((a,b)=>a.box[0]-b.box[0]);
          if (candidates[0]) { regions[index].push(candidates[0].box); remember(candidates[0].other.content); }
        }
      }
    }
  });
  // Mask repeated occurrences (e.g. invoice numbers in reference notes), including
  // values split into multiple OCR words, without masking unrelated money rows.
  const terms = [...secrets].map(normalize).filter(s=>s.length>=3);
  pages.forEach((page,index) => {
    for (const line of page.lines || []) {
      const text = normalize(line.content);
      if (terms.some(secret=>text.includes(secret))) regions[index].push(bounds(line.polygon,page));
    }
    for (const word of page.words || []) {
      const text = normalize(word.content);
      if (text.length>=3 && terms.some(secret=>text===secret)) regions[index].push(bounds(word.polygon,page));
    }
  });
  return {regions,secrets};
}

function selectivePlan(result, documentPages, form = {}, extraction = {}, qrPages = []) {
  const pages = result?.analyzeResult?.pages;
  if (!Array.isArray(pages) || pages.length !== documentPages.length) throw fail('Azure chưa đọc đủ các trang. Không lưu file.');
  pages.forEach((page,index)=>{
    if(page.pageNumber!==index+1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width<=0 || page.height<=0 || !['inch','pixel'].includes(page.unit) || !Array.isArray(page.words) || !page.words.length || page.words.length>20000 || !Number.isFinite(page.angle||0)) throw fail('Không xác định đủ nội dung và vị trí từng trang. Không lưu file.');
    if(Math.abs(page.width/page.height-documentPages[index].width/documentPages[index].height)>.02 || Math.abs(page.angle||0)>5) throw fail('Trang bị xoay hoặc lệch; hãy xoay thẳng bản PDF rồi thử lại.');
    for(const word of page.words) bounds(word.polygon,page);
  });
  const {regions} = sensitiveRegions(result,form,extraction);
  return pages.map((page,index)=>{
    // QR/barcodes have no trusted harmless schema yet: treat them as unverified.
    for(const barcode of page.barcodes||[]) regions[index].push(bounds(barcode.polygon,page));
    const rectangles=[...regions[index],...(qrPages[index]||[])];
    for(const r of rectangles) if(r.length!==4||r.some(n=>!Number.isFinite(n)||n<0||n>1)||r[0]>=r[2]||r[1]>=r[3]) throw fail('Vùng che không hợp lệ.');
    const unique = rectangles.filter((box,i)=>!rectangles.slice(0,i).some(prev=>box.every((n,k)=>n===prev[k])));
    return {...documentPages[index],rectangles:unique};
  });
}

function sanitizedForm(form, result, extraction) {
  const secrets = result ? sensitiveRegions(result,form,extraction).secrets : new Set([form.invoiceNumber,extraction.fields?.taxCode?.value].filter(Boolean));
  const terms=[...secrets].map(normalize).filter(s=>s.length>=3);
  const display={};
  for(const key of DISPLAY_FIELDS) {
    const value=String(form[key]||'');
    display[key]=value.split(/\r?\n/).map(line=>{
      const text=normalize(line);
      // Drop the full line when a forbidden value occurs; this avoids retaining
      // adjacent address fragments in unstructured form fields.
      return labels.test(text)||addressLike.test(text)||terms.some(secret=>text.includes(secret))?'[Đã che]':line;
    }).join('\n');
  }
  return display;
}

module.exports={POLICY,DISPLAY_FIELDS,selectivePlan,sanitizedForm,sensitiveRegions};
