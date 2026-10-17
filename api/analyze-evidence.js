'use strict';

const { normalizeInvoiceNumber, comparePartyName, moneyMinorUnits } = require('../shared/invoice-matching.js');

const {extractChineseInvoice}=require('./azure-layout');
const validMoney=value=>moneyMinorUnits(value)!==null;
const unknownBuyerField=()=>({value:'',confidence:0,evidence:'',regions:[]});
const buyerNameFields = ['buyerPersonName', 'buyerOrganizationName'];
const labels = { invoiceKind: 'loại hóa đơn', buyerPersonName: 'tên cá nhân người mua', buyerOrganizationName: 'tên doanh nghiệp/đơn vị người mua', vendor: 'nhà cung cấp', invoiceNumber: 'số hóa đơn', invoiceDate: 'ngày hóa đơn', amountBeforeTax: 'tiền trước thuế', vatAmount: 'tiền VAT', totalAmount: 'tổng thanh toán cuối cùng' };
const confidenceThresholds = {
  invoiceKind: 0.90, buyerName: 0.80, vendor: 0.80, taxCode: 0.80, invoiceNumber: 0.80,
  amountBeforeTax: 0.90, vatAmount: 0.90, zeroVat: 0.70, discountAmount: 0.85,
  salesTotalAmount: 0.81, vatTotalAmount: 0.90, knownTaxCode: 0.85, vendorAliasWithTax: 0.70
};
function assess(request, analysis, registeredVendorMatch = null) {
  const data = analysis.fields || {};
  const issues=[];
  const addIssue=(field,severity,message)=>issues.push({field,severity,message});
  const field=dataKey=>data[dataKey]||{};
  const hasEvidence=dataKey=>Boolean(String(field(dataKey).evidence||'').trim());
  const confident=(dataKey,threshold)=>Number.isFinite(Number(field(dataKey).confidence))
    && Number(field(dataKey).confidence)>=threshold && hasEvidence(dataKey);
  const rawKind=String(field('invoiceKind').value||'UNKNOWN').trim().toUpperCase();
  const kindClear=['SALES','VAT'].includes(rawKind)&&confident('invoiceKind',confidenceThresholds.invoiceKind);
  const invoiceKind=kindClear&&rawKind==='SALES'?'SALES':'VAT';
  const buyerMode=String(request.payload.buyerMode||'').toUpperCase();
  const selectedBuyerField=buyerMode==='PERSON'?'buyerPersonName':buyerMode==='ORGANIZATION'?'buyerOrganizationName':null;
  let buyerMatch={status:'UNVERIFIED'};
  if(buyerMode==='NO_NAME') {
    const clearlyNamed=buyerNameFields.filter(key=>String(field(key).value||'').trim()&&confident(key,confidenceThresholds.buyerName));
    const unverified=buyerNameFields.filter(key=>!confident(key,confidenceThresholds.buyerName)
      ||String(field(key).value||'').trim());
    if(clearlyNamed.length) {
      if(analysis.buyerRereadStatus==='COMPLETED') {
        buyerMatch={status:'MISMATCH',fields:clearlyNamed};
        for(const key of clearlyNamed) addIssue(key,'RED','Người nộp xác nhận hóa đơn không ghi tên người mua nhưng lượt đọc xác minh lại vẫn thấy tên rõ trên chứng từ.');
      } else {
        buyerMatch={status:'UNVERIFIED',fields:clearlyNamed};
        for(const key of clearlyNamed) addIssue(key,'YELLOW','AI thấy tên người mua nhưng lượt đọc xác minh lại chưa hoàn tất; quản lý cần đối chiếu PDF trước khi kết luận.');
      }
    } else if(unverified.length) {
      buyerMatch={status:'UNVERIFIED'};
      for(const key of unverified) addIssue(key,'YELLOW','Chưa xác minh được mục tên này có để trống trên PDF; quản lý cần kiểm tra.');
    } else buyerMatch={status:'NOT_REQUIRED'};
  } else if(selectedBuyerField) {
    const buyerValue=String(field(selectedBuyerField).value||'').trim();
    buyerMatch=comparePartyName(buyerValue,request.payload.buyerCompany);
    if(!buyerValue||!confident(selectedBuyerField,confidenceThresholds.buyerName)) {
      addIssue(selectedBuyerField,'YELLOW',`AI chưa đọc ${labels[selectedBuyerField]} đủ chắc (cần ≥${Math.round(confidenceThresholds.buyerName*100)}%) hoặc thiếu bằng chứng.`);
      buyerMatch={status:'UNVERIFIED'};
    } else if(buyerMatch.status==='MISMATCH'&&analysis.buyerRereadStatus==='UNAVAILABLE')
      addIssue(selectedBuyerField,'YELLOW','Lượt đọc xác minh lại tên người mua chưa thực hiện được; quản lý cần đối chiếu PDF trước khi kết luận sai lệch.');
    else if(buyerMatch.status==='MISMATCH') addIssue(selectedBuyerField,'RED','Tên người mua trên hóa đơn mâu thuẫn rõ với tên đã khai trên form.');
    else if(buyerMatch.status!=='MATCH') addIssue(selectedBuyerField,'YELLOW','Tên người mua chưa khớp chắc chắn; quản lý cần đối chiếu trực tiếp.');
  } else {
    addIssue('buyerMode','YELLOW','Chưa xác định được lựa chọn đối chiếu tên người mua trên form.');
  }

  const vendorValue=String(field('vendor').value||'').trim();
  const vendorConfidence=Number(field('vendor').confidence)||0;
  const taxCodeValue=String(field('taxCode').value||'').trim();
  const taxCodeConfidence=Number(field('taxCode').confidence)||0;
  const nameMatch=comparePartyName(vendorValue,request.payload.vendor);
  const registeredStatus=registeredVendorMatch?.status||'UNAVAILABLE';
  const knownVendor=registeredStatus==='MATCH'&&registeredVendorMatch?.method==='VERIFIED_ALIAS'
    &&vendorConfidence>=confidenceThresholds.vendorAliasWithTax&&Boolean(vendorValue)&&hasEvidence('vendor')
    &&taxCodeConfidence>=confidenceThresholds.knownTaxCode&&Boolean(taxCodeValue)&&hasEvidence('taxCode');
  const vendorAliasUpdateCandidate=registeredStatus==='MATCH'
    &&registeredVendorMatch?.method==='VERIFIED_TAX_CODE_ALIAS_CANDIDATE'
    &&Number(registeredVendorMatch.name_similarity)>=0.80
    &&vendorConfidence>=confidenceThresholds.vendorAliasWithTax&&Boolean(vendorValue)&&hasEvidence('vendor')
    &&taxCodeConfidence>=confidenceThresholds.knownTaxCode&&Boolean(taxCodeValue)&&hasEvidence('taxCode');
  const newVendorCandidate=registeredStatus==='NO_MATCH'&&nameMatch.status==='MATCH'
    &&vendorConfidence>=confidenceThresholds.vendor&&hasEvidence('vendor')
    &&taxCodeConfidence>=confidenceThresholds.taxCode&&Boolean(taxCodeValue)&&hasEvidence('taxCode');
  const vendorVerified=knownVendor||newVendorCandidate||vendorAliasUpdateCandidate;
  const vendorAccepted=vendorVerified;
  const vendorMatch=registeredStatus==='MATCH'||registeredStatus==='MISMATCH'
    ?{status:registeredStatus,method:registeredVendorMatch.method,
      ...(knownVendor?{verifiedAlias:true,verifiedTaxCode:true}:{}),
      ...(vendorAliasUpdateCandidate?{verifiedTaxCode:true,aliasUpdateCandidate:true,nameSimilarity:Number(registeredVendorMatch.name_similarity),
        vendorId:registeredVendorMatch.vendor_id}: {})}:nameMatch;
  // A hard conflict requires the directory to prove that the tax code belongs
  // to a different registered supplier. An unregistered spelling stays reviewable.
  const clearVendorConflict=(registeredStatus==='MISMATCH'&&registeredVendorMatch?.method==='TAX_CODE_CONFLICT'
    &&taxCodeConfidence>=confidenceThresholds.knownTaxCode&&hasEvidence('taxCode'));
  const vendorTaxThreshold=['MATCH','MISMATCH'].includes(registeredStatus)
    ?confidenceThresholds.knownTaxCode:confidenceThresholds.taxCode;
  if(!vendorAccepted) {
    if(clearVendorConflict) addIssue('vendor','RED','Tên nhà cung cấp hoặc MST mâu thuẫn rõ với form/danh mục đã xác minh.');
    else {
      if(registeredStatus==='UNAVAILABLE') addIssue('vendor','YELLOW','Không xác minh được danh mục nhà cung cấp; cần Quản lý kiểm tra tên và MST trên PDF.');
      if(registeredStatus==='MATCH'&&registeredVendorMatch?.method!=='VERIFIED_ALIAS')
        addIssue('vendor','YELLOW','Tên OCR chưa khớp bí danh đã xác minh trong danh mục nhà cung cấp.');
      if(registeredStatus==='MISMATCH'&&registeredVendorMatch?.method!=='TAX_CODE_CONFLICT')
        addIssue('vendor','YELLOW','MST có thể khớp nhà cung cấp nhưng tên OCR chưa có trong danh mục bí danh; Quản lý cần xác minh.');
      if(!vendorValue||vendorConfidence<confidenceThresholds.vendor||!hasEvidence('vendor')||nameMatch.status!=='MATCH')
        addIssue('vendor','YELLOW','Tên nhà cung cấp chưa đủ confidence hoặc chưa khớp chắc chắn với danh mục/form.');
      if(!taxCodeValue||taxCodeConfidence<vendorTaxThreshold||!hasEvidence('taxCode'))
        addIssue('taxCode','YELLOW','MST chưa đủ confidence/bằng chứng để xác minh nhà cung cấp.');
    }
  }

  const invoiceNumber=field('invoiceNumber');
  const invoiceNumberMatch=Boolean(String(invoiceNumber.value||'').trim())
    &&normalizeInvoiceNumber(invoiceNumber.value)===normalizeInvoiceNumber(request.payload.invoiceNumber);
  if(!confident('invoiceNumber',confidenceThresholds.invoiceNumber))
    addIssue('invoiceNumber','YELLOW','AI chưa đọc số hóa đơn đủ chắc (cần ≥80%) hoặc thiếu bằng chứng.');
  else if(!invoiceNumberMatch) addIssue('invoiceNumber','YELLOW','Số hóa đơn đọc từ PDF không khớp form; quản lý cần đối chiếu.');

  const total=field('totalAmount');
  const totalThreshold=invoiceKind==='SALES'?confidenceThresholds.salesTotalAmount:confidenceThresholds.vatTotalAmount;
  const submittedAmount=Number(request.amount);
  const totalPresent=validMoney(total.value)&&total.value>0;
  if(!totalPresent||!confident('totalAmount',totalThreshold))
    addIssue('totalAmount','YELLOW',`AI chưa đọc tổng thanh toán đủ chắc (cần ≥${Math.round(totalThreshold*100)}%) hoặc thiếu bằng chứng.`);
  else if(total.value!==submittedAmount)
    addIssue('totalAmount','YELLOW','Tổng thanh toán trên PDF không khớp số tiền form; quản lý cần kiểm tra phép tính và chứng từ.');

  const discountField=field('discountAmount');
  const discount=Math.abs(validMoney(discountField.value)?discountField.value:0);
  const discountEvidence=String(discountField.evidence||'').trim();
  const discountObserved=discount>0||Boolean(discountEvidence);
  const discountReady=!discountObserved||(Number.isFinite(Number(discountField.confidence))
    &&Number(discountField.confidence)>=confidenceThresholds.discountAmount&&Boolean(discountEvidence));
  if(!discountReady) addIssue('discountAmount','YELLOW','Chiết khấu có trên hóa đơn nhưng chưa đạt confidence ≥85% hoặc thiếu bằng chứng.');

  let totalsConsistent=invoiceKind==='SALES';
  if(invoiceKind==='VAT') {
    const before=field('amountBeforeTax'), vat=field('vatAmount');
    const beforeReady=validMoney(before.value)&&before.value>=0&&confident('amountBeforeTax',confidenceThresholds.amountBeforeTax);
    const vatIsZero=validMoney(vat.value)&&vat.value===0;
    const vatThreshold=vatIsZero?confidenceThresholds.zeroVat:confidenceThresholds.vatAmount;
    const vatZeroEvidence=/(?:\bVAT\b|thu[eế])/iu.test(String(vat.evidence||''))
      &&/(?:^|[^\d])0(?:[,.]0+)?(?:\s*(?:đ|₫|vnd|đồng|%))?(?:$|[^\d])/iu.test(String(vat.evidence||''));
    const vatReady=validMoney(vat.value)&&vat.value>=0&&confident('vatAmount',vatThreshold)
      &&(!vatIsZero||vatZeroEvidence);
    if(!beforeReady) addIssue('amountBeforeTax','YELLOW','Tiền trước thuế chưa đạt confidence ≥90% hoặc thiếu bằng chứng.');
    if(!vatReady) addIssue('vatAmount','YELLOW',vatIsZero?'VAT được đọc là 0 nhưng confidence chưa đạt 70% hoặc bằng chứng chưa thể hiện rõ số 0.':'Tiền VAT chưa đạt confidence ≥90% hoặc thiếu bằng chứng.');
    if(beforeReady&&vatReady&&discountReady&&totalPresent) {
      const expected=moneyMinorUnits(before.value)-moneyMinorUnits(discount)+moneyMinorUnits(vat.value);
      totalsConsistent=expected===moneyMinorUnits(total.value);
      if(!totalsConsistent) addIssue('totalAmount','YELLOW','Tổng tính theo tiền trước thuế − giảm giá + VAT không khớp tổng trên hóa đơn; quản lý cần kiểm tra.');
    } else totalsConsistent=null;
  }

  if(field('totalAmount').rereadConflict) addIssue('totalAmount','YELLOW','Hai lần AI đọc tổng thanh toán cho kết quả khác nhau; quản lý cần đối chiếu PDF.');
  const submittedCurrency=request.payload.currency||'VND';
  const detectedCurrency=field('totalAmount').currency||field('currency').value;
  if(detectedCurrency&&detectedCurrency!==submittedCurrency) addIssue('totalAmount','YELLOW','Loại tiền trên hóa đơn không khớp loại tiền đã chọn.');
  if(submittedCurrency!=='VND') addIssue('currency','YELLOW','Ngoại tệ cần tỷ giá quy đổi được xác nhận trước khi duyệt theo hạn mức VNĐ.');
  const rejection=issues.some(issue=>issue.severity==='RED');
  const needsReview=issues.length>0;
  const code=rejection?'REJECTED':needsReview?'U2':submittedAmount>20000000?'U3':'CLEAR';
  const messages=issues.map(issue=>issue.message);
  const reason=code==='U3'
    ?`Tổng thanh toán ${new Intl.NumberFormat('vi-VN').format(submittedAmount)} ₫ vượt ngưỡng 20.000.000 ₫; chuyển CFO.`
    :code==='CLEAR'
      ?`AI đã đọc và đối chiếu hóa đơn ${invoiceKind==='SALES'?'bán hàng':'VAT'} đạt các ngưỡng đã quy định.`
      :messages.join(' ');
  return {
    code,reason,question:code==='U2'?`Quản lý cần kiểm tra: ${messages.join(' ')}`:'',
    fieldIssues:issues,effectiveInvoiceKind:invoiceKind,newVendorCandidate,vendorAliasUpdateCandidate,
    matching:{invoiceKind:kindClear?'MATCH':'DEFAULTED_TO_VAT',
      vendor:vendorMatch,buyerIdentity:buyerMatch,invoiceNumber:invoiceNumberMatch?'MATCH':'MISMATCH',
      totalAmount:total.value===submittedAmount?'MATCH':'MISMATCH'},
    checks:{vendorVerified,vendorAccepted,knownVendor,newVendorCandidate,vendorAliasUpdateCandidate,
      vendorIdentityMethod:vendorMatch.method||'UNVERIFIED',totalsConsistent,buyerMode}
  };
}

const azureRegions = (field, pages) => {
  if (!Array.isArray(field?.boundingRegions) || !Array.isArray(pages)) return [];
  return field.boundingRegions.slice(0, 4).flatMap(region => {
    const pageNumber = Number(region?.pageNumber);
    const page = pages.find(item => Number(item?.pageNumber) === pageNumber);
    const pageWidth = Number(page?.width);
    const pageHeight = Number(page?.height);
    const polygon = region?.polygon;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isFinite(pageWidth) || pageWidth <= 0
      || !Number.isFinite(pageHeight) || pageHeight <= 0 || !Array.isArray(polygon)
      || polygon.length < 8 || polygon.length > 32 || polygon.length % 2 !== 0) return [];
    const points = [];
    for (let index = 0; index < polygon.length; index += 2) {
      const x = Number(polygon[index]);
      const y = Number(polygon[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > pageWidth * 1.02 || y > pageHeight * 1.02) return [];
      points.push([Number(x.toFixed(4)), Number(y.toFixed(4))]);
    }
    return [{ pageNumber, pageWidth, pageHeight, polygon: points }];
  });
};

const toIsoDate = (year, month, day) => {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1000 || y > 9999) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const invoiceDateCandidates = value => {
  // Azure may include English translations in parentheses in bilingual OCR,
  // for example: "Ngày (Date) 24 tháng (month) 09 năm (year) 2026".
  const text = String(value || '').replace(/\([\p{L}\s]{1,32}\)/gu, ' ');
  if (!text.trim()) return [];
  const candidates = [];
  const addDate = (date, match, start) => {
    if (date) candidates.push({ value: date, start, end: match.index + match[0].length });
  };
  for (const match of text.matchAll(/(?:^|\D)(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?=\D|$)/g)) {
    const start = match.index + match[0].indexOf(match[1]);
    addDate(toIsoDate(match[1], match[2], match[3]), match, start);
  }
  for (const match of text.matchAll(/(?:^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?=\D|$)/g)) {
    const first = Number(match[1]), second = Number(match[2]);
    const date = second > 12 && first <= 12
      ? toIsoDate(match[3], first, second)
      : toIsoDate(match[3], second, first);
    const start = match.index + match[0].indexOf(match[1]);
    addDate(date, match, start);
  }
  for (const match of text.matchAll(/(\d{1,2})\s+th(?:á|a)ng\s+(\d{1,2})\s+n(?:ă|a)m\s+(\d{4})/giu)) {
    addDate(toIsoDate(match[3], match[2], match[1]), match, match.index);
  }
  return candidates;
};

const parseInvoiceDate = value => {
  const dates = [...new Set(invoiceDateCandidates(value).map(candidate => candidate.value))];
  return dates.length === 1 ? dates[0] : '';
};

const normalizeDateText = value => String(value || '').normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const hasInvoiceDateLabel = value => /(?:^|\b)(?:ngay\s*(?:(?:lap|xuat)\s+)?hoa\s+don|invoice\s+date|date\s+of\s+(?:the\s+)?invoice|issue\s+date|date\s+issued?)(?:\b|:)/u.test(normalizeDateText(value));
const hasLeadingDate = value => /^ngay\s*[:\-]?\s*\d/u.test(normalizeDateText(value));

const layoutWordConfidence = (page, line, candidate) => {
  const lineStart = Number(line?.spans?.[0]?.offset);
  if (!Number.isInteger(lineStart) || !Array.isArray(page?.words)) return 0;
  const start = lineStart + candidate.start;
  const end = lineStart + candidate.end;
  const confidences = page.words.flatMap(word => {
    const spans = [word?.span, ...(Array.isArray(word?.spans) ? word.spans : [])].filter(Boolean);
    const overlapsDate = spans.some(span => {
      const wordStart = Number(span.offset), wordEnd = wordStart + Number(span.length);
      return Number.isInteger(wordStart) && Number.isFinite(wordEnd) && wordStart < end && wordEnd > start;
    });
    return overlapsDate && Number.isFinite(word.confidence) ? [word.confidence] : [];
  });
  return confidences.length ? Math.min(...confidences) : 0;
};

const normalizeAzureInvoiceDateFromLayout = result => {
  const analyzeResult = result?.analyzeResult;
  const pages = Array.isArray(analyzeResult?.pages) ? analyzeResult.pages : [];
  const candidates = [];
  const addLineCandidates = (page, line, evidence = line?.content, allowUnlabeledDate = false) => {
    const content = String(line?.content || '');
    const matches = invoiceDateCandidates(content);
    const anchored = hasInvoiceDateLabel(content) || hasLeadingDate(content);
    if ((!anchored && !allowUnlabeledDate) || !matches.length) return false;
    for (const match of matches) {
      candidates.push({
        value: match.value,
        confidence: layoutWordConfidence(page, line, match),
        evidence: String(evidence || content).slice(0, 240),
        regions: azureRegions({ boundingRegions: [{ pageNumber: page?.pageNumber, polygon: line?.polygon }] }, pages)
      });
    }
    return true;
  };

  for (const page of pages) {
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (addLineCandidates(page, line)) continue;
      if (hasInvoiceDateLabel(line?.content) && lines[index + 1]) {
        addLineCandidates(page, lines[index + 1], `${line.content} ${lines[index + 1].content || ''}`, true);
      }
    }
  }

  if (!pages.some(page => Array.isArray(page?.lines) && page.lines.length) && typeof analyzeResult?.content === 'string') {
    for (const content of analyzeResult.content.split(/\r?\n/)) addLineCandidates(null, { content });
  }

  const byDate = new Map();
  for (const candidate of candidates) {
    const existing = byDate.get(candidate.value);
    if (!existing || candidate.confidence > existing.confidence) byDate.set(candidate.value, candidate);
  }
  if (byDate.size !== 1) return { value: '', confidence: 0, evidence: '', regions: [] };
  return [...byDate.values()][0];
};

const normalizeVndAmount = (amount, evidence) => {
  if (!Number.isFinite(amount)) return null;

  // Azure can interpret a Vietnamese thousands separator as a decimal point.
  // Only repair it when the printed value is unambiguously grouped in threes
  // and the parsed groups agree with Azure's numeric value.
  const tokens = String(evidence || '').normalize('NFKC').match(/\d[\d.,]*/g) || [];
  if (tokens.length !== 1) return Number.isSafeInteger(amount) ? amount : null;
  const token = tokens[0];
  const separators = [...token.matchAll(/[.,]/g)].map(([separator]) => separator);
  if (!separators.length || separators.some(separator => separator !== separators[0])) {
    return Number.isSafeInteger(amount) ? amount : null;
  }
  const groups = token.split(separators[0]);
  if (groups[0].length < 1 || groups[0].length > 3 || groups.slice(1).some(group => group.length !== 3)) {
    return Number.isSafeInteger(amount) ? amount : null;
  }

  const groupedValue = Number(groups.join(''));
  const scale = 1000 ** (groups.length - 1);
  if (!Number.isSafeInteger(groupedValue) || !Number.isFinite(scale)) return null;
  if (amount === groupedValue || Math.round(amount * scale) === groupedValue) return groupedValue;
  return null;
};

const azureField = (fields, names, kind, pages) => {
  const field = names.map(name => fields?.[name]).find(Boolean);
  let value = kind === 'money' ? 0 : '';
  let confidence = 0;
  let evidence = '';
  if (field) {
    const currency = field.valueCurrency;
    // FinRef amounts are VND; unknown and foreign currencies must not be compared as VND.
    const currencyCode = String(currency?.currencyCode || '').toUpperCase();
    const knownForeignCurrency = ['USD','CNY','EUR'].includes(currencyCode);
    const isVnd = currencyCode === 'VND'
      || /(?:VND|VNĐ|₫|đ)/i.test(`${currency?.currencySymbol || ''} ${field.content || ''}`);
    if (kind === 'money' && typeof currency?.amount === 'number' && Number.isFinite(currency.amount)) {
      if (knownForeignCurrency && validMoney(currency.amount)) {
        value=currency.amount;
        confidence=Number.isFinite(field.confidence)?field.confidence:0;
      } else if (currencyCode && currencyCode!=='VND' || !isVnd) {
        confidence = 0;
      } else {
        const normalizedAmount = normalizeVndAmount(currency.amount, field.content);
        if (normalizedAmount !== null) {
          value = normalizedAmount;
          confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
        }
      }
    } else if (kind === 'date') {
      const parsedDate = [field.valueDate, field.valueString, field.content].map(parseInvoiceDate).find(Boolean);
      if (parsedDate) {
        value = parsedDate;
        confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
      }
    } else if (kind === 'string' && typeof field.valueString === 'string') {
      value = field.valueString;
      confidence = Number.isFinite(field.confidence) ? field.confidence : 0;
    }
    evidence = typeof field.content === 'string' ? field.content.slice(0, 240) : '';
  }
  return { value, confidence, evidence, regions: azureRegions(field, pages), ...(kind==='money'?{currency:String(field?.valueCurrency?.currencyCode||'').toUpperCase()}: {}) };
};

const normalizeInvoiceTypeText = value => String(value || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[đĐ]/gu, 'D')
  .toLocaleUpperCase('vi');

const classifyAzureInvoiceType = analyzeResult => {
  const text = typeof analyzeResult?.content === 'string'
    ? analyzeResult.content
    : (analyzeResult?.pages || []).flatMap(page => (page.lines || []).map(line => line.content || '')).join('\n');
  const normalized = normalizeInvoiceTypeText(text);
  const salesPattern = /(?:HOA\s+DON\s+BAN\s+HANG|SALES\s+INVOICE)/u;
  const vatPattern = /(?:HOA\s+DON\s+GIA\s+TRI\s+GIA\s+TANG|HOA\s+DON\s+GTGT|VAT\s+INVOICE|VALUE\s+ADDED\s+TAX\s+INVOICE)/u;
  const isSales = salesPattern.test(normalized);
  const isVat = vatPattern.test(normalized);
  if (isSales === isVat) return { value: 'UNKNOWN', confidence: 0, evidence: '', regions: [] };

  const pattern = isSales ? salesPattern : vatPattern;
  const evidence = text.split(/\r?\n/u).find(line => pattern.test(normalizeInvoiceTypeText(line))) || '';
  if (!evidence.trim()) return { value: 'UNKNOWN', confidence: 0, evidence: '', regions: [] };
  return { value: isSales ? 'SALES' : 'VAT', confidence: 0.99, evidence: evidence.trim().slice(0, 240), regions: [] };
};

const normalizeAzureInvoice = result => {
  const analyzeResult = result?.analyzeResult;
  const fields = analyzeResult?.documents?.[0]?.fields;
  const pages = analyzeResult?.pages;
  if (!fields || typeof fields !== 'object') {
    throw Object.assign(new Error('Azure không trích xuất được dữ liệu hóa đơn.'), { code: 'AZURE_EMPTY_INVOICE_FIELDS' });
  }
  const invoiceNumber = azureField(fields, ['InvoiceId'], 'string', pages);
  const invoiceNumberEvidence = invoiceNumber.evidence.trim();
  if (/^0+\d+$/.test(invoiceNumberEvidence) && /^\d+$/.test(invoiceNumber.value)) {
    invoiceNumber.value = invoiceNumberEvidence;
  }
  const buyerCandidate = azureField(fields, ['CustomerName', 'CustomerAddressRecipient', 'BillingAddressRecipient'], 'string', pages);
  return { _azureBuyerCandidate: buyerCandidate, fields: {
    invoiceKind: classifyAzureInvoiceType(analyzeResult),
    buyerPersonName: unknownBuyerField(),
    buyerOrganizationName: unknownBuyerField(),
    vendor: azureField(fields, ['VendorName'], 'string', pages),
    taxCode: azureField(fields, ['VendorTaxId'], 'string', pages),
    invoiceNumber,
    invoiceDate: azureField(fields, ['InvoiceDate'], 'date', pages),
    amountBeforeTax: azureField(fields, ['SubTotal'], 'money', pages),
    vatAmount: azureField(fields, ['TotalTax'], 'money', pages),
    discountAmount: azureField(fields, ['DiscountAmount', 'TotalDiscount', 'Discount'], 'money', pages),
    totalAmount: azureField(fields, ['InvoiceTotal'], 'money', pages),
    amountDue: azureField(fields, ['AmountDue'], 'money', pages)
  } };
};



const retryDelay = headers => {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds * 1000) : 1000;
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const analyzeAzureModel = async (base, modelId, invoiceBytes, apiVersion, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  const requestTimeout = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  const analyzeUrl = new URL(`${base}/documentintelligence/documentModels/${modelId}:analyze`);
  analyzeUrl.searchParams.set('api-version', apiVersion);
  if (modelId === 'prebuilt-layout') analyzeUrl.searchParams.set('stringIndexType', 'utf16CodeUnit');
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY };
  let accepted;
  try {
    accepted = await fetch(analyzeUrl, {
      method: 'POST', headers, body: JSON.stringify({ base64Source: invoiceBytes.toString('base64') }),
      signal: AbortSignal.timeout(requestTimeout()), redirect: 'error'
    });
  } catch { throw new Error('Không kết nối được Azure Document Intelligence.'); }
  if (accepted.status !== 202) throw new Error('Azure Document Intelligence từ chối phân tích hóa đơn.');

  const location = accepted.headers.get('operation-location');
  let operation;
  try { operation = new URL(location); }
  catch { throw new Error('Azure trả về thông tin xử lý không hợp lệ.'); }
  const operationPrefix = `/documentintelligence/documentModels/${modelId}/analyzeResults/`;
  if (operation.origin !== base || operation.username || operation.password || !operation.pathname.startsWith(operationPrefix) || operation.searchParams.get('api-version') !== apiVersion) {
    throw new Error('Azure trả về thông tin xử lý không hợp lệ.');
  }

  try {
    let delay = retryDelay(accepted.headers);
    while (Date.now() < deadline) {
      await wait(Math.min(delay, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      let response;
      try {
        response = await fetch(operation, { headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY }, signal: AbortSignal.timeout(requestTimeout()), redirect: 'error' });
      } catch { throw new Error('Không lấy được kết quả từ Azure Document Intelligence.'); }
      if (!response.ok) throw new Error('Không lấy được kết quả từ Azure Document Intelligence.');
      let result;
      try { result = await response.json(); }
      catch { throw new Error('Azure trả về dữ liệu hóa đơn không hợp lệ.'); }
      if (result.status === 'succeeded') return result;
      if (result.status === 'failed') throw new Error('Azure không phân tích được hóa đơn.');
      if (!['running', 'notStarted'].includes(result.status)) throw new Error('Azure trả về trạng thái phân tích không hợp lệ.');
      delay = retryDelay(response.headers);
    }
    throw Object.assign(new Error('Azure xử lý hóa đơn quá lâu; hãy thử lại sau.'), { status: 504 });
  } finally {
    try {
      const deleted = await fetch(operation, {
        method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY },
        signal: AbortSignal.timeout(5000), redirect: 'error'
      });
      if (deleted.status !== 204) throw new Error('cleanup');
    } catch {
      // A fixed event code only: no URL, result ID, OCR or provider error body.
      console.warn('azure_analysis_cleanup_unconfirmed');
      throw Object.assign(new Error('Chưa xác nhận được việc xóa kết quả tạm tại Azure. Không lưu hồ sơ; hãy thử lại sau.'), { status: 503, safe: true });
    }
  }
};

const analyzeWithAzure = async (request, invoiceBytes, timeoutMs=35000) => {
  const deadline=Date.now()+timeoutMs;
  const endpoint=new URL(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!['','/'].includes(endpoint.pathname))throw new Error('Azure endpoint không hợp lệ.');
  let result,extraction;
  try {
    result=await analyzeAzureModel(endpoint.origin,'prebuilt-invoice',invoiceBytes,'2024-11-30',Math.min(18000,timeoutMs));
    extraction=normalizeAzureInvoice(result);
  } catch(error) {
    // Never continue after unconfirmed deletion of an Azure operation.
    if(error.safe||error.status===503)throw error;
  }
  if(!extraction||(request.payload.currency||'VND')!=='VND'||!extraction.fields.invoiceNumber.value||!extraction.fields.totalAmount.confidence){
    const remaining=deadline-Date.now();
    if(remaining<3000)throw new Error('Không đủ thời gian đọc bố cục hóa đơn.');
    const layout=await analyzeAzureModel(endpoint.origin,'prebuilt-layout',invoiceBytes,'2024-11-30',Math.min(14000,remaining));
    const chinese=extractChineseInvoice(layout);
    if(!extraction)extraction={fields:Object.fromEntries(['invoiceKind','buyerPersonName','buyerOrganizationName','vendor','taxCode','invoiceNumber','invoiceDate','amountBeforeTax','vatAmount','discountAmount','totalAmount','amountDue'].map(key=>[key,{value:['amountBeforeTax','vatAmount','discountAmount','totalAmount','amountDue'].includes(key)?0:'',confidence:0,evidence:'',regions:[]}]))};
    for(const [key,value] of Object.entries(chinese.fields)){
      if(key==='buyerCandidate')extraction._azureBuyerCandidate=value;
      else if(value.value!==''&&(value.confidence>0||!extraction.fields[key]?.confidence))extraction.fields[key]=value;
    }
    if(!result){
      const titles=(layout.analyzeResult?.pages||[]).flatMap(p=>p.lines||[]).filter(l=>/电子发票|增值税.*发票/.test(l.content||''));
      if(titles.length!==1||!chinese.fields.invoiceNumber?.value)throw new Error('Không xác định được một hóa đơn duy nhất.');
      // Layout fallback has no model document fields: mask all OCR text, with no
      // exemptions. Do not copy identity or raw text into the signed summary.
      layout.analyzeResult.documents=[{docType:'invoice',fields:{}}];
      result=layout;
    }
  }
  const key=request.payload.buyerMode==='PERSON'?'buyerPersonName':request.payload.buyerMode==='ORGANIZATION'?'buyerOrganizationName':null;
  if(key&&extraction._azureBuyerCandidate&&!extraction.fields[key]?.confidence)extraction.fields[key]=extraction._azureBuyerCandidate;
  extraction.buyerRereadStatus='UNAVAILABLE';extraction.vendorRereadStatus='UNAVAILABLE';
  delete extraction._azureBuyerCandidate;
  return {extraction,result};
};

module.exports = require('../shared/private-intake.js').createAnalyzeHandler({ analyzeWithAzure, assess });
module.exports.config = { api: { bodyParser: false } };
module.exports.assess = assess;
module.exports.normalizeAzureInvoice = normalizeAzureInvoice;
module.exports.normalizeAzureInvoiceDateFromLayout = normalizeAzureInvoiceDateFromLayout;

module.exports.analyzeWithAzure=analyzeWithAzure;
