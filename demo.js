const form = document.querySelector('#paymentForm');
const decisionEmpty = document.querySelector('#decisionEmpty');
const decisionResult = document.querySelector('#decisionResult');
const fileList = document.querySelector('#fileList');
const auditList = document.querySelector('#auditList');
const queueBody = document.querySelector('#queueBody');
const roleGateway = document.querySelector('#roleGateway');
const appShell = document.querySelector('#appShell');
const activeRoleLabel = document.querySelector('#activeRoleLabel');
const dailyLimitNotice = document.querySelector('#dailyLimitNotice');

const STORE_KEY = 'finref-demo-state-v3';
const money = (value) => new Intl.NumberFormat('vi-VN').format(Number(value || 0)) + ' ₫';
const now = () => new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = () => new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const makeId = () => `PAY-${String(Date.now()).slice(-6)}`;
const roleMeta = {
  applicant: { label: 'Người nộp đơn', person: 'Nguyễn Minh An', initials: 'NA', title: 'Cổng nộp đề nghị', eyebrow: 'REQUESTER WORKSPACE', copy: 'Tạo hồ sơ, gửi minh chứng và theo dõi trạng thái xử lý.' },
  treasurer: { label: 'Quản lý tài chính', person: 'Quản lý tài chính', initials: 'QT', title: 'Hàng đợi quản lý tài chính', eyebrow: 'FINANCE MANAGER WORKSPACE', copy: 'Kiểm tra hồ sơ trước; duyệt cuối trong hạn mức hoặc chuyển Giám đốc cấp quyền.' },
  cfo: { label: 'Giám đốc Tài chính', person: 'Giám đốc Tài chính', initials: 'TC', title: 'Duyệt cấp quyền', eyebrow: 'FINANCE DIRECTOR WORKSPACE', copy: 'Xem hồ sơ trên 20 triệu; cấp quyền cho trường hợp vượt hạn mức.' },
};
const seed = [
  { requestId: 'PAY-0318', requester: 'Nguyễn Minh An', department: 'Marketing', buyerCompany: 'Công ty TNHH FinRef Demo', amount: 12500000, vendor: 'Công ty In Sao Mai', purpose: 'In ấn tài liệu sự kiện', invoiceNumber: 'INV-2026-0318', status: 'READY_FOR_APPROVAL', code: 'CLEAR', createdAt: '20/09/2026 · 09:14', reason: 'Các trường hóa đơn và phép tính tổng đã khớp form trong phạm vi kiểm tra hiện có.', question: 'Chờ quản lý tài chính bấm duyệt cuối.' },
  { requestId: 'PAY-0317', requester: 'Phòng Mua sắm', department: 'Operations', buyerCompany: 'Công ty TNHH FinRef Demo', amount: 24800000, vendor: 'Công ty Thiết bị Sao Việt', purpose: 'Mua thiết bị máy chiếu', invoiceNumber: 'INV-2026-0317', status: 'READY_FOR_APPROVAL', code: 'CLEAR', createdAt: '20/09/2026 · 08:52', reason: 'AI hoàn tất kiểm tra; Quản lý Tài chính xem trước. Hồ sơ trên 20 triệu cần Giám đốc cấp quyền sau đó.', question: 'Quản lý Tài chính cần xác nhận đã kiểm tra.' },
  { requestId: 'PAY-0316', requester: 'Lê Thu Hà', department: 'HR', buyerCompany: 'Công ty TNHH FinRef Demo', amount: 3200000, vendor: 'Nhà cung cấp mẫu', purpose: 'Chi phí đào tạo', invoiceNumber: 'INV-2026-0316', status: 'TREASURER_REVIEW', code: 'U1', createdAt: '20/09/2026 · 08:26', reason: 'Số hóa đơn trên PDF chưa khớp với form.', question: 'Quản lý Tài chính kiểm tra số hóa đơn trước.' },
];
let state = loadState();
let currentRole = localStorage.getItem('finref-demo-role') || null;

function loadState() {
  try {
    const saved=JSON.parse(localStorage.getItem(STORE_KEY));
    if(!saved) return { requests: seed, audits: [] };
    for(const item of saved.requests||[]) {
      if(item.status==='CFO_REVIEW'&&!item.managerReviewedAt) {
        item.status='READY_FOR_APPROVAL';
        item.reason='Quản lý Tài chính cần kiểm tra hồ sơ trước khi Giám đốc cấp quyền.';
        item.question='Quản lý Tài chính kiểm tra trước.';
      }
    }
    return saved;
  }
  catch { return { requests: seed, audits: [] }; }
}
function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function bangkokDate(value) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = Object.fromEntries(parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return `${part.year}-${part.month}-${part.day}`;
}
function approvedTotalToday() {
  const today = bangkokDate(Date.now());
  return state.requests.filter((item) => item.status === 'APPROVED' && item.approvedAt && bangkokDate(item.approvedAt) === today)
    .reduce((total, item) => total + item.amount, 0);
}
function renderDailyLimitNotice() {
  const total = approvedTotalToday();
  if (currentRole !== 'treasurer' || total <= 80000000) { dailyLimitNotice.classList.add('hidden'); dailyLimitNotice.textContent = ''; return; }
  const remaining = Math.max(0, 100000000 - total);
  const over = Math.max(0, total - 100000000);
  dailyLimitNotice.classList.remove('hidden');
  dailyLimitNotice.textContent = over
    ? `DEMO · Hôm nay (giờ Bangkok) đã duyệt ${money(total)} trên ${money(100000000)}, vượt ${money(over)} theo quyền Giám đốc; số dư còn lại là 0 ₫.`
    : `DEMO · Hôm nay (giờ Bangkok) đã duyệt ${money(total)} trên ${money(100000000)}, còn ${money(remaining)}. Hồ sơ làm tổng ngày vượt 100 triệu cần Giám đốc cấp quyền.`;
}
function statusInfo(item) {
  const map = { TREASURER_REVIEW: ['review', 'Chờ quản lý tài chính kiểm tra'], READY_FOR_APPROVAL: ['ready', 'Chờ quản lý tài chính kiểm tra'], CFO_REVIEW: ['escalate', 'Chờ Giám đốc Tài chính cấp quyền'], NEEDS_INFO: ['review', 'Cần bổ sung'], APPROVED: ['ready', 'Đã duyệt'], REJECTED: ['reject', 'Từ chối'] };
  return map[item.status] || ['review', 'Đang xử lý'];
}
function evaluate(data) {
  const missing = ['requester', 'department', 'buyerCompany', 'budgetCode', 'purpose', 'vendor', 'invoiceNumber', 'invoiceDate'].filter((k) => !data[k]);
  if (!Number.isSafeInteger(data.amount) || data.amount <= 0) missing.push('amount');
  if (missing.length) return { kind: 'escalate', code: 'U1', title: 'Cần kiểm tra', receiver: 'Quản lý tài chính', reason: `Còn thiếu hoặc chưa chắc ${missing.length} trường.`, question: 'Quản lý Tài chính kiểm tra trước; có thể yêu cầu người nộp bổ sung.', status: 'TREASURER_REVIEW' };
  return { kind: 'ready', code: 'CLEAR', title: 'Chờ quản lý tài chính kiểm tra', receiver: 'Quản lý tài chính', reason: 'Các dữ kiện form mẫu được xem là khớp; ngân sách theo mã/chính sách chưa được kiểm tra.', question: 'Quản lý Tài chính xác nhận trước. Hồ sơ trên 20 triệu hoặc làm tổng ngày vượt 100 triệu cần Giám đốc cấp quyền.', status: 'READY_FOR_APPROVAL' };
}
function getFormData() {
  return { requestId: makeId(), requesterType: document.querySelector('#requesterType').value, requester: document.querySelector('#requester').value.trim(), department: document.querySelector('#department').value.trim(), buyerCompany: document.querySelector('#buyerCompany').value.trim(), budgetCode: document.querySelector('#budgetCode').value.trim(), purpose: document.querySelector('#purpose').value.trim(), vendor: document.querySelector('#vendor').value.trim(), invoiceNumber: document.querySelector('#invoiceNumber').value.trim(), invoiceDate: document.querySelector('#invoiceDate').value, amount: Number(document.querySelector('#amount').value), createdAt: dateTime() };
}
function addAudit(title, subtitle) { state.audits.unshift({ title, subtitle, hash: 'local' }); saveState(); renderAudit(); }
function renderAudit() {
  const entries = [...state.audits, { title: 'Ngân sách/chính sách theo mã chưa được nạp', subtitle: 'Hạn mức ngày chỉ mô phỏng trên trình duyệt này', hash: 'scope' }].slice(0, 8);
  if (auditList) auditList.innerHTML = entries.map((a, i) => `<div class="audit-item"><span class="audit-dot ${i % 3 === 0 ? 'green' : i % 3 === 1 ? 'blue' : 'purple'}"></span><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.subtitle)}</small></div><code>${escapeHtml(a.hash)}</code></div>`).join('');
}
function actionButtons(item) {
  if (currentRole === 'treasurer') return item.status === 'READY_FOR_APPROVAL' || item.status === 'TREASURER_REVIEW' ? '<button class="action-secondary" data-action="clarify">Yêu cầu bổ sung</button><button class="action-primary" data-action="approve">Xác nhận kiểm tra & duyệt / chuyển Giám đốc</button>' : '<button class="action-secondary" data-action="close">Đóng</button>';
  if (currentRole === 'cfo') return item.status === 'CFO_REVIEW' ? '<button class="action-secondary" data-action="reject">Từ chối</button><button class="action-primary" data-action="approve">Cấp quyền và duyệt</button>' : '<button class="action-secondary" data-action="close">Chỉ xem</button>';
  return '<button class="action-secondary" data-action="close">Đã hiểu trạng thái</button>';
}
function renderDecision(item) {
  decisionEmpty.classList.add('hidden'); decisionResult.classList.remove('hidden');
  const [kind, label] = statusInfo(item);
  const resultKind = kind === 'ready' ? 'ready' : kind === 'reject' ? 'reject' : 'escalate';
  const receiver = item.status === 'CFO_REVIEW' ? 'Giám đốc Tài chính' : ['READY_FOR_APPROVAL','TREASURER_REVIEW'].includes(item.status) ? 'Quản lý tài chính' : currentRole === 'applicant' ? 'Người nộp đơn' : roleMeta[currentRole].label;
  const cfoReason = currentRole === 'cfo' && item.status === 'CFO_REVIEW' ? '<label class="field">Lý do cấp quyền<textarea id="cfoApprovalReason" maxlength="2000" rows="3" placeholder="Bắt buộc khi Giám đốc cấp quyền"></textarea></label>' : '';
  decisionResult.innerHTML = `<div class="decision-banner ${resultKind}"><div class="decision-icon">${resultKind === 'ready' ? '✓' : resultKind === 'reject' ? '×' : '!'}</div><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(item.code || 'U1')} · ${escapeHtml(receiver)}</small></div></div><div class="decision-meta"><div class="meta-row"><span>Mã hồ sơ</span><strong>${escapeHtml(item.requestId)}</strong></div><div class="meta-row"><span>Tổng gồm VAT</span><strong>${money(item.amount)}</strong></div><div class="meta-row"><span>Công ty mua trên hóa đơn</span><strong>${escapeHtml(item.buyerCompany || 'Chưa khai báo')}</strong></div><div class="meta-row"><span>Nhà cung cấp</span><strong>${escapeHtml(item.vendor)}</strong></div><div class="meta-row"><span>Trạng thái</span><strong>${escapeHtml(label)}</strong></div></div><div class="question-box"><span class="eyebrow">GỢI Ý XỬ LÝ</span><p>${escapeHtml(item.question || item.reason || 'Chọn hành động phù hợp với thẩm quyền của bạn.')}</p><small class="reason-copy">${escapeHtml(item.reason || '')} Dữ liệu chỉ mô phỏng trong trình duyệt; hạn mức thật phải được Supabase kiểm tra.</small></div>${cfoReason}<div class="decision-actions">${actionButtons(item)}</div>`;
  decisionResult.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => handleAction(item.requestId, b.dataset.action)));
}
function handleAction(requestId, action) {
  const item = state.requests.find((r) => r.requestId === requestId); if (!item || action === 'close') return;
  if (!((currentRole === 'treasurer' && ['TREASURER_REVIEW','READY_FOR_APPROVAL'].includes(item.status) && ['approve','clarify'].includes(action)) || (currentRole === 'cfo' && item.status === 'CFO_REVIEW' && ['approve','reject'].includes(action)))) return;
  if (action === 'approve' && currentRole === 'cfo') {
    const reason = document.querySelector('#cfoApprovalReason')?.value.trim();
    if (!reason) { alert('Giám đốc cần ghi lý do cấp quyền trước khi duyệt.'); return; }
    item.status = 'APPROVED'; item.approvedAt = new Date().toISOString(); item.reason = `Giám đốc Tài chính cấp quyền. Lý do: ${reason}`;
  } else if (action === 'approve') {
    const projectedTotal = approvedTotalToday() + item.amount;
    item.managerReviewedAt = new Date().toISOString();
    if (item.amount > 20000000 || projectedTotal > 100000000) {
      item.status = 'CFO_REVIEW';
      item.reason = `Quản lý Tài chính đã kiểm tra; cần Giám đốc cấp quyền vì ${item.amount > 20000000 ? 'hồ sơ trên 20 triệu' : 'tổng duyệt trong ngày sẽ vượt 100 triệu'}.`;
      item.question = 'Chờ Giám đốc Tài chính cấp quyền và ghi lý do.';
    } else {
      item.status = 'APPROVED'; item.approvedAt = new Date().toISOString();
      item.reason = 'Quản lý Tài chính đã duyệt cuối trong cả hai hạn mức.';
    }
  }
  if (action === 'clarify') item.status = 'NEEDS_INFO';
  if (action === 'reject') item.status = 'REJECTED';
  saveState(); addAudit(`${item.requestId} · ${action === 'approve' ? 'Đã phê duyệt' : action === 'clarify' ? 'Yêu cầu bổ sung' : 'Từ chối'}`, `${now()} · ${roleMeta[currentRole].label}`); renderAll(); renderDecision(item);
}
function renderQueue() {
  if (!queueBody) return;
  let rows = state.requests;
  if (currentRole === 'applicant') rows = rows.filter((r) => r.requester === roleMeta.applicant.person);
  if (currentRole === 'treasurer') rows = rows.filter((r) => ['TREASURER_REVIEW', 'READY_FOR_APPROVAL', 'NEEDS_INFO'].includes(r.status));
  if (currentRole === 'cfo') rows = rows.filter((r) => r.status === 'CFO_REVIEW' || r.amount > 20000000);
  queueBody.innerHTML = rows.length ? rows.map((item) => { const [kind, label] = statusInfo(item); return `<tr data-request-id="${escapeHtml(item.requestId)}"><td><strong>${escapeHtml(item.requestId)}</strong><small>${escapeHtml(item.createdAt || '')}</small></td><td>${escapeHtml(item.requester)}<small>${escapeHtml(item.department)}</small></td><td>${money(item.amount)}</td><td><span class="status-tag ${kind}">${escapeHtml(label)}</span></td><td>${currentRole === 'applicant' ? 'Theo dõi' : 'Mở hồ sơ'}</td></tr>`; }).join('') : '<tr><td colspan="5" class="empty-table">Không có hồ sơ trong hàng đợi này.</td></tr>';
  queueBody.querySelectorAll('tr[data-request-id]').forEach((row) => row.addEventListener('click', () => renderDecision(state.requests.find((r) => r.requestId === row.dataset.requestId))));
}
function renderStats() {
  const all = state.requests;
  document.querySelector('#readyCount').textContent = String(all.filter((r) => r.status === 'READY_FOR_APPROVAL').length).padStart(2, '0');
  document.querySelector('#escalationCount').textContent = String(all.filter((r) => ['TREASURER_REVIEW', 'NEEDS_INFO', 'REJECTED'].includes(r.status)).length).padStart(2, '0');
  document.querySelector('#cfoCount').textContent = String(all.filter((r) => r.status === 'CFO_REVIEW').length).padStart(2, '0');
}
function renderAll() { renderQueue(); renderStats(); renderAudit(); renderDailyLimitNotice(); }
function enterRole(role) {
  decisionResult.innerHTML = ''; decisionResult.classList.add('hidden'); decisionEmpty.classList.remove('hidden');
  currentRole = role; localStorage.setItem('finref-demo-role', role); const meta = roleMeta[role];
  roleGateway.classList.add('hidden'); appShell.classList.remove('hidden'); document.body.className = `role-${role}`;
  activeRoleLabel.textContent = meta.person; document.querySelector('.topbar h1').textContent = meta.title; document.querySelector('.topbar .eyebrow').textContent = meta.eyebrow; document.querySelector('.topbar .muted').textContent = meta.copy; document.querySelector('.profile strong').textContent = meta.person; document.querySelector('.profile .avatar').textContent = meta.initials;
  document.querySelector('#request-card').classList.toggle('hidden', role !== 'applicant'); document.querySelector('#queue-card h2').textContent = role === 'applicant' ? 'Hồ sơ của tôi' : role === 'cfo' ? 'Ca chờ Giám đốc Tài chính' : 'Hàng đợi xử lý'; document.querySelector('#verifyButton').textContent = role === 'applicant' ? 'Hướng dẫn hồ sơ' : '▶ Chạy Verify 5 ca';
  renderAll();
}
document.querySelectorAll('[data-enter-role]').forEach((b) => b.addEventListener('click', () => enterRole(b.dataset.enterRole)));
document.querySelector('#logoutButton')?.addEventListener('click', () => { currentRole = null; localStorage.removeItem('finref-demo-role'); dailyLimitNotice.classList.add('hidden'); dailyLimitNotice.textContent=''; appShell.classList.add('hidden'); roleGateway.classList.remove('hidden'); document.body.className = ''; });
if (currentRole && roleMeta[currentRole]) enterRole(currentRole);
form?.addEventListener('submit', (event) => { event.preventDefault(); const data = getFormData(); const result = evaluate(data); const item = { ...data, status: result.status, code: result.code, reason: result.reason, question: result.question }; state.requests.unshift(item); saveState(); addAudit(`${item.requestId} · ${result.title}`, `${now()} · ${roleMeta.applicant.label}`); renderAll(); renderDecision(item); form.reset(); document.querySelector('#requester').value = roleMeta.applicant.person; document.querySelector('#department').value = 'Marketing'; document.querySelector('#budgetCode').value = 'MKT-OPS-2026'; });
document.querySelector('#loadSample')?.addEventListener('click', () => { document.querySelector('#amount').value = '24800000'; document.querySelector('#purpose').value = 'Mua thiết bị máy chiếu cho phòng họp'; document.querySelector('#buyerCompany').value = 'Công ty TNHH FinRef Demo'; document.querySelector('#vendor').value = 'Công ty Thiết bị Sao Việt'; document.querySelector('#invoiceNumber').value = 'INV-2026-0402'; });
document.querySelectorAll('input[type="file"]').forEach((input) => input.addEventListener('change', (event) => { const files = [...event.target.files]; if (files.length) fileList.innerHTML = files.map((f) => `<span class="file-chip valid">✓ ${escapeHtml(f.name)} · ${(f.size / 1024 / 1024).toFixed(1)} MB</span>`).join(''); }));
document.querySelector('#verifyButton')?.addEventListener('click', (event) => { if (currentRole === 'applicant') { alert('Demo chỉ mô phỏng trạng thái; không đọc/lưu minh chứng, không đối chiếu ngân sách/chính sách và không ghi backend.'); return; } const results = FinRefRules.verify().slice(0,5); const passed = results.filter(r=>r.pass).length; event.currentTarget.textContent = `Verify: ${passed}/5 PASS`; addAudit(`Mô phỏng luật hóa đơn · ${passed}/5 ca đạt`, now()); });
document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
