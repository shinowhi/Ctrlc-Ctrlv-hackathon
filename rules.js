(function(root) {
  // Preview only. The authoritative rules are enforced by the database RPC.
  function assess(amount,checks={}) {
    if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999) return 'U1';
    if(['paper','stamp','signature','match'].some(k=>checks[k]!==true)) return 'U1';
    if(checks.budget!==true||checks.policy!==true) return 'U2';
    return amount>20000000?'U3':'CLEAR';
  }
  function money(amount) { return new Intl.NumberFormat('vi-VN').format(amount) + ' ₫'; }
  function decide(amount,checks={}) {
    const code=assess(amount,checks);
    if(code==='CLEAR') return {action:'AUTO_APPROVE',code,receiver:null,question:null};
    if(code==='U1') {
      const labels={paper:'bản chụp hóa đơn giấy',stamp:'dấu đỏ',signature:'chữ ký',match:'đối chiếu thông tin'};
      const missing=Object.keys(labels).filter(k=>checks[k]!==true).map(k=>labels[k]);
      if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999) missing.unshift('số tiền nguyên dương hợp lệ');
      return {action:'ESCALATE',code,receiver:'treasurer',question:`Chưa xác minh được ${missing.join(', ')}. Vui lòng bổ sung hoặc xác nhận minh chứng tương ứng trước khi xử lý hồ sơ.`};
    }
    if(code==='U2') return {action:'ESCALATE',code,receiver:'cfo',question:'Khoản chi chưa được xác định là phù hợp với ngân sách hoặc chính sách hiện hành. Có phê duyệt ngoại lệ cho hồ sơ này không?'};
    return {action:'ESCALATE',code,receiver:'cfo',question:`Khoản chi ${money(amount)} vượt hạn mức tự động 20.000.000 ₫. Giám đốc Tài chính có phê duyệt khoản này không?`};
  }
  function execute(amount,checks={}) {
    const decision=decide(amount,checks);
    return {...decision,status:decision.code==='CLEAR'?'APPROVED':decision.code==='U1'?'NEEDS_INFO':'CFO_REVIEW',reason:decision.code==='CLEAR'?'Đủ điều kiện mẫu và trong quyền tự động 20 triệu.':decision.code==='U1'?'Thông tin chưa xác minh.':decision.code==='U2'?'Cần quyết định ngoại lệ chính sách/ngân sách.':'Vượt quyền tự động.'};
  }
  function verify() {
    const all={paper:true,stamp:true,signature:true,match:true,budget:true,policy:true};
    const cases=[
      ['1 đồng',1,all,'CLEAR'],['12,5 triệu',12500000,all,'CLEAR'],['Đúng 20 triệu',20000000,all,'CLEAR'],
      ['20 triệu + 1',20000001,all,'U3'],['Thiếu chữ ký',1000,{...all,signature:false},'U1'],
      ['Thiếu dấu',1000,{...all,stamp:false},'U1'],['Chưa đối chiếu',1000,{...all,match:false},'U1'],
      ['Không phải hóa đơn giấy',1000,{...all,paper:false},'U1'],['Vượt ngân sách',1000,{...all,budget:false},'U2'],
      ['Ngoài chính sách',1000,{...all,policy:false},'U2'],['Số tiền 0',0,all,'U1'],['Số tiền âm',-1,all,'U1'],
      ['Số thập phân',1.5,all,'U1'],['U1 trước U3',24000000,{...all,stamp:false},'U1'],['U2 trước U3',24000000,{...all,budget:false},'U2']
    ];
    return cases.map(([name,amount,checks,expected])=>{
      const decision=execute(amount,checks),actual=decision.code;
      const expectedAction=expected==='CLEAR'?'AUTO_APPROVE':'ESCALATE';
      const expectedStatus=expected==='CLEAR'?'APPROVED':expected==='U1'?'NEEDS_INFO':'CFO_REVIEW';
      return {name,expected,actual,decision,expectedAction,expectedStatus,pass:actual===expected&&decision.action===expectedAction&&decision.status===expectedStatus&&(expected==='CLEAR'?decision.question===null:!!decision.question)};
    });
  }
  root.FinRefRules={assess,decide,execute,verify};
  if(typeof module!=='undefined') module.exports=root.FinRefRules;
})(globalThis);
