-- Run once in a NEW Supabase project's SQL Editor, as the project owner.
begin;
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('applicant','treasurer','cfo'))
);
create table public.requests (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id),
  payload jsonb not null,
  amount bigint not null check (amount between 1 and 999999999999),
  invoice_path text not null,
  request_path text,
  status text not null default 'TREASURER_REVIEW' check (status in ('TREASURER_REVIEW','READY_FOR_APPROVAL','NEEDS_INFO','CFO_REVIEW','APPROVED','REJECTED')),
  checks jsonb,
  reason text not null default '',
  version integer not null default 1,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint requests_approval_timestamp_required check (status <> 'APPROVED' or approved_at is not null)
);
create table public.audit_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.requests(id),
  actor_id uuid not null,
  actor_role text not null,
  old_status text,
  new_status text not null,
  reason text not null,
  version integer not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index requests_owner on public.requests(owner_id);
create index requests_status on public.requests(status);
create index requests_approved_at on public.requests(approved_at) where status = 'APPROVED';
create index audit_request on public.audit_events(request_id);

create function public.my_role() returns text language sql stable security definer
set search_path = '' as $$ select role from public.profiles where id = auth.uid() $$;

create function public.can_read_request(p_id uuid) returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (select 1 from public.requests r where r.id = p_id and (
    r.owner_id = auth.uid() or public.my_role() = 'treasurer'
    or (public.my_role() = 'cfo' and (r.escalated_at is not null or r.amount > 20000000))
  ));
$$;

alter table public.profiles enable row level security;
alter table public.requests enable row level security;
alter table public.audit_events enable row level security;
revoke all on public.profiles, public.requests, public.audit_events from anon, authenticated;
grant select on public.profiles, public.requests, public.audit_events to authenticated;
grant all on public.profiles, public.requests, public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;
create policy profile_self on public.profiles for select to authenticated using (id = auth.uid());
create policy request_read on public.requests for select to authenticated using (public.can_read_request(id));
create policy audit_read on public.audit_events for select to authenticated using (public.can_read_request(request_id));

-- Private bucket. Applicants insert new immutable objects, never overwrite evidence.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('evidence','evidence',false,10485760,array['application/pdf','image/jpeg','image/png']);
create policy evidence_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'evidence' and public.my_role() = 'applicant'
  and split_part(name,'/',1) = auth.uid()::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(invoice\.pdf|request\.(pdf|jpg|png))$'
);
create policy evidence_read on storage.objects for select to authenticated using (
  bucket_id = 'evidence' and (
    split_part(name,'/',1) = auth.uid()::text
    or exists(select 1 from public.requests r where public.can_read_request(r.id)
      and name in (r.invoice_path,r.request_path))
  )
);

create function public.record_request_event() returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.audit_events(request_id,actor_id,actor_role,old_status,new_status,reason,version,snapshot)
  values(new.id,coalesce(auth.uid(),new.owner_id),coalesce(public.my_role(),'ai'),case when TG_OP='UPDATE' then old.status else null end,
    new.status,new.reason,new.version,to_jsonb(new));
  return new;
end $$;
create trigger request_audit after insert or update on public.requests
for each row execute function public.record_request_event();

-- Server-only extraction result. AI may classify a request, but never approves it.
-- Budget and policy are deliberately not marked as checked in this release.
create function public.normalize_invoice_number(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when normalized.value ~ '^[0-9]+$'
    then coalesce(nullif(regexp_replace(normalized.value, '^0+', ''), ''), '0')
    else normalized.value end
  from (select lower(regexp_replace(trim(coalesce(p_value,'')), '[[:space:]]+', ' ', 'g')) as value) normalized;
$$;

create function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  facts_clear boolean;
  fields_match boolean;
  totals_consistent boolean;
  target text;
  why text;
  extracted jsonb := p_analysis->'fields';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ thủ quỹ.';
  end if;
  fields_match := lower(regexp_replace(trim(coalesce(extracted->'vendor'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
    and lower(regexp_replace(trim(coalesce(extracted->'buyerName'->>'value','')), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(trim(coalesce(r.payload->>'requester','')), '[[:space:]]+', ' ', 'g'))
    and public.normalize_invoice_number(extracted->'invoiceNumber'->>'value')
      = public.normalize_invoice_number(r.payload->>'invoiceNumber')
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
    and coalesce(nullif(extracted->'buyerName'->>'confidence','')::numeric,0) >= 0.85
    and coalesce(nullif(extracted->'vendor'->>'confidence','')::numeric,0) >= 0.85
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'invoiceDate'->>'confidence','')::numeric,0) >= 0.85
    and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(length(trim(extracted->'buyerName'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceDate'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'amountBeforeTax'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vatAmount'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'totalAmount'->>'evidence')),0) > 0;
  target := case when facts_clear then 'READY_FOR_APPROVAL' else 'TREASURER_REVIEW' end;
  why := case when facts_clear
    then 'AI hoàn tất các kiểm tra hiện có; quản lý tài chính cần xem và quyết định trước. Hạn mức 20 triệu/hồ sơ và tổng 100 triệu/ngày được kiểm tra khi duyệt.'
    else left(coalesce(nullif(p_analysis->'assessment'->>'reason',''), 'AI phát hiện dữ kiện chưa chắc hoặc chưa khớp; chuyển quản lý tài chính kiểm tra trước.'),2000)
  end;
  update public.requests set status=target,reason=why,
    checks=jsonb_build_object('invoice_fields_match',fields_match,'invoice_totals_consistent',totals_consistent,
      'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

-- All writes go through these RPCs. A client cannot assign status, role, or owner.
create function public.submit_request(p_id uuid, p_payload jsonb, p_invoice_path text,
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
  if coalesce(length(trim(p_payload->>'invoiceType')),0) > 1000 then
    raise exception 'Trường invoiceType tối đa 1000 ký tự.';
  end if;
  if nullif(trim(p_payload->>'invoiceType'),'') is not null then
    clean := clean || jsonb_build_object('invoiceType',trim(p_payload->>'invoiceType'));
  end if;
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

create function public.review_request(p_id uuid,p_expected_version integer,p_action text,
  p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests; who text := public.my_role(); target text; why text; duplicate_invoice boolean;
  approval_at timestamptz; approval_day date; approved_today numeric; projected_today numeric;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version <> p_expected_version then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.';
  end if;
  if auth.uid() is null or not ((who='treasurer' and r.status in ('TREASURER_REVIEW','READY_FOR_APPROVAL'))
    or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target := case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why := trim(p_reason);
  else
    -- Serialize final approvals for the same invoice and the Bangkok business day.
    perform pg_advisory_xact_lock(hashtextextended(
      lower(regexp_replace(trim(coalesce(r.payload->>'vendor','')), '[[:space:]]+', ' ', 'g')) || '/' ||
      public.normalize_invoice_number(r.payload->>'invoiceNumber'), 0));
    select exists(select 1 from public.requests x where x.id<>r.id and x.status='APPROVED'
      and lower(regexp_replace(trim(coalesce(x.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
        = lower(regexp_replace(trim(coalesce(r.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
      and public.normalize_invoice_number(x.payload->>'invoiceNumber')
        = public.normalize_invoice_number(r.payload->>'invoiceNumber'))
      into duplicate_invoice;
    if duplicate_invoice then
      raise exception 'Hóa đơn này đã có hồ sơ được duyệt cùng nhà cung cấp và số hóa đơn. Hãy yêu cầu làm rõ hoặc từ chối; không thể duyệt trùng.';
    end if;
    if who='treasurer' and r.status='TREASURER_REVIEW'
      and not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true}'::jsonb,false) then
      raise exception 'Hãy xác nhận đã kiểm tra hóa đơn, trường form và tổng thanh toán gồm VAT; hoặc yêu cầu bổ sung.';
    end if;
    loop
      approval_at := clock_timestamp();
      approval_day := (approval_at at time zone 'Asia/Bangkok')::date;
      perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:' || approval_day::text,0));
      approval_at := clock_timestamp();
      exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
    end loop;
    select coalesce(sum(x.amount),0) into approved_today
    from public.requests x
    where x.status='APPROVED'
      and x.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
      and x.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
    projected_today := approved_today + r.amount;
    if who='treasurer' then
      if r.amount>20000000 or projected_today>100000000 then
        target := 'CFO_REVIEW';
        why := trim(concat_ws(' ',nullif(trim(p_reason),''),case
          when r.amount>20000000 and projected_today>100000000 then 'Quản lý tài chính đã kiểm tra; cần Giám đốc cấp quyền vì vượt 20 triệu/hồ sơ và tổng duyệt ngày 100 triệu.'
          when r.amount>20000000 then 'Quản lý tài chính đã kiểm tra; cần Giám đốc cấp quyền vì hồ sơ vượt 20 triệu.'
          else 'Quản lý tài chính đã kiểm tra; cần Giám đốc cấp quyền vì tổng duyệt ngày sẽ vượt 100 triệu.' end));
      else
        target := 'APPROVED';
        why := 'Quản lý tài chính đã kiểm tra và duyệt cuối trong hạn mức 20 triệu/hồ sơ và 100 triệu/ngày.';
      end if;
    else
      if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Giám đốc cần ghi lý do cấp quyền trước khi duyệt.'; end if;
      target := 'APPROVED';
      why := 'Giám đốc Tài chính đã cấp quyền. Lý do: ' || trim(p_reason);
      if r.amount>20000000 and projected_today>100000000 then
        why := why || ' Hồ sơ vượt hạn mức 20 triệu và tổng duyệt ngày 100 triệu.';
      elsif r.amount>20000000 then
        why := why || ' Hồ sơ vượt hạn mức 20 triệu.';
      elsif projected_today>100000000 then
        why := why || ' Tổng duyệt trong ngày vượt 100 triệu.';
      end if;
    end if;
  end if;
  update public.requests set status=target,reason=why,
    approved_at=case when target='APPROVED' then approval_at else approved_at end,
    checks=case when who='treasurer' and p_action='approve' and r.status='TREASURER_REVIEW' then p_checks else checks end,
    escalated_at=case when target='CFO_REVIEW' then coalesce(escalated_at,now()) else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

create function public.daily_approval_summary()
returns table(approved_total bigint,daily_limit bigint,warning_threshold bigint,remaining bigint,business_date date)
language plpgsql stable security definer set search_path = '' as $$
declare approval_day date := (now() at time zone 'Asia/Bangkok')::date; total bigint;
begin
  if auth.uid() is null or public.my_role() is distinct from 'treasurer' then
    raise exception 'Chỉ quản lý tài chính được xem tổng duyệt trong ngày.';
  end if;
  select coalesce(sum(r.amount),0)::bigint into total
  from public.requests r
  where r.status='APPROVED'
    and r.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
    and r.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
  return query select total,100000000::bigint,80000000::bigint,
    greatest(100000000::bigint-total,0),approval_day;
end $$;
revoke execute on function public.my_role(),public.can_read_request(uuid),public.record_request_event(),
  public.normalize_invoice_number(text),
  public.submit_request(uuid,jsonb,text,text,integer),public.review_request(uuid,integer,text,text,jsonb),
  public.record_invoice_analysis(uuid,integer,jsonb),public.daily_approval_summary() from public,anon,authenticated;
grant execute on function public.my_role(),public.can_read_request(uuid),
  public.submit_request(uuid,jsonb,text,text,integer),public.review_request(uuid,integer,text,text,jsonb),
  public.daily_approval_summary() to authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
commit;
