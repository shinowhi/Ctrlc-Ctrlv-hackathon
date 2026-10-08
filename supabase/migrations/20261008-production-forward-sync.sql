-- Forward migration for the already-existing Supabase Production database.
-- Replays the agreed application RPCs and adds the missing status/table support.
begin;

alter table public.requests alter column amount drop not null;
alter table public.requests drop constraint if exists requests_amount_check;
alter table public.requests drop constraint if exists requests_amount_valid_for_status;
alter table public.requests add constraint requests_amount_valid_for_status check (
  (status='NEEDS_INFO' and (amount is null or amount between 1 and 999999999999))
  or (status<>'NEEDS_INFO' and amount is not null and amount between 1 and 999999999999)
);
-- READY_FOR_APPROVAL is emitted by record_invoice_analysis and must be allowed
-- by the existing table constraint before the RPC can persist a clear result.
alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check check (
  status in ('TREASURER_REVIEW','NEEDS_INFO','CFO_REVIEW','READY_FOR_APPROVAL','APPROVED','REJECTED')
);

create table if not exists public.vendor_review_notes (
  request_id uuid primary key references public.requests(id) on delete cascade,
  vendor_name text not null,
  tax_code text not null,
  invoice_path text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);
alter table public.vendor_review_notes enable row level security;
revoke all on public.vendor_review_notes from public,anon,authenticated;
grant all on public.vendor_review_notes to service_role;
drop policy if exists vendor_review_notes_cfo_read on public.vendor_review_notes;
create policy vendor_review_notes_cfo_read on public.vendor_review_notes
  for select to authenticated using (public.my_role()='cfo');

create or replace function public.can_read_request(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.requests r where r.id=p_id and (
    r.owner_id=auth.uid() or public.my_role()='treasurer'
      or (public.my_role()='cfo' and (
        r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000)
        or (r.status='APPROVED' and r.escalated_at is not null)
        or (r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED')
          and exists(select 1 from public.vendor_review_notes n where n.request_id=r.id and n.reviewed_at is null))
      ))
  ));
$$;

create or replace function public.vendor_review_note_list()
returns table(request_id uuid,vendor_name text,tax_code text,evidence jsonb,created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or public.my_role() is distinct from 'cfo' then
    raise exception 'Chỉ Giám đốc Tài chính được xem ghi chú cập nhật danh mục nhà cung cấp.';
  end if;
  return query select n.request_id,n.vendor_name,n.tax_code,n.evidence,n.created_at
    from public.vendor_review_notes n join public.requests r on r.id=n.request_id
    where n.reviewed_at is null and r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED')
    order by n.created_at desc;
end $$;

create or replace function public.vendor_review_note_resolve(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or public.my_role() is distinct from 'cfo' then
    raise exception 'Chỉ Giám đốc Tài chính được cập nhật ghi chú danh mục nhà cung cấp.';
  end if;
  update public.vendor_review_notes n set reviewed_at=now(),reviewed_by=auth.uid()
    from public.requests r
    where n.request_id=p_request_id and r.id=n.request_id
      and r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED') and n.reviewed_at is null;
  if not found then raise exception 'Ghi chú không tồn tại, đã xử lý hoặc hồ sơ còn chờ Quản lý.'; end if;
end $$;

drop policy if exists evidence_read on storage.objects;
create policy evidence_read on storage.objects for select to authenticated using (
  bucket_id='evidence' and (
    split_part(name,'/',1)=auth.uid()::text
    or exists(select 1 from public.requests r where public.can_read_request(r.id)
      and name in (r.invoice_path,r.request_path))
  )
);

create or replace function public.submit_request(p_id uuid,p_payload jsonb,p_invoice_path text,
  p_request_path text,p_expected_version integer default 0)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  clean jsonb := '{}'::jsonb;
  field text;
  value_text text;
  missing_fields text[] := array[]::text[];
  amt bigint;
  was_existing boolean;
  next_status text;
begin
  if auth.uid() is null or public.my_role() is distinct from 'applicant' then
    raise exception 'Chỉ người nộp đơn được gửi hồ sơ.';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Thông tin form không hợp lệ.'; end if;
  foreach field in array array['requesterType','requester','department','buyerMode','budgetCode','purpose','vendor','invoiceNumber','invoiceDate'] loop
    value_text:=trim(coalesce(p_payload->>field,''));
    if length(value_text)>1000 then raise exception 'Trường % tối đa 1000 ký tự.',field; end if;
    clean:=clean||jsonb_build_object(field,value_text);
    if value_text='' then missing_fields:=array_append(missing_fields,field); end if;
  end loop;
  if clean->>'requesterType' not in ('employee','department') then
    if not ('requesterType'=any(missing_fields)) then missing_fields:=array_append(missing_fields,'requesterType'); end if;
  end if;
  if clean->>'buyerMode' not in ('PERSON','ORGANIZATION','NO_NAME') then
    if not ('buyerMode'=any(missing_fields)) then missing_fields:=array_append(missing_fields,'buyerMode'); end if;
  end if;
  value_text:=trim(coalesce(p_payload->>'buyerCompany',''));
  if length(value_text)>1000 then raise exception 'Tên người mua tối đa 1000 ký tự.'; end if;
  if clean->>'buyerMode' in ('PERSON','ORGANIZATION') and value_text='' then
    missing_fields:=array_append(missing_fields,'buyerCompany');
  end if;
  clean:=clean||jsonb_build_object('buyerCompany',case when clean->>'buyerMode'='NO_NAME' then '' else value_text end);
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

-- Name similarity is calculated from meaningful words after removing company
-- legal forms, so the API and database apply the same 80% alias threshold.
create or replace function public.vendor_name_similarity(p_left text,p_right text)
returns numeric language plpgsql immutable parallel safe set search_path = '' as $$
declare
  left_text text;
  right_text text;
  left_tokens text[];
  right_tokens text[];
  shared_count integer;
  legal_words text[]:=array['cong','ty','tnhh','mot','thanh','vien','mtv','co','phan','cp','tap','doan','ho','kinh','doanh','nghiep','company','limited','ltd','inc','corp','corporation','llc','jsc'];
  accent_source text:='àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
  accent_target text:='aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';
begin
  left_text:=regexp_replace(translate(lower(normalize(trim(coalesce(p_left,'')),NFKC)),accent_source,accent_target),'[^a-z0-9]+',' ','g');
  right_text:=regexp_replace(translate(lower(normalize(trim(coalesce(p_right,'')),NFKC)),accent_source,accent_target),'[^a-z0-9]+',' ','g');
  select coalesce(array_agg(distinct word order by word),array[]::text[]) into left_tokens
    from regexp_split_to_table(left_text,'[[:space:]]+') as parts(word)
    where word<>'' and word<>all(legal_words);
  select coalesce(array_agg(distinct word order by word),array[]::text[]) into right_tokens
    from regexp_split_to_table(right_text,'[[:space:]]+') as parts(word)
    where word<>'' and word<>all(legal_words);
  if cardinality(left_tokens)=0 or cardinality(right_tokens)=0 then return 0; end if;
  select count(*) into shared_count from unnest(left_tokens) as token where token=any(right_tokens);
  return (2.0*shared_count)/(cardinality(left_tokens)+cardinality(right_tokens));
end $$;

-- A verified tax code identifies the supplier. A close but unregistered seller
-- name can pass as an alias candidate; CFO updates the directory later.
create or replace function public.resolve_vendor_name_match_with_confidence(
  p_form_name text,p_invoice_name text,p_invoice_tax_code text,p_invoice_name_confidence numeric
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  form_name text:=public.normalize_party_name(p_form_name);
  invoice_name text:=public.normalize_party_name(p_invoice_name);
  invoice_tax_code text:=public.normalize_vendor_tax_code(p_invoice_tax_code);
  form_vendor_id uuid;
  invoice_vendor_id uuid;
  tax_vendor_id uuid;
  registered_tax_code text;
  form_similarity numeric:=0;
  invoice_similarity numeric:=0;
  invoice_name_is_clear boolean:=coalesce(p_invoice_name_confidence,0)>=0.80;
  invoice_name_is_usable boolean:=coalesce(p_invoice_name_confidence,0)>=0.70;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được phân giải tên nhà cung cấp.'; end if;
  if form_name='' then return jsonb_build_object('status','NO_MATCH'); end if;
  select a.vendor_id into form_vendor_id from public.vendor_aliases a where a.normalized_name=form_name;
  if invoice_name<>'' then select a.vendor_id into invoice_vendor_id from public.vendor_aliases a where a.normalized_name=invoice_name; end if;
  if invoice_tax_code is not null then select v.id into tax_vendor_id from public.vendor_directory v where v.tax_code_key=invoice_tax_code; end if;
  if tax_vendor_id is not null then
    if form_vendor_id is not null and form_vendor_id is distinct from tax_vendor_id then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT','vendor_id',tax_vendor_id);
    end if;
    if invoice_vendor_id is not null and invoice_vendor_id is distinct from tax_vendor_id then
      if invoice_name_is_clear then
        return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT','vendor_id',tax_vendor_id);
      end if;
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_NAME_UNVERIFIED','vendor_id',tax_vendor_id);
    end if;

    select coalesce(max(public.vendor_name_similarity(form_name,n.name)),0),
      coalesce(max(public.vendor_name_similarity(invoice_name,n.name)),0)
      into form_similarity,invoice_similarity
      from (
        select v.legal_name as name from public.vendor_directory v where v.id=tax_vendor_id
        union all
        select a.alias_name as name from public.vendor_aliases a where a.vendor_id=tax_vendor_id
      ) n;
    if form_vendor_id is null and form_similarity<0.80 then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_NAME_UNVERIFIED',
        'vendor_id',tax_vendor_id,'name_similarity',form_similarity);
    end if;
    if invoice_vendor_id=tax_vendor_id then
      return jsonb_build_object('status','MATCH','method','VERIFIED_ALIAS','vendor_id',tax_vendor_id,
        'name_similarity',invoice_similarity);
    end if;
    if invoice_vendor_id is null and invoice_name_is_usable and invoice_similarity>=0.80 then
      return jsonb_build_object('status','MATCH','method','VERIFIED_TAX_CODE_ALIAS_CANDIDATE',
        'vendor_id',tax_vendor_id,'name_similarity',invoice_similarity);
    end if;
    return jsonb_build_object('status','MISMATCH','method','TAX_CODE_NAME_UNVERIFIED',
      'vendor_id',tax_vendor_id,'name_similarity',invoice_similarity);
  end if;
  if invoice_name='' then return jsonb_build_object('status','NO_MATCH'); end if;
  if form_name=invoice_name then
    if form_vendor_id is null then return jsonb_build_object('status','NO_MATCH','method','UNREGISTERED_NAME'); end if;
    select v.tax_code_key into registered_tax_code from public.vendor_directory v where v.id=form_vendor_id;
    if registered_tax_code is not null and invoice_tax_code is not null and registered_tax_code<>invoice_tax_code then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
    end if;
    return jsonb_build_object('status','MATCH','method','NORMALIZED_NAME');
  end if;
  if form_vendor_id is null or invoice_vendor_id is null or form_vendor_id<>invoice_vendor_id then
    return jsonb_build_object('status','NO_MATCH');
  end if;
  if invoice_tax_code is not null then
    select v.tax_code_key into registered_tax_code from public.vendor_directory v where v.id=form_vendor_id;
    if registered_tax_code is not null and registered_tax_code<>invoice_tax_code then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
    end if;
  end if;
  return jsonb_build_object('status','MATCH','method','VERIFIED_ALIAS');
end $$;
revoke execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) to service_role;

-- Only exact identifiers backed by AI evidence/confidence or an explicit
-- manager confirmation from the PDF participate in duplicate detection.
-- Legacy manager_verified alone is not sufficient to trust an OCR tax code.
create or replace function public.request_duplicate_identifiers(p_checks jsonb,p_payload jsonb)
returns jsonb language plpgsql immutable parallel safe set search_path = '' as $$
declare
  tax_value text;
  invoice_value text;
  confidence_text text;
  confidence numeric;
begin
  tax_value:=nullif(trim(p_checks->'manager_verified_identifiers'->'taxCode'->>'value'),'');
  if tax_value is null then
    tax_value:=nullif(trim(p_checks->'ai'->'fields'->'taxCode'->>'value'),'');
    confidence_text:=coalesce(p_checks->'ai'->'fields'->'taxCode'->>'confidence','');
    confidence:=case when confidence_text ~ '^(0([.][0-9]+)?|1([.]0+)?)$' then confidence_text::numeric else 0 end;
    if confidence<0.80 or coalesce(length(trim(p_checks->'ai'->'fields'->'taxCode'->>'evidence')),0)=0 then tax_value:=null; end if;
  end if;
  tax_value:=nullif(public.normalize_vendor_tax_code(tax_value),'');

  invoice_value:=nullif(trim(p_checks->'manager_verified_identifiers'->'invoiceNumber'->>'value'),'');
  if invoice_value is null and p_checks->>'manager_verified'='true'
    and p_checks->'manager_verification'->>'fields_match'='true' then
    invoice_value:=nullif(trim(p_payload->>'invoiceNumber'),'');
  end if;
  if invoice_value is null then
    invoice_value:=nullif(trim(p_checks->'ai'->'fields'->'invoiceNumber'->>'value'),'');
    confidence_text:=coalesce(p_checks->'ai'->'fields'->'invoiceNumber'->>'confidence','');
    confidence:=case when confidence_text ~ '^(0([.][0-9]+)?|1([.]0+)?)$' then confidence_text::numeric else 0 end;
    if confidence<0.80 or coalesce(length(trim(p_checks->'ai'->'fields'->'invoiceNumber'->>'evidence')),0)=0 then invoice_value:=null; end if;
  end if;
  invoice_value:=nullif(public.normalize_invoice_number(invoice_value),'');

  return jsonb_strip_nulls(jsonb_build_object('taxCode',tax_value,'invoiceNumber',invoice_value));
end $$;
revoke execute on function public.request_duplicate_identifiers(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.request_duplicate_identifiers(jsonb,jsonb) to service_role;

create or replace function public.request_identifier_needs_manager_verification(p_checks jsonb,p_payload jsonb,p_field text)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare
  confidence_text text;
  confidence numeric;
  ai_value text;
  submitted_value text;
  issue_list jsonb;
  has_issue boolean;
begin
  if p_field is null or p_field not in ('taxCode','invoiceNumber') then return true; end if;
  confidence_text:=coalesce(p_checks->'ai'->'fields'->p_field->>'confidence','');
  confidence:=case when confidence_text ~ '^(0([.][0-9]+)?|1([.]0+)?)$' then confidence_text::numeric else 0 end;
  ai_value:=nullif(trim(p_checks->'ai'->'fields'->p_field->>'value'),'');
  issue_list:=case when jsonb_typeof(p_checks->'ai'->'assessment'->'fieldIssues')='array'
    then p_checks->'ai'->'assessment'->'fieldIssues' else '[]'::jsonb end;
  select exists(select 1 from jsonb_array_elements(issue_list) as issue(item) where issue.item->>'field'=p_field)
    into has_issue;
  if confidence<0.80 or coalesce(length(trim(p_checks->'ai'->'fields'->p_field->>'evidence')),0)=0 or has_issue then return true; end if;
  if p_field='invoiceNumber' then
    submitted_value:=nullif(trim(p_payload->>'invoiceNumber'),'');
    return public.normalize_invoice_number(ai_value) is distinct from public.normalize_invoice_number(submitted_value);
  end if;
  return false;
end $$;
revoke execute on function public.request_identifier_needs_manager_verification(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.request_identifier_needs_manager_verification(jsonb,jsonb,text) to service_role;

-- Older clear/CFO queue items with unverified identifiers must go back through
-- manager review before the new approval guards are installed.
update public.requests r set status='TREASURER_REVIEW',
  reason='MST hoặc số hóa đơn cần Quản lý đối chiếu trực tiếp với PDF trước khi tiếp tục duyệt.',
  escalated_at=null,version=version+1,updated_at=now()
where r.status in ('READY_FOR_APPROVAL','CFO_REVIEW')
  and ((public.request_identifier_needs_manager_verification(r.checks,r.payload,'taxCode')
        and nullif(trim(r.checks->'manager_verified_identifiers'->'taxCode'->>'value'),'') is null)
    or (public.request_identifier_needs_manager_verification(r.checks,r.payload,'invoiceNumber')
        and nullif(trim(r.checks->'manager_verified_identifiers'->'invoiceNumber'->>'value'),'') is null));

-- Do not install duplicate detection while already-approved history contains
-- records whose identifiers cannot be compared reliably. The transaction
-- stops atomically so those records can be checked and backfilled first.
do $$
declare
  unresolved_approved_count bigint;
begin
  select count(*) into unresolved_approved_count from public.requests r
  where r.status='APPROVED'
    and ((public.request_duplicate_identifiers(r.checks,r.payload)->>'taxCode') is null
      or (public.request_duplicate_identifiers(r.checks,r.payload)->>'invoiceNumber') is null);
  if unresolved_approved_count>0 then
    raise exception 'Migration stopped: % already-approved record(s) lack a trustworthy TIN or invoice number for duplicate checks. Verify/backfill those PDFs, then rerun the migration.',unresolved_approved_count;
  end if;
end $$;

create or replace function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  f jsonb:=p_analysis->'fields';
  raw_kind text:=upper(trim(coalesce(p_analysis->'fields'->'invoiceKind'->>'value','UNKNOWN')));
  invoice_kind text;
  buyer_mode text;
  buyer_name text;
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
  buyer_name:=trim(coalesce(f->'buyerName'->>'value',''));
  buyer_match:=coalesce(p_analysis->'assessment'->'matching'->'buyerCompany'->>'status'='MATCH',false);
  buyer_clear:=case when buyer_mode='NO_NAME' then buyer_name=''
    else buyer_match and buyer_name<>''
      and coalesce(nullif(f->'buyerName'->>'confidence','')::numeric,0)>=0.80
      and length(trim(coalesce(f->'buyerName'->>'evidence','')))>0 end;
  buyer_conflict:=exists(select 1 from jsonb_array_elements(coalesce(p_analysis->'assessment'->'fieldIssues','[]'::jsonb)) as issue(item)
    where issue.item->>'field'='buyerName' and issue.item->>'severity'='RED')
    and coalesce(nullif(f->'buyerName'->>'confidence','')::numeric,0)>=0.80
    and length(trim(coalesce(f->'buyerName'->>'evidence','')))>0;

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
  total_clear:=total_amount>0 and total_conf>=case when invoice_kind='SALES' then 0.82 else 0.90 end
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

create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,
  p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  who text:=public.my_role();
  target text;
  why text;
  exact_duplicate boolean:=false;
  approval_at timestamptz;
  approval_day date;
  approved_today numeric;
  projected_today numeric;
  tax_value text;
  invoice_no text;
  pending_ids jsonb;
  manager_ids jsonb;
  candidate_ids jsonb;
  needs_tax_confirmation boolean:=false;
  needs_invoice_confirmation boolean:=false;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version<>p_expected_version then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.';
  end if;
  if auth.uid() is null or not ((who='treasurer' and r.status in ('TREASURER_REVIEW','READY_FOR_APPROVAL'))
    or (who='cfo' and (r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000)))) then
    raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.';
  end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0)>2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target:=case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why:=trim(p_reason);
  else
    if jsonb_typeof(p_checks) is distinct from 'object' then raise exception 'Thông tin xác nhận của quản lý không hợp lệ.'; end if;
    pending_ids:=coalesce(p_checks->'verified_identifiers','{}'::jsonb);
    if jsonb_typeof(pending_ids) is distinct from 'object' then raise exception 'Thông tin xác nhận MST/số hóa đơn không hợp lệ.'; end if;
    if p_checks ? 'verified_identifiers' and not (who='treasurer' and r.status='TREASURER_REVIEW') then
      raise exception 'Chỉ Quản lý tài chính đang xử lý hồ sơ mới được xác nhận định danh từ PDF.';
    end if;
    manager_ids:=coalesce(r.checks->'manager_verified_identifiers','{}'::jsonb);
    if jsonb_typeof(manager_ids) is distinct from 'object' then manager_ids:='{}'::jsonb; end if;
    if pending_ids ? 'taxCode' then
      tax_value:=trim(coalesce(pending_ids->'taxCode'->>'value',''));
      if pending_ids->'taxCode'->>'confirmed' is distinct from 'true'
        or tax_value is null or length(tax_value) not between 5 and 30
        or tax_value !~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{3,29}$' then
        raise exception 'Hãy xác nhận MST đúng định dạng theo PDF.';
      end if;
      manager_ids:=manager_ids||jsonb_build_object('taxCode',jsonb_build_object(
        'value',tax_value,'source','PDF','verified_by',auth.uid(),'verified_at',now()));
    end if;
    if pending_ids ? 'invoiceNumber' then
      invoice_no:=trim(coalesce(pending_ids->'invoiceNumber'->>'value',''));
      if pending_ids->'invoiceNumber'->>'confirmed' is distinct from 'true'
        or invoice_no is null or length(invoice_no) not between 1 and 100 or invoice_no ~ '[[:cntrl:]]' then
        raise exception 'Hãy xác nhận số hóa đơn theo PDF.';
      end if;
      manager_ids:=manager_ids||jsonb_build_object('invoiceNumber',jsonb_build_object(
        'value',invoice_no,'source','PDF','verified_by',auth.uid(),'verified_at',now()));
    end if;
    candidate_ids:=public.request_duplicate_identifiers(
      coalesce(r.checks,'{}'::jsonb)||jsonb_build_object('manager_verified_identifiers',manager_ids),r.payload);
    tax_value:=candidate_ids->>'taxCode';
    invoice_no:=candidate_ids->>'invoiceNumber';
    if tax_value is null or invoice_no is null then
      raise exception 'Chưa có MST và số hóa đơn đủ căn cứ để kiểm tra trùng. Hãy xác minh trên PDF trước khi duyệt.';
    end if;
    needs_tax_confirmation:=public.request_identifier_needs_manager_verification(r.checks,r.payload,'taxCode');
    needs_invoice_confirmation:=public.request_identifier_needs_manager_verification(r.checks,r.payload,'invoiceNumber');
    if needs_tax_confirmation and nullif(trim(manager_ids->'taxCode'->>'value'),'') is null then
      raise exception 'MST còn confidence thấp hoặc đang có cảnh báo. Hãy chuyển Quản lý đối chiếu và xác nhận MST trên PDF trước khi duyệt.';
    end if;
    if needs_invoice_confirmation and nullif(trim(manager_ids->'invoiceNumber'->>'value'),'') is null then
      raise exception 'Số hóa đơn còn confidence thấp, thiếu bằng chứng hoặc lệch form. Hãy chuyển Quản lý đối chiếu và xác nhận số trên PDF trước khi duyệt.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(tax_value||'/'||invoice_no,0));
    select exists(select 1 from public.requests a where a.id<>r.id and a.status='APPROVED'
      and (public.request_duplicate_identifiers(a.checks,a.payload)->>'taxCode')=tax_value
      and (public.request_duplicate_identifiers(a.checks,a.payload)->>'invoiceNumber')=invoice_no
    ) into exact_duplicate;
    if exact_duplicate then
      target:='REJECTED';
      why:='Phát hiện trùng mã số thuế và số hóa đơn với hồ sơ đã được duyệt; hồ sơ bị từ chối để tránh thanh toán trùng.';
    elsif who='treasurer' and r.status='TREASURER_REVIEW'
      and not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true}'::jsonb,false) then
      raise exception 'Hãy xác nhận đã kiểm tra hóa đơn, các trường cần đối chiếu và tổng thanh toán; hoặc yêu cầu bổ sung.';
    else
      loop
        approval_at:=clock_timestamp(); approval_day:=(approval_at at time zone 'Asia/Bangkok')::date;
        perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:'||approval_day::text,0));
        approval_at:=clock_timestamp(); exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
      end loop;
      select coalesce(sum(x.amount),0) into approved_today from public.requests x
        where x.status='APPROVED' and x.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
        and x.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
      projected_today:=approved_today+r.amount;
      if who='treasurer' and (r.amount>20000000 or projected_today>100000000) then
        target:='CFO_REVIEW';
        why:=trim(concat_ws(' ',nullif(trim(p_reason),''),'Quản lý tài chính đã xác minh các điểm cần kiểm tra; chuyển Giám đốc duyệt do vượt hạn mức hồ sơ hoặc ngày.'));
      elsif who='treasurer' then
        target:='APPROVED'; why:='Quản lý tài chính đã kiểm tra và duyệt cuối trong hạn mức 20 triệu/hồ sơ và 100 triệu/ngày.';
      else
        if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Giám đốc cần ghi lý do cấp quyền trước khi duyệt.'; end if;
        target:='APPROVED'; why:='Giám đốc Tài chính đã cấp quyền. Lý do: '||trim(p_reason);
      end if;
    end if;
  end if;
  update public.requests set status=target,reason=why,
    approved_at=case when target='APPROVED' then approval_at else approved_at end,
    checks=case when who='treasurer' and p_action='approve' and r.status='TREASURER_REVIEW'
      and target in ('APPROVED','CFO_REVIEW','REJECTED') then coalesce(checks,'{}'::jsonb)||jsonb_build_object(
        'manager_verified',true,'manager_verification',p_checks,'manager_verified_identifiers',manager_ids,
        'manager_reason',nullif(trim(p_reason),''),'manager_verified_at',now())
      else checks end,
    escalated_at=case when target='CFO_REVIEW' then coalesce(escalated_at,now()) else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

create or replace function public.review_requests_batch(p_requests jsonb,p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who text:=public.my_role();
  item_count integer;
  distinct_count integer;
  invalid_count integer;
  locked_count integer;
  duplicate_ids uuid[]:=array[]::uuid[];
  remaining_ids uuid[]:=array[]::uuid[];
  requested_total numeric;
  approved_today numeric;
  projected_total numeric;
  target text;
  approval_at timestamptz;
  approval_day date;
  batch_reason text;
  duplicate_count integer:=0;
begin
  if auth.uid() is null or coalesce(who,'') not in ('treasurer','cfo') then
    raise exception 'Chỉ quản lý tài chính hoặc Giám đốc Tài chính được duyệt theo đợt.';
  end if;
  if jsonb_typeof(p_requests) is distinct from 'array' or jsonb_array_length(p_requests)=0 then
    raise exception 'Danh sách duyệt phải có ít nhất một hóa đơn.';
  end if;
  if coalesce(length(p_reason),0)>2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if who='cfo' and coalesce(length(trim(p_reason)),0)=0 then raise exception 'Giám đốc cần ghi lý do cấp quyền trước khi duyệt.'; end if;
  select count(*),count(distinct x.id),count(*) filter(where x.id is null or x.version is null)
    into item_count,distinct_count,invalid_count from jsonb_to_recordset(p_requests) as x(id uuid,version integer);
  if item_count=0 or item_count<>distinct_count or invalid_count>0 then raise exception 'Danh sách hóa đơn không hợp lệ hoặc có mã bị lặp.'; end if;
  perform r.id from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    order by r.id for update;
  get diagnostics locked_count=row_count;
  if locked_count<>item_count then raise exception 'Một hoặc nhiều hóa đơn không còn trong danh sách duyệt.'; end if;
  if exists(select 1 from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id where r.version<>x.version) then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại danh sách trước khi duyệt.';
  end if;
  if who='treasurer' and exists(select 1 from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    where r.status<>'READY_FOR_APPROVAL' or r.amount>20000000) then
    raise exception 'Quản lý chỉ được duyệt hóa đơn đủ điều kiện không quá 20 triệu mỗi hóa đơn.';
  end if;
  if who='cfo' and exists(select 1 from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    where not (r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000))) then
    raise exception 'Đợt của Giám đốc chỉ nhận hồ sơ trong hàng chờ CFO hoặc hóa đơn đủ điều kiện trên 20 triệu.';
  end if;
  if exists(select 1 from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    where (public.request_duplicate_identifiers(r.checks,r.payload)->>'taxCode') is null
      or (public.request_duplicate_identifiers(r.checks,r.payload)->>'invoiceNumber') is null) then
    raise exception 'Không thể duyệt đợt: có hồ sơ thiếu MST hoặc số hóa đơn đủ căn cứ để kiểm tra trùng.';
  end if;
  if exists(select 1 from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    where (public.request_identifier_needs_manager_verification(r.checks,r.payload,'taxCode')
        and nullif(trim(r.checks->'manager_verified_identifiers'->'taxCode'->>'value'),'') is null)
      or (public.request_identifier_needs_manager_verification(r.checks,r.payload,'invoiceNumber')
        and nullif(trim(r.checks->'manager_verified_identifiers'->'invoiceNumber'->>'value'),'') is null)) then
    raise exception 'Không thể duyệt đợt: có hồ sơ còn MST/số hóa đơn confidence thấp hoặc bị gắn cờ, chưa được Quản lý xác nhận trực tiếp từ PDF.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(k.invoice_key,0))
    from (select distinct (public.request_duplicate_identifiers(r.checks,r.payload)->>'taxCode')||'/'||
      (public.request_duplicate_identifiers(r.checks,r.payload)->>'invoiceNumber') as invoice_key
      from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id) k
    order by k.invoice_key;

  select coalesce(array_agg(chosen.id order by chosen.created_at,chosen.id),array[]::uuid[]) into duplicate_ids
  from public.requests chosen join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=chosen.id
  where exists(select 1 from public.requests approved where approved.id<>chosen.id and approved.status='APPROVED'
      and (public.request_duplicate_identifiers(approved.checks,approved.payload)->>'taxCode')
        =(public.request_duplicate_identifiers(chosen.checks,chosen.payload)->>'taxCode')
      and (public.request_duplicate_identifiers(approved.checks,approved.payload)->>'invoiceNumber')
        =(public.request_duplicate_identifiers(chosen.checks,chosen.payload)->>'invoiceNumber'))
    or exists(select 1 from public.requests prior join jsonb_to_recordset(p_requests) as xp(id uuid,version integer) on xp.id=prior.id
      where prior.id<>chosen.id and (prior.created_at<chosen.created_at or (prior.created_at=chosen.created_at and prior.id<chosen.id))
        and (public.request_duplicate_identifiers(prior.checks,prior.payload)->>'taxCode')
          =(public.request_duplicate_identifiers(chosen.checks,chosen.payload)->>'taxCode')
        and (public.request_duplicate_identifiers(prior.checks,prior.payload)->>'invoiceNumber')
          =(public.request_duplicate_identifiers(chosen.checks,chosen.payload)->>'invoiceNumber'));
  duplicate_count:=cardinality(duplicate_ids);
  if duplicate_count>0 then
    update public.requests set status='REJECTED',reason='Phát hiện trùng mã số thuế và số hóa đơn với hồ sơ đã duyệt hoặc một hồ sơ cùng đợt; từ chối để tránh thanh toán trùng.',
      checks=coalesce(checks,'{}'::jsonb)||jsonb_build_object('duplicate_detected',true),version=version+1,updated_at=now()
      where id=any(duplicate_ids);
  end if;
  select coalesce(array_agg(r.id),array[]::uuid[]) into remaining_ids from public.requests r
    join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id where not (r.id=any(duplicate_ids));
  if cardinality(remaining_ids)=0 then
    return jsonb_build_object('status','REJECTED','invoice_count',0,'duplicate_count',duplicate_count,'requested_total',0,
      'approved_today_before',0,'projected_total',0,'daily_limit',100000000,'remaining',100000000,
      'business_date',(now() at time zone 'Asia/Bangkok')::date);
  end if;
  loop
    approval_at:=clock_timestamp(); approval_day:=(approval_at at time zone 'Asia/Bangkok')::date;
    perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:'||approval_day::text,0));
    approval_at:=clock_timestamp(); exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
  end loop;
  select coalesce(sum(r.amount),0) into requested_total from public.requests r where r.id=any(remaining_ids);
  select coalesce(sum(r.amount),0) into approved_today from public.requests r where r.status='APPROVED'
    and r.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
    and r.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
  projected_total:=approved_today+requested_total;
  target:=case when who='cfo' then 'APPROVED' when projected_total<=100000000 then 'APPROVED' else 'CFO_REVIEW' end;
  batch_reason:=case when who='cfo'
    then 'Giám đốc Tài chính duyệt đợt. Lý do: '||trim(p_reason)
    when target='APPROVED' then 'Quản lý tài chính duyệt các hóa đơn đủ điều kiện trong thẩm quyền và ngân sách ngày.'
    else 'Đợt duyệt của Quản lý sẽ làm tổng ngày vượt 100 triệu; hồ sơ chuyển Giám đốc Tài chính.' end;
  update public.requests r set status=target,reason=batch_reason,
    approved_at=case when target='APPROVED' then approval_at else r.approved_at end,
    escalated_at=case when target='CFO_REVIEW' then coalesce(r.escalated_at,approval_at) else r.escalated_at end,
    version=r.version+1,updated_at=approval_at where r.id=any(remaining_ids);
  return jsonb_build_object('status',target,'invoice_count',cardinality(remaining_ids),'duplicate_count',duplicate_count,
    'requested_total',requested_total,'approved_today_before',approved_today,'projected_total',projected_total,
    'daily_limit',100000000,'remaining',greatest(100000000-projected_total,0),'business_date',approval_day);
end $$;

revoke execute on function public.vendor_review_note_list() from public,anon;
grant execute on function public.vendor_review_note_list() to authenticated;
revoke execute on function public.vendor_review_note_resolve(uuid) from public,anon;
grant execute on function public.vendor_review_note_resolve(uuid) to authenticated;
revoke execute on function public.can_read_request(uuid) from public,anon;
grant execute on function public.can_read_request(uuid) to authenticated;
revoke execute on function public.submit_request(uuid,jsonb,text,text,integer) from public,anon;
grant execute on function public.submit_request(uuid,jsonb,text,text,integer) to authenticated;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
revoke execute on function public.review_request(uuid,integer,text,text,jsonb) from public,anon;
grant execute on function public.review_request(uuid,integer,text,text,jsonb) to authenticated;
revoke execute on function public.review_requests_batch(jsonb,text) from public,anon;
grant execute on function public.review_requests_batch(jsonb,text) to authenticated;

commit;
notify pgrst,'reload schema';
