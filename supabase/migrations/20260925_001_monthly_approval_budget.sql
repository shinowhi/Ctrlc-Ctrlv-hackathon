-- Existing FinRef database upgrade. For a new project, run supabase/schema.sql instead.

begin;

alter table public.requests add column if not exists approved_at timestamptz;

update public.requests r set approved_at=coalesce((select max(a.created_at) from public.audit_events a where a.request_id=r.id and a.new_status='APPROVED'),r.updated_at,r.created_at) where r.status='APPROVED' and r.approved_at is null;

create index if not exists requests_approved_at on public.requests(approved_at) where status='APPROVED';

create or replace function public.submit_request(p_id uuid,p_payload jsonb,p_invoice_path text,p_request_path text,p_expected_version integer default 0)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests; field text; clean jsonb := '{}'::jsonb; amt bigint; was_existing boolean;
begin
  if auth.uid() is null or public.my_role() is distinct from 'applicant' then raise exception 'Chỉ người nộp đơn được gửi hồ sơ.'; end if;
  foreach field in array array['requester','department','purpose','vendor','invoiceNumber','invoiceDate','requesterType'] loop
    if coalesce(length(trim(p_payload->>field)),0) not between 1 and 1000 then raise exception 'Trường % bắt buộc, tối đa 1000 ký tự.',field; end if;
    clean := clean || jsonb_build_object(field,trim(p_payload->>field));
  end loop;
  if clean->>'requesterType' not in ('employee','department') then raise exception 'Loại người nộp không hợp lệ.'; end if;
  perform (clean->>'invoiceDate')::date;
  if coalesce(p_payload->>'amount','') !~ '^[0-9]{1,12}$' then raise exception 'Số tiền phải là số nguyên dương.'; end if;
  amt := (p_payload->>'amount')::bigint; if amt < 1 then raise exception 'Số tiền phải lớn hơn 0.'; end if;
  clean := clean || jsonb_build_object('amount',amt);
  if p_invoice_path is null or p_request_path is null or split_part(p_invoice_path,'/',1) <> auth.uid()::text or split_part(p_request_path,'/',1) <> auth.uid()::text or split_part(p_invoice_path,'/',2) <> split_part(p_request_path,'/',2)
    or p_invoice_path !~ '/invoice\.pdf$' or p_request_path !~ '/request\.(pdf|jpg|png)$'
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path) or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
  then raise exception 'Cần tải đủ hai minh chứng của chính tài khoản này.'; end if;
  select * into r from public.requests where id=p_id for update; was_existing := found;
  if was_existing then
    if r.owner_id <> auth.uid() or r.status <> 'NEEDS_INFO' or p_expected_version is null or r.version <> p_expected_version then raise exception 'Hồ sơ đã thay đổi hoặc không được phép bổ sung. Hãy tải lại.'; end if;
    update public.requests set payload=clean,amount=amt,invoice_path=p_invoice_path,request_path=p_request_path,status='TREASURER_REVIEW',checks=null,reason='Người nộp đã bổ sung hồ sơ.',escalated_at=null,version=version+1,updated_at=now() where id=p_id returning * into r;
  else
    if p_expected_version is null or p_expected_version <> 0 then raise exception 'Không tìm thấy phiên bản hồ sơ.'; end if;
    insert into public.requests(id,owner_id,payload,amount,invoice_path,request_path,reason) values(p_id,auth.uid(),clean,amt,p_invoice_path,p_request_path,'Đã gửi; chờ thủ quỹ kiểm tra minh chứng.') returning * into r;
  end if; return r;
end $$;

create or replace function public.approval_budget_summary(p_amount bigint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  month_start date := date_trunc('month', timezone('Asia/Ho_Chi_Minh', now()))::date;
  month_start_at timestamptz; month_end_at timestamptz; spent bigint; amount bigint := coalesce(p_amount,0); projected bigint; cap bigint := 200000000;
begin
  if auth.uid() is null or public.my_role() not in ('treasurer','cfo') then raise exception 'Chỉ người duyệt tài chính được xem hạn mức.'; end if;
  if amount < 0 then raise exception 'Số tiền cần xem không hợp lệ.'; end if;
  month_start_at := month_start::timestamp at time zone 'Asia/Ho_Chi_Minh';
  month_end_at := (month_start + interval '1 month')::timestamp at time zone 'Asia/Ho_Chi_Minh';
  select coalesce(sum(amount),0)::bigint into spent from public.requests where status='APPROVED' and approved_at >= month_start_at and approved_at < month_end_at;
  projected := spent + amount;
  return jsonb_build_object('month_start',month_start,'approved_total',spent,'invoice_amount',amount,'projected_total',projected,'cap',cap,
    'remaining_after',greatest(cap-projected,0),'exceeded_by',greatest(projected-cap,0),'warning_threshold',160000000,'warning',projected >= 160000000);
end $$;

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
    and lower(regexp_replace(trim(coalesce(extracted->'invoiceNumber'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'invoiceNumber','')), '[[:space:]]+', ' ', 'g'))
    and coalesce(extracted->'invoiceDate'->>'value','') = coalesce(r.payload->>'invoiceDate','')
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) = r.amount;
  totals_consistent := coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0)
    + coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0)
    = coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0);
  facts_clear := fields_match and totals_consistent
    and coalesce(length(trim(extracted->'vendor'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceDate'->>'value')),0) > 0
    and coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0) >= 0
    and coalesce(nullif(extracted->'vendor'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'invoiceDate'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0) >= 0.95
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0) >= 0.95
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
    checks=coalesce(r.checks,'{}'::jsonb) || jsonb_build_object('invoice_fields_match',fields_match,'invoice_totals_consistent',totals_consistent,
      'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;


create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests; who text := public.my_role(); target text; why text; budget_snapshot jsonb;
  month_start date; month_start_at timestamptz; month_end_at timestamptz; spent bigint; projected bigint; cap bigint := 200000000;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version <> p_expected_version then raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.'; end if;
  if auth.uid() is null or not ((who='treasurer' and (r.status in ('TREASURER_REVIEW','READY_FOR_APPROVAL') or (r.status='NEEDS_INFO' and p_action='clarify'))) or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action='approve' then
    perform pg_advisory_xact_lock(896532014);
    month_start := date_trunc('month', timezone('Asia/Ho_Chi_Minh', now()))::date;
    month_start_at := month_start::timestamp at time zone 'Asia/Ho_Chi_Minh';
    month_end_at := (month_start + interval '1 month')::timestamp at time zone 'Asia/Ho_Chi_Minh';
    select coalesce(sum(amount),0)::bigint into spent from public.requests where status='APPROVED' and approved_at >= month_start_at and approved_at < month_end_at;
    projected := spent + r.amount; budget_snapshot := public.approval_budget_summary(r.amount);
    if who='treasurer' then
      if r.status='TREASURER_REVIEW' and not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true}'::jsonb,false) then raise exception 'U1: hãy xác nhận đã kiểm tra hóa đơn, trường form và tổng thanh toán gồm VAT; hoặc yêu cầu bổ sung.'; end if;
      if r.amount > 20000000 then target:='CFO_REVIEW'; why:='U3: tổng thanh toán vượt 20.000.000 ₫; chuyển CFO xác nhận.';
      elsif projected > cap then target:='CFO_REVIEW'; why:='Dự kiến vượt hạn mức ngân sách tháng; chuyển CFO xác nhận ngoại lệ.';
      else target:='APPROVED'; why:='Quản lý tài chính đã duyệt trong hạn mức ngân sách tháng.'; end if;
    else
      if projected > cap and coalesce(length(trim(p_reason)),0)=0 then raise exception 'Cần ghi lý do khi CFO duyệt ngoại lệ vượt ngân sách tháng.'; end if;
      target:='APPROVED'; why:=case when projected > cap then trim(p_reason) else 'Người đứng đầu nhánh tài chính đã bấm duyệt cuối.' end;
    end if;
  elsif p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target:=case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end; why:=trim(p_reason);
  end if;
  update public.requests set status=target,reason=why,
    checks=case when p_action='approve' then coalesce(checks,'{}'::jsonb) || case when who='treasurer' and r.status='TREASURER_REVIEW' then p_checks else '{}'::jsonb end || jsonb_build_object('budget_checked',true,'budget_snapshot',budget_snapshot) else checks end,
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,approved_at=case when target='APPROVED' then now() else approved_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

revoke execute on function public.approval_budget_summary(bigint) from public,anon;

grant execute on function public.approval_budget_summary(bigint) to authenticated;

commit;
