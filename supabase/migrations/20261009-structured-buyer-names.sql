-- Forward-only update: assess the applicant-selected buyer identity field.
-- Expects the production forward-sync functions and the 81% Sales threshold.
begin;

create or replace function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  f jsonb:=p_analysis->'fields';
  raw_kind text:=upper(trim(coalesce(p_analysis->'fields'->'invoiceKind'->>'value','UNKNOWN')));
  invoice_kind text;
  buyer_mode text;
  buyer_field text;
  buyer_name text;
  buyer_conf numeric;
  buyer_evidence text;
  buyer_person text;
  buyer_org text;
  buyer_person_conf numeric;
  buyer_org_conf numeric;
  buyer_match boolean;
  buyer_clear boolean;
  buyer_conflict boolean;
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
  foreach required_field in array array['requesterType','requester','department','buyerMode','budgetCode','purpose','vendor','invoiceNumber','invoiceDate'] loop
    if coalesce(trim(r.payload->>required_field),'')='' then missing_fields:=array_append(missing_fields,required_field); end if;
  end loop;
  if upper(coalesce(r.payload->>'buyerMode','')) in ('PERSON','ORGANIZATION')
    and coalesce(trim(r.payload->>'buyerCompany'),'')='' then missing_fields:=array_append(missing_fields,'buyerCompany'); end if;
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
  buyer_field:=case buyer_mode when 'PERSON' then 'buyerPersonName' when 'ORGANIZATION' then 'buyerOrganizationName' else null end;
  buyer_person:=trim(coalesce(f->'buyerPersonName'->>'value',''));
  buyer_org:=trim(coalesce(f->'buyerOrganizationName'->>'value',''));
  buyer_person_conf:=coalesce(nullif(f->'buyerPersonName'->>'confidence','')::numeric,0);
  buyer_org_conf:=coalesce(nullif(f->'buyerOrganizationName'->>'confidence','')::numeric,0);
  buyer_name:=case when buyer_field='buyerPersonName' then buyer_person when buyer_field='buyerOrganizationName' then buyer_org else '' end;
  buyer_conf:=case when buyer_field='buyerPersonName' then buyer_person_conf when buyer_field='buyerOrganizationName' then buyer_org_conf else 0 end;
  buyer_evidence:=case when buyer_field='buyerPersonName' then trim(coalesce(f->'buyerPersonName'->>'evidence',''))
    when buyer_field='buyerOrganizationName' then trim(coalesce(f->'buyerOrganizationName'->>'evidence','')) else '' end;
  buyer_match:=case when buyer_mode='NO_NAME' then buyer_person='' and buyer_org=''
    when buyer_field is not null then buyer_name<>''
      and public.normalize_party_name(buyer_name)=public.normalize_party_name(r.payload->>'buyerCompany')
    else false end;
  buyer_clear:=case when buyer_mode='NO_NAME' then buyer_match and buyer_person='' and buyer_org=''
      and buyer_person_conf>=0.80 and buyer_org_conf>=0.80
      and length(trim(coalesce(f->'buyerPersonName'->>'evidence','')))>0
      and length(trim(coalesce(f->'buyerOrganizationName'->>'evidence','')))>0
    else buyer_field is not null and buyer_match and buyer_name<>'' and buyer_conf>=0.80 and buyer_evidence<>'' end;
  buyer_conflict:=exists(select 1 from jsonb_array_elements(coalesce(p_analysis->'assessment'->'fieldIssues','[]'::jsonb)) as issue(item)
    where issue.item->>'severity'='RED'
      and ((buyer_mode in ('PERSON','NO_NAME') and issue.item->>'field'='buyerPersonName' and buyer_person<>'' and buyer_person_conf>=0.80
          and length(trim(coalesce(f->'buyerPersonName'->>'evidence','')))>0)
        or (buyer_mode in ('ORGANIZATION','NO_NAME') and issue.item->>'field'='buyerOrganizationName' and buyer_org<>'' and buyer_org_conf>=0.80
          and length(trim(coalesce(f->'buyerOrganizationName'->>'evidence','')))>0)));

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
    when issue_count>0 or assessment_code='U2' then 'U2'
    when r.amount>20000000 or assessment_code='U3' then 'U3' else 'CLEAR' end;
  target:=case assessment_code when 'REJECTED' then 'REJECTED' when 'U2' then 'TREASURER_REVIEW'
    when 'U3' then 'CFO_REVIEW' else 'READY_FOR_APPROVAL' end;
  why:=case when exact_duplicate then 'Phát hiện trùng mã số thuế và số hóa đơn với hồ sơ đã được duyệt; hồ sơ bị từ chối để tránh thanh toán trùng.'
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
      'new_vendor_candidate',new_vendor,'budget_checked',false,'policy_checked',false,'ai',p_analysis),
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

commit;
notify pgrst, 'reload schema';
