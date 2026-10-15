-- Isolate anonymous demo data inside the existing Supabase project.
-- Apply only after the normal schema and production migrations are current.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='finref_rpc') then
    execute 'create role finref_rpc nologin noinherit nobypassrls';
  end if;
end $$;
alter role finref_rpc nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

create or replace function public.current_data_scope()
returns boolean language sql stable set search_path = '' as $$
  select case when auth.role()='service_role'
    then coalesce(nullif(current_setting('finref.guest_scope',true),''),'false')='true'
    else coalesce(auth.jwt()->>'is_anonymous','false')='true' end;
$$;
revoke all on function public.current_data_scope() from public,anon,authenticated,service_role;
grant execute on function public.current_data_scope() to finref_rpc;

alter table public.requests add column if not exists is_guest boolean not null default false;
create or replace function public.stamp_request_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    new.is_guest:=public.current_data_scope();
  elsif new.is_guest is distinct from old.is_guest or new.owner_id is distinct from old.owner_id then
    raise exception 'Không thể đổi scope hoặc chủ sở hữu hồ sơ.';
  end if;
  return new;
end $$;
drop trigger if exists requests_scope_guard on public.requests;
create trigger requests_scope_guard before insert or update on public.requests
for each row execute function public.stamp_request_scope();

alter table public.vendor_directory add column if not exists is_guest boolean not null default false;
alter table public.vendor_aliases add column if not exists is_guest boolean not null default false;
drop index if exists public.vendor_directory_normalized_name_uq;
drop index if exists public.vendor_directory_tax_code_uq;
create unique index vendor_directory_normalized_name_scope_uq
  on public.vendor_directory(is_guest,normalized_name);
create unique index vendor_directory_tax_code_scope_uq
  on public.vendor_directory(is_guest,tax_code_key) where tax_code_key is not null;
alter table public.vendor_directory add constraint vendor_directory_id_scope_uq unique(id,is_guest);
alter table public.vendor_aliases drop constraint if exists vendor_aliases_normalized_name_key;
alter table public.vendor_aliases drop constraint if exists vendor_aliases_vendor_id_fkey;
alter table public.vendor_aliases add constraint vendor_aliases_normalized_name_scope_uq unique(is_guest,normalized_name);
alter table public.vendor_aliases add constraint vendor_aliases_vendor_scope_fkey
  foreign key(vendor_id,is_guest) references public.vendor_directory(id,is_guest) on delete cascade;

-- The non-login function owner is subject to RLS, unlike the old postgres-owned
-- SECURITY DEFINER RPCs. Their existing business rules remain inside those RPCs.
grant usage on schema public,auth,storage to finref_rpc;
grant create on schema public to finref_rpc;
grant execute on function auth.uid(),auth.role(),auth.jwt() to finref_rpc;
grant select,insert,update on public.requests to finref_rpc;
grant select,update on public.profiles to finref_rpc;
grant insert on public.audit_events to finref_rpc;
grant select,insert,update,delete on public.vendor_review_notes to finref_rpc;
grant select,insert,update,delete on public.vendor_directory,public.vendor_aliases to finref_rpc;
grant select on storage.objects to finref_rpc;
grant usage,select on sequence public.audit_events_id_seq to finref_rpc;
-- Existing application helpers are intentionally unavailable to API roles;
-- the trusted SECURITY DEFINER owner needs them to preserve the same checks.
grant execute on function public.normalize_party_name(text),public.normalize_invoice_number(text),
  public.normalize_vendor_tax_code(text),
  public.request_duplicate_identifiers(jsonb,jsonb),
  public.request_identifier_needs_manager_verification(jsonb,jsonb,text) to finref_rpc;

drop policy if exists profiles_rpc_self on public.profiles;
create policy profiles_rpc_self on public.profiles for all to finref_rpc
  using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists requests_rpc_scope on public.requests;
create policy requests_rpc_scope on public.requests for all to finref_rpc
  using(is_guest=public.current_data_scope()) with check(is_guest=public.current_data_scope());
drop policy if exists audit_events_rpc_scope on public.audit_events;
create policy audit_events_rpc_scope on public.audit_events for insert to finref_rpc with check(
  exists(select 1 from public.requests r where r.id=request_id and r.is_guest=public.current_data_scope())
);
drop policy if exists vendor_review_notes_rpc_scope on public.vendor_review_notes;
create policy vendor_review_notes_rpc_scope on public.vendor_review_notes for all to finref_rpc
  using(exists(select 1 from public.requests r where r.id=request_id and r.is_guest=public.current_data_scope()))
  with check(exists(select 1 from public.requests r where r.id=request_id and r.is_guest=public.current_data_scope()));
drop policy if exists vendor_directory_rpc_scope on public.vendor_directory;
create policy vendor_directory_rpc_scope on public.vendor_directory for all to finref_rpc
  using(is_guest=public.current_data_scope()) with check(is_guest=public.current_data_scope());
drop policy if exists vendor_aliases_rpc_scope on public.vendor_aliases;
create policy vendor_aliases_rpc_scope on public.vendor_aliases for all to finref_rpc
  using(is_guest=public.current_data_scope()) with check(is_guest=public.current_data_scope());
drop policy if exists evidence_rpc_read on storage.objects;
create policy evidence_rpc_read on storage.objects for select to finref_rpc using(
  bucket_id='evidence' and (
    split_part(name,'/',1)=auth.uid()::text
    or exists(select 1 from public.requests r where r.is_guest=public.current_data_scope()
      and name in (r.invoice_path,r.request_path))
  )
);

create or replace function public.can_read_request(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.requests r where r.id=p_id
    and r.is_guest=public.current_data_scope() and (
      r.owner_id=auth.uid() or public.my_role()='treasurer'
      or (public.my_role()='cfo' and (
        r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000)
        or (r.status='TREASURER_REVIEW' and r.amount>20000000)
        or (r.status='APPROVED' and r.escalated_at is not null)
        or (r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED')
          and exists(select 1 from public.vendor_review_notes n where n.request_id=r.id and n.reviewed_at is null))
      ))
    ));
$$;

drop policy if exists vendor_review_notes_cfo_read on public.vendor_review_notes;
create policy vendor_review_notes_cfo_read on public.vendor_review_notes for select to authenticated
  using(public.my_role()='cfo' and public.can_read_request(request_id));

create or replace function public.vendor_directory_list()
returns table(vendor_id uuid,legal_name text,tax_code text,aliases text[],created_at timestamptz,updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(public.my_role(),'') not in ('applicant','treasurer','cfo') then
    raise exception 'Không có quyền xem danh mục nhà cung cấp.';
  end if;
  return query select v.id,v.legal_name,nullif(v.tax_code,''),
    array(select a.alias_name from public.vendor_aliases a
      where a.vendor_id=v.id and a.is_guest=public.current_data_scope() order by a.normalized_name),
    v.created_at,v.updated_at
    from public.vendor_directory v where v.is_guest=public.current_data_scope()
    order by v.normalized_name;
end $$;

create or replace function public.save_vendor(p_vendor_id uuid,p_legal_name text,p_tax_code text,p_aliases text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid:=auth.uid();
  who text:=public.my_role();
  guest_scope boolean:=public.current_data_scope();
  vendor_id uuid;
  existing_vendor_id uuid;
  candidate text;
  normalized_candidate text;
  code text:=coalesce(trim(p_tax_code),'');
begin
  if actor is null or coalesce(who,'') not in ('treasurer','cfo') then
    raise exception 'Chỉ Quản lý tài chính hoặc Giám đốc Tài chính được quản lý danh mục nhà cung cấp.';
  end if;
  if p_legal_name is null or length(trim(p_legal_name)) not between 3 and 250 then
    raise exception 'Tên pháp lý nhà cung cấp phải từ 3 đến 250 ký tự.';
  end if;
  if code<>'' and (length(code) not between 5 and 30 or code !~ '^[A-Za-z0-9][A-Za-z0-9 .\/-]{3,29}$') then
    raise exception 'Mã số thuế chỉ được chứa chữ, số, dấu chấm, gạch chéo hoặc gạch ngang.';
  end if;
  if coalesce(cardinality(p_aliases),0)>50 then raise exception 'Mỗi lần chỉ có thể thêm tối đa 50 bí danh.'; end if;

  if p_vendor_id is null then
    insert into public.vendor_directory(legal_name,tax_code,is_guest,created_by,updated_by)
      values(trim(p_legal_name),code,guest_scope,actor,actor) returning id into vendor_id;
  else
    update public.vendor_directory set legal_name=trim(p_legal_name),tax_code=code,
      updated_by=actor,updated_at=now()
      where id=p_vendor_id and is_guest=guest_scope returning id into vendor_id;
    if vendor_id is null then raise exception 'Không tìm thấy nhà cung cấp trong scope hiện tại.'; end if;
  end if;

  foreach candidate in array array_prepend(trim(p_legal_name),coalesce(p_aliases,array[]::text[])) loop
    candidate:=trim(candidate);
    if candidate='' then continue; end if;
    if length(candidate) not between 3 and 250 then raise exception 'Mỗi tên/bí danh phải từ 3 đến 250 ký tự.'; end if;
    normalized_candidate:=public.normalize_party_name(candidate);
    select a.vendor_id into existing_vendor_id from public.vendor_aliases a
      where a.is_guest=guest_scope and a.normalized_name=normalized_candidate;
    if existing_vendor_id is not null and existing_vendor_id<>vendor_id then
      raise exception 'Bí danh "%" đã thuộc về nhà cung cấp khác trong scope này.',candidate;
    end if;
    insert into public.vendor_aliases(vendor_id,alias_name,is_guest,verified_by,verification_note)
      values(vendor_id,candidate,guest_scope,actor,
        'Đã được Quản lý tài chính/Giám đốc Tài chính xác minh khi thêm vào danh mục.')
      on conflict(is_guest,normalized_name) do nothing;
  end loop;
  return vendor_id;
end $$;

-- Keep the existing four-argument resolver for the analysis RPC, and wrap it
-- with an explicit service-only scope for the API's direct lookup.
create or replace function public.resolve_vendor_name_match_with_confidence(
  p_form_name text,p_invoice_name text,p_invoice_tax_code text,p_invoice_name_confidence numeric,p_is_guest boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' or p_is_guest is null then
    raise exception 'Chỉ AI backend được phân giải tên nhà cung cấp trong scope hợp lệ.';
  end if;
  perform set_config('finref.guest_scope',p_is_guest::text,true);
  return public.resolve_vendor_name_match_with_confidence(
    p_form_name,p_invoice_name,p_invoice_tax_code,p_invoice_name_confidence);
end $$;

-- Rename the old service-only entry point. The wrapper sets trusted scope before
-- its body executes; RLS then scopes its duplicate scans, updates and notes.
alter function public.record_invoice_analysis(uuid,integer,jsonb) rename to record_invoice_analysis_scoped_legacy;
create function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb,p_is_guest boolean)
returns public.requests language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' or p_is_guest is null then
    raise exception 'Chỉ AI backend được ghi kết quả phân tích trong scope hợp lệ.';
  end if;
  perform set_config('finref.guest_scope',p_is_guest::text,true);
  return public.record_invoice_analysis_scoped_legacy(p_id,p_expected_version,p_analysis);
end $$;

-- Keep the existing account-mode RPC available during a rolling deployment.
create function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Chỉ AI backend được gọi thao tác này.';
  end if;
  perform set_config('finref.guest_scope','false',true);
  return public.record_invoice_analysis_scoped_legacy(p_id,p_expected_version,p_analysis);
end $$;

-- Separate advisory-lock namespaces as well as the RLS-filtered table scans.
do $$
declare
  definition text;
  old_expr text;
begin
  definition:=pg_get_functiondef('public.review_request(uuid,integer,text,text,jsonb)'::regprocedure);
  old_expr:='hashtextextended(tax_value||''/''||invoice_no,0)';
  if position(old_expr in definition)=0 then raise exception 'review_request lock expression changed; inspect before applying guest scope migration.'; end if;
  definition:=replace(definition,old_expr,'hashtextextended(public.current_data_scope()::text||'':''||tax_value||''/''||invoice_no,0)');
  old_expr:='hashtextextended(''finref-daily-approvals:''||approval_day::text,0)';
  if position(old_expr in definition)=0 then raise exception 'review_request daily lock expression changed; inspect before applying guest scope migration.'; end if;
  definition:=replace(definition,old_expr,'hashtextextended(''finref-daily-approvals:''||public.current_data_scope()::text||'':''||approval_day::text,0)');
  execute definition;

  definition:=pg_get_functiondef('public.review_requests_batch(jsonb,text)'::regprocedure);
  old_expr:='hashtextextended(k.invoice_key,0)';
  if position(old_expr in definition)=0 then raise exception 'review_requests_batch invoice lock expression changed; inspect before applying guest scope migration.'; end if;
  definition:=replace(definition,old_expr,'hashtextextended(public.current_data_scope()::text||'':''||k.invoice_key,0)');
  old_expr:='hashtextextended(''finref-daily-approvals:''||approval_day::text,0)';
  if position(old_expr in definition)=0 then raise exception 'review_requests_batch daily lock expression changed; inspect before applying guest scope migration.'; end if;
  definition:=replace(definition,old_expr,'hashtextextended(''finref-daily-approvals:''||public.current_data_scope()::text||'':''||approval_day::text,0)');
  execute definition;
end $$;

-- Reassign privileged application RPCs to a non-bypass owner so their direct
-- SQL reads/writes are constrained by the policies above.
alter function public.my_role() owner to finref_rpc;
alter function public.can_read_request(uuid) owner to finref_rpc;
alter function public.record_request_event() owner to finref_rpc;
alter function public.stamp_request_scope() owner to finref_rpc;
alter function public.submit_request(uuid,jsonb,text,text,integer) owner to finref_rpc;
alter function public.review_request(uuid,integer,text,text,jsonb) owner to finref_rpc;
alter function public.review_requests_batch(jsonb,text) owner to finref_rpc;
alter function public.daily_approval_summary() owner to finref_rpc;
alter function public.vendor_review_note_list() owner to finref_rpc;
alter function public.vendor_review_note_resolve(uuid) owner to finref_rpc;
alter function public.vendor_directory_list() owner to finref_rpc;
alter function public.save_vendor(uuid,text,text,text[]) owner to finref_rpc;
alter function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) owner to finref_rpc;
alter function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean) owner to finref_rpc;
alter function public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb) owner to finref_rpc;
alter function public.record_invoice_analysis(uuid,integer,jsonb) owner to finref_rpc;
alter function public.record_invoice_analysis(uuid,integer,jsonb,boolean) owner to finref_rpc;

revoke execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric)
  from public,anon,authenticated;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) to finref_rpc;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) to service_role;
revoke execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean)
  from public,anon,authenticated;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean) to service_role;
revoke execute on function public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb) to finref_rpc;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb,boolean) to service_role;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
revoke execute on function public.resolve_vendor_name_match(text,text,text) from service_role;

-- Anonymous identities get the same profile shape as named users; named signup
-- and password login are unchanged.
create or replace function public.create_guest_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_anonymous then
    insert into public.profiles(id,display_name,role)
    values(new.id,'Khách trải nghiệm','applicant') on conflict(id) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.create_guest_profile() from public,anon,authenticated;
drop trigger if exists finref_create_guest_profile_after_signup on auth.users;
create trigger finref_create_guest_profile_after_signup after insert on auth.users
for each row execute function public.create_guest_profile();

create or replace function public.set_guest_role(p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'is_anonymous','false')<>'true' then
    raise exception 'Chỉ phiên khách ẩn danh được chọn vai trò demo.';
  end if;
  if p_role is null or p_role not in ('applicant','treasurer','cfo') then
    raise exception 'Vai trò demo không hợp lệ.';
  end if;
  update public.profiles set role=p_role,
    display_name=case p_role when 'applicant' then 'Khách · Người nộp đơn'
      when 'treasurer' then 'Khách · Quản lý tài chính' else 'Khách · CFO' end
    where id=auth.uid();
  if not found then raise exception 'Không tìm thấy hồ sơ khách.'; end if;
end $$;
alter function public.set_guest_role(text) owner to finref_rpc;
revoke create on schema public from finref_rpc;
revoke execute on function public.set_guest_role(text) from public,anon;
grant execute on function public.set_guest_role(text) to authenticated;

create table public.guest_analysis_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  analysis_count integer not null check(analysis_count between 1 and 5),
  primary key(user_id,usage_day)
);
alter table public.guest_analysis_usage enable row level security;
revoke all on public.guest_analysis_usage from public,anon,authenticated;
grant select,insert,update,delete on public.guest_analysis_usage to service_role;
create function public.consume_guest_analysis_quota(p_user_id uuid,p_daily_limit integer default 5)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_count integer;
begin
  if p_user_id is null or p_daily_limit is null or p_daily_limit not between 1 and 5
    or not exists(select 1 from auth.users u where u.id=p_user_id and u.is_anonymous) then
    raise exception 'Giới hạn phân tích khách không hợp lệ.';
  end if;
  insert into public.guest_analysis_usage(user_id,usage_day,analysis_count)
    values(p_user_id,(now() at time zone 'Asia/Bangkok')::date,1)
  on conflict(user_id,usage_day) do update
    set analysis_count=public.guest_analysis_usage.analysis_count+1
    where public.guest_analysis_usage.analysis_count<p_daily_limit
  returning analysis_count into current_count;
  return found;
end $$;
revoke execute on function public.consume_guest_analysis_quota(uuid,integer) from public,anon,authenticated;
grant execute on function public.consume_guest_analysis_quota(uuid,integer) to service_role;

commit;
notify pgrst,'reload schema';
