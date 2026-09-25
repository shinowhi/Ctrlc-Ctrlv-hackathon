-- Apply once to an existing database created from supabase/schema.sql.
-- Existing request PDFs remain stored; new app submissions pass a null request_path.
begin;
alter table public.requests alter column request_path drop not null;
create or replace function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  facts_clear boolean;
  fields_match boolean;
  totals_consistent boolean;
  target text;
  why text;
  code text;
  extracted jsonb := p_analysis->'fields';
begin
  if auth.role() <> 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ thủ quỹ.';
  end if;
  fields_match := lower(regexp_replace(trim(coalesce(extracted->'vendor'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
    and lower(regexp_replace(trim(coalesce(extracted->'buyerName'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'requester','')), '[[:space:]]+', ' ', 'g'))
    and lower(regexp_replace(trim(coalesce(extracted->'invoiceNumber'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'invoiceNumber','')), '[[:space:]]+', ' ', 'g'))
    and coalesce(extracted->'invoiceDate'->>'value','') = coalesce(r.payload->>'invoiceDate','')
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) = r.amount;
  totals_consistent := coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0)
    + coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0)
    = coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0);
  facts_clear := fields_match and totals_consistent
    and coalesce(length(trim(extracted->'buyerName'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceDate'->>'value')),0) > 0
    and coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0) >= 0
    and coalesce(nullif(extracted->'buyerName'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'vendor'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'invoiceDate'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(length(trim(extracted->'buyerName'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceDate'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'amountBeforeTax'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vatAmount'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'totalAmount'->>'evidence')),0) > 0;
  code := case when not facts_clear then 'U1' when r.amount > 20000000 then 'U3' else 'CLEAR' end;
  target := case when code='U1' then 'NEEDS_INFO' when code='U3' then 'CFO_REVIEW' else 'READY_FOR_APPROVAL' end;
  why := case when code='U1' then left(coalesce(nullif(p_analysis->'assessment'->>'reason',''), 'Chưa đọc chắc hoặc dữ liệu hóa đơn chưa khớp; vui lòng kiểm tra và bổ sung.'),2000)
    when code='U3' then 'Tổng thanh toán đã gồm VAT vượt 20.000.000 ₫; chuyển người đứng đầu nhánh tài chính duyệt cuối.'
    else 'Các trường hóa đơn đang kiểm tra và phép tính tổng đã khớp form; sẵn sàng để quản lý tài chính bấm duyệt cuối.' end;
  update public.requests set status=target,reason=why,
    checks=jsonb_build_object('invoice_fields_match',fields_match,'invoice_totals_consistent',totals_consistent,
      'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

-- All writes go through these RPCs. A client cannot assign status, role, or owner.

create or replace function public.submit_request(p_id uuid, p_payload jsonb, p_invoice_path text,
  p_request_path text, p_expected_version integer default 0)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  field text;
  clean jsonb := '{}'::jsonb;
  amt bigint;
  was_existing boolean;
begin
  if auth.uid() is null or public.my_role() is distinct from 'applicant' then
    raise exception 'Chỉ người nộp đơn được gửi hồ sơ.';
  end if;
  foreach field in array array['requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','requesterType'] loop
    if coalesce(length(trim(p_payload->>field)),0) not between 1 and 1000 then
      raise exception 'Trường % bắt buộc, tối đa 1000 ký tự.',field;
    end if;
    clean := clean || jsonb_build_object(field,trim(p_payload->>field));
  end loop;
  if clean->>'requesterType' not in ('employee','department') then raise exception 'Loại người nộp không hợp lệ.'; end if;
  perform (clean->>'invoiceDate')::date;
  if coalesce(p_payload->>'amount','') !~ '^[0-9]{1,12}$' then raise exception 'Số tiền phải là số nguyên dương.'; end if;
  amt := (p_payload->>'amount')::bigint;
  if amt < 1 then raise exception 'Số tiền phải lớn hơn 0.'; end if;
  clean := clean || jsonb_build_object('amount',amt);
  if p_invoice_path is null
    or split_part(p_invoice_path,'/',1) <> auth.uid()::text
    or p_invoice_path !~ '/invoice\.pdf$'
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path)
    or (p_request_path is not null and (
      split_part(p_request_path,'/',1) <> auth.uid()::text
      or split_part(p_invoice_path,'/',2) <> split_part(p_request_path,'/',2)
      or p_request_path !~ '/request\.(pdf|jpg|png)$'
      or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
    ))
  then raise exception 'Cần tải hóa đơn PDF của chính tài khoản này; đơn đề nghị đính kèm (nếu có) phải thuộc cùng hồ sơ.'; end if;
  select * into r from public.requests where id=p_id for update;
  was_existing := found;
  if was_existing then
    if r.owner_id <> auth.uid() or r.status <> 'NEEDS_INFO' or p_expected_version is null or r.version <> p_expected_version then
      raise exception 'Hồ sơ đã thay đổi hoặc không được phép bổ sung. Hãy tải lại.';
    end if;
    update public.requests set payload=clean,amount=amt,invoice_path=p_invoice_path,request_path=p_request_path,
      status='TREASURER_REVIEW',checks=null,reason='Người nộp đã bổ sung hồ sơ.',escalated_at=null,version=version+1,updated_at=now()
      where id=p_id returning * into r;
  else
    if p_expected_version is null or p_expected_version <> 0 then raise exception 'Không tìm thấy phiên bản hồ sơ.'; end if;
    insert into public.requests(id,owner_id,payload,amount,invoice_path,request_path,reason)
      values(p_id,auth.uid(),clean,amt,p_invoice_path,p_request_path,'Đã gửi; chờ thủ quỹ kiểm tra hóa đơn.') returning * into r;
  end if;
  return r;
end $$;


commit;

