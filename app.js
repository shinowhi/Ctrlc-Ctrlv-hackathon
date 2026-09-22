'use strict';
const $ = id => document.getElementById(id);
const api = new FinRefApi(window.FINREF_CONFIG || {});
const money = n => new Intl.NumberFormat('vi-VN').format(n) + ' ₫';
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles={applicant:'Người nộp đơn',treasurer:'Thủ quỹ',cfo:'Giám đốc Tài chính',agent:'Tác tử FinRef'};
const statuses={TREASURER_REVIEW:'Chờ thủ quỹ',CFO_REVIEW:'Chờ GĐTC',NEEDS_INFO:'Cần bổ sung',APPROVED:'Đã duyệt',REJECTED:'Từ chối'};
const checkLabels={paper:'Đã kiểm tra đúng hóa đơn giấy',stamp:'Đã kiểm tra dấu đỏ',signature:'Đã kiểm tra chữ ký',match:'Đã giải quyết mọi nghi vấn; thông tin, số tiền và minh chứng khớp nhau'};
const fields=['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount','category'];
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
  $('formTitle').textContent='Tạo đề nghị mới'; $('submitButton').textContent='Gửi và tự động đánh giá →'; $('analysisResult').textContent='';
}
async function enter(p) {
  if(!roles[p.role]) throw new Error('Vai trò không hợp lệ.');
  profile=p; epoch++; $('loginScreen').classList.add('hidden'); $('appShell').classList.remove('hidden');
  document.body.className='online role-' + p.role;
  $('profileName').textContent=p.display_name; $('profileRole').textContent=roles[p.role]; $('roleLabel').textContent=roles[p.role];
  $('pageTitle').textContent={applicant:'Đề nghị của bạn',treasurer:'Không gian thủ quỹ',cfo:'Phê duyệt cấp trên'}[p.role];
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
  $('queueBody').innerHTML=filtered.length ? filtered.map(r=>`<tr><td><strong>PAY-${esc(r.id.slice(0,8))}</strong><small>${esc(time(r.created_at))}</small></td><td>${esc(r.payload.requester)}<small>${esc(r.payload.department)}</small></td><td>${money(r.amount)}</td><td><span class="status-tag ${r.status==='APPROVED'?'ready':r.status==='REJECTED'?'reject':'review'}">${statuses[r.status]}</span></td><td><button class="text-button" data-id="${r.id}">Mở</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-table">Chưa có hồ sơ ở trạng thái này.</td></tr>';
  $('queueBody').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openRequest(b.dataset.id));
  for(const [id,status] of Object.entries({waitingCount:'TREASURER_REVIEW',cfoCount:'CFO_REVIEW',readyCount:'APPROVED',infoCount:'NEEDS_INFO'})) $(id).textContent=rows.filter(r=>r.status===status).length;
}
async function openRequest(id) {
  if(busy)return;
  const r=rows.find(x=>x.id===id); if(!r) return; selected=r; const run=epoch;
  const mayReview=(profile.role==='treasurer'&&r.status==='TREASURER_REVIEW')||(profile.role==='cfo'&&r.status==='CFO_REVIEW');
  const metadata={ 'Người đề nghị':r.payload.requester,'Bộ phận':r.payload.department,'Mục đích':r.payload.purpose,'Nhà cung cấp':r.payload.vendor,'Số hóa đơn':r.payload.invoiceNumber,'Ngày hóa đơn':r.payload.invoiceDate,'Mã ngân sách':r.payload.budgetCode };
  $('decisionResult').innerHTML=`<div class="decision-banner ${r.status==='APPROVED'?'ready':'escalate'}"><div><strong>${statuses[r.status]}</strong><small>PAY-${esc(r.id.slice(0,8))} · phiên bản ${r.version}</small></div></div><h2 class="detail-amount">${money(r.amount)}</h2><div class="decision-meta">${Object.entries(metadata).map(([k,v])=>`<div class="meta-row"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div><p class="notice">${esc(r.reason)}</p><div class="evidence-actions"><button class="secondary-button clay-button" data-file="invoice_path">Xem hóa đơn</button><button class="secondary-button clay-button" data-file="request_path">Xem đơn đề nghị</button></div><div id="evidenceLink" aria-live="polite"></div>
  ${r.code?`<p><strong>${esc(r.code)} · ${esc(r.policy_version)}</strong></p><p>${esc(r.question||'Không cần hỏi — đã hoàn tất xử lý.')}</p><ul>${(r.flags||[]).map(f=>`<li>${esc(f)}</li>`).join('')}</ul>`:''}
  ${r.analysis?.extracted?`<details><summary>Dữ kiện AI đọc được</summary>${Object.entries(r.analysis.extracted).map(([kind,d])=>`<p><strong>${kind==='invoice'?'Hóa đơn':'Đơn đề nghị'}</strong>: ${d.amount===null?'Chưa đọc được số tiền':money(d.amount)} · ${esc(d.vendor||'Thiếu nhà cung cấp')} · ${esc(d.invoiceNumber||'Thiếu số hóa đơn')} · ${esc(d.invoiceDate||'Thiếu ngày')}</p>`).join('')}<p class="muted">Nhận diện hình dấu/chữ ký không chứng minh chứng từ là thật.</p></details>`:''}
  ${mayReview?`<form id="reviewForm">${profile.role==='treasurer'?`<p class="muted">Mở và kiểm tra minh chứng trước khi xác nhận. Đây là kiểm tra thủ công.</p><div class="review-checks">${Object.entries(checkLabels).map(([k,v])=>`<label class="plain-check"><input type="checkbox" name="${k}">${v}</label>`).join('')}</div>`:''}<label class="field">Lý do / nội dung cần bổ sung<textarea id="reviewReason" maxlength="2000" rows="3" placeholder="Bắt buộc: câu trả lời và căn cứ quyết định"></textarea></label><div class="decision-actions"><button class="action-secondary" type="button" data-action="clarify">Yêu cầu bổ sung</button><button class="action-secondary" type="button" data-action="reject">Từ chối</button><button class="action-primary" type="button" data-action="approve">${profile.role==='treasurer'?'Xác minh & đánh giá lại':'Phê duyệt'}</button></div></form>`:''}
  ${profile.role==='applicant'&&(r.status==='NEEDS_INFO'||(r.code==='U1'&&r.status==='TREASURER_REVIEW'))?'<button class="primary-button clay-button" id="supplementButton">Bổ sung và gửi lại</button>':''}`;
  $('decisionResult').querySelectorAll('[data-file]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try {const url=await api.signedUrl(r[b.dataset.file]); if(epoch===run&&selected?.id===id) $('evidenceLink').innerHTML=`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Mở minh chứng trong tab mới ↗</a><p class="muted">Liên kết có hiệu lực 60 giây.</p>`;}
    catch(e) {notify(e.message,true);} finally {b.disabled=false;}
  });
  $('decisionResult').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>review(r,b.dataset.action));
  if($('supplementButton')) $('supplementButton').onclick=()=>{
    editing={id:r.id,version:r.version}; fields.forEach(k=>$(k).value=r.payload[k]??'');
    $('invoiceFile').value=''; $('requestFile').value=''; $('paperConfirm').checked=false;
    $('formTitle').textContent='Bổ sung PAY-'+r.id.slice(0,8); $('submitButton').textContent='Gửi lại và đánh giá lại →';
    $('request-card').scrollIntoView({behavior:'smooth'}); notify('Tải lại đủ hai minh chứng cho phiên bản bổ sung.');
  };
  $('auditList').textContent='Đang tải nhật ký…';
  try { const audit=await api.audit(id); if(epoch!==run||selected?.id!==id) return;
    $('auditList').innerHTML=audit.map(a=>`<div class="audit-item"><span class="audit-dot purple"></span><div><strong>${esc(roles[a.actor_role])} · ${statuses[a.new_status]}</strong><p>${esc(a.reason)}</p><small>${esc(time(a.created_at))} · phiên bản ${a.version}</small></div></div>`).join('');
  } catch(e) {if(epoch===run&&selected?.id===id) $('auditList').textContent='Không tải được nhật ký: '+e.message;}
}
function setBusy(value) {busy=value; $('submitButton').disabled=value; $('logoutButton').disabled=value; document.querySelectorAll('[data-action], #paymentForm input, #paymentForm select, #paymentForm textarea, #supplementButton').forEach(b=>b.disabled=value);}
async function review(r,action) {
  if(busy) return;
  const reason=$('reviewReason').value.trim();
  if(!reason) {notify('Hãy trả lời câu hỏi chuyển tiếp hoặc ghi rõ lý do.',true);return;}
  const checks={}; document.querySelectorAll('#reviewForm input[type=checkbox]').forEach(c=>checks[c.name]=c.checked);
  if(action==='approve'&&profile.role==='treasurer') {
    if(Object.keys(checkLabels).some(k=>checks[k]!==true)) {notify('Chưa giải quyết đủ nghi vấn. Hãy kiểm tra minh chứng hoặc yêu cầu bổ sung.',true);return;}
    action='resolve';
  }
  setBusy(true);
  try {await api.rpc('review_request',{p_id:r.id,p_expected_version:r.version,p_action:action,p_reason:reason,p_checks:checks}); notify('Đã lưu quyết định và nhật ký.');}
  catch(e) {notify(e.message,true);} finally {setBusy(false);await refresh();}
}
function validateFile(file) {
  if(!file||file.size===0||file.size>10485760||!['application/pdf','image/jpeg','image/png'].includes(file.type)) throw new Error('Mỗi minh chứng phải là PDF/JPG/PNG, không rỗng và tối đa 10 MB.');
  return {'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png'}[file.type];
}
$('paymentForm').onsubmit=async event=>{
  event.preventDefault(); if(busy||profile?.role!=='applicant') return;
  const submissionEdit=editing?{...editing}:null;
  setBusy(true);
  try {
    const invoice=$('invoiceFile').files[0], request=$('requestFile').files[0];
    const invExt=validateFile(invoice), reqExt=validateFile(request);
    const payload=Object.fromEntries(fields.map(k=>[k,$(k).value.trim()])); payload.amount=Number(payload.amount); payload.invoiceType='paper';
    const folder=profile.id+'/'+crypto.randomUUID();
    const invoicePath=folder+'/invoice.'+invExt, requestPath=folder+'/request.'+reqExt;
    notify('Đang tải hai minh chứng và gửi hồ sơ…');
    await api.upload(invoicePath,invoice); await api.upload(requestPath,request);
    let assessmentId=null,analysisError='';
    notify('Đang đọc hai chứng từ và đối chiếu…');
    try{const analysis=await api.analyzeEvidence(payload,{invoicePath,requestPath});assessmentId=analysis.assessmentId;}
    catch(e){analysisError=e.message;}
    const result=await api.rpc('submit_request',{p_id:submissionEdit?.id||crypto.randomUUID(),p_payload:payload,p_invoice_path:invoicePath,p_request_path:requestPath,p_expected_version:submissionEdit?.version||0,p_agent_assessment_id:assessmentId});
    resetForm(); notify('Đã gửi: '+statuses[result.status]+'. '+(analysisError||result.reason));
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
$('verifyButton').onclick=()=>window.runFinRefVerify(5);
$('verifyAll').onclick=()=>window.runFinRefVerify(15);
if(!api.configured) {
  notify('Chưa kết nối Supabase. Làm theo HUONG-DAN-ONLINE.md để bật đăng nhập. Bạn vẫn có thể mở demo bên dưới.',false,true);
  $('loginForm').querySelector('button').disabled=true;
} else if(api.session) {
  api.profile().then(enter).catch(e=>{api.remember(null);showLogin();notify(e.message,true,true);});
}
