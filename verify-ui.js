(function(){
  const labels={cfo:'Giám đốc Tài chính',treasurer:'Thủ quỹ'};
  const statuses={APPROVED:'Đã duyệt',NEEDS_INFO:'Chờ làm rõ',CFO_REVIEW:'Chờ GĐTC'};
  window.runFinRefVerify=function(count=5){
    const rows=FinRefRules.verify().slice(0,count),target=document.getElementById('verifyResult');
    target.replaceChildren();
    const summary=document.createElement('p');summary.textContent=`${rows.filter(r=>r.pass).length}/${rows.length} PASS · ${rows.filter(r=>r.decision.action==='AUTO_APPROVE').length} tự xử lý · ${rows.filter(r=>r.decision.action==='ESCALATE').length} chuyển tiếp`;target.append(summary);
    const note=document.createElement('p');note.className='muted';note.textContent='Chạy bộ xử lý demo với dữ kiện giả lập; không gọi AI và không ghi hồ sơ online.';target.append(note);
    const list=document.createElement('ol');
    for(const row of rows){
      const item=document.createElement('li');const title=document.createElement('strong');title.textContent=`${row.pass?'✓':'✗'} ${row.name} — ${row.decision.action==='AUTO_APPROVE'?'Tự phê duyệt':'Chuyển tiếp'} (${row.actual})`;
      const details=document.createElement('p');details.textContent=`Trạng thái: ${statuses[row.decision.status]}. ${row.decision.reason} Người nhận: ${labels[row.decision.receiver]||'Không cần'}. Câu hỏi: ${row.decision.question||'Không cần hỏi'}`;
      item.append(title,details);list.append(item);
    }
    target.append(list);return rows;
  };
})();
