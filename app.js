'use strict';
const $ = id => document.getElementById(id);
const api = new FinRefApi(window.FINREF_CONFIG || {});
const money = n => new Intl.NumberFormat('vi-VN').format(n) + ' ₫';
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles={applicant:'Người nộp đơn',treasurer:'Quản lý tài chính',cfo:'Người đứng đầu nhánh tài chính'};
const statuses={TREASURER_REVIEW:'Chờ quản lý tài chính kiểm tra',READY_FOR_APPROVAL:'Sẵn sàng duyệt',CFO_REVIEW:'Chờ người đứng đầu nhánh tài chính',NEEDS_INFO:'Cần bổ sung',APPROVED:'Đã duyệt',REJECTED:'Từ chối'};
const checkLabels={invoice:'Đã xem hóa đơn PDF',fields_match:'Nhà cung cấp, số và ngày hóa đơn khớp form',total_includes_vat:'Tổng thanh toán trên form đã gồm VAT và khớp hóa đơn'};
const fields=['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount'];
const aiFieldLabels={buyerName:'Người mua / đơn vị nhận hóa đơn',vendor:'Nhà cung cấp',taxCode:'Mã số thuế NCC',invoiceNumber:'Số hóa đơn',invoiceDate:'Ngày hóa đơn',amountBeforeTax:'Tiền trước thuế',vatAmount:'VAT',totalAmount:'Tổng thanh toán gồm VAT',amountDue:'Còn phải thanh toán (thông tin)'};
const aiMoneyFields=new Set(['amountBeforeTax','vatAmount','totalAmount','amountDue']);
let profile=null, rows=[], selected=null, editing=null, timer=null, loading=false, busy=false, epoch=0;
function notify(text,error=false,login=false) { const el=$(login?'loginMessage':'message'); el.textContent=text; el.classList.toggle('error',error); }
function time(value) { return new Date(value).toLocaleString('vi-VN'); }
function showLogin() {
  epoch++; clearInterval(timer); clearPdfViewer(); profile=null; rows=[]; selected=null; editing=null;
  $('appShell').classList.add('hidden'); $('loginScreen').classList.remove('hidden');
  $('queueBody').innerHTML=''; $('decisionResult').innerHTML=''; $('auditList').innerHTML='';
  $('paymentForm').reset(); document.body.className='';
}
function resetForm() {
  editing=null; $('paymentForm').reset(); $('requester').value=profile?.display_name || '';
  $('invoiceDate').value=new Date().toLocaleDateString('en-CA');
  $('formTitle').textContent='Tạo đề nghị mới'; $('submitButton').textContent='Gửi đề nghị →';
}
async function enter(p) {
  if(!roles[p.role]) throw new Error('Vai trò không hợp lệ.');
  profile=p; epoch++; $('loginScreen').classList.add('hidden'); $('appShell').classList.remove('hidden');
  document.body.className='online role-' + p.role;
  $('profileName').textContent=p.display_name; $('profileRole').textContent=roles[p.role]; $('roleLabel').textContent=roles[p.role];
  $('pageTitle').textContent={applicant:'Đề nghị của bạn',treasurer:'Không gian quản lý tài chính',cfo:'Phê duyệt của người đứng đầu nhánh tài chính'}[p.role];
  $('queueTitle').textContent=p.role==='applicant'?'Hồ sơ của tôi':'Hồ sơ được phép xử lý';
  $('request-card').classList.toggle('hidden',p.role!=='applicant'); $('newRequest').classList.toggle('hidden',p.role!=='applicant');
  $('statusFilter').value=''; resetForm(); await refresh();
  clearInterval(timer); timer=setInterval(()=>{if(!document.hidden) refresh().catch(()=>{});},10000);
}
async function refresh() {
  if(!profile||loading||busy) return;
  loading=true; const run=epoch;
  try {
    const data=await api.list(); if(run!==epoch) return;
    rows=data; renderRows(); $('syncStatus').textContent='Cập nhật: '+new Date().toLocaleTimeString('vi-VN')+' · tự làm mới mỗi 10 giây · 200 hồ sơ mới nhất';
    if(selected) {
      const latest=rows.find(r=>r.id===selected.id);
      if(!latest) {selected=null; $('decisionResult').textContent='Hồ sơ không còn trong danh sách.'; $('auditList').textContent='';}
      else if(latest.version!==selected.version) { await openRequest(latest.id); notify('Hồ sơ vừa được cập nhật. Hãy xem phiên bản mới trước khi xử lý.'); }
    }
  } catch(e) {if(run===epoch) {notify('Không đồng bộ được: '+e.message,true); $('syncStatus').textContent='Mất kết nối — dữ liệu đang hiển thị có thể đã cũ.'; if(!api.session) showLogin();}} finally {loading=false;}
}
function renderRows() {
  const filtered=rows.filter(r=>!$('statusFilter').value||r.status===$('statusFilter').value);
  $('queueBody').innerHTML=filtered.length ? filtered.map(r=>`<tr><td><strong>PAY-${esc(r.id.slice(0,8))}</strong><small>${esc(time(r.created_at))}</small></td><td>${esc(r.payload.requester)}<small>${esc(r.payload.department)}</small></td><td>${money(r.amount)}</td><td><span class="status-tag ${r.status==='APPROVED'?'ready':r.status==='REJECTED'?'reject':r.status==='READY_FOR_APPROVAL'?'ready':'review'}">${statuses[r.status]||esc(r.status)}</span></td><td><button class="text-button" data-id="${r.id}">Mở</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-table">Chưa có hồ sơ ở trạng thái này.</td></tr>';
  $('queueBody').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openRequest(b.dataset.id));
  for(const [id,status] of Object.entries({waitingCount:'TREASURER_REVIEW',cfoCount:'CFO_REVIEW',readyCount:'READY_FOR_APPROVAL',infoCount:'NEEDS_INFO'})) $(id).textContent=rows.filter(r=>r.status===status).length;
}
function renderAiAnalysis(ai) {
  if(!ai?.fields) return '';
  const lines=Object.entries(aiFieldLabels).map(([key,label])=>{
    const field=ai.fields[key]||{}, raw=field.value;
    if(key==='amountDue'&&(!Number.isSafeInteger(raw)||raw<=0)) return '';
    const readableMoney=Number.isSafeInteger(raw)&&(raw>0||(key==='vatAmount'&&raw===0&&Number(field.confidence)>0));
    const value=aiMoneyFields.has(key)?(readableMoney?money(raw):'Chưa đọc được'):String(raw||'Chưa đọc được');
    return `<div class="invoice-field${key==='amountDue'?' informational':''}"><div class="invoice-field-main"><strong>${label}</strong><span>${esc(value)}</span></div><small>Độ tin cậy ${Math.round((Number(field.confidence)||0)*100)}%${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}</small></div>`;
  }).join('');
  return `<section class="invoice-analysis"><h3>Kết quả đọc PDF</h3>${lines}<p class="muted">Ngân sách và chính sách chưa được kiểm tra. Độ tin cậy AI không xác thực nguồn phát hành hay chữ ký số.</p></section>`;
}
const reviewFieldBindings={buyerName:{formKey:'requester',label:'Người mua / đơn vị nhận hóa đơn'},vendor:{formKey:'vendor',label:'Nhà cung cấp'},invoiceNumber:{formKey:'invoiceNumber',label:'Số hóa đơn'},invoiceDate:{formKey:'invoiceDate',label:'Ngày hóa đơn'},totalAmount:{formKey:'amount',label:'Tổng thanh toán gồm VAT'}};
const requiredInvoiceFields=['buyerName','vendor','invoiceNumber','invoiceDate','amountBeforeTax','vatAmount','totalAmount'];
const formReviewFields=[
  {key:'requesterType',label:'Loại người đề nghị',read:value=>value==='department'?'Phòng ban':'Nhân viên'},
  {key:'requester',label:'Họ tên / phòng ban',analysisKey:'buyerName'},
  {key:'department',label:'Bộ phận'},
  {key:'purpose',label:'Mục đích chi'},
  {key:'vendor',label:'Nhà cung cấp',analysisKey:'vendor'},
  {key:'invoiceNumber',label:'Số hóa đơn',analysisKey:'invoiceNumber'},
  {key:'invoiceDate',label:'Ngày hóa đơn',analysisKey:'invoiceDate'},
  {key:'amount',label:'Tổng thanh toán trên form (đã gồm VAT)',analysisKey:'totalAmount',read:(_,request)=>money(request.amount)},
  {key:'budgetCode',label:'Mã ngân sách'}
];
function reviewValue(key,field) {
  const value=field?.value;
  if(aiMoneyFields.has(key)) return Number.isSafeInteger(value)?money(value):'Chưa đọc được';
  return String(value??'').trim()||'Chưa đọc được';
}
function buildReviewAnnotations(request,ai) {
  const source=ai?.fields||{};
  const annotations={};
  const add=(key,state,note)=>{
    if(!annotations[key]) annotations[key]={key,label:aiFieldLabels[key]||key,state:'yellow',notes:[],regions:Array.isArray(source[key]?.regions)?source[key].regions:[]};
    const item=annotations[key];
    if(state==='red') item.state='red';
    if(!item.notes.includes(note)) item.notes.push(note);
  };
  for(const key of requiredInvoiceFields) {
    const field=source[key]||{};
    const value=field.value;
    const isZeroVat=key==='vatAmount'&&value===0&&Number(field.confidence)>0;
    const present=aiMoneyFields.has(key)?Number.isSafeInteger(value)&&(value>0||isZeroVat):typeof value==='string'&&Boolean(value.trim());
    const confidence=Number(field.confidence);
    const confident=Number.isFinite(confidence)&&confidence>=0.95&&Boolean(String(field.evidence||'').trim());
    if(!present||!confident) {
      const confidenceText=Number.isFinite(confidence)?` Độ tin cậy ${Math.round(confidence*100)}%.`:'';
      add(key,'yellow',`${!present?'Chưa đọc được trường này.':'Kết quả đọc còn chưa chắc.'}${confidenceText} Hãy đối chiếu trực tiếp với hóa đơn.`);
    }
    const binding=reviewFieldBindings[key];
    if(binding&&present) {
      const expected=key==='totalAmount'?request.amount:request.payload?.[binding.formKey];
      const actual=aiMoneyFields.has(key)?Number(value):String(value||'').trim();
      const submitted=key==='totalAmount'?Number(expected):String(expected||'').trim();
      const mismatch=aiMoneyFields.has(key)?Number.isFinite(submitted)&&actual!==submitted:normalized(actual)!==normalized(submitted);
      if(mismatch) {
        const note=`${!confident?'AI đọc chưa chắc. ':''}Form ghi “${key==='totalAmount'?money(submitted):submitted}”, hóa đơn đọc được “${reviewValue(key,field)}”. ${confident?'Có sai lệch cần xử lý.':'Cần xác nhận bằng mắt trước khi kết luận sai lệch.'}`;
        add(key,confident?'red':'yellow',note);
      }
    }
  }
  for(const key of ['taxCode','amountDue']) {
    const field=source[key]||{};
    const value=field.value;
    const present=aiMoneyFields.has(key)?Number.isSafeInteger(value)&&value>0:typeof value==='string'&&Boolean(value.trim());
    if(present&&(Number(field.confidence)<0.95||!String(field.evidence||'').trim())) {
      const confidence=Number(field.confidence);
      add(key,'yellow',`Trường thông tin này đọc chưa chắc${Number.isFinite(confidence)?` (độ tin cậy ${Math.round(confidence*100)}%)`:''}. Hãy kiểm tra trực tiếp trên hóa đơn.`);
    }
  }
  const amountFields=['amountBeforeTax','vatAmount','totalAmount'].map(key=>source[key]||{});
  const amounts=amountFields.map(field=>field.value);
  if(amounts.every(Number.isSafeInteger)&&amounts[0]+amounts[1]!==amounts[2]) {
    const confident=amountFields.every(field=>Number(field.confidence)>=0.95&&String(field.evidence||'').trim());
    const note=confident?'Tiền trước thuế cộng VAT không khớp tổng thanh toán.':'Phép tính tiền chưa thể xác nhận do một hoặc nhiều trường đọc chưa chắc.';
    for(const key of ['amountBeforeTax','vatAmount','totalAmount']) add(key,confident?'red':'yellow',note);
  }
  return annotations;
}
function renderSubmittedForm(request,annotations) {
  const rows=formReviewFields.map(field=>{
    const value=field.read?field.read(request.payload?.[field.key],request):request.payload?.[field.key];
    const annotation=field.analysisKey?annotations[field.analysisKey]:null;
    const state=annotation?.state;
    const note=annotation?`<small class="review-mark-note">${annotation.notes.map(esc).join(' ')}</small>`:field.analysisKey?'':'<small class="review-unchecked-note">Chưa có đối chiếu tự động với hóa đơn.</small>';
    return `<div class="review-form-field${state?` marked marked--${state}`:''}"><dt>${field.label}</dt><dd>${esc(value||'—')}</dd>${note}</div>`;
  }).join('');
  return `<dl class="submitted-form-fields">${rows}</dl>`;
}
function renderInvoiceNotes(annotations,ai) {
  const items=Object.values(annotations);
  if(!items.length) return '<p class="review-clear-note">Không có trường nào cần đánh dấu theo các quy tắc hiện có. Người duyệt vẫn cần kiểm tra hóa đơn gốc.</p>';
  return `<ul class="invoice-issue-list">${items.map(item=>{
    const region=item.regions.find(candidate=>Number.isInteger(candidate.pageNumber)&&candidate.pageNumber>0);
    const value=reviewValue(item.key,ai?.fields?.[item.key]);
    return `<li class="invoice-issue invoice-issue--${item.state}"><button type="button" class="invoice-issue-jump"${region?` data-pdf-page="${region.pageNumber}"`:''}><span class="review-mark-icon" aria-hidden="true"></span><strong>${esc(item.label)}</strong><span>${esc(value)}</span></button><small>${item.notes.map(esc).join(' ')}${region?'':` Chưa có tọa độ để khoanh vùng trên PDF.`}</small></li>`;
  }).join('')}</ul>`;
}
let pdfjsPromise=null,pdfViewToken=0,pdfViewCleanup=null;
function clearPdfViewer() {
  pdfViewToken++;
  if(pdfViewCleanup) { pdfViewCleanup(); pdfViewCleanup=null; }
}
async function loadPdfJs() {
  if(!pdfjsPromise) pdfjsPromise=import('./vendor/pdfjs/pdf.min.mjs').then(pdfjs=>{
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.min.mjs',document.baseURI).toString();
    return pdfjs;
  }).catch(error=>{pdfjsPromise=null;throw error;});
  return pdfjsPromise;
}
async function renderReviewPdf(url,annotations,token) {
  const status=$('reviewPdfStatus'),stage=$('reviewPdfStage'),wrap=$('reviewPdfWrap'),toolbar=$('reviewPdfToolbar');
  let documentProxy=null,renderTask=null,resizeObserver=null,disposed=false;
  const cleanup=()=>{
    disposed=true; resizeObserver?.disconnect();
    try { renderTask?.cancel(); } catch {}
    if(documentProxy) void documentProxy.destroy().catch(()=>{});
  };
  pdfViewCleanup=cleanup;
  try {
    const pdfjs=await loadPdfJs();
    if(token!==pdfViewToken||disposed) return;
    const response=await fetch(url,{credentials:'omit'});
    if(!response.ok) throw new Error('Không tải được nội dung PDF.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(token!==pdfViewToken||disposed) return;
    const base=new URL('./vendor/pdfjs/',document.baseURI).toString();
    documentProxy=await pdfjs.getDocument({
      data:bytes,
      cMapUrl:`${base}cmaps/`,cMapPacked:true,
      standardFontDataUrl:`${base}standard_fonts/`,wasmUrl:`${base}wasm/`,iccUrl:`${base}iccs/`
    }).promise;
    if(token!==pdfViewToken||disposed) { cleanup(); return; }
    status.classList.add('hidden'); toolbar.classList.remove('hidden');
    const pageLabel=$('reviewPdfPageLabel'),back=$('reviewPdfPrevious'),forward=$('reviewPdfNext');
    const zoomOut=$('reviewPdfZoomOut'),zoomIn=$('reviewPdfZoomIn');
    let pageNumber=1,zoom=1,resizeTimer=null,pageRenderVersion=0,ignoreInitialResize=true;
    const renderPage=async()=>{
      const thisRender=++pageRenderVersion;
      if(token!==pdfViewToken||disposed) return;
      try { renderTask?.cancel(); } catch {}
      if(renderTask) { try { await renderTask.promise; } catch {} renderTask=null; }
      if(thisRender!==pageRenderVersion||token!==pdfViewToken||disposed) return;
      const page=await documentProxy.getPage(pageNumber);
      if(thisRender!==pageRenderVersion||token!==pdfViewToken||disposed) return;
      const initial=page.getViewport({scale:1});
      const available=Math.max(240,wrap.clientWidth-24);
      const scale=Math.min(3,Math.max(0.35,available/initial.width*zoom));
      const viewport=page.getViewport({scale});
      const pixelRatio=Math.min(2,window.devicePixelRatio||1);
      const canvas=document.createElement('canvas');
      canvas.width=Math.ceil(viewport.width*pixelRatio); canvas.height=Math.ceil(viewport.height*pixelRatio);
      canvas.style.width=`${viewport.width}px`; canvas.style.height=`${viewport.height}px`;
      const context=canvas.getContext('2d',{alpha:false});
      if(!context) throw new Error('Trình duyệt không hỗ trợ hiển thị PDF.');
      const currentTask=page.render({canvasContext:context,viewport,transform:pixelRatio===1?null:[pixelRatio,0,0,pixelRatio,0,0]});
      renderTask=currentTask;
      try { await currentTask.promise; }
      catch(error) { if(error?.name==='RenderingCancelledException'||thisRender!==pageRenderVersion) return; throw error; }
      if(renderTask===currentTask) renderTask=null;
      if(thisRender!==pageRenderVersion||token!==pdfViewToken||disposed) return;
      stage.replaceChildren(canvas);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      const sourcePage=Object.values(annotations).flatMap(item=>item.regions||[]).find(region=>region.pageNumber===pageNumber);
      const sourceWidth=sourcePage?.pageWidth||initial.width,sourceHeight=sourcePage?.pageHeight||initial.height;
      svg.setAttribute('class','pdf-mark-layer'); svg.setAttribute('viewBox',`0 0 ${sourceWidth} ${sourceHeight}`); svg.setAttribute('preserveAspectRatio','none');
      svg.setAttribute('role','group'); svg.setAttribute('aria-label','Các vùng cần kiểm tra trên hóa đơn');
      svg.style.width=`${viewport.width}px`; svg.style.height=`${viewport.height}px`;
      let marker=0;
      for(const item of Object.values(annotations)) for(const region of item.regions||[]) {
        if(region.pageNumber!==pageNumber||!Array.isArray(region.polygon)||region.polygon.length<3) continue;
        marker++;
        const points=region.polygon.map(point=>`${Number(point[0])},${Number(point[1])}`).join(' ');
        const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');
        polygon.setAttribute('points',points); polygon.setAttribute('class',`pdf-mark pdf-mark--${item.state}`);
        polygon.setAttribute('tabindex','0'); polygon.setAttribute('role','img');
        polygon.setAttribute('aria-label',`${item.label}: ${item.notes.join(' ')}`);
        const title=document.createElementNS('http://www.w3.org/2000/svg','title'); title.textContent=`${item.label}: ${item.notes.join(' ')}`; polygon.append(title);
        svg.append(polygon);
        const center=region.polygon.reduce((sum,point)=>[sum[0]+Number(point[0])/region.polygon.length,sum[1]+Number(point[1])/region.polygon.length],[0,0]);
        const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');
        circle.setAttribute('cx',String(center[0])); circle.setAttribute('cy',String(center[1])); circle.setAttribute('r',String(Math.min(sourceWidth,sourceHeight)*0.014));
        circle.setAttribute('class',`pdf-mark-badge pdf-mark-badge--${item.state}`); circle.setAttribute('aria-hidden','true'); svg.append(circle);
        const text=document.createElementNS('http://www.w3.org/2000/svg','text');
        text.setAttribute('x',String(center[0])); text.setAttribute('y',String(center[1])); text.setAttribute('font-size',String(Math.min(sourceWidth,sourceHeight)*0.02)); text.setAttribute('text-anchor','middle'); text.setAttribute('dominant-baseline','central'); text.setAttribute('aria-hidden','true'); text.textContent=String(marker); svg.append(text);
      }
      stage.append(svg); pageLabel.textContent=`Trang ${pageNumber} / ${documentProxy.numPages}`;
      back.disabled=pageNumber<=1; forward.disabled=pageNumber>=documentProxy.numPages;
    };
    back.onclick=()=>{if(pageNumber>1){pageNumber--;renderPage().catch(showRenderError);}};
    forward.onclick=()=>{if(pageNumber<documentProxy.numPages){pageNumber++;renderPage().catch(showRenderError);}};
    zoomOut.onclick=()=>{zoom=Math.max(0.6,zoom-0.2);renderPage().catch(showRenderError);};
    zoomIn.onclick=()=>{zoom=Math.min(2.4,zoom+0.2);renderPage().catch(showRenderError);};
    $('invoiceIssueList').querySelectorAll('[data-pdf-page]').forEach(button=>button.onclick=()=>{
      const next=Number(button.dataset.pdfPage); if(Number.isInteger(next)&&next>=1&&next<=documentProxy.numPages){pageNumber=next;renderPage().catch(showRenderError);stage.focus?.();}
    });
    function showRenderError(error) { if(token===pdfViewToken&&!disposed) {status.classList.remove('hidden');status.textContent=error.message||'Không hiển thị được trang PDF.';} }
    resizeObserver=new ResizeObserver(()=>{if(ignoreInitialResize){ignoreInitialResize=false;return;}clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>renderPage().catch(showRenderError),120);});
    resizeObserver.observe(wrap);
    await renderPage();
  } catch(error) {
    if(token===pdfViewToken&&!disposed) {status.classList.remove('hidden');status.textContent=`Không hiển thị được hóa đơn: ${error.message||'Lỗi PDF.'}`;toolbar.classList.add('hidden');}
  }
}
async function openRequest(id) {
  const r=rows.find(x=>x.id===id); if(!r) return; clearPdfViewer(); selected=r; const run=epoch;
  const isReviewer=profile.role==='treasurer'||profile.role==='cfo';
  const mayReview=(profile.role==='treasurer'&&['TREASURER_REVIEW','READY_FOR_APPROVAL'].includes(r.status))||(profile.role==='cfo'&&r.status==='CFO_REVIEW');
  const manualChecks=profile.role==='treasurer'&&r.status==='TREASURER_REVIEW';
  const ai=r.checks?.ai;
  const annotations=buildReviewAnnotations(r,ai);
  const metadata={ 'Người đề nghị':r.payload.requester,'Bộ phận':r.payload.department,'Mục đích':r.payload.purpose,'Nhà cung cấp':r.payload.vendor,'Số hóa đơn':r.payload.invoiceNumber,'Ngày hóa đơn':r.payload.invoiceDate,'Mã ngân sách':r.payload.budgetCode };
  const reviewLayout=isReviewer?`<div class="reviewer-layout"><section class="submitted-form-panel"><div class="review-pane-heading"><span class="eyebrow">BÊN TRÁI · FORM NGƯỜI NỘP</span><h3>Thông tin đã gửi</h3><p class="muted">Các giá trị giữ nguyên như lúc nộp hồ sơ.</p></div><div class="review-legend"><span class="legend-yellow"><i></i>Vàng · AI chưa đọc chắc</span><span class="legend-red"><i></i>Đỏ · sai lệch đã rõ</span><small>Trường khớp và đủ rõ không đánh dấu.</small></div>${renderSubmittedForm(r,annotations)}</section><section class="invoice-review-panel"><div class="review-pane-heading"><span class="eyebrow">BÊN PHẢI · MINH CHỨNG</span><h3>Hóa đơn PDF</h3><p class="muted">Các khung màu chỉ vị trí cần kiểm tra trên hóa đơn.</p></div><div id="reviewPdfToolbar" class="pdf-toolbar hidden"><button id="reviewPdfPrevious" type="button" aria-label="Trang trước">‹</button><span id="reviewPdfPageLabel">Trang 1</span><button id="reviewPdfNext" type="button" aria-label="Trang sau">›</button><span class="pdf-toolbar-spacer"></span><button id="reviewPdfZoomOut" type="button" aria-label="Thu nhỏ">−</button><button id="reviewPdfZoomIn" type="button" aria-label="Phóng to">＋</button></div><p id="reviewPdfStatus" class="muted">Đang mở hóa đơn…</p><div id="reviewPdfWrap" class="pdf-viewer-wrap"><div id="reviewPdfStage" class="pdf-stage" tabindex="0" aria-label="Trang hóa đơn và các vùng cần kiểm tra"></div></div><div class="invoice-issues"><h4>Ghi chú cần kiểm tra</h4><div id="invoiceIssueList">${renderInvoiceNotes(annotations,ai)}</div></div></section></div>${renderAiAnalysis(ai)}`:`<div class="decision-meta">${Object.entries(metadata).map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div>${renderAiAnalysis(ai)}<section class="invoice-preview"><h3>Hóa đơn PDF</h3><p id="invoicePreviewStatus" class="muted">Đang mở hóa đơn…</p><iframe id="invoicePreview" title="Hóa đơn PDF" class="hidden"></iframe></section>`;
  const reviewForm=mayReview?`<form id="reviewForm" class="review-form">${manualChecks?`<p class="muted">Hãy đối chiếu các trường với hóa đơn rồi xác nhận các bước kiểm tra thủ công.</p><div class="review-checks">${Object.entries(checkLabels).map(([k,v])=>`<label class="plain-check"><input type="checkbox" name="${k}">${v}</label>`).join('')}</div>`:profile.role==='treasurer'?'<p class="muted">AI đã hoàn tất các kiểm tra hiện có. Bạn vẫn là người quyết định bấm duyệt cuối.</p>':'<p class="muted">Đây là bước phê duyệt cuối của người đứng đầu nhánh tài chính.</p>'}<label class="field">Lý do / nội dung cần bổ sung<textarea id="reviewReason" maxlength="2000" rows="3" placeholder="Bắt buộc khi yêu cầu bổ sung hoặc từ chối"></textarea></label><div class="decision-actions"><button class="action-secondary" type="button" data-action="clarify">Yêu cầu bổ sung</button><button class="action-secondary" type="button" data-action="reject">Từ chối</button><button class="action-primary" type="button" data-action="approve">${profile.role==='treasurer'&&r.amount>20000000?'Xác nhận & chuyển người đứng đầu nhánh tài chính':'Phê duyệt cuối'}</button></div></form>`:'';
  $('decisionResult').innerHTML=`<div class="decision-banner ${r.status==='APPROVED'?'ready':r.status==='REJECTED'?'reject':r.status==='READY_FOR_APPROVAL'?'ready':'escalate'}"><div><strong>${statuses[r.status]||esc(r.status)}</strong><small>PAY-${esc(r.id.slice(0,8))} · phiên bản ${r.version}</small></div></div><h2 class="detail-amount">${money(r.amount)} <small>đã gồm VAT</small></h2><p class="notice">${esc(r.reason)}</p>${ai?.assessment?.question?`<p class="notice">${esc(ai.assessment.question)}</p>`:''}${reviewLayout}<div class="scope-note compact"><strong>Chưa kiểm tra:</strong> ngân sách, chính sách, MST công ty, NCC được duyệt, PO và lịch sử hóa đơn/thanh toán. AI không xác thực nguồn phát hành hoặc chữ ký số.</div>${reviewForm}${profile.role==='applicant'&&r.status==='NEEDS_INFO'?'<button class="primary-button clay-button" id="supplementButton">Bổ sung và gửi lại</button>':''}`;
  const viewerToken=pdfViewToken;
  api.signedUrl(r.invoice_path).then(url=>{
    if(epoch!==run||selected?.id!==id) return;
    if(isReviewer) renderReviewPdf(url,annotations,viewerToken);
    else {$('invoicePreview').src=url;$('invoicePreview').classList.remove('hidden');$('invoicePreviewStatus').classList.add('hidden');}
  }).catch(e=>{
    if(epoch===run&&selected?.id===id) { const status=$(isReviewer?'reviewPdfStatus':'invoicePreviewStatus'); status.textContent='Không mở được hóa đơn: '+e.message; status.classList.remove('hidden'); }
  });
  $('decisionResult').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>review(r,b.dataset.action));
  if($('supplementButton')) $('supplementButton').onclick=()=>{
    editing={id:r.id,version:r.version}; fields.forEach(k=>$(k).value=r.payload[k]??'');
    $('invoiceFile').value='';
    $('formTitle').textContent='Bổ sung PAY-'+r.id.slice(0,8); $('submitButton').textContent='Gửi lại để phân tích →';
    $('request-card').scrollIntoView({behavior:'smooth'}); notify('Tải lại hóa đơn PDF cho phiên bản bổ sung.');
  };
  $('auditList').textContent='Đang tải nhật ký…';
  try { const audit=await api.audit(id); if(epoch!==run||selected?.id!==id) return;
    $('auditList').innerHTML=audit.map(a=>`<div class="audit-item"><span class="audit-dot purple"></span><div><strong>${esc(roles[a.actor_role]||a.actor_role)} · ${esc(statuses[a.new_status]||a.new_status)}</strong><p>${esc(a.reason)}</p><small>${esc(time(a.created_at))} · phiên bản ${a.version}</small></div></div>`).join('');
  } catch(e) {if(epoch===run&&selected?.id===id) $('auditList').textContent='Không tải được nhật ký: '+e.message;}
}
function setBusy(value) {busy=value; $('submitButton').disabled=value; $('logoutButton').disabled=value; document.querySelectorAll('[data-action]').forEach(b=>b.disabled=value);}
async function review(r,action) {
  if(busy) return;
  const reason=$('reviewReason').value.trim();
  if(action!=='approve'&&!reason) {notify('Hãy ghi rõ lý do hoặc nội dung cần bổ sung.',true);return;}
  const checks={}; document.querySelectorAll('#reviewForm input[type=checkbox]').forEach(c=>checks[c.name]=c.checked);
  if(action==='approve'&&profile.role==='treasurer'&&r.status==='TREASURER_REVIEW') {
    const result=FinRefRules.assess(r.amount,{pdf:checks.invoice,fieldsMatch:checks.fields_match,totalsConsistent:checks.total_includes_vat,confidenceSufficient:true});
    if(result==='U1') {notify('U1: chưa đủ xác nhận về PDF, trường form hoặc tổng thanh toán gồm VAT. Hãy kiểm tra minh chứng hoặc yêu cầu bổ sung.',true);return;}
  }
  setBusy(true);
  try {await api.rpc('review_request',{p_id:r.id,p_expected_version:r.version,p_action:action,p_reason:reason,p_checks:checks}); notify('Đã lưu quyết định và nhật ký.');}
  catch(e) {notify(e.message,true);} finally {setBusy(false);await refresh();}
}
function validateFile(file,invoice=false) {
  if(!file||file.size===0||file.size>10485760||!['application/pdf','image/jpeg','image/png'].includes(file.type)) throw new Error('Mỗi minh chứng phải là PDF/JPG/PNG, không rỗng và tối đa 10 MB.');
  if(invoice&&file.type!=='application/pdf') throw new Error('Hóa đơn trong đợt này phải là PDF, có thể là PDF chữ hoặc PDF scan.');
  return {'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png'}[file.type];
}
$('paymentForm').onsubmit=async event=>{
  event.preventDefault(); if(busy||profile?.role!=='applicant') return;
  setBusy(true);
  try {
    const invoice=$('invoiceFile').files[0];
    const invExt=validateFile(invoice,true);
    const payload=Object.fromEntries(fields.map(k=>[k,$(k).value.trim()])); payload.amount=Number(payload.amount); payload.invoiceType='electronic';
    const folder=profile.id+'/'+crypto.randomUUID();
    const invoicePath=folder+'/invoice.'+invExt;
    notify('Đang tải hóa đơn và gửi hồ sơ…');
    await api.upload(invoicePath,invoice);
    const result=await api.rpc('submit_request',{p_id:editing?.id||crypto.randomUUID(),p_payload:payload,p_invoice_path:invoicePath,p_request_path:null,p_expected_version:editing?.version||0});
    resetForm(); notify('Đã tải hóa đơn. AI đang đọc và đối chiếu thông tin…');
    try {
      const verification=await api.analyzeEvidence(result.id);
      notify(verification.status==='READY_FOR_APPROVAL'?'AI hoàn tất các kiểm tra hiện có. Hồ sơ sẵn sàng để quản lý tài chính bấm duyệt cuối.':verification.status==='CFO_REVIEW'?'Tổng gồm VAT vượt 20 triệu; hồ sơ đã chuyển người đứng đầu nhánh tài chính duyệt cuối.':verification.status==='NEEDS_INFO'?'AI chưa đọc chắc hoặc phát hiện dữ liệu chưa khớp. Hãy xem câu hỏi trong hồ sơ và bổ sung.':'AI đã ghi kết quả phân tích.');
    } catch(e) {
      notify('Đã gửi hồ sơ; AI chưa đọc được PDF. Quản lý tài chính có thể kiểm tra thủ công. Ngân sách/chính sách vẫn chưa được đối chiếu.',true);
    }
    setBusy(false); await refresh(); await openRequest(result.id);
  } catch(e) {notify('Chưa gửi thành công: '+e.message,true);} finally {setBusy(false);}
};
$('loginForm').onsubmit=async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true; notify('Đang đăng nhập…',false,true);
  try {const p=await api.login($('email').value.trim(),$('password').value); $('password').value=''; await enter(p); notify('',false,true);}
  catch(e) {api.remember(null); notify('Đăng nhập thất bại: '+e.message,true,true);} finally {button.disabled=false;}
};
$('logoutButton').onclick=async()=>{if(busy)return; const button=$('logoutButton');button.disabled=true; try {await api.logout();notify('',false,true);} catch {notify('Đã thoát trên thiết bị này; không liên lạc được máy chủ để thu hồi phiên.',true,true);} finally {showLogin();button.disabled=false;}};
$('refreshButton').onclick=refresh;
$('statusFilter').onchange=renderRows;
$('cancelEdit').onclick=()=>{if(!busy)resetForm();};
$('newRequest').onclick=()=>{if(!busy)resetForm();};
document.querySelectorAll('[data-scroll]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.scroll).scrollIntoView({behavior:'smooth'})));
$('verifyButton').onclick=()=>{
  const results=FinRefRules.verify();
  $('verifyResult').innerHTML=`<p>${results.filter(r=>r.pass).length}/${results.length} PASS · ${esc(new Date().toLocaleString('vi-VN'))}</p><ul>${results.map(r=>`<li>${r.pass?'✓':'✗'} ${esc(r.name)}: ${r.actual} (cần ${r.expected})</li>`).join('')}</ul>`;
};
if(!api.configured) {
  notify('Chưa kết nối Supabase. Làm theo HUONG-DAN-ONLINE.md để bật đăng nhập. Bạn vẫn có thể mở demo bên dưới.',false,true);
  $('loginForm').querySelector('button').disabled=true;
} else if(api.session) {
  api.profile().then(enter).catch(e=>{api.remember(null);showLogin();notify(e.message,true,true);});
}
