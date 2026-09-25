'use strict';
const $ = id => document.getElementById(id);
const api = new FinRefApi(window.FINREF_CONFIG || {});
const money = n => new Intl.NumberFormat('vi-VN').format(n) + ' ₫';
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles={applicant:'Người nộp đơn',treasurer:'Quản lý tài chính',cfo:'Người đứng đầu nhánh tài chính'};
const statuses={TREASURER_REVIEW:'Chờ quản lý tài chính kiểm tra',READY_FOR_APPROVAL:'Sẵn sàng duyệt',CFO_REVIEW:'Chờ người đứng đầu nhánh tài chính',NEEDS_INFO:'Cần bổ sung',APPROVED:'Đã duyệt',REJECTED:'Từ chối'};
const checkLabels={invoice:'Đã xem hóa đơn PDF',fields_match:'Nhà cung cấp, số và ngày hóa đơn khớp form',total_includes_vat:'Tổng thanh toán trên form đã gồm VAT và khớp hóa đơn'};
const fields=['requesterType','requester','department','purpose','vendor','invoiceNumber','invoiceDate','amount'];
const aiFieldLabels={vendor:'Nhà cung cấp',taxCode:'Mã số thuế NCC',invoiceNumber:'Số hóa đơn',invoiceDate:'Ngày hóa đơn',amountBeforeTax:'Tiền trước thuế',vatAmount:'VAT',totalAmount:'Tổng thanh toán gồm VAT'};
const aiMoneyFields=new Set(['amountBeforeTax','vatAmount','totalAmount']);
let profile=null, rows=[], selected=null, editing=null, timer=null, loading=false, busy=false, epoch=0;
function notify(text,error=false,login=false) { const el=$(login?'loginMessage':'message'); el.textContent=text; el.classList.toggle('error',error); }
function time(value) { return new Date(value).toLocaleString('vi-VN'); }
function showLogin() {
  epoch++; clearInterval(timer); profile=null; rows=[]; selected=null; editing=null;
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
    const readableMoney=Number.isSafeInteger(raw)&&(raw>0||(key==='vatAmount'&&raw===0&&Number(field.confidence)>0));
    const value=aiMoneyFields.has(key)?(readableMoney?money(raw):'Chưa đọc được'):String(raw||'Chưa đọc được');
    return `<div class="invoice-field"><div class="invoice-field-main"><strong>${label}</strong><span>${esc(value)}</span></div><small>Độ tin cậy ${Math.round((Number(field.confidence)||0)*100)}%${field.evidence?` · Bằng chứng: ${esc(field.evidence)}`:''}</small></div>`;
  }).join('');
  return `<section class="invoice-analysis"><h3>Kết quả đọc PDF</h3>${lines}<p class="muted">Hạn mức tháng được kiểm tra tại bước phê duyệt; AI không xác thực nguồn phát hành hay chữ ký số.</p></section>`;
}
function renderDuplicateFlags(flags) {
  if(!flags||(!flags.exact&&!flags.near)) return '';
  const matches=Array.isArray(flags.matches)?flags.matches:[];
  const label=flags.exact?'Có hồ sơ trùng chính xác cần đối chiếu':'Có hồ sơ gần giống cần đối chiếu';
  const items=matches.map(m=>`<li>PAY-${esc(String(m.request_id||m.requestId||'').slice(0,8))} · ${esc(statuses[m.status]||m.status||'')} · HĐ ${esc(m.invoice_number||m.invoiceNumber||'')} · ${esc(m.invoice_date||m.invoiceDate||'')} · ${money(Number(m.amount)||0)}</li>`).join('');
  return `<section class="duplicate-warning" role="alert"><strong>⚠ ${label}</strong><p>Đây là cờ để người duyệt kiểm tra; hệ thống không tự kết luận gian lận hoặc tự chặn duyệt.</p>${items?`<ul>${items}</ul>`:''}</section>`;
}
async function openRequest(id) {
  const r=rows.find(x=>x.id===id); if(!r) return; selected=r; const run=epoch;
  const clarifyOnly=profile.role==='treasurer'&&r.status==='NEEDS_INFO';
  const mayReview=clarifyOnly||(profile.role==='treasurer'&&['TREASURER_REVIEW','READY_FOR_APPROVAL'].includes(r.status))||(profile.role==='cfo'&&r.status==='CFO_REVIEW');
  const manualChecks=profile.role==='treasurer'&&r.status==='TREASURER_REVIEW';
  const metadata={ 'Người đề nghị':r.payload.requester,'Bộ phận':r.payload.department,'Mục đích':r.payload.purpose,'Nhà cung cấp':r.payload.vendor,'Số hóa đơn':r.payload.invoiceNumber,'Ngày hóa đơn':r.payload.invoiceDate };
  $('decisionResult').innerHTML=`<div class="decision-banner ${r.status==='APPROVED'?'ready':r.status==='REJECTED'?'reject':r.status==='READY_FOR_APPROVAL'?'ready':'escalate'}"><div><strong>${statuses[r.status]||esc(r.status)}</strong><small>PAY-${esc(r.id.slice(0,8))} · phiên bản ${r.version}</small></div></div><h2 class="detail-amount">${money(r.amount)} <small>đã gồm VAT</small></h2><div class="decision-meta">${Object.entries(metadata).map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div><p class="notice">${esc(r.reason)}</p>${r.checks?.ai?.assessment?.question?`<p class="notice">${esc(r.checks.ai.assessment.question)}</p>`:''}${renderAiAnalysis(r.checks?.ai)}${profile.role==='applicant'?'':renderDuplicateFlags(r.checks?.duplicate_flags)}<div class="scope-note compact">Ngân sách chung được tính tại bước duyệt. <strong>Chưa kiểm tra:</strong> U2/chính sách chi tiết, MST công ty, NCC được duyệt, PO và lịch sử hóa đơn/thanh toán. AI không xác thực nguồn hóa đơn hoặc chữ ký số.</div><div class="evidence-actions"><button class="secondary-button clay-button" data-file="invoice_path">Xem hóa đơn PDF</button><button class="secondary-button clay-button" data-file="request_path">Xem đơn đề nghị</button></div><div id="evidenceLink" aria-live="polite"></div>
  ${mayReview?`<form id="reviewForm">${clarifyOnly?'<p class="muted">Hồ sơ đang chờ người nộp bổ sung. Nếu PDF mờ hoặc khó đọc, bạn có thể yêu cầu gửi bản rõ hơn; trạng thái này không thể được phê duyệt.</p>':manualChecks?`<p class="muted">AI chưa hoàn tất phân tích. Hãy mở minh chứng và xác nhận các dữ kiện hóa đơn trước khi duyệt.</p><div class="review-checks">${Object.entries(checkLabels).map(([k,v])=>`<label class="plain-check"><input type="checkbox" name="${k}">${v}</label>`).join('')}</div>`:profile.role==='treasurer'?'<p class="muted">AI đã hoàn tất các kiểm tra hiện có. Bạn vẫn là người quyết định bấm duyệt cuối.</p>':'<p class="muted">Đây là bước phê duyệt cuối của người đứng đầu nhánh tài chính.</p>'}<label class="field">Lý do / nội dung cần bổ sung<textarea id="reviewReason" maxlength="2000" rows="3" placeholder="${clarifyOnly?'Nêu trang hoặc thông tin cần gửi lại rõ hơn':'Bắt buộc khi yêu cầu bổ sung hoặc từ chối'}"></textarea></label><div class="decision-actions">${clarifyOnly?'<button class="action-primary" type="button" data-action="clarify">Yêu cầu gửi lại PDF rõ hơn</button>':`<button class="action-secondary" type="button" data-action="clarify">Yêu cầu bổ sung</button><button class="action-secondary" type="button" data-action="reject">Từ chối</button><button class="action-primary" type="button" data-action="approve">${profile.role==='treasurer'&&r.amount>20000000?'Xác nhận & chuyển người đứng đầu nhánh tài chính':'Phê duyệt cuối'}</button>`}</div></form>`:''}
  ${profile.role==='applicant'&&r.status==='NEEDS_INFO'?'<button class="primary-button clay-button" id="supplementButton">Bổ sung và gửi lại</button>':''}`;
  $('decisionResult').querySelectorAll('[data-file]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try {const url=await api.signedUrl(r[b.dataset.file]); if(epoch===run&&selected?.id===id) $('evidenceLink').innerHTML=`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Mở minh chứng trong tab mới ↗</a><p class="muted">Liên kết có hiệu lực 60 giây.</p>`;}
    catch(e) {notify(e.message,true);} finally {b.disabled=false;}
  });
  $('decisionResult').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>review(r,b.dataset.action));
  if($('supplementButton')) $('supplementButton').onclick=()=>{
    editing={id:r.id,version:r.version}; fields.forEach(k=>$(k).value=r.payload[k]??'');
    $('invoiceFile').value=''; $('requestFile').value='';
    $('formTitle').textContent='Bổ sung PAY-'+r.id.slice(0,8); $('submitButton').textContent='Gửi lại để phân tích →';
    $('request-card').scrollIntoView({behavior:'smooth'}); notify('Tải lại đủ hai minh chứng cho phiên bản bổ sung.');
  };
  $('auditList').textContent='Đang tải nhật ký…';
  try { const audit=await api.audit(id); if(epoch!==run||selected?.id!==id) return;
    $('auditList').innerHTML=audit.map(a=>`<div class="audit-item"><span class="audit-dot purple"></span><div><strong>${esc(roles[a.actor_role]||a.actor_role)} · ${esc(statuses[a.new_status]||a.new_status)}</strong><p>${esc(a.reason)}</p><small>${esc(time(a.created_at))} · phiên bản ${a.version}</small></div></div>`).join('');
  } catch(e) {if(epoch===run&&selected?.id===id) $('auditList').textContent='Không tải được nhật ký: '+e.message;}
}
function setBusy(value) {busy=value; $('submitButton').disabled=value; $('logoutButton').disabled=value; document.querySelectorAll('[data-action]').forEach(b=>b.disabled=value);}
function confirmBudgetApproval(r,summary) {
  if(Array.isArray(summary)) summary=summary[0]||{};
  const spent=Number(summary.approved_total)||0,amount=Number(r.amount)||0;
  const projected=Number(summary.projected_total)||spent+amount,cap=Number(summary.cap)||200000000;
  const remaining=Number(summary.remaining_after)||Math.max(cap-projected,0),exceeded=Number(summary.exceeded_by)||Math.max(projected-cap,0);
  const routeToCfo=profile.role==='treasurer'&&(amount>20000000||projected>cap),needsReason=profile.role==='cfo'&&projected>cap;
  const dialog=$('approvalDialog'),confirmButton=$('confirmApproval'),cancelButton=$('cancelApproval');
  $('approvalTitle').textContent=routeToCfo?'Chuyển cấp xác nhận':'Xác nhận phê duyệt';
  $('approvalMonth').textContent='Tháng ngân sách: '+String(summary.month_start||'').slice(0,7)+' · Việt Nam';
  $('budgetSummaryRows').innerHTML=[['Đã duyệt trong tháng',money(spent)],['Hồ sơ này',money(amount)],['Tổng dự kiến sau quyết định',money(projected)],[exceeded?'Vượt hạn mức':'Còn lại',money(exceeded||remaining)]].map(([l,v])=>'<div class="budget-summary-row"><span>'+esc(l)+'</span><strong>'+esc(v)+'</strong></div>').join('');
  $('approvalWarning').textContent=needsReason?'Tổng dự kiến vượt hạn mức. CFO cần ghi lý do ngoại lệ; khoản này chỉ được tính sau khi phê duyệt.':routeToCfo?'Hồ sơ sẽ chuyển CFO xác nhận. Hồ sơ chờ duyệt chưa bị trừ ngân sách.':projected>=160000000?'Cảnh báo: tổng dự kiến đã đạt ít nhất 80% hạn mức tháng.':'Chỉ hồ sơ đã được phê duyệt mới được tính vào ngân sách.';
  $('approvalReasonWrap').classList.toggle('hidden',!needsReason); $('approvalReason').value='';
  confirmButton.textContent=routeToCfo?'Chuyển CFO xác nhận':'Xác nhận duyệt'; confirmButton.disabled=needsReason; dialog.showModal();
  return new Promise(resolve=>{const finish=v=>{confirmButton.onclick=null;cancelButton.onclick=null;dialog.oncancel=null;dialog.close();resolve(v);};
    cancelButton.onclick=()=>finish(null); dialog.oncancel=e=>{e.preventDefault();finish(null);};
    if(needsReason) $('approvalReason').oninput=()=>{confirmButton.disabled=!$('approvalReason').value.trim();};
    confirmButton.onclick=()=>finish({reason:needsReason?$('approvalReason').value.trim():''});
  });
}
async function review(r,action) {
  if(busy)return; const reason=$('reviewReason').value.trim();
  if(action!=='approve'&&!reason){notify('Hãy ghi rõ lý do hoặc nội dung cần bổ sung.',true);return;}
  const checks={}; document.querySelectorAll('#reviewForm input[type=checkbox]').forEach(c=>checks[c.name]=c.checked);
  if(action==='approve'&&profile.role==='treasurer'&&r.status==='TREASURER_REVIEW'){
    const result=FinRefRules.assess(r.amount,{pdf:checks.invoice,fieldsMatch:checks.fields_match,totalsConsistent:checks.total_includes_vat,confidenceSufficient:true});
    if(result==='U1'){notify('U1: chưa đủ xác nhận về PDF, trường form hoặc tổng thanh toán gồm VAT. Hãy kiểm tra minh chứng hoặc yêu cầu bổ sung.',true);return;}
  }
  setBusy(true);
  try{
    let decisionReason=reason;
    if(action==='approve'){const raw=await api.rpc('approval_budget_summary',{p_amount:r.amount});const summary=Array.isArray(raw)?raw[0]:raw;const confirmed=await confirmBudgetApproval(r,summary);if(!confirmed)return;if(confirmed.reason)decisionReason=confirmed.reason;}
    const raw=await api.rpc('review_request',{p_id:r.id,p_expected_version:r.version,p_action:action,p_reason:decisionReason,p_checks:checks});const result=Array.isArray(raw)?raw[0]:raw;
    if(result&&result.status==='APPROVED'){const data=await api.rpc('approval_budget_summary',{p_amount:0});const s=Array.isArray(data)?data[0]:data;notify('Đã duyệt. Tháng '+String(s.month_start||'').slice(0,7)+': đã duyệt '+money(s.approved_total)+' / '+money(s.cap)+', còn '+money(s.remaining_after)+'.');}
    else if(result&&result.status==='CFO_REVIEW')notify('Hồ sơ được chuyển CFO xác nhận; chưa bị tính vào ngân sách.');
    else notify('Đã lưu quyết định và nhật ký.');
  }catch(e){notify(e.message,true);}finally{setBusy(false);await refresh();}
}
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
