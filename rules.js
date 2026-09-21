(function(root) {
  // Preview only. The authoritative rules are enforced by the database RPC.
  function assess(amount,checks={}) {
    if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999) return 'U1';
    if(['paper','stamp','signature','match'].some(k=>checks[k]!==true)) return 'U1';
    if(checks.budget!==true||checks.policy!==true) return 'U2';
    return amount>20000000?'U3':'CLEAR';
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
    return cases.map(([name,amount,checks,expected])=>{const actual=assess(amount,checks);return {name,expected,actual,pass:actual===expected};});
  }
  root.FinRefRules={assess,verify};
  if(typeof module!=='undefined') module.exports=root.FinRefRules;
})(globalThis);
