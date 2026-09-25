(function(root) {
  // Preview only. Database RPCs enforce the same invoice and authority boundaries.
  function assess(amount,checks={}) {
    if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999) return 'U1';
    if(['pdf','fieldsMatch','totalsConsistent','confidenceSufficient'].some(k=>checks[k]!==true)) return 'U1';
    return amount>20000000?'U3':'CLEAR';
  }
  function verify() {
    const all={pdf:true,fieldsMatch:true,totalsConsistent:true,confidenceSufficient:true};
    const cases=[
      ['Một đồng',1,all,'CLEAR'],['12,5 triệu',12500000,all,'CLEAR'],['Đúng 20 triệu gồm VAT',20000000,all,'CLEAR'],
      ['20 triệu + 1 gồm VAT',20000001,all,'U3'],['PDF scan đọc rõ',1000,all,'CLEAR'],
      ['Thiếu nhà cung cấp',1000,{...all,fieldsMatch:false},'U1'],['Sai số hóa đơn',1000,{...all,fieldsMatch:false},'U1'],
      ['Sai ngày hóa đơn',1000,{...all,fieldsMatch:false},'U1'],['Sai tổng so với form',1000,{...all,fieldsMatch:false},'U1'],
      ['Tổng trước thuế và VAT lệch',1000,{...all,totalsConsistent:false},'U1'],['Confidence thấp',1000,{...all,confidenceSufficient:false},'U1'],
      ['Không phải PDF',1000,{...all,pdf:false},'U1'],['Số tiền 0',0,all,'U1'],['Số tiền âm',-1,all,'U1'],
      ['U1 trước U3',24000000,{...all,confidenceSufficient:false},'U1']
    ];
    return cases.map(([name,amount,checks,expected])=>{const actual=assess(amount,checks);return {name,expected,actual,pass:actual===expected};});
  }
  root.FinRefRules={assess,verify};
  if(typeof module!=='undefined') module.exports=root.FinRefRules;
})(globalThis);
