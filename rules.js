(function(root) {
  // Preview only. The online RPCs also enforce the daily aggregate and two-stage authority flow.
  function assess(amount,checks={}) {
    if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999) return 'U1';
    if(checks.requiredFieldsMissing===true||checks.pdf!==true) return 'U1';
    if(checks.clearContradiction===true||checks.duplicateApproved===true) return 'REJECTED';
    if(['fieldsMatch','totalsConsistent','confidenceSufficient'].some(k=>checks[k]===false)
      ||checks.managerReview===true) return 'U2';
    return amount>20000000?'U3':'CLEAR';
  }
  function verify() {
    const all={pdf:true,fieldsMatch:true,totalsConsistent:true,confidenceSufficient:true};
    const cases=[
      ['Một đồng',1,all,'CLEAR'],['12,5 triệu',12500000,all,'CLEAR'],['Đúng 20 triệu gồm VAT',20000000,all,'CLEAR'],
      ['20 triệu + 1 gồm VAT',20000001,all,'U3'],['Không phân loại rõ · mặc định VAT',1000,{...all,invoiceKindUncertain:true},'CLEAR'],
      ['Chọn hóa đơn không ghi tên người mua',1000,{...all,buyerMode:'NO_NAME'},'CLEAR'],
      ['Thiếu trường form sau khi gửi',1000,{...all,requiredFieldsMissing:true},'U1'],['Không có hóa đơn PDF',1000,{...all,pdf:false},'U1'],
      ['Confidence trường quyết định thấp',1000,{...all,confidenceSufficient:false},'U2'],['Số hóa đơn cần quản lý kiểm tra',1000,{...all,fieldsMatch:false},'U2'],
      ['Tổng trên form lệch PDF',1000,{...all,fieldsMatch:false},'U2'],['Phép tính VAT không khớp',1000,{...all,totalsConsistent:false},'U2'],
      ['Mâu thuẫn người mua/NCC đã rõ',1000,{...all,clearContradiction:true},'REJECTED'],['Trùng MST và số với hồ sơ đã duyệt',1000,{...all,duplicateApproved:true},'REJECTED'],
      ['VAT=0 confidence 69%',1000,{...all,confidenceSufficient:false},'U2'],['VAT=0 confidence 70% và có bằng chứng',1000,all,'CLEAR'],
      ['Ngày hóa đơn và tiền còn phải trả chỉ để tham khảo',1000,{...all,invoiceDateConfidence:0,amountDueConfidence:0},'CLEAR']
    ];
    return cases.map(([name,amount,checks,expected])=>{const actual=assess(amount,checks);return {name,expected,actual,pass:actual===expected};});
  }
  root.FinRefRules={assess,verify};
  if(typeof module!=='undefined') module.exports=root.FinRefRules;
})(globalThis);
