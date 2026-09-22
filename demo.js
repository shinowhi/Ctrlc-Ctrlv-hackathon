const form = document.querySelector('#paymentForm');
const decisionEmpty = document.querySelector('#decisionEmpty');
const decisionResult = document.querySelector('#decisionResult');
const fileList = document.querySelector('#fileList');
const auditList = document.querySelector('#auditList');
const queueBody = document.querySelector('#queueBody');
const roleGateway = document.querySelector('#roleGateway');
const appShell = document.querySelector('#appShell');
const activeRoleLabel = document.querySelector('#activeRoleLabel');

const STORE_KEY = 'finref-demo-state-v3';
const money = (value) => new Intl.NumberFormat('vi-VN').format(Number(value || 0)) + ' ₫';
const now = () => new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = () => new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const makeId = () => `PAY-${String(Date.now()).slice(-6)}`;
const roleMeta = {
  applicant: { label: 'Người nộp đơn', person: 'Nguyễn Minh An', initials: 'NA', title: 'Cổng nộp đề nghị', eyebrow: 'REQUESTER WORKSPACE', copy: 'Tạo hồ sơ, gửi minh chứng và theo dõi trạng thái xử lý.' },
  treasurer: { label: 'Thủ quỹ', person: 'Thủ quỹ Trâm', initials: 'TT', title: 'Hàng đợi thủ quỹ', eyebrow: 'TREASURER WORKSPACE', copy: 'Kiểm tra hồ sơ trong hạn mức và chuyển ca cần thẩm quyền.' },
  cfo: { label: 'Giám đốc Tài chính', person: 'Giám đốc Tài chính', initials: 'GĐ', title: 'Phê duyệt cấp trên', eyebrow: 'CFO WORKSPACE', copy: 'Quyết định các đề nghị từ 20 triệu đồng.' },
};
const seed = [
  { requestId: 'PAY-0318', requester: 'Nguyễn Minh An', department: 'Marketing', amount: 12500000, vendor: 'Công ty In Sao Mai', purpose: 'In ấn tài liệu sự kiện', invoiceNumber: 'INV-2026-0318', status: 'APPROVED', code: 'CLEAR', createdAt: '20/09/2026 · 09:14', hasStamp: true, hasSignature: true, hasAcceptance: true },
  { requestId: 'PAY-0317', requester: 'Phòng Mua sắm', department: 'Operations', amount: 24800000, vendor: 'Công ty Thiết bị Sao Việt', purpose: 'Mua thiết bị máy chiếu', invoiceNumber: 'INV-2026-0317', status: 'CFO_REVIEW', code: 'U3', createdAt: '20/09/2026 · 08:52', hasStamp: true, hasSignature: true, hasAcceptance: true },
  { requestId: 'PAY-0316', requester: 'Lê Thu Hà', department: 'HR', amount: 3200000, vendor: 'Nhà cung cấp mẫu', purpose: 'Chi phí đào tạo', invoiceNumber: 'INV-2026-0316', status: 'NEEDS_INFO', code: 'U1', createdAt: '20/09/2026 · 08:26', hasStamp: false, hasSignature: true, hasAcceptance: true },
];
let state = loadState();
let editingDemo=null;
let currentRole = localStorage.getItem('finref-demo-role') || null;

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { requests: seed, audits: [] }; }
  catch { return { requests: seed, audits: [] }; }
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function statusInfo(item) {
  const map = { TREASURER_REVIEW: ['review', 'Chờ thủ quỹ'], CFO_REVIEW: ['escalate', 'Chờ GĐTC'], NEEDS_INFO: ['review', 'Cần bổ sung'], APPROVED: ['ready', 'Đã duyệt'], REJECTED: ['reject', 'Từ chối'], PAID_READY: ['ready', 'Đủ điều kiện chi'] };
  return map[item.status] || ['review', 'Đang xử lý'];
}
function evaluate(data) {
  const required={requester:'người đề nghị',department:'bộ phận',budgetCode:'mã ngân sách',purpose:'mục đích',vendor:'nhà cung cấp',invoiceNumber:'số hóa đơn',invoiceDate:'ngày hóa đơn'};
  const missing=Object.keys(required).filter(k=>!data[k]?.trim()).map(k=>required[k]);
  const result=FinRefRules.execute(data.amount,{paper:true,stamp:data.hasStamp===true,signature:data.hasSignature===true,match:data.hasAcceptance===true&&missing.length===0,budget:data.budgetStatus==='ok',policy:data.policyIssue===false});
  if(missing.length)result.question='Vui lòng bổ sung '+missing.join(', ')+'. Thông tin đúng là gì?';
  return {...result,kind:result.action==='AUTO_APPROVE'?'ready':'escalate',title:result.action==='AUTO_APPROVE'?'Tự phê duyệt':'Chuyển tiếp '+result.code,receiver:result.receiver==='cfo'?'Giám đốc Tài chính':result.receiver==='treasurer'?'Thủ quỹ':'Không cần'};
}
function getFormData() {
  return { requestId: makeId(), requesterType: document.querySelector('#requesterType').value, requester: document.querySelector('#requester').value.trim(), department: document.querySelector('#department').value.trim(), budgetCode: document.querySelector('#budgetCode').value.trim(), purpose: document.querySelector('#purpose').value.trim(), vendor: document.querySelector('#vendor').value.trim(), invoiceNumber: document.querySelector('#invoiceNumber').value.trim(), invoiceDate: document.querySelector('#invoiceDate').value, amount: Number(document.querySelector('#amount').value), budgetStatus: document.querySelector('#budgetStatus').value, hasStamp: document.querySelector('#hasStamp').checked, hasSignature: document.querySelector('#hasSignature').checked, hasAcceptance: document.querySelector('#hasAcceptance').checked, policyIssue: document.querySelector('#policyIssue').checked, createdAt: dateTime() };
}
function addAudit(title, subtitle) { state.audits.unshift({ title, subtitle, hash: 'local' }); saveState(); renderAudit(); }
function renderAudit() {
  const entries = [...state.audits, { title: 'Policy FIN-DEMO-1 (mẫu)', subtitle: 'Rules Engine · local demo', hash: 'policy' }].slice(0, 8);
  if (auditList) auditList.innerHTML = entries.map((a, i) => `<div class="audit-item"><span class="audit-dot ${i % 3 === 0 ? 'green' : i % 3 === 1 ? 'blue' : 'purple'}"></span><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.subtitle)}</small></div><code>${escapeHtml(a.hash)}</code></div>`).join('');
}
function actionButtons(item) {
  if(currentRole==='applicant'&&item.status==='NEEDS_INFO')return '<button class="action-primary" data-action="supplement">Bổ sung & đánh giá lại</button>';
  if (currentRole === 'treasurer') return item.status === 'TREASURER_REVIEW' ? '<button class="action-secondary" data-action="clarify">Yêu cầu bổ sung</button><button class="action-primary" data-action="approve">Duyệt trong hạn mức</button>' : '<button class="action-secondary" data-action="close">Đóng</button>';
  if (currentRole === 'cfo') return item.status === 'CFO_REVIEW' ? '<button class="action-secondary" data-action="reject">Từ chối</button><button class="action-primary" data-action="approve">Phê duyệt khoản chi</button>' : '<button class="action-secondary" data-action="close">Đóng</button>';
  return '<button class="action-secondary" data-action="close">Đã hiểu trạng thái</button>';
}
function renderDecision(item) {
  decisionEmpty.classList.add('hidden'); decisionResult.classList.remove('hidden');
  const [kind, label] = statusInfo(item);
  const resultKind = kind === 'ready' ? 'ready' : kind === 'reject' ? 'reject' : 'escalate';
  const receiver = item.receiver || (currentRole === 'cfo' ? 'Giám đốc Tài chính' : currentRole === 'treasurer' ? 'Thủ quỹ' : 'Người nộp đơn');
  decisionResult.innerHTML = `<div class="decision-banner ${resultKind}"><div class="decision-icon">${resultKind === 'ready' ? '✓' : resultKind === 'reject' ? '×' : '!'}</div><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(item.code || 'U1')} · ${escapeHtml(receiver)}</small></div></div><div class="decision-meta"><div class="meta-row"><span>Mã hồ sơ</span><strong>${escapeHtml(item.requestId)}</strong></div><div class="meta-row"><span>Số tiền</span><strong>${money(item.amount)}</strong></div><div class="meta-row"><span>Nhà cung cấp</span><strong>${escapeHtml(item.vendor)}</strong></div><div class="meta-row"><span>Trạng thái</span><strong>${escapeHtml(label)}</strong></div></div><div class="question-box"><span class="eyebrow">${item.status === 'APPROVED' ? 'KẾT QUẢ XỬ LÝ' : 'CÂU HỎI CHUYỂN TIẾP'}</span><p>${escapeHtml(item.question || (item.status === 'NEEDS_INFO' ? 'Vui lòng bổ sung minh chứng giấy có dấu đỏ và chữ ký.' : (item.status === 'APPROVED' ? 'Không cần hỏi — hồ sơ đã được xử lý.' : 'Chọn hành động phù hợp với thẩm quyền của bạn.')))}</p><small class="reason-copy">${escapeHtml(item.reason || 'Dữ liệu đang được lưu trong demo trên trình duyệt.')}</small></div><div class="decision-actions">${actionButtons(item)}</div>`;
  decisionResult.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => handleAction(item.requestId, b.dataset.action)));
}
function handleAction(requestId, action) {
  const item = state.requests.find((r) => r.requestId === requestId); if (!item || action === 'close') return;
  if(action==='supplement'&&currentRole==='applicant'&&item.status==='NEEDS_INFO'){
    editingDemo=requestId;
    for(const key of ['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount','budgetStatus'])if(document.getElementById(key))document.getElementById(key).value=item[key]??'';
    for(const key of ['hasStamp','hasSignature','hasAcceptance','policyIssue'])document.getElementById(key).checked=item[key]===true;
    form.scrollIntoView({behavior:'smooth'});return;
  }
  if (!((currentRole === 'treasurer' && item.status === 'TREASURER_REVIEW' && item.amount < 20000000 && ['approve','clarify'].includes(action)) || (currentRole === 'cfo' && item.status === 'CFO_REVIEW' && ['approve','reject'].includes(action)))) return;
  if (action === 'approve') item.status = currentRole === 'cfo' ? 'APPROVED' : 'PAID_READY';
  if (action === 'clarify') item.status = 'NEEDS_INFO';
  if (action === 'reject') item.status = 'REJECTED';
  saveState(); addAudit(`${item.requestId} · ${action === 'approve' ? 'Đã phê duyệt' : action === 'clarify' ? 'Yêu cầu bổ sung' : 'Từ chối'}`, `${now()} · ${roleMeta[currentRole].label}`); renderAll(); renderDecision(item);
}
function renderQueue() {
  if (!queueBody) return;
  let rows = state.requests;
  if (currentRole === 'applicant') rows = rows.filter((r) => r.requester === roleMeta.applicant.person);
  if (currentRole === 'treasurer') rows = rows.filter((r) => ['TREASURER_REVIEW', 'NEEDS_INFO', 'CFO_REVIEW'].includes(r.status));
  if (currentRole === 'cfo') rows = rows.filter((r) => r.status === 'CFO_REVIEW');
  queueBody.innerHTML = rows.length ? rows.map((item) => { const [kind, label] = statusInfo(item); return `<tr data-request-id="${escapeHtml(item.requestId)}"><td><strong>${escapeHtml(item.requestId)}</strong><small>${escapeHtml(item.createdAt || '')}</small></td><td>${escapeHtml(item.requester)}<small>${escapeHtml(item.department)}</small></td><td>${money(item.amount)}</td><td><span class="status-tag ${kind}">${escapeHtml(label)}</span></td><td>${currentRole === 'applicant' ? 'Theo dõi' : 'Mở hồ sơ'}</td></tr>`; }).join('') : '<tr><td colspan="5" class="empty-table">Không có hồ sơ trong hàng đợi này.</td></tr>';
  queueBody.querySelectorAll('tr[data-request-id]').forEach((row) => row.addEventListener('click', () => renderDecision(state.requests.find((r) => r.requestId === row.dataset.requestId))));
}
function renderStats() {
  const all = state.requests;
  document.querySelector('#readyCount').textContent = String(all.filter((r) => ['APPROVED', 'PAID_READY'].includes(r.status)).length).padStart(2, '0');
  document.querySelector('#escalationCount').textContent = String(all.filter((r) => ['TREASURER_REVIEW', 'NEEDS_INFO', 'REJECTED'].includes(r.status)).length).padStart(2, '0');
  document.querySelector('#cfoCount').textContent = String(all.filter((r) => r.status === 'CFO_REVIEW').length).padStart(2, '0');
}
function renderAll() { renderQueue(); renderStats(); renderAudit(); }
function enterRole(role) {
  decisionResult.innerHTML = ''; decisionResult.classList.add('hidden'); decisionEmpty.classList.remove('hidden');
  currentRole = role; localStorage.setItem('finref-demo-role', role); const meta = roleMeta[role];
  roleGateway.classList.add('hidden'); appShell.classList.remove('hidden'); document.body.className = `role-${role}`;
  activeRoleLabel.textContent = meta.person; document.querySelector('.topbar h1').textContent = meta.title; document.querySelector('.topbar .eyebrow').textContent = meta.eyebrow; document.querySelector('.topbar .muted').textContent = meta.copy; document.querySelector('.profile strong').textContent = meta.person; document.querySelector('.profile .avatar').textContent = meta.initials;
  document.querySelector('#request-card').classList.toggle('hidden', role !== 'applicant'); document.querySelector('#queue-card h2').textContent = role === 'applicant' ? 'Hồ sơ của tôi' : role === 'cfo' ? 'Ca chờ Giám đốc Tài chính' : 'Hàng đợi xử lý'; document.querySelector('#verifyButton').textContent = '▶ Chạy Verify 5 ca';
  renderAll();
}
document.querySelectorAll('[data-enter-role]').forEach((b) => b.addEventListener('click', () => enterRole(b.dataset.enterRole)));
document.querySelector('#logoutButton')?.addEventListener('click', () => { currentRole = null; localStorage.removeItem('finref-demo-role'); appShell.classList.add('hidden'); roleGateway.classList.remove('hidden'); document.body.className = ''; });
if (currentRole && roleMeta[currentRole]) enterRole(currentRole);
  form?.addEventListener('submit', (event) => { event.preventDefault(); const data = getFormData(); const result = evaluate(data); const item = { ...data, requestId: editingDemo || data.requestId, status: result.status, code: result.code, receiver: result.receiver, question: result.question, reason: result.reason }; if(editingDemo) state.requests=state.requests.filter(r=>r.requestId!==editingDemo); editingDemo=null; state.requests.unshift(item); saveState(); addAudit(`${item.requestId} · ${result.title}`, `${now()} · ${roleMeta.applicant.label}`); renderAll(); renderDecision(item); form.reset(); document.querySelector('#requester').value = roleMeta.applicant.person; document.querySelector('#department').value = 'Marketing'; document.querySelector('#budgetCode').value = 'MKT-OPS-2026'; });
document.querySelector('#loadSample')?.addEventListener('click', () => { document.querySelector('#amount').value = '24800000'; document.querySelector('#purpose').value = 'Mua thiết bị máy chiếu cho phòng họp'; document.querySelector('#vendor').value = 'Công ty Thiết bị Sao Việt'; document.querySelector('#invoiceNumber').value = 'INV-2026-0402'; document.querySelector('#budgetStatus').value = 'ok'; document.querySelector('#hasStamp').checked = true; document.querySelector('#hasSignature').checked = true; document.querySelector('#hasAcceptance').checked = true; document.querySelector('#policyIssue').checked = false; });
document.querySelectorAll('input[type="file"]').forEach((input) => input.addEventListener('change', (event) => { const files = [...event.target.files]; if (files.length) fileList.innerHTML = files.map((f) => `<span class="file-chip valid">✓ ${escapeHtml(f.name)} · ${(f.size / 1024 / 1024).toFixed(1)} MB</span>`).join(''); }));
document.querySelector('#verifyButton')?.addEventListener('click', () => window.runFinRefVerify(5));
document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
