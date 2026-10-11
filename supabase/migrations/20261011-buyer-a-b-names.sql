-- Forward-only migration: separate personal and organization buyer names, and route clear omissions through U1.
-- Keeps the prior supplier, duplicate, amount, VAT and approval rules intact.
BEGIN;

create or replace function public.submit_request(p_id uuid,p_payload jsonb,p_invoice_path text,
  p_request_path text,p_expected_version integer default 0)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  clean jsonb := '{}'::jsonb;
  field text;
  value_text text;
  legacy_buyer_mode text;
  buyer_person text;
  buyer_organization text;
  buyer_no_name_confirmed boolean;
  missing_fields text[] := array[]::text[];
  amt bigint;
  was_existing boolean;
  next_status text;
begin
  if auth.uid() is null or public.my_role() is distinct from 'applicant' then
    raise exception 'Chỉ người nộp đơn được gửi hồ sơ.';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Thông tin form không hợp lệ.'; end if;
  foreach field in array array['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate'] loop
    value_text:=trim(coalesce(p_payload->>field,''));
    if length(value_text)>1000 then raise exception 'Trường % tối đa 1000 ký tự.',field; end if;
    clean:=clean||jsonb_build_object(field,value_text);
    if value_text='' then missing_fields:=array_append(missing_fields,field); end if;
  end loop;
  if clean->>'requesterType' not in ('employee','department') then
    if not ('requesterType'=any(missing_fields)) then missing_fields:=array_append(missing_fields,'requesterType'); end if;
  end if;
  legacy_buyer_mode:=upper(trim(coalesce(p_payload->>'buyerMode','')));
  buyer_person:=trim(coalesce(p_payload->>'buyerPersonName',case when legacy_buyer_mode='PERSON' then p_payload->>'buyerCompany' else '' end,''));
  buyer_organization:=trim(coalesce(p_payload->>'buyerOrganizationName',case when legacy_buyer_mode='ORGANIZATION' then p_payload->>'buyerCompany' else '' end,''));
  if length(buyer_person)>1000 then raise exception 'Tên cá nhân người mua tối đa 1000 ký tự.'; end if;
  if length(buyer_organization)>1000 then raise exception 'Tên doanh nghiệp/đơn vị người mua tối đa 1000 ký tự.'; end if;
  if p_payload ? 'buyerNoNameConfirmed' and jsonb_typeof(p_payload->'buyerNoNameConfirmed') is distinct from 'boolean' then
    raise exception 'Xác nhận hóa đơn không ghi tên người mua không hợp lệ.';
  end if;
  buyer_no_name_confirmed:=coalesce((p_payload->>'buyerNoNameConfirmed')::boolean,legacy_buyer_mode='NO_NAME');
  if buyer_person<>'' or buyer_organization<>'' then buyer_no_name_confirmed:=false; end if;
  clean:=clean||jsonb_build_object(
    'buyerPersonName',buyer_person,
    'buyerOrganizationName',buyer_organization,
    'buyerNoNameConfirmed',buyer_no_name_confirmed,
    'buyerMode',case when buyer_no_name_confirmed then 'NO_NAME'
      when buyer_person<>'' and buyer_organization<>'' then 'BOTH'
      when buyer_person<>'' then 'PERSON'
      when buyer_organization<>'' then 'ORGANIZATION' else '' end,
    'buyerCompany',case when buyer_organization<>'' then buyer_organization else buyer_person end
  );
  if buyer_person='' and buyer_organization='' and not buyer_no_name_confirmed then
    missing_fields:=array_append(missing_fields,'buyerNoNameConfirmed');
  end if;
  if clean->>'invoiceDate'<>'' then
    if (clean->>'invoiceDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      missing_fields:=array_append(missing_fields,'invoiceDate');
    else
      begin
        if to_char((clean->>'invoiceDate')::date,'YYYY-MM-DD')<>(clean->>'invoiceDate') then
          missing_fields:=array_append(missing_fields,'invoiceDate');
        end if;
      exception when invalid_datetime_format or datetime_field_overflow then
        missing_fields:=array_append(missing_fields,'invoiceDate');
      end;
    end if;
  end if;
  if coalesce(p_payload->>'amount','') ~ '^[0-9]{1,12}$' then
    amt:=(p_payload->>'amount')::bigint;
    if amt<1 then amt:=null; end if;
  else amt:=null; end if;
  if amt is null then missing_fields:=array_append(missing_fields,'amount'); end if;
  clean:=clean||jsonb_build_object('amount',amt);
  if coalesce(length(trim(p_payload->>'invoiceType')),0)>1000 then raise exception 'Trường invoiceType tối đa 1000 ký tự.'; end if;
  if nullif(trim(p_payload->>'invoiceType'),'') is not null then clean:=clean||jsonb_build_object('invoiceType',trim(p_payload->>'invoiceType')); end if;
  if p_invoice_path is null or split_part(p_invoice_path,'/',1)<>auth.uid()::text
    or p_invoice_path !~ '/invoice\.pdf$'
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path)
    or (p_request_path is not null and (
      split_part(p_request_path,'/',1)<>auth.uid()::text
      or split_part(p_invoice_path,'/',2)<>split_part(p_request_path,'/',2)
      or p_request_path !~ '/request\.(pdf|jpg|png)$'
      or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
    )) then
    raise exception 'Cần tải hóa đơn PDF của chính tài khoản này; đơn đề nghị đính kèm (nếu có) phải thuộc cùng hồ sơ.';
  end if;
  select * into r from public.requests where id=p_id for update;
  was_existing:=found;
  next_status:=case when cardinality(missing_fields)>0 then 'NEEDS_INFO' else 'TREASURER_REVIEW' end;
  if was_existing then
    if r.owner_id<>auth.uid() or r.status<>'NEEDS_INFO' or p_expected_version is null or r.version<>p_expected_version then
      raise exception 'Hồ sơ đã thay đổi hoặc không được phép bổ sung. Hãy tải lại.';
    end if;
    delete from public.vendor_review_notes where request_id=p_id;
    update public.requests set payload=clean,amount=amt,invoice_path=p_invoice_path,request_path=p_request_path,
      status=next_status,
      checks=case when next_status='NEEDS_INFO' then jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(missing_fields)) else null end,
      reason=case when next_status='NEEDS_INFO' then 'Hồ sơ còn thiếu thông tin bắt buộc; đã trả người nộp để bổ sung.' else 'Người nộp đã bổ sung đủ form; chờ đánh giá hóa đơn.' end,
      escalated_at=null,approved_at=null,version=version+1,updated_at=now()
      where id=p_id returning * into r;
  else
    if p_expected_version is null or p_expected_version<>0 then raise exception 'Không tìm thấy phiên bản hồ sơ.'; end if;
    insert into public.requests(id,owner_id,payload,amount,invoice_path,request_path,status,checks,reason)
      values(p_id,auth.uid(),clean,amt,p_invoice_path,p_request_path,next_status,
        case when next_status='NEEDS_INFO' then jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(missing_fields)) else null end,
        case when next_status='NEEDS_INFO' then 'Hồ sơ còn thiếu thông tin bắt buộc; đã trả người nộp để bổ sung.' else 'Đã gửi đủ form; chờ đánh giá hóa đơn.' end)
      returning * into r;
  end if;
  return r;
end $$;

create or replace function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  f jsonb:=p_analysis->'fields';
  raw_kind text:=upper(trim(coalesce(p_analysis->'fields'->'invoiceKind'->>'value','UNKNOWN')));
  invoice_kind text;
  buyer_mode text;
  buyer_person_form text;
  buyer_org_form text;
  buyer_no_name_confirmed boolean;
  buyer_person text;
  buyer_org text;
  buyer_person_conf numeric;
  buyer_org_conf numeric;
  buyer_person_status text;
  buyer_org_status text;
  buyer_person_clear boolean;
  buyer_org_clear boolean;
  buyer_clear boolean;
  buyer_conflict boolean;
  buyer_missing_fields text[]:=array[]::text[];
  vendor_value text;
  tax_value text;
  vendor_conf numeric;
  tax_conf numeric;
  invoice_no text;
  invoice_no_conf numeric;
  total_amount bigint;
  total_conf numeric;
  before_tax bigint;
  before_conf numeric;
  vat_amount bigint;
  vat_conf numeric;
  discount_amount bigint;
  discount_conf numeric;
  vendor_match jsonb;
  known_vendor boolean;
  vendor_alias_update_candidate boolean;
  new_vendor boolean;
  vendor_note_candidate boolean;
  vendor_note_type text;
  vendor_clear boolean;
  vendor_conflict boolean;
  number_clear boolean;
  number_match boolean;
  total_clear boolean;
  total_match boolean;
  vat_clear boolean:=true;
  discount_clear boolean:=true;
  totals_consistent boolean:=true;
  missing_fields text[]:=array[]::text[];
  required_field text;
  issue_count integer;
  exact_duplicate boolean:=false;
  assessment_code text;
  target text;
  why text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version<>p_expected_version or r.status<>'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ phân tích.';
  end if;
  foreach required_field in array array['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate'] loop
    if coalesce(trim(r.payload->>required_field),'')='' then missing_fields:=array_append(missing_fields,required_field); end if;
  end loop;
  if coalesce(trim(r.payload->>'buyerPersonName'),case when upper(coalesce(r.payload->>'buyerMode',''))='PERSON' then trim(coalesce(r.payload->>'buyerCompany','')) else '' end,'')=''
    and coalesce(trim(r.payload->>'buyerOrganizationName'),case when upper(coalesce(r.payload->>'buyerMode',''))='ORGANIZATION' then trim(coalesce(r.payload->>'buyerCompany','')) else '' end,'')=''
    and coalesce(r.payload->>'buyerNoNameConfirmed','false')<>'true' and upper(coalesce(r.payload->>'buyerMode',''))<>'NO_NAME' then
    missing_fields:=array_append(missing_fields,'buyerNoNameConfirmed');
  end if;
  if r.amount is null then missing_fields:=array_append(missing_fields,'amount'); end if;
  if cardinality(missing_fields)>0 then
    update public.requests set status='NEEDS_INFO',checks=jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(missing_fields)),
      reason='Hồ sơ chưa đủ dữ liệu form để phân tích; trả người nộp bổ sung.',version=version+1,updated_at=now()
      where id=p_id returning * into r;
    return r;
  end if;

  invoice_kind:=case when raw_kind='SALES'
    and coalesce(nullif(f->'invoiceKind'->>'confidence','')::numeric,0)>=0.90
    and length(trim(coalesce(f->'invoiceKind'->>'evidence','')))>0 then 'SALES' else 'VAT' end;
  buyer_mode:=upper(coalesce(r.payload->>'buyerMode',''));
  buyer_person_form:=trim(coalesce(r.payload->>'buyerPersonName',case when buyer_mode='PERSON' then r.payload->>'buyerCompany' else '' end,''));
  buyer_org_form:=trim(coalesce(r.payload->>'buyerOrganizationName',case when buyer_mode='ORGANIZATION' then r.payload->>'buyerCompany' else '' end,''));
  buyer_no_name_confirmed:=r.payload->>'buyerNoNameConfirmed'='true' or buyer_mode='NO_NAME';
  buyer_person:=trim(coalesce(f->'buyerPersonName'->>'value',''));
  buyer_org:=trim(coalesce(f->'buyerOrganizationName'->>'value',''));
  buyer_person_conf:=coalesce(nullif(f->'buyerPersonName'->>'confidence','')::numeric,0);
  buyer_org_conf:=coalesce(nullif(f->'buyerOrganizationName'->>'confidence','')::numeric,0);
  buyer_person_status:=coalesce(p_analysis->'assessment'->'matching'->'buyerIdentity'->'fields'->'buyerPersonName'->>'status','UNVERIFIED');
  buyer_org_status:=coalesce(p_analysis->'assessment'->'matching'->'buyerIdentity'->'fields'->'buyerOrganizationName'->>'status','UNVERIFIED');

  if buyer_person_form='' and not buyer_no_name_confirmed and buyer_person_status='FORM_MISSING'
    and buyer_person<>'' and buyer_person_conf>=0.80 and trim(coalesce(f->'buyerPersonName'->>'evidence',''))<>'' then
    buyer_missing_fields:=array_append(buyer_missing_fields,'buyerPersonName');
  end if;
  if buyer_org_form='' and not buyer_no_name_confirmed and buyer_org_status='FORM_MISSING'
    and buyer_org<>'' and buyer_org_conf>=0.80 and trim(coalesce(f->'buyerOrganizationName'->>'evidence',''))<>'' then
    buyer_missing_fields:=array_append(buyer_missing_fields,'buyerOrganizationName');
  end if;

  buyer_person_clear:=case when buyer_person_form<>'' then buyer_person_status='MATCH' and buyer_person<>'' and buyer_person_conf>=0.80
      and trim(coalesce(f->'buyerPersonName'->>'evidence',''))<>''
    else buyer_person_status='NOT_REQUIRED' and buyer_person='' and buyer_person_conf>=0.80
      and trim(coalesce(f->'buyerPersonName'->>'evidence',''))<>'' end;
  buyer_org_clear:=case when buyer_org_form<>'' then buyer_org_status='MATCH' and buyer_org<>'' and buyer_org_conf>=0.80
      and trim(coalesce(f->'buyerOrganizationName'->>'evidence',''))<>''
    else buyer_org_status='NOT_REQUIRED' and buyer_org='' and buyer_org_conf>=0.80
      and trim(coalesce(f->'buyerOrganizationName'->>'evidence',''))<>'' end;
  buyer_clear:=buyer_person_clear and buyer_org_clear;
  buyer_conflict:=exists(select 1 from jsonb_array_elements(coalesce(p_analysis->'assessment'->'fieldIssues','[]'::jsonb)) as issue(item)
    where p_analysis->>'buyerRereadStatus'='COMPLETED'
      and issue.item->>'severity'='RED'
      and ((issue.item->>'field'='buyerPersonName' and buyer_person_conf>=0.80 and trim(coalesce(f->'buyerPersonName'->>'evidence',''))<>''
          and (buyer_person_form<>'' or buyer_no_name_confirmed))
        or (issue.item->>'field'='buyerOrganizationName' and buyer_org_conf>=0.80 and trim(coalesce(f->'buyerOrganizationName'->>'evidence',''))<>''
          and (buyer_org_form<>'' or buyer_no_name_confirmed))));

  vendor_value:=trim(coalesce(f->'vendor'->>'value',''));
  tax_value:=trim(coalesce(f->'taxCode'->>'value',''));
  vendor_conf:=coalesce(nullif(f->'vendor'->>'confidence','')::numeric,0);
  tax_conf:=coalesce(nullif(f->'taxCode'->>'confidence','')::numeric,0);
  vendor_match:=public.resolve_vendor_name_match_with_confidence(r.payload->>'vendor',
    case when vendor_value<>'' and trim(coalesce(f->'vendor'->>'evidence',''))<>'' then vendor_value else null end,
    case when tax_value<>'' and tax_conf>=0.80 and trim(coalesce(f->'taxCode'->>'evidence',''))<>'' then tax_value else null end,
    vendor_conf);
  known_vendor:=vendor_match->>'status'='MATCH'
    and vendor_match->>'method'='VERIFIED_ALIAS'
    and vendor_value<>'' and trim(coalesce(f->'vendor'->>'evidence',''))<>'' and vendor_conf>=0.70
    and tax_value<>'' and trim(coalesce(f->'taxCode'->>'evidence',''))<>'' and tax_conf>=0.85;
  vendor_alias_update_candidate:=vendor_match->>'status'='MATCH'
    and vendor_match->>'method'='VERIFIED_TAX_CODE_ALIAS_CANDIDATE'
    and coalesce(nullif(vendor_match->>'name_similarity','')::numeric,0)>=0.80
    and coalesce(nullif(vendor_match->>'vendor_id',''),'')<>''
    and vendor_value<>'' and trim(coalesce(f->'vendor'->>'evidence',''))<>'' and vendor_conf>=0.70
    and tax_value<>'' and trim(coalesce(f->'taxCode'->>'evidence',''))<>'' and tax_conf>=0.85;
  new_vendor:=vendor_match->>'status'='NO_MATCH'
    and public.normalize_party_name(vendor_value)=public.normalize_party_name(r.payload->>'vendor')
    and vendor_value<>'' and trim(coalesce(f->'vendor'->>'evidence',''))<>'' and vendor_conf>=0.80
    and tax_value<>'' and trim(coalesce(f->'taxCode'->>'evidence',''))<>'' and tax_conf>=0.80;
  vendor_note_candidate:=coalesce(new_vendor,false) or coalesce(vendor_alias_update_candidate,false);
  vendor_note_type:=case when vendor_alias_update_candidate then 'ALIAS_UPDATE' else 'NEW_VENDOR' end;
  vendor_clear:=coalesce(known_vendor,false) or coalesce(vendor_alias_update_candidate,false) or coalesce(new_vendor,false);
  vendor_conflict:=vendor_match->>'status'='MISMATCH' and vendor_match->>'method'='TAX_CODE_CONFLICT'
    and tax_conf>=0.85 and trim(coalesce(f->'taxCode'->>'evidence',''))<>'';

  invoice_no:=trim(coalesce(f->'invoiceNumber'->>'value',''));
  invoice_no_conf:=coalesce(nullif(f->'invoiceNumber'->>'confidence','')::numeric,0);
  number_clear:=invoice_no<>'' and invoice_no_conf>=0.80 and trim(coalesce(f->'invoiceNumber'->>'evidence',''))<>'';
  number_match:=public.normalize_invoice_number(invoice_no)=public.normalize_invoice_number(r.payload->>'invoiceNumber');
  total_amount:=coalesce(nullif(f->'totalAmount'->>'value','')::bigint,0);
  total_conf:=coalesce(nullif(f->'totalAmount'->>'confidence','')::numeric,0);
  total_clear:=total_amount>0 and total_conf>=case when invoice_kind='SALES' then 0.81 else 0.90 end
    and trim(coalesce(f->'totalAmount'->>'evidence',''))<>'';
  total_match:=total_amount=r.amount;

  discount_amount:=abs(coalesce(nullif(f->'discountAmount'->>'value','')::bigint,0));
  discount_conf:=coalesce(nullif(f->'discountAmount'->>'confidence','')::numeric,0);
  if discount_amount>0 or trim(coalesce(f->'discountAmount'->>'evidence',''))<>'' then
    discount_clear:=discount_conf>=0.85 and trim(coalesce(f->'discountAmount'->>'evidence',''))<>'';
  end if;
  if invoice_kind='VAT' then
    before_tax:=coalesce(nullif(f->'amountBeforeTax'->>'value','')::bigint,0);
    before_conf:=coalesce(nullif(f->'amountBeforeTax'->>'confidence','')::numeric,0);
    vat_amount:=coalesce(nullif(f->'vatAmount'->>'value','')::bigint,-1);
    vat_conf:=coalesce(nullif(f->'vatAmount'->>'confidence','')::numeric,0);
    before_conf:=case when before_tax>=0 and before_conf>=0.90 and trim(coalesce(f->'amountBeforeTax'->>'evidence',''))<>'' then before_conf else 0 end;
    vat_clear:=vat_amount>=0 and vat_conf>=case when vat_amount=0 then 0.70 else 0.90 end
      and trim(coalesce(f->'vatAmount'->>'evidence',''))<>''
      and (vat_amount<>0 or (
        coalesce(f->'vatAmount'->>'evidence','') ~* '(VAT|thu[eế])'
        and coalesce(f->'vatAmount'->>'evidence','') ~* '(^|[^0-9])0([,.]0+)?([^0-9]|$)'
      ));
    vat_clear:=vat_clear and before_conf>=0.90;
    if before_conf>=0.90 and vat_clear and discount_clear and total_clear then
      totals_consistent:=before_tax-discount_amount+vat_amount=total_amount;
    else totals_consistent:=false; end if;
  end if;

  assessment_code:=upper(coalesce(p_analysis->'assessment'->>'code','U2'));
  select exists(select 1 from public.requests a
    where a.id<>r.id and a.status='APPROVED'
      and tax_conf>=0.80 and length(trim(coalesce(f->'taxCode'->>'evidence','')))>0
      and number_clear
      and (public.request_duplicate_identifiers(a.checks,a.payload)->>'taxCode')=public.normalize_vendor_tax_code(tax_value)
      and (public.request_duplicate_identifiers(a.checks,a.payload)->>'invoiceNumber')=public.normalize_invoice_number(invoice_no)
  ) into exact_duplicate;

  issue_count:=case when jsonb_typeof(p_analysis->'assessment'->'fieldIssues')='array'
    then jsonb_array_length(p_analysis->'assessment'->'fieldIssues') else 0 end;
  if not vendor_clear then issue_count:=issue_count+1; end if;
  if not buyer_clear then issue_count:=issue_count+1; end if;
  if not number_clear or not number_match then issue_count:=issue_count+1; end if;
  if not total_clear or not total_match then issue_count:=issue_count+1; end if;
  if invoice_kind='VAT' and (not vat_clear or not totals_consistent) then issue_count:=issue_count+1; end if;
  if not discount_clear then issue_count:=issue_count+1; end if;

  assessment_code:=case when exact_duplicate or buyer_conflict or vendor_conflict then 'REJECTED'
    when cardinality(buyer_missing_fields)>0 then 'U1'
    when issue_count>0 or assessment_code='U2' then 'U2'
    when r.amount>20000000 or assessment_code='U3' then 'U3' else 'CLEAR' end;
  target:=case assessment_code when 'REJECTED' then 'REJECTED' when 'U1' then 'NEEDS_INFO' when 'U2' then 'TREASURER_REVIEW'
    when 'U3' then 'CFO_REVIEW' else 'READY_FOR_APPROVAL' end;
  why:=case when exact_duplicate then 'Phát hiện trùng mã số thuế và số hóa đơn với hồ sơ đã được duyệt; hồ sơ bị từ chối để tránh thanh toán trùng.'
    when assessment_code='U1' then 'AI đọc rõ tên người mua trên hóa đơn nhưng ô tương ứng còn trống; trả người nộp bổ sung đúng ô.'
    when assessment_code='REJECTED' then left(coalesce(nullif(p_analysis->'assessment'->>'reason',''),'AI phát hiện mâu thuẫn rõ giữa hóa đơn và thông tin khai báo.'),2000)
    when assessment_code='U2' then left(case
      when upper(coalesce(p_analysis->'assessment'->>'code','')) in ('CLEAR','U3')
        then 'Kiểm tra cuối phía máy chủ phát hiện trường chưa đủ điều kiện tự động duyệt; Quản lý cần đối chiếu hóa đơn PDF với form.'
      else coalesce(nullif(p_analysis->'assessment'->>'reason',''),'Có trường cần quản lý kiểm tra trước khi quyết định.') end,2000)
    when assessment_code='U3' then 'AI đã đánh giá hóa đơn đạt điều kiện; hồ sơ vượt 20 triệu/hóa đơn nên chuyển Giám đốc Tài chính.'
    else 'AI đã đánh giá hóa đơn đạt các ngưỡng đã chốt; chờ Quản lý duyệt trong thẩm quyền.' end;

  update public.requests set status=target,reason=why,
    escalated_at=case when target='CFO_REVIEW' then coalesce(escalated_at,now()) else escalated_at end,
    checks=coalesce(checks,'{}'::jsonb)||jsonb_build_object(
      'assessment_code',assessment_code,'invoice_fields_match',vendor_clear and buyer_clear and number_clear and number_match,
      'invoice_totals_consistent',case when invoice_kind='SALES' then true else totals_consistent end,
      'invoice_kind',invoice_kind,'vendor_identity_method',coalesce(vendor_match->>'method','UNVERIFIED'),
      'new_vendor_candidate',new_vendor,'budget_checked',false,'policy_checked',false,'ai',p_analysis)
      ||case when assessment_code='U1' then jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(buyer_missing_fields)) else '{}'::jsonb end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  if vendor_note_candidate then
    insert into public.vendor_review_notes(request_id,vendor_name,tax_code,invoice_path,evidence)
      values(r.id,vendor_value,tax_value,r.invoice_path,jsonb_build_object(
        'reviewType',vendor_note_type,'vendorId',vendor_match->>'vendor_id',
        'nameSimilarity',vendor_match->'name_similarity',
        'vendor',f->'vendor','taxCode',f->'taxCode','invoiceNumber',f->'invoiceNumber'))
      on conflict(request_id) do update set vendor_name=excluded.vendor_name,tax_code=excluded.tax_code,
        invoice_path=excluded.invoice_path,evidence=excluded.evidence,created_at=now(),reviewed_at=null,reviewed_by=null;
  else
    delete from public.vendor_review_notes where request_id=r.id and reviewed_at is null;
  end if;
  return r;
end $$;

revoke execute on function public.submit_request(uuid,jsonb,text,text,integer) from public,anon;
grant execute on function public.submit_request(uuid,jsonb,text,text,integer) to authenticated;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
