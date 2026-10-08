'use strict';
const $ = id => document.getElementById(id);
const api = new FinRefApi(window.FINREF_CONFIG || {});
const money = n => new Intl.NumberFormat('vi-VN').format(n) + ' ₫';
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const {normalizeInvoiceNumber,normalizePartyName,comparePartyName}=window.FinRefInvoiceMatching;
const normalized = normalizePartyName;
const roles={applicant:'Người nộp đơn',treasurer:'Quản lý tài chính',cfo:'Giám đốc Tài chính'};
const statuses={TREASURER_REVIEW:'Chờ quản lý tài chính xử lý',READY_FOR_APPROVAL:'Sẵn sàng duyệt',CFO_REVIEW:'Chờ Giám đốc Tài chính duyệt',NEEDS_INFO:'Cần bổ sung',APPROVED:'Đã duyệt',REJECTED:'Từ chối'};
const checkLabels={invoice:'Đã xem hóa đơn PDF',fields_match:'Nhà cung cấp, người mua và số hóa đơn khớp form',total_includes_vat:'Tổng thanh toán trên form khớp tổng cuối cùng trên hóa đơn'};
const fields=['requesterType','requester','department','buyerMode','buyerCompany','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount'];
const aiFieldLabels={invoiceKind:'Loại hóa đơn',buyerName:'Người mua / đơn vị nhận hóa đơn',vendor:'Nhà cung cấp',taxCode:'Mã số thuế NCC',invoiceNumber:'Số hóa đơn',invoiceDate:'Ngày hóa đơn (tham khảo)',amountBeforeTax:'Tiền trước thuế',vatAmount:'VAT',discountAmount:'Chiết khấu',totalAmount:'Tổng thanh toán cuối cùng',amountDue:'Còn phải thanh toán (thông tin)'};
const aiMoneyFields=new Set(['amountBeforeTax','vatAmount','discountAmount','totalAmount','amountDue']);
const aiConfidenceThresholds={buyerName:0.80,vendor:0.80,taxCode:0.80,invoiceNumber:0.80,amountBeforeTax:0.90,vatAmount:0.90,discountAmount:0.85,totalAmountSales:0.82,totalAmountVat:0.90,zeroVat:0.70};
let profile=null, rows=[], vendors=[], vendorReviewNotes=[], vendorDirectoryError='', selected=null, selectedFromVendorNote=false, editing=null, timer=null, loading=false, busy=false, vendorSaving=false, epoch=0, dailySummary=null;
function notify(text,error=false,login=false) { const el=$(login?'loginMessage':'message'); el.textContent=text; el.classList.toggle('error',error); }
function time(value) { return new Date(value).toLocaleString('vi-VN'); }
function showLogin() {
  epoch++; clearInterval(timer); clearPdfViewer(); profile=null; rows=[]; vendors=[]; vendorReviewNotes=[]; vendorDirectoryError=''; selected=null; selectedFromVendorNote=false; editing=null; dailySummary=null;
  $('appShell').classList.add('hidden'); $('loginScreen').classList.remove('hidden');
  $('queueBody').innerHTML=''; $('decisionResult').innerHTML=''; $('auditList').innerHTML='';
  $('approvalTools').classList.add('hidden');
  $('dailyLimitNotice').classList.add('hidden'); $('dailyLimitNotice').textContent='';
  $('paymentForm').reset(); $('vendorReviewNotesList').innerHTML=''; $('vendorReviewNotesMessage').textContent=''; document.body.className='';
}
function resetForm() {
  editing=null; $('paymentForm').reset(); $('requester').value=profile?.display_name || '';
  $('formTitle').textContent='Tạo đề nghị mới'; $('submitButton').textContent='Gửi đề nghị →';
  updateBuyerModeUI();
  markMissingFormFields([]);
}
function markMissingFormFields(keys) {
  document.querySelectorAll('#paymentForm .field').forEach(wrapper=>{
    wrapper.classList.remove('field-missing');
    const input=wrapper.querySelector('input,select,textarea');
    if(input) input.removeAttribute('aria-invalid');
  });
  for(const key of keys||[]) {
    if(key==='buyerCompany'&&$('buyerMode').value==='NO_NAME') continue;
    const input=$(key),wrapper=input?.closest('.field');
    if(!input||!wrapper) continue;
    wrapper.classList.add('field-missing');
    input.setAttribute('aria-invalid','true');
  }
}
function updateBuyerModeUI() {
  const mode=$('buyerMode')?.value||'';
  const field=$('buyerNameField');
  const input=$('buyerCompany');
  if(!field||!input) return;
  field.classList.toggle('hidden',mode==='NO_NAME');
  input.disabled=mode==='NO_NAME';
  $('buyerNameHelp').textContent=mode==='PERSON'?'Nhập tên cá nhân người mua như trên hóa đơn.':mode==='ORGANIZATION'?'Nhập tên đơn vị/pháp nhân người mua như trên hóa đơn.':'Nhập đúng tên người mua đã chọn trên hóa đơn.';
  if(mode==='NO_NAME') input.value='';
}
async function enter(p) {
  if(!roles[p.role]) throw new Error('Vai trò không hợp lệ.');
  profile=p; epoch++; dailySummary=null; $('loginScreen').classList.add('hidden'); $('appShell').classList.remove('hidden');
  document.body.className='online role-' + p.role;
  $('profileName').textContent=p.display_name; $('profileRole').textContent=roles[p.role]; $('roleLabel').textContent=roles[p.role];
  $('pageTitle').textContent={applicant:'Đề nghị của bạn',treasurer:'Không gian quản lý tài chính',cfo:'Duyệt cấp quyền · Giám đốc Tài chính'}[p.role];
  $('queueTitle').textContent=p.role==='applicant'?'Hồ sơ của tôi':p.role==='cfo'?'Danh sách chờ Giám đốc duyệt':'Danh sách đề nghị thanh toán';
  $('request-card').classList.toggle('hidden',p.role!=='applicant'); $('newRequest').classList.toggle('hidden',p.role!=='applicant');
  const canManageVendors=['treasurer','cfo'].includes(p.role);
  $('vendorDirectoryNav').classList.toggle('hidden',!canManageVendors); $('vendors-card').classList.toggle('hidden',!canManageVendors);
  $('vendorReviewNotesNav').classList.toggle('hidden',p.role!=='cfo'); $('vendorReviewNotesCard').classList.toggle('hidden',p.role!=='cfo');
  $('statusFilter').value=p.role==='applicant'?'':'APPROVAL_QUEUE'; $('batchReason').value=''; resetForm(); await refresh();
  clearInterval(timer); timer=setInterval(()=>{if(!document.hidden) refresh().catch(()=>{});},10000);
}
async function refresh() {
  if(!profile||loading||busy) return;
  loading=true; const run=epoch;
  if(['treasurer','cfo'].includes(profile.role)) {dailySummary=null;renderApprovalTools();}
  try {
    const data=await api.list(profile.role); if(run!==epoch) return;
    rows=data; renderRows(); $('syncStatus').textContent='Đang hiển thị '+data.length+' hồ sơ có quyền truy cập · cập nhật mỗi 10 giây';
    await refreshVendorDirectory(run); if(run!==epoch) return;
    if(profile.role==='cfo') {await refreshVendorReviewNotes(run); if(run!==epoch) return;}
    await refreshDailyApprovalNotice(run); if(run!==epoch) return;
    if(selected) {
      let latest=rows.find(r=>r.id===selected.id);
      if(!latest&&profile.role==='cfo'&&selectedFromVendorNote&&vendorReviewNotes.some(note=>note.request_id===selected.id)) {
        try {latest=await api.getRequest(selected.id);} catch {latest=null;}
        if(run!==epoch) return;
      }
      if(!latest) {clearPdfViewer();selected=null;selectedFromVendorNote=false;$('decisionResult').textContent='Hồ sơ không còn trong danh sách.';$('auditList').textContent='';}
      else if(latest.version!==selected.version) { await openRequest(latest.id,selectedFromVendorNote); notify('Hồ sơ vừa được cập nhật. Hãy xem phiên bản mới trước khi xử lý.'); }
    }
  } catch(e) {if(run===epoch) {notify('Không đồng bộ được: '+e.message,true); $('syncStatus').textContent='Mất kết nối — dữ liệu đang hiển thị có thể đã cũ.'; if(!api.session) showLogin();}} finally {loading=false;}
}
async function refreshVendorDirectory(run=epoch) {
  try {
    const result=await api.vendorDirectory();
    if(run!==epoch) return;
    vendors=Array.isArray(result)?result:[]; vendorDirectoryError='';
  } catch(error) {
    if(run!==epoch) return;
    vendors=[]; vendorDirectoryError=error.message||'Không tải được danh mục nhà cung cấp.';
  }
  renderVendorDirectory();
}
async function refreshVendorReviewNotes(run=epoch) {
  const message=$('vendorReviewNotesMessage'),list=$('vendorReviewNotesList');
  try {
    const result=await api.vendorReviewNotes();
    if(run!==epoch||profile?.role!=='cfo') return;
    vendorReviewNotes=Array.isArray(result)?result:[];
    message.textContent=vendorReviewNotes.length
      ?`${vendorReviewNotes.length} ghi chú danh mục nhà cung cấp cần CFO xem xét.`
      :'Chưa có ghi chú danh mục nhà cung cấp chờ xem xét.';
    list.innerHTML=vendorReviewNotes.map(note=>{
      const name=note.evidence?.vendor||{},tax=note.evidence?.taxCode||{};
      const aliasUpdate=note.evidence?.reviewType==='ALIAS_UPDATE';
      const noteLabel=aliasUpdate?'Bí danh OCR chưa có trong danh mục':'Nhà cung cấp mới chưa có trong danh mục';
      const fillLabel=aliasUpdate?'Điền vào form bí danh':'Điền vào form nhà cung cấp';
      const similarity=Number(note.evidence?.nameSimilarity);
      const similarityText=aliasUpdate&&Number.isFinite(similarity)
        ?`<small>Tên OCR tương đồng ${Math.round(similarity*100)}% với nhà cung cấp đã xác minh.</small>`:'';
      return `<article class="vendor-record vendor-candidate"><div><strong>${esc(noteLabel)}: ${esc(note.vendor_name)}</strong><small>MST: ${esc(note.tax_code)} · số hóa đơn: ${esc(note.evidence?.invoiceNumber?.value||'Chưa đọc được')}</small><small>Tên NCC ${Math.round((Number(name.confidence)||0)*100)}% · ${esc(name.evidence||'Không có trích dẫn')}; MST ${Math.round((Number(tax.confidence)||0)*100)}% · ${esc(tax.evidence||'Không có trích dẫn')}</small>${similarityText}</div><div class="vendor-candidate-actions"><button type="button" class="secondary-button clay-button" data-vendor-note-open="${esc(note.request_id)}">Mở hồ sơ và hóa đơn PDF</button><button type="button" class="text-button" data-vendor-note-fill="${esc(note.request_id)}">${esc(fillLabel)}</button><button type="button" class="text-button" data-vendor-note-resolve="${esc(note.request_id)}">Đã xem xét ghi chú</button></div></article>`;
    }).join('');
    list.querySelectorAll('[data-vendor-note-open]').forEach(button=>button.onclick=async()=>{
      const note=vendorReviewNotes.find(item=>item.request_id===button.dataset.vendorNoteOpen);
      if(!note) return;
      await openRequest(note.request_id,true);
    });
    list.querySelectorAll('[data-vendor-note-resolve]').forEach(button=>button.onclick=async()=>{
      if(profile?.role!=='cfo'||button.disabled) return;
      const requestId=button.dataset.vendorNoteResolve;
      button.disabled=true;
      try {
        await api.resolveVendorReviewNote(requestId);
        await refreshVendorReviewNotes(run);
        if(selected?.id===requestId&&selectedFromVendorNote&&!rows.some(row=>row.id===requestId)) {
          clearPdfViewer(); selected=null; selectedFromVendorNote=false;
          $('decisionResult').textContent='Ghi chú đã được xử lý.'; $('auditList').textContent='';
        }
        notify('Đã đánh dấu ghi chú nhà cung cấp là đã xem xét.');
      } catch(error) {notify('Chưa cập nhật được ghi chú nhà cung cấp: '+error.message,true);}
      finally {button.disabled=false;}
    });
    list.querySelectorAll('[data-vendor-note-fill]').forEach(button=>button.onclick=()=>{
      const note=vendorReviewNotes.find(item=>item.request_id===button.dataset.vendorNoteFill);
      if(!note) return;
      if(note.evidence?.reviewType==='ALIAS_UPDATE') {
        $('vendorAliasTarget').value=note.evidence.vendorId||'';
        $('vendorAliasName').value=note.vendor_name;
        $('vendorAliasVerified').checked=false;
        $('vendorAliasForm').scrollIntoView({behavior:'smooth'});
        $('vendorAliasName').focus({preventScroll:true});
        notify('Đã điền bí danh OCR. Đối chiếu hóa đơn/MST rồi xác nhận để lưu bí danh.');
        return;
      }
      $('vendorLegalName').value=note.vendor_name;
      $('vendorTaxCode').value=note.tax_code;
      $('vendors-card').scrollIntoView({behavior:'smooth'});
      $('vendorLegalName').focus({preventScroll:true});
      notify('Đã điền tên và MST để CFO tự xác minh rồi quyết định thêm vào danh mục.');
    });
  } catch(error) {
    if(run!==epoch||profile?.role!=='cfo') return;
    vendorReviewNotes=[];
    message.textContent='Không tải được ghi chú nhà cung cấp mới: '+(error.message||'Lỗi dịch vụ.');
    list.innerHTML='';
  }
}
function renderVendorDirectory() {
  const search=normalized($('vendorSearch').value);
  const allNames=[...new Set(vendors.flatMap(v=>[v.legal_name,...(Array.isArray(v.aliases)?v.aliases:[])]).filter(Boolean))];
  $('vendorDirectoryOptions').innerHTML=allNames.map(name=>`<option value="${esc(name)}"></option>`).join('');
  const target=$('vendorAliasTarget'), previous=target.value;
  target.innerHTML=vendors.map(v=>`<option value="${esc(v.vendor_id)}">${esc(v.legal_name)}</option>`).join('');
  if(vendors.some(v=>v.vendor_id===previous)) target.value=previous;
  const matches=vendors.filter(v=>normalized([v.legal_name,v.tax_code,...(Array.isArray(v.aliases)?v.aliases:[])].join(' ')).includes(search));
  $('vendorDirectoryMessage').textContent=vendorDirectoryError
    ?`Không tải được danh mục. Hãy kiểm tra đã chạy migration vendor-directory trên Supabase chưa. (${vendorDirectoryError})`
    :vendors.length?`${vendors.length} nhà cung cấp đã xác minh. Bí danh chỉ được thêm sau khi đối chiếu với hóa đơn hoặc MST.`:'Chưa có nhà cung cấp trong danh mục.';
  $('vendorDirectoryList').innerHTML=matches.length?matches.map(v=>`<article class="vendor-record"><div><strong>${esc(v.legal_name)}</strong><small>MST: ${esc(v.tax_code||'Chưa ghi nhận')}</small></div><div class="vendor-alias-list">${(Array.isArray(v.aliases)?v.aliases:[]).map(alias=>`<span class="vendor-alias-chip">${esc(alias)}</span>`).join('')}</div></article>`).join(''):vendors.length?'<p class="muted">Không tìm thấy nhà cung cấp phù hợp.</p>':'<p class="muted">Danh mục chưa có nhà cung cấp.</p>';
  $('vendorCreateButton').disabled=vendorSaving;
  $('vendorAliasButton').disabled=vendorSaving||vendors.length===0;
}
async function refreshDailyApprovalNotice(run=epoch) {
  const notice=$('dailyLimitNotice');
  if(!['treasurer','cfo'].includes(profile?.role)) {dailySummary=null;notice.classList.add('hidden');notice.textContent='';renderApprovalTools();return;}
  try {
    const result=await api.dailyApprovalSummary();
    if(run!==epoch||!['treasurer','cfo'].includes(profile?.role)) return;
    const summary=Array.isArray(result)?result[0]:result;
    const total=Number(summary?.approved_total), limit=Number(summary?.daily_limit), warning=Number(summary?.warning_threshold), remaining=Number(summary?.remaining);
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(limit)||!Number.isSafeInteger(warning)||!Number.isSafeInteger(remaining)) throw new Error('Số liệu hạn mức không hợp lệ.');
    dailySummary={total,limit,warning,remaining}; renderApprovalTools();
    if(profile.role!=='treasurer'||total<=warning) {notice.classList.add('hidden');notice.textContent='';return;}
    const over=Math.max(0,total-limit);
    notice.classList.remove('hidden','error');
    notice.textContent=over>0
      ? `Hạn mức duyệt hôm nay (giờ Bangkok): đã duyệt ${money(total)} trên ${money(limit)}, vượt ${money(over)} theo quyền Giám đốc; số dư còn lại là 0 ₫.`
      : `Hạn mức duyệt hôm nay (giờ Bangkok): đã duyệt ${money(total)} trên ${money(limit)}, còn ${money(remaining)}. Hồ sơ khiến tổng ngày vượt 100.000.000 ₫ cần Giám đốc cấp quyền.`;
  } catch(error) {
    if(run!==epoch||!['treasurer','cfo'].includes(profile?.role)) return;
    dailySummary=null; renderApprovalTools();
    if(profile.role==='treasurer') {notice.classList.remove('hidden');notice.classList.add('error');
      notice.textContent='Không tải được số dư hạn mức ngày. Hãy làm mới trước khi duyệt hồ sơ.';}
  }
}
function approvalQueue() {
  if(profile?.role==='treasurer') return rows.filter(r=>r.status==='READY_FOR_APPROVAL'&&Number(r.amount)<=20000000);
  if(profile?.role==='cfo') return rows.filter(r=>r.status==='CFO_REVIEW'||(r.status==='READY_FOR_APPROVAL'&&Number(r.amount)>20000000));
  return [];
}
function managerMustAskCfo(request) {
  return Number(request?.amount)>20000000
    ||Boolean(dailySummary&&dailySummary.total+Number(request?.amount||0)>100000000);
}
function renderApprovalTools() {
  const tools=$('approvalTools');
  const reviewer=['treasurer','cfo'].includes(profile?.role);
  tools.classList.toggle('hidden',!reviewer);
  if(!reviewer) return;
  const items=approvalQueue();
  const amount=items.reduce((sum,r)=>sum+Number(r.amount||0),0);
  const countText=`${items.length} hóa đơn · tổng ${money(amount)}`;
  $('approvalQueueCount').textContent=(profile.role==='treasurer'?'Quản lý':'Giám đốc')+' · '+countText;
  $('batchReasonField').classList.toggle('hidden',profile.role!=='cfo');
  if(!dailySummary) $('approvalSummaryText').textContent='Chưa tải được tổng đã duyệt trong ngày; làm mới danh sách trước khi duyệt.';
  else {
    const projected=dailySummary.total+amount;
    const budgetText=`Hôm nay đã duyệt ${money(dailySummary.total)} / ${money(dailySummary.limit)} · còn ${money(dailySummary.remaining)}.`;
    const consequence=profile.role==='treasurer'
      ?projected<=dailySummary.limit?` Duyệt cả danh sách sẽ còn ${money(dailySummary.limit-projected)}.`:` Duyệt cả danh sách sẽ vượt ${money(projected-dailySummary.limit)}; toàn bộ đợt sẽ chuyển lên Giám đốc.`
      :projected<=dailySummary.limit?` Sau đợt này dự kiến còn ${money(dailySummary.limit-projected)}.`:` Sau đợt này vượt hạn mức ${money(projected-dailySummary.limit)}; cần ghi lý do chấp thuận.`;
    $('approvalSummaryText').textContent=budgetText+consequence;
  }
  const button=$('approveAllButton');
  button.textContent=`Duyệt tất cả (${items.length})`;
  button.disabled=busy||!dailySummary||items.length===0||(profile.role==='cfo'&&!$('batchReason').value.trim());
}
function renderRows() {
  const filter=$('statusFilter').value, actionable=new Set(approvalQueue().map(r=>r.id));
  const filtered=rows.filter(r=>!filter||(filter==='APPROVAL_QUEUE'?actionable.has(r.id):r.status===filter));
  $('queueBody').innerHTML=filtered.length ? filtered.map(r=>{
    const highReady=r.status==='READY_FOR_APPROVAL'&&Number(r.amount)>20000000;
    const label=highReady&&profile?.role==='cfo'?'Chờ Giám đốc duyệt (>20 triệu)':highReady&&profile?.role==='treasurer'?'Đủ điều kiện · thuộc thẩm quyền Giám đốc':statuses[r.status]||esc(r.status);
    const actions=actionable.has(r.id)?`<div class="queue-actions"><button class="queue-approve" data-approve-id="${r.id}" ${busy||!dailySummary||(profile.role==='cfo'&&!$('batchReason').value.trim())?'disabled':''}>Duyệt lẻ</button><button class="text-button" data-id="${r.id}">Mở</button></div>`:`<button class="text-button" data-id="${r.id}">Mở</button>`;
    const stateClass={APPROVED:'ready',READY_FOR_APPROVAL:'ready',REJECTED:'reject',CFO_REVIEW:'cfo-wait',NEEDS_INFO:'missing',TREASURER_REVIEW:'review'}[r.status]||'review';
    return `<tr><td><strong>PAY-${esc(r.id.slice(0,8))}</strong><small>${esc(time(r.created_at))}</small></td><td>${esc(r.payload.requester||'Chưa điền')}<small>${esc(r.payload.department||'')}</small></td><td>${r.amount==null?'—':money(r.amount)}</td><td><span class="status-tag ${stateClass}">${label}</span></td><td>${actions}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-table">Không có hóa đơn trong danh sách này.</td></tr>';
  $('queueBody').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openRequest(b.dataset.id));
  $('queueBody').querySelectorAll('[data-approve-id]').forEach(b=>b.onclick=()=>approveQueueItem(rows.find(r=>r.id===b.dataset.approveId)));
  for(const [id,status] of Object.entries({waitingCount:'TREASURER_REVIEW',cfoCount:'CFO_REVIEW',readyCount:'READY_FOR_APPROVAL',infoCount:'NEEDS_INFO'})) $(id).textContent=rows.filter(r=>r.status===status).length;
  renderApprovalTools();
}
function renderAiAnalysis(ai,request=null) {
  if(!ai?.fields) return '';
  const rawKind=String(ai.fields.invoiceKind?.value||'').toUpperCase();
  const kindRead=ai.fields.invoiceKind||{};
  const kindIsClear=['SALES','VAT'].includes(rawKind)&&Number(kindRead.confidence)>=0.90&&String(kindRead.evidence||'').trim();
  const effectiveKind=kindIsClear?rawKind:'VAT';
  const lines=Object.entries(aiFieldLabels).map(([key,label])=>{
    const field=ai.fields[key]||{}, raw=field.value;
    const managerIdentifier=request?.checks?.manager_verified_identifiers?.[key];
    const hasManagerIdentifier=typeof managerIdentifier?.value==='string'&&managerIdentifier.value.trim()!=='';
    const displayRaw=hasManagerIdentifier?managerIdentifier.value:raw;
    if(key==='amountDue'&&(!Number.isSafeInteger(raw)||raw<=0)) return '';
    const displayMoney=key==='discountAmount'&&Number.isSafeInteger(raw)?Math.abs(raw):raw;
    if(key==='discountAmount'&&(!Number.isSafeInteger(displayMoney)||displayMoney<=0)) return '';
    const readableMoney=Number.isSafeInteger(displayMoney)&&(displayMoney>0||(key==='vatAmount'&&displayMoney===0&&Number(field.confidence)>0));
    const invoiceKindValue=key==='invoiceKind'?kindIsClear?{SALES:'Hóa đơn bán hàng',VAT:'Hóa đơn VAT'}[rawKind]:'Chưa phân loại chắc · áp dụng rule VAT':'';
    const notComparedVat=key==='vatAmount'&&effectiveKind==='SALES'&&raw===0;
    const submittedInvoiceNumber=String(request?.payload?.invoiceNumber??'').trim();
    const invoiceNumberMatches=key==='invoiceNumber'&&/^\d+$/.test(normalized(displayRaw))&&/^\d+$/.test(normalized(submittedInvoiceNumber))&&normalizeInvoiceNumber(displayRaw)===normalizeInvoiceNumber(submittedInvoiceNumber);
    const invoiceNumberFormatDiffers=invoiceNumberMatches&&normalized(displayRaw)!==normalized(submittedInvoiceNumber);
    const value=key==='invoiceKind'?invoiceKindValue:aiMoneyFields.has(key)?(notComparedVat?'Không dùng để đối chiếu':readableMoney?money(displayMoney):'Chưa đọc được'):invoiceNumberFormatDiffers?submittedInvoiceNumber:String(displayRaw||'Chưa đọc được');
    const numberNote=invoiceNumberFormatDiffers?` · Khớp form sau khi chuẩn hóa số 0 đầu (đọc “${esc(displayRaw)}”)`:'';
    const vendorMatch=ai.assessment?.matching?.vendor;
    const aliasNote=key==='vendor'&&vendorMatch?.verifiedAlias?' · Khớp bí danh đã xác minh':key==='vendor'&&vendorMatch?.verifiedTaxCode?' · MST khớp danh mục đã xác minh':'';
    const informational=['invoiceDate','amountDue'].includes(key);
    const managerVerified=request?.checks?.manager_verified===true;
    const identifierField=key==='taxCode'||key==='invoiceNumber';
    const managerVerifiedField=managerVerified&&!identifierField;
    const rereadNote=field.reread?` · OpenAI đọc lại: ${Number.isSafeInteger(field.reread.value)?money(field.reread.value):'không đọc được'} (${Math.round((Number(field.reread.confidence)||0)*100)}%)${field.reread.evidence?` · ${esc(field.reread.evidence)}`:''}`:'';
    const fallbackReadNote=field.fallbackRead?` · Lượt đọc toàn hóa đơn: ${Number.isSafeInteger(field.fallbackRead.value)?money(field.fallbackRead.value):'không đọc được'} (${Math.round((Number(field.fallbackRead.confidence)||0)*100)}%)${field.fallbackRead.evidence?` · ${esc(field.fallbackRead.evidence)}`:''}`:'';
    const confidenceNote=informational?'':hasManagerIdentifier?`<small>Quản lý đã xác nhận giá trị này trực tiếp từ PDF${managerIdentifier.verified_by?` · Tài khoản xác nhận: ${esc(String(managerIdentifier.verified_by))}`:''}${managerIdentifier.verified_at?` · ${esc(time(managerIdentifier.verified_at))}`:''} · AI đọc ban đầu: ${esc(String(raw||'Chưa đọc được'))} (${Math.round((Number(field.confidence)||0)*100)}%)${field.evidence?` · Bằng chứng OCR: ${esc(field.evidence)}`:''}</small>`:managerVerifiedField?`<small>Quản lý đã xác minh giá trị này${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}</small>`:managerVerified&&identifierField?`<small>Hồ sơ đã được quản lý duyệt, nhưng chưa lưu xác nhận riêng cho định danh này. OCR ${Math.round((Number(field.confidence)||0)*100)}%${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}</small>`:`<small>Độ tin cậy ${Math.round((Number(field.confidence)||0)*100)}%${numberNote}${aliasNote}${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}${rereadNote}${fallbackReadNote}</small>`;
    return `<div class="invoice-field${informational?' informational':''}"><div class="invoice-field-main"><strong>${label}</strong><span>${esc(value)}</span></div>${confidenceNote}</div>`;
  }).join('');
  const kindNote=effectiveKind==='VAT'&&!kindIsClear?' Loại hóa đơn chưa đủ chắc; đã áp dụng quy tắc VAT.':'';
  return `<section class="invoice-analysis"><h3>Kết quả đọc PDF</h3>${lines}<p class="muted">Ngân sách và chính sách chưa được kiểm tra.${kindNote} Độ tin cậy AI không xác thực nguồn phát hành hay chữ ký số.</p></section>`;
}
const reviewFieldBindings={buyerName:{formKey:'buyerCompany',label:'Tên người mua'},vendor:{formKey:'vendor',label:'Nhà cung cấp'},invoiceNumber:{formKey:'invoiceNumber',label:'Số hóa đơn'},totalAmount:{formKey:'amount',label:'Tổng thanh toán cuối cùng'}};
const requiredInvoiceFields=['buyerName','invoiceNumber','totalAmount'];
function isBuyerNameExempt(request) { return request?.payload?.buyerMode==='NO_NAME'; }
function isVendorVerifiedByTaxCode(ai) {
  const field=ai?.fields?.taxCode||{};
  return ai?.assessment?.matching?.vendor?.verifiedTaxCode===true
    && Boolean(String(field.value||'').trim())
    && Number.isFinite(Number(field.confidence))&&Number(field.confidence)>=0.85
    && Boolean(String(field.evidence||'').trim());
}
function isVendorVerifiedByAlias(ai) {
  const field=ai?.fields?.vendor||{};
  return ai?.assessment?.matching?.vendor?.verifiedAlias===true
    && Boolean(String(field.value||'').trim())
    && Number.isFinite(Number(field.confidence))&&Number(field.confidence)>=0.70
    && Boolean(String(field.evidence||'').trim());
}
const formReviewFields=[
  {key:'requesterType',label:'Loại người đề nghị',read:value=>({employee:'Nhân viên',department:'Phòng ban'})[value]||'Chưa chọn'},
  {key:'requester',label:'Họ tên / phòng ban'},
  {key:'department',label:'Bộ phận'},
  {key:'buyerMode',label:'Lựa chọn thông tin người mua',read:value=>({PERSON:'Tên cá nhân',ORGANIZATION:'Tên đơn vị',NO_NAME:'Hóa đơn không ghi tên người mua'})[value]||'Chưa chọn'},
  {key:'buyerCompany',label:'Tên người mua',analysisKey:'buyerName',read:(value,request)=>request.payload?.buyerMode==='PERSON'?`Cá nhân: ${value||''}`:request.payload?.buyerMode==='ORGANIZATION'?`Đơn vị: ${value||''}`:value},
  {key:'purpose',label:'Mục đích chi'},
  {key:'vendor',label:'Nhà cung cấp',analysisKey:'vendor'},
  {key:'invoiceNumber',label:'Số hóa đơn',analysisKey:'invoiceNumber'},
  {key:'invoiceDate',label:'Ngày hóa đơn',reviewNote:'AI trích xuất để tham khảo; không dùng ngày này làm điều kiện đối chiếu hoặc duyệt.'},
  {key:'amount',label:'Tổng thanh toán trên form',analysisKey:'totalAmount',read:(_,request)=>request.amount==null?'Chưa điền':money(request.amount)},
  {key:'budgetCode',label:'Mã ngân sách'}
];
function reviewValue(key,field) {
  const value=field?.value;
  if(key==='invoiceKind') return {SALES:'Hóa đơn bán hàng',VAT:'Hóa đơn VAT'}[String(value||'').toUpperCase()]||'Chưa xác định';
  if(aiMoneyFields.has(key)) return Number.isSafeInteger(value)?money(value):'Chưa đọc được';
  return String(value??'').trim()||'Chưa đọc được';
}
function buildReviewAnnotations(request,ai) {
  const annotations={};
  const add=(key,state,note)=>{
    if(!annotations[key]) annotations[key]={key,label:aiFieldLabels[key]||key,state:'yellow',notes:[],regions:Array.isArray(source[key]?.regions)?source[key].regions:[]};
    const item=annotations[key];
    if(state==='red') item.state='red';
    if(!item.notes.includes(note)) item.notes.push(note);
  };
  const source=ai?.fields||{};
  if(request?.checks?.manager_verified) return annotations;
  const fieldIssues=ai?.assessment?.fieldIssues;
  if(Array.isArray(fieldIssues)) {
    for(const issue of fieldIssues) add(issue.field,issue.severity==='RED'?'red':'yellow',issue.message||'Quản lý cần đối chiếu trường này với hóa đơn.');
    return annotations;
  }
  const kind=String(ai?.assessment?.effectiveInvoiceKind||source.invoiceKind?.value||'VAT').toUpperCase()==='SALES'?'SALES':'VAT';
  for(const key of requiredInvoiceFields) {
    if(key==='buyerName'&&isBuyerNameExempt(request)) {
      const field=source.buyerName||{};
      if(String(field.value||'').trim()&&Number(field.confidence)>=aiConfidenceThresholds.buyerName&&String(field.evidence||'').trim()) {
        add(key,'red','Người nộp xác nhận hóa đơn không ghi tên người mua nhưng AI đọc thấy tên rõ trên chứng từ.');
      }
      continue;
    }
    const field=source[key]||{};
    const threshold=key==='totalAmount'?(kind==='SALES'?aiConfidenceThresholds.totalAmountSales:aiConfidenceThresholds.totalAmountVat):aiConfidenceThresholds[key];
    if(!String(field.value??'').trim()||!Number.isFinite(Number(field.confidence))||Number(field.confidence)<threshold||!String(field.evidence||'').trim()) {
      add(key,'yellow',`AI chưa đọc đủ chắc trường này (ngưỡng ${Math.round(threshold*100)}%). Hãy đối chiếu trực tiếp với hóa đơn.`);
    }
  }
  return annotations;
}
const identifierConfirmationFields={
  taxCode:{label:'Mã số thuế nhà cung cấp',minimum:5,maximum:30,pattern:'^[A-Za-z0-9][A-Za-z0-9 ./-]{3,29}$'},
  invoiceNumber:{label:'Số hóa đơn',minimum:1,maximum:100}
};
function needsIdentifierConfirmation(key,request,ai,annotations) {
  const field=ai?.fields?.[key]||{};
  const assessmentIssue=Array.isArray(ai?.assessment?.fieldIssues)
    &&ai.assessment.fieldIssues.some(issue=>issue?.field===key);
  const invoiceNumberMismatch=key==='invoiceNumber'
    &&normalizeInvoiceNumber(field.value)!==normalizeInvoiceNumber(request?.payload?.invoiceNumber);
  return Boolean(annotations?.[key])||assessmentIssue||invoiceNumberMismatch
    ||!String(field.value??'').trim()
    ||!Number.isFinite(Number(field.confidence))
    ||Number(field.confidence)<aiConfidenceThresholds[key]
    ||!String(field.evidence||'').trim();
}
function renderIdentifierConfirmations(request,ai,annotations) {
  const required=Object.keys(identifierConfirmationFields).filter(key=>needsIdentifierConfirmation(key,request,ai,annotations));
  if(!required.length) return '';
  const fields=required.map(key=>{
    const field=ai?.fields?.[key]||{},definition=identifierConfirmationFields[key];
    const value=String(field.value??'');
    const confidence=Math.round((Number(field.confidence)||0)*100);
    return `<div class="identifier-confirmation" data-identifier-confirmation="${key}"><label class="field" for="verified-${key}">${definition.label} theo hóa đơn<input id="verified-${key}" type="text" maxlength="${definition.maximum}" value="${esc(value)}" data-verified-identifier="${key}" autocomplete="off" aria-describedby="verified-${key}-help"></label><small id="verified-${key}-help" class="identifier-source">AI đọc: ${esc(value||'Chưa đọc được')} · ${confidence}%${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}</small><button class="secondary-button verify-identifier-button" type="button" data-verify-identifier="${key}" aria-pressed="false">Xác nhận giá trị trên PDF</button></div>`;
  }).join('');
  return `<section class="identifier-verification"><h4>Đối chiếu thông tin dùng phát hiện hóa đơn trùng</h4><p>Đọc đúng giá trị in trên PDF. Nếu AI đọc sai, sửa ô bên dưới rồi bấm xác nhận. Giá trị này sẽ được lưu kèm người xác nhận và dùng để so MST + số hóa đơn với hồ sơ đã duyệt. Nếu không đọc rõ trên PDF, để hồ sơ ở hàng quản lý.</p><div class="identifier-confirmation-list">${fields}</div></section>`;
}
function renderSubmittedForm(request,annotations) {
  const missing=new Set(request?.checks?.form_missing_fields||[]);
  const rows=formReviewFields.map(field=>{
    const value=field.read?field.read(request.payload?.[field.key],request):request.payload?.[field.key];
    const annotation=field.analysisKey?annotations[field.analysisKey]:null;
    const isMissing=missing.has(field.key)||(field.key==='buyerCompany'&&missing.has('buyerCompany'));
    const state=isMissing?'purple':annotation?.state||'';
    const note=isMissing?'<small class="review-mark-note">Thiếu thông tin — cần người nộp bổ sung.</small>':annotation?`<small class="review-mark-note">${annotation.notes.map(esc).join(' ')}</small>`:field.reviewNote?`<small class="review-unchecked-note">${esc(field.reviewNote)}</small>`:'';
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
// Older saved assessments may contain date flags; date is now display-only.
const withoutInvoiceDateAssessmentIssues = value => String(value||'')
  .replace(/(?:^|\s)(?:Không đọc rõ ngày hóa đơn|Độ tin cậy khi đọc ngày hóa đơn dưới \d+%|Thiếu bằng chứng đọc ngày hóa đơn|Ngày hóa đơn không có định dạng YYYY-MM-DD hợp lệ|Ngày hóa đơn trên PDF không khớp form)\.\s*/giu,' ')
  .replace(/Vui lòng kiểm tra và bổ sung\/cập nhật:\s*$/iu,'')
  .replace(/\s+/g,' ')
  .trim();
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
async function openRequest(id,fromVendorNote=false) {
  const requestEpoch=epoch;
  let r=rows.find(x=>x.id===id);
  if(!r&&fromVendorNote&&profile?.role==='cfo') {
    try {r=await api.getRequest(id);} catch(error) {notify('Không mở được hồ sơ nhà cung cấp: '+error.message,true);return;}
    if(requestEpoch!==epoch||profile?.role!=='cfo') return;
  }
  if(!r) return;
  clearPdfViewer(); selected=r; selectedFromVendorNote=fromVendorNote; const run=epoch;
  const isReviewer=profile.role==='treasurer'||profile.role==='cfo';
  const mayReview=(profile.role==='treasurer'&&(r.status==='TREASURER_REVIEW'||(r.status==='READY_FOR_APPROVAL'&&Number(r.amount)<=20000000)))||
    (profile.role==='cfo'&&(r.status==='CFO_REVIEW'||(r.status==='READY_FOR_APPROVAL'&&Number(r.amount)>20000000)));
  const manualChecks=profile.role==='treasurer'&&r.status==='TREASURER_REVIEW';
  const ai=r.checks?.ai;
  const visibleReason=withoutInvoiceDateAssessmentIssues(r.reason);
  const visibleQuestion=withoutInvoiceDateAssessmentIssues(ai?.assessment?.question);
  const annotations=buildReviewAnnotations(r,ai);
  const metadata={ 'Người đề nghị':r.payload.requester,'Bộ phận':r.payload.department,'Công ty mua trên hóa đơn':r.payload.buyerCompany,'Mục đích':r.payload.purpose,'Nhà cung cấp':r.payload.vendor,'Số hóa đơn':r.payload.invoiceNumber,'Ngày hóa đơn':r.payload.invoiceDate,'Mã ngân sách':r.payload.budgetCode };
  const reviewLayout=isReviewer?`<div class="reviewer-layout"><section class="submitted-form-panel"><div class="review-pane-heading"><span class="eyebrow">BÊN TRÁI · FORM NGƯỜI NỘP</span><h3>Thông tin đã gửi</h3><p class="muted">Các giá trị giữ nguyên như lúc nộp hồ sơ.</p></div><div class="review-legend"><span class="legend-yellow"><i></i>Vàng · AI chưa đọc chắc</span><span class="legend-red"><i></i>Đỏ · sai lệch đã rõ</span><small>Trường khớp và đủ rõ không đánh dấu.</small></div>${renderSubmittedForm(r,annotations)}</section><section class="invoice-review-panel"><div class="review-pane-heading"><span class="eyebrow">BÊN PHẢI · MINH CHỨNG</span><h3>Hóa đơn PDF</h3><p class="muted">Các khung màu chỉ vị trí cần kiểm tra trên hóa đơn.</p></div><div id="reviewPdfToolbar" class="pdf-toolbar hidden"><button id="reviewPdfPrevious" type="button" aria-label="Trang trước">‹</button><span id="reviewPdfPageLabel">Trang 1</span><button id="reviewPdfNext" type="button" aria-label="Trang sau">›</button><span class="pdf-toolbar-spacer"></span><button id="reviewPdfZoomOut" type="button" aria-label="Thu nhỏ">−</button><button id="reviewPdfZoomIn" type="button" aria-label="Phóng to">＋</button></div><p id="reviewPdfStatus" class="muted">Đang mở hóa đơn…</p><div id="reviewPdfWrap" class="pdf-viewer-wrap"><div id="reviewPdfStage" class="pdf-stage" tabindex="0" aria-label="Trang hóa đơn và các vùng cần kiểm tra"></div></div><div class="invoice-issues"><h4>Ghi chú cần kiểm tra</h4><div id="invoiceIssueList">${renderInvoiceNotes(annotations,ai)}</div></div></section></div>${renderAiAnalysis(ai,r)}`:`<div class="decision-meta">${Object.entries(metadata).map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div>${renderAiAnalysis(ai,r)}<section class="invoice-preview"><h3>Hóa đơn PDF</h3><p id="invoicePreviewStatus" class="muted">Đang mở hóa đơn…</p><iframe id="invoicePreview" title="Hóa đơn PDF" class="hidden"></iframe></section>`;
  const reviewerMessage=profile.role==='cfo'
    ?r.checks?.manager_verified?'<p class="review-clear-note">Quản lý tài chính đã kiểm tra các điểm cần xác minh; dữ kiện dưới đây đã được xác nhận trước khi chuyển CFO.</p><p class="muted">Giám đốc duyệt hồ sơ vượt thẩm quyền hoặc được chuyển lên do tổng duyệt trong ngày. Lý do được lưu vào nhật ký.</p>':'<p class="muted">AI đã đánh giá hóa đơn clear. Hồ sơ vượt thẩm quyền hoặc được quản lý chuyển lên đang chờ CFO; lý do duyệt được lưu vào nhật ký.</p>'
    :manualChecks
      ?`<p class="muted">Hồ sơ có điểm cần xác minh. Quản lý tài chính kiểm tra hóa đơn và form trước; nếu được xác nhận nhưng vượt 20 triệu/hồ sơ hoặc tổng 100 triệu/ngày, hệ thống chuyển Giám đốc cấp quyền.</p>${renderIdentifierConfirmations(r,ai,annotations)}<div class="review-checks">${Object.entries(checkLabels).map(([k,v])=>`<label class="plain-check"><input type="checkbox" name="${k}">${v}</label>`).join('')}</div>`
      :'<p class="muted">AI đã đánh giá hóa đơn đạt điều kiện. Quản lý không cần kiểm tra lại từng hồ sơ; hãy xem tổng danh sách và số dư hạn mức ngày rồi duyệt riêng hoặc duyệt cả danh sách.</p>';
  const reviewForm=mayReview?`<form id="reviewForm" class="review-form">${reviewerMessage}<label class="field">${profile.role==='cfo'?'Lý do duyệt':'Ghi chú kiểm tra / nội dung cần bổ sung'}<textarea id="reviewReason" maxlength="2000" rows="3" placeholder="${profile.role==='cfo'?'Bắt buộc khi Giám đốc duyệt':'Bắt buộc khi yêu cầu bổ sung hoặc từ chối'}"></textarea></label><div class="decision-actions"><button class="action-secondary" type="button" data-action="clarify">Yêu cầu bổ sung</button><button class="action-secondary" type="button" data-action="reject">Từ chối</button><button class="action-primary" type="button" data-action="approve">${profile.role==='cfo'?'Duyệt và ghi lý do':manualChecks?'Xác nhận đã kiểm tra và xử lý':'Duyệt hóa đơn'}</button></div></form>`:'';
  const bannerClass={APPROVED:'ready',READY_FOR_APPROVAL:'ready',REJECTED:'reject',CFO_REVIEW:'cfo-wait',NEEDS_INFO:'missing',TREASURER_REVIEW:'review'}[r.status]||'review';
  const aiClear=['CLEAR','U3'].includes(ai?.assessment?.code);
  const aiBadge=aiClear&&r.status==='CFO_REVIEW'?'<span class="ai-clear-badge">AI clear</span>':'';
  $('decisionResult').innerHTML=`<div class="decision-banner ${bannerClass}"><div><strong>${statuses[r.status]||esc(r.status)}</strong><small>PAY-${esc(r.id.slice(0,8))} · phiên bản ${r.version}</small></div>${aiBadge}</div><h2 class="detail-amount">${r.amount==null?'Chưa điền':money(r.amount)} <small>theo form</small></h2>${visibleReason?`<p class="notice">${esc(visibleReason)}</p>`:''}${visibleQuestion?`<p class="notice">${esc(visibleQuestion)}</p>`:''}${reviewLayout}<div class="scope-note compact"><strong>Chưa kiểm tra:</strong> ngân sách theo mã, chính sách chi tiêu, MST doanh nghiệp, NCC được duyệt, PO và lịch sử hóa đơn/thanh toán. AI không xác thực nguồn phát hành hoặc chữ ký số.</div>${reviewForm}${profile.role==='applicant'&&r.status==='NEEDS_INFO'?'<button class="primary-button clay-button" id="supplementButton">Bổ sung và gửi lại</button>':''}`;
  if(profile.role==='applicant'&&r.status==='NEEDS_INFO') {
    const panel=document.createElement('section');
    panel.className='u1-feedback';
    panel.innerHTML=`<h3>Thiếu thông tin cần bổ sung</h3><p>Các trường màu tím cần người nộp kiểm tra trước khi gửi lại.</p>${renderSubmittedForm(r,{})}`;
    $('decisionResult').querySelector('.detail-amount')?.after(panel);
  }
  if(manualChecks&&managerMustAskCfo(r)) {
    const confirmButton=$('decisionResult').querySelector('[data-action="approve"]');
    if(confirmButton) confirmButton.textContent='Đã kiểm tra · xin CFO duyệt';
  }
  $('decisionResult').querySelectorAll('[data-verify-identifier]').forEach(button=>{
    const key=button.dataset.verifyIdentifier;
    const input=$(`verified-${key}`);
    if(!input) return;
    input.addEventListener('input',()=>{
      button.dataset.confirmed='false';
      button.setAttribute('aria-pressed','false');
      button.classList.remove('is-confirmed');
      button.textContent='Xác nhận giá trị trên PDF';
    });
    button.onclick=()=>{
      const value=input.value.trim(),definition=identifierConfirmationFields[key];
      if(value.length<definition.minimum||value.length>definition.maximum
        ||(definition.pattern&&!new RegExp(definition.pattern).test(value))) {
        notify(`${definition.label} không đúng định dạng hoặc độ dài. Hãy đối chiếu lại PDF.`,true); return;
      }
      button.dataset.confirmed='true';
      button.setAttribute('aria-pressed','true');
      button.classList.add('is-confirmed');
      button.textContent='Đã xác nhận theo PDF';
    };
  });
  $('reviewForm')?.addEventListener('submit',event=>event.preventDefault());
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
    updateBuyerModeUI();
    markMissingFormFields(r.checks?.form_missing_fields||[]);
    $('invoiceFile').value='';
    $('formTitle').textContent='Bổ sung PAY-'+r.id.slice(0,8); $('submitButton').textContent='Gửi lại để phân tích →';
    $('request-card').scrollIntoView({behavior:'smooth'}); notify('Tải lại hóa đơn PDF cho phiên bản bổ sung.');
  };
  $('auditList').textContent='Đang tải nhật ký…';
  try { const audit=await api.audit(id); if(epoch!==run||selected?.id!==id) return;
    $('auditList').innerHTML=audit.map(a=>`<div class="audit-item"><span class="audit-dot purple"></span><div><strong>${esc(roles[a.actor_role]||a.actor_role)} · ${esc(statuses[a.new_status]||a.new_status)}</strong><p>${esc(a.reason)}</p><small>${esc(time(a.created_at))} · phiên bản ${a.version}</small></div></div>`).join('');
  } catch(e) {if(epoch===run&&selected?.id===id) $('auditList').textContent='Không tải được nhật ký: '+e.message;}
}
function setBusy(value) {busy=value; $('submitButton').disabled=value; $('logoutButton').disabled=value; document.querySelectorAll('[data-action],[data-batch-action],[data-approve-id],[data-verify-identifier],[data-verified-identifier]').forEach(b=>b.disabled=value); renderApprovalTools();}
async function submitApprovalBatch(items,reason='') {
  if(busy||!items?.length) return;
  if(!dailySummary) {notify('Chưa tải được số tiền đã duyệt hôm nay. Hãy làm mới danh sách trước khi duyệt.',true);return;}
  if(profile.role==='cfo'&&!reason.trim()) {notify('Giám đốc cần ghi lý do cấp quyền trước khi duyệt.',true);return;}
  setBusy(true);
  try {
    const result=await api.rpc('review_requests_batch',{p_requests:items.map(r=>({id:r.id,version:r.version})),p_reason:reason.trim()});
    const outcome=Array.isArray(result)?result[0]:result;
    notify(outcome?.duplicate_count>0
      ?`Đã từ chối ${outcome.duplicate_count} hóa đơn trùng MST và số hóa đơn; ${outcome.invoice_count} hồ sơ còn lại được ${outcome.status==='CFO_REVIEW'?'chuyển CFO':'xử lý theo hạn mức'}.`
      :outcome?.status==='CFO_REVIEW'
        ?`${outcome.invoice_count} hóa đơn được chuyển lên Giám đốc vì tổng đợt vượt hạn mức ngày.`
        :`${profile.role==='cfo'?'Giám đốc':'Quản lý'} đã duyệt ${outcome?.invoice_count||items.length} hóa đơn, tổng ${money(Number(outcome?.requested_total)||items.reduce((sum,r)=>sum+Number(r.amount),0))}.`);
    if(profile.role==='cfo') $('batchReason').value='';
  } catch(error) {notify(error.message,true);} finally {setBusy(false);await refresh();}
}
function approveQueueItem(r) {
  if(!r) return;
  const reason=profile.role==='cfo'?$('batchReason').value.trim():'';
  submitApprovalBatch([r],reason);
}
function approveAllQueue() {
  const items=approvalQueue();
  if(!items.length) return;
  const reason=profile.role==='cfo'?$('batchReason').value.trim():'';
  submitApprovalBatch(items,reason);
}
async function review(r,action) {
  if(busy) return;
  const reason=$('reviewReason').value.trim();
  if(action!=='approve'&&!reason) {notify('Hãy ghi rõ lý do hoặc nội dung cần bổ sung.',true);return;}
  if(action==='approve'&&['treasurer','cfo'].includes(profile.role)&&!dailySummary) {notify('Chưa tải được tổng đã duyệt trong ngày. Hãy làm mới trước khi duyệt.',true);return;}
  if(action==='approve'&&profile.role==='cfo'&&!reason) {notify('Giám đốc cần ghi lý do cấp quyền trước khi duyệt.',true);return;}
  if(action==='approve'&&profile.role==='treasurer'&&r.status==='READY_FOR_APPROVAL') {
    await submitApprovalBatch([r]); return;
  }
  if(action==='approve'&&profile.role==='cfo'&&(r.status==='CFO_REVIEW'||(r.status==='READY_FOR_APPROVAL'&&Number(r.amount)>20000000))) {
    await submitApprovalBatch([r],reason); return;
  }
  const checks={}; document.querySelectorAll('#reviewForm input[type=checkbox]').forEach(c=>checks[c.name]=c.checked);
  if(action==='approve'&&profile.role==='treasurer'&&r.status==='TREASURER_REVIEW') {
    const verifiedIdentifiers={};
    for(const [key,definition] of Object.entries(identifierConfirmationFields)) {
      const input=$(`verified-${key}`),button=document.querySelector(`#decisionResult [data-verify-identifier="${key}"]`);
      if(!input||!button) continue;
      const value=input.value.trim();
      if(button.dataset.confirmed!=='true') {
        notify(`Hãy đối chiếu và xác nhận ${definition.label} từ PDF trước khi duyệt.`,true); return;
      }
      if(value.length<definition.minimum||value.length>definition.maximum
        ||(definition.pattern&&!new RegExp(definition.pattern).test(value))) {
        notify(`${definition.label} không đúng định dạng hoặc độ dài.`,true); return;
      }
      verifiedIdentifiers[key]={value,confirmed:true};
    }
    if(Object.keys(verifiedIdentifiers).length) checks.verified_identifiers=verifiedIdentifiers;
  }
  if(action==='approve'&&profile.role==='treasurer'&&r.status==='TREASURER_REVIEW') {
    const result=FinRefRules.assess(r.amount,{pdf:checks.invoice,fieldsMatch:checks.fields_match,totalsConsistent:checks.total_includes_vat,confidenceSufficient:true});
    if(result==='U1') {notify('Hồ sơ còn thiếu trường bắt buộc hoặc PDF; chưa thể xác nhận duyệt.',true);return;}
    if(result==='U2') {notify('Còn điểm cần quản lý xác minh. Hãy kiểm tra PDF/form và xác nhận đủ các mục trước khi duyệt hoặc chuyển CFO.',true);return;}
  }
  setBusy(true);
  try {
    const result=await api.rpc('review_request',{p_id:r.id,p_expected_version:r.version,p_action:action,p_reason:reason,p_checks:checks});
    notify(result?.status==='CFO_REVIEW'?'Quản lý tài chính đã xác nhận kiểm tra; hồ sơ chuyển Giám đốc cấp quyền.':result?.status==='APPROVED'&&profile.role==='cfo'?'Giám đốc đã cấp quyền và duyệt hồ sơ.':result?.status==='APPROVED'?'Quản lý tài chính đã duyệt hồ sơ trong hạn mức.':'Đã lưu quyết định và nhật ký.');
  }
  catch(e) {notify(e.message,true);} finally {setBusy(false);await refresh();}
}
function validateFile(file,invoice=false) {
  if(!file||file.size===0||file.size>10485760||!['application/pdf','image/jpeg','image/png'].includes(file.type)) throw new Error('Mỗi minh chứng phải là PDF/JPG/PNG, không rỗng và tối đa 10 MB.');
  if(invoice&&file.type!=='application/pdf') throw new Error('Hóa đơn trong đợt này phải là PDF, có thể là PDF chữ hoặc PDF scan.');
  return {'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png'}[file.type];
}
$('vendorCreateForm').onsubmit=async event=>{
  event.preventDefault(); if(vendorSaving||!['treasurer','cfo'].includes(profile?.role)) return;
  vendorSaving=true; renderVendorDirectory();
  try {
    await api.saveVendor(null,$('vendorLegalName').value.trim(),$('vendorTaxCode').value.trim(),[]);
    $('vendorCreateForm').reset();
    await refreshVendorDirectory();
    notify('Đã thêm nhà cung cấp. Tên pháp lý đã được đưa vào danh sách chọn cho người nộp.');
  } catch(error) {notify('Chưa thêm được nhà cung cấp: '+error.message,true);}
  finally {vendorSaving=false;renderVendorDirectory();}
};
$('vendorAliasForm').onsubmit=async event=>{
  event.preventDefault(); if(vendorSaving||!['treasurer','cfo'].includes(profile?.role)) return;
  const vendor=vendors.find(item=>item.vendor_id===$('vendorAliasTarget').value);
  if(!vendor) {notify('Hãy chọn nhà cung cấp trong danh mục.',true);return;}
  vendorSaving=true; renderVendorDirectory();
  try {
    const alias=$('vendorAliasName').value.trim();
    await api.saveVendor(vendor.vendor_id,vendor.legal_name,vendor.tax_code||'',[
      ...(Array.isArray(vendor.aliases)?vendor.aliases:[]),alias
    ]);
    $('vendorAliasForm').reset();
    await refreshVendorDirectory();
    notify(`Đã xác minh và thêm bí danh “${alias}” cho ${vendor.legal_name}.`);
  } catch(error) {notify('Chưa thêm được bí danh: '+error.message,true);}
  finally {vendorSaving=false;renderVendorDirectory();}
};
$('vendorSearch').oninput=renderVendorDirectory;
$('paymentForm').onsubmit=async event=>{
  event.preventDefault(); if(busy||profile?.role!=='applicant') return;
  setBusy(true);
  try {
    const invoice=$('invoiceFile').files[0];
    const invExt=validateFile(invoice,true);
    const payload=Object.fromEntries(fields.map(k=>[k,$(k).value.trim()])); payload.amount=payload.amount===''?null:Number(payload.amount); payload.invoiceType='electronic';
    const folder=profile.id+'/'+crypto.randomUUID();
    const invoicePath=folder+'/invoice.'+invExt;
    notify('Đang tải hóa đơn và gửi hồ sơ…');
    await api.upload(invoicePath,invoice);
    const result=await api.rpc('submit_request',{p_id:editing?.id||crypto.randomUUID(),p_payload:payload,p_invoice_path:invoicePath,p_request_path:null,p_expected_version:editing?.version||0});
    resetForm();
    if(result.status==='NEEDS_INFO') {
      notify('Hồ sơ được gửi nhưng còn thiếu thông tin. Các trường cần bổ sung được đánh dấu màu tím.');
      setBusy(false); await refresh(); await openRequest(result.id); return;
    }
    notify('Đã tải hóa đơn. AI đang đọc và đối chiếu thông tin…');
    try {
      const verification=await api.analyzeEvidence(result.id);
      notify(verification.status==='READY_FOR_APPROVAL'?'AI đã đánh giá hóa đơn đủ điều kiện; hóa đơn dưới 20 triệu vào danh sách chờ Quản lý duyệt.':verification.status==='CFO_REVIEW'?'AI đã đánh giá hóa đơn đủ điều kiện; do trên 20 triệu, hồ sơ vào danh sách chờ Giám đốc duyệt.':verification.status==='TREASURER_REVIEW'?'AI gắn cờ điểm cần xem; hồ sơ đã chuyển Quản lý Tài chính kiểm tra trước.':verification.status==='NEEDS_INFO'?'Hồ sơ cần bổ sung thông tin.':'AI đã ghi kết quả phân tích.');
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
$('batchReason').oninput=renderRows;
$('approveAllButton').onclick=approveAllQueue;
$('cancelEdit').onclick=()=>{if(!busy)resetForm();};
$('newRequest').onclick=()=>{if(!busy)resetForm();};
$('buyerMode').onchange=updateBuyerModeUI;
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
