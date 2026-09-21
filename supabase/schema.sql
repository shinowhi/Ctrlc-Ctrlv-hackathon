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
  request_path text not null,
  status text not null default 'TREASURER_REVIEW' check (status in ('TREASURER_REVIEW','NEEDS_INFO','CFO_REVIEW','APPROVED','REJECTED')),
  checks jsonb,
  reason text not null default '',
  version integer not null default 1,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
create index audit_request on public.audit_events(request_id);

create function public.my_role() returns text language sql stable security definer
set search_path = '' as $$ select role from public.profiles where id = auth.uid() $$;

create function public.can_read_request(p_id uuid) returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (select 1 from public.requests r where r.id = p_id and (
    r.owner_id = auth.uid() or public.my_role() = 'treasurer'
    or (public.my_role() = 'cfo' and r.escalated_at is not null)
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
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(invoice|request)\.(pdf|jpg|png)$'
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
  values(new.id,auth.uid(),public.my_role(),case when TG_OP='UPDATE' then old.status else null end,
    new.status,new.reason,new.version,to_jsonb(new));
  return new;
end $$;
create trigger request_audit after insert or update on public.requests
for each row execute function public.record_request_event();

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
  foreach field in array array['requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','requesterType','invoiceType'] loop
    if coalesce(length(trim(p_payload->>field)),0) not between 1 and 1000 then
      raise exception 'Trường % bắt buộc, tối đa 1000 ký tự.',field;
    end if;
    clean := clean || jsonb_build_object(field,trim(p_payload->>field));
  end loop;
  if clean->>'invoiceType' <> 'paper' then raise exception 'Chỉ nhận bản chụp/scan hóa đơn giấy, không nhận hóa đơn điện tử.'; end if;
  if clean->>'requesterType' not in ('employee','department') then raise exception 'Loại người nộp không hợp lệ.'; end if;
  perform (clean->>'invoiceDate')::date;
  if coalesce(p_payload->>'amount','') !~ '^[0-9]{1,12}$' then raise exception 'Số tiền phải là số nguyên dương.'; end if;
  amt := (p_payload->>'amount')::bigint;
  if amt < 1 then raise exception 'Số tiền phải lớn hơn 0.'; end if;
  clean := clean || jsonb_build_object('amount',amt);
  if p_invoice_path is null or p_request_path is null
    or split_part(p_invoice_path,'/',1) <> auth.uid()::text
    or split_part(p_request_path,'/',1) <> auth.uid()::text
    or split_part(p_invoice_path,'/',2) <> split_part(p_request_path,'/',2)
    or p_invoice_path !~ '/invoice\.(pdf|jpg|png)$'
    or p_request_path !~ '/request\.(pdf|jpg|png)$'
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path)
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
  then raise exception 'Cần tải đủ hai minh chứng của chính tài khoản này.'; end if;
  select * into r from public.requests where id=p_id for update;
  was_existing := found;
  if was_existing then
    if r.owner_id <> auth.uid() or r.status <> 'NEEDS_INFO' or p_expected_version is null or r.version <> p_expected_version then
      raise exception 'Hồ sơ đã thay đổi hoặc không được phép bổ sung. Hãy tải lại.';
    end if;
    update public.requests set payload=clean,amount=amt,invoice_path=p_invoice_path,request_path=p_request_path,
      status='TREASURER_REVIEW',checks=null,reason='Người nộp đã bổ sung hồ sơ.',version=version+1,updated_at=now()
      where id=p_id returning * into r;
  else
    if p_expected_version is null or p_expected_version <> 0 then raise exception 'Không tìm thấy phiên bản hồ sơ.'; end if;
    insert into public.requests(id,owner_id,payload,amount,invoice_path,request_path,reason)
      values(p_id,auth.uid(),clean,amt,p_invoice_path,p_request_path,'Đã gửi; chờ thủ quỹ kiểm tra minh chứng.') returning * into r;
  end if;
  return r;
end $$;

create function public.review_request(p_id uuid,p_expected_version integer,p_action text,
  p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare r public.requests; who text := public.my_role(); target text; why text;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version <> p_expected_version then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.';
  end if;
  if auth.uid() is null or not ((who='treasurer' and r.status='TREASURER_REVIEW')
    or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target := case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why := trim(p_reason);
  else
    if who='treasurer' then
      if not (coalesce(p_checks @> '{"paper":true,"stamp":true,"signature":true,"match":true,"budget":true,"policy":true}'::jsonb,false)) then
        raise exception 'U1/U2: chưa xác nhận đủ minh chứng, ngân sách và chính sách. Yêu cầu bổ sung hoặc từ chối.';
      end if;
      target := case when r.amount>20000000 then 'CFO_REVIEW' else 'APPROVED' end;
      why := case when r.amount>20000000 then 'U3: đã kiểm tra, chuyển Giám đốc Tài chính vì vượt 20 triệu.' else 'Thủ quỹ đã kiểm tra và duyệt trong hạn mức.' end;
    else
      if not coalesce(r.checks @> '{"paper":true,"stamp":true,"signature":true,"match":true,"budget":true,"policy":true}'::jsonb,false)
        then raise exception 'Chưa có xác nhận đầy đủ của thủ quỹ.'; end if;
      target := 'APPROVED'; why := 'Giám đốc Tài chính đã phê duyệt khoản chi.';
    end if;
  end if;
  update public.requests set status=target,reason=why,
    checks=case when who='treasurer' and p_action='approve' then p_checks else checks end,
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;
revoke execute on function public.my_role(),public.can_read_request(uuid),public.record_request_event(),
  public.submit_request(uuid,jsonb,text,text,integer),public.review_request(uuid,integer,text,text,jsonb) from public,anon;
grant execute on function public.my_role(),public.can_read_request(uuid),
  public.submit_request(uuid,jsonb,text,text,integer),public.review_request(uuid,integer,text,text,jsonb) to authenticated;
commit;
