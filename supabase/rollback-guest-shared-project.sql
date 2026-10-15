-- DRAFT ONLY: functional rollback of 20261016-guest-shared-project.sql.
-- Review against the live catalog and take a database backup before applying.
-- Confirm this was the only database migration since baseline 16980fd and
-- deploy/disable guest-capable web code first. This file is not executed by Codex.
--
-- The pre-guest state of role finref_rpc was not recorded. This rollback
-- deliberately leaves that NOLOGIN role and its object/schema ACLs in place;
-- it restores the application functions/policies/data shape, but cannot claim
-- byte-for-byte catalog restoration. Do not DROP ROLE or DROP OWNED without a
-- pre-migration role/ACL snapshot.

begin;
set local lock_timeout = '10s';

-- Freeze writes while validating guest-only data and removing its columns.
-- If the live site is busy, this transaction should fail and be retried later.
lock table public.requests, public.vendor_directory, public.vendor_aliases,
  public.vendor_review_notes, public.guest_analysis_usage
  in access exclusive mode;
lock table auth.users in share row exclusive mode;
lock table storage.objects in share row exclusive mode;

do $$
declare
  role_oid oid;
  object_sig text;
  object_def text;
  owner_name text;
  body_hash text;
  expected record;
  has_guest_rows boolean;
  guest_count bigint;
begin
  if current_user <> 'postgres' then
    raise exception 'Run as database role postgres; current_user is %.', current_user;
  end if;

  if not exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='requests' and column_name='is_guest')
    or not exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='vendor_directory' and column_name='is_guest')
    or not exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='vendor_aliases' and column_name='is_guest') then
    raise exception 'Guest scope columns are missing; the expected guest migration state is not present.';
  end if;
  if exists (
    select 1
    from (values ('requests'),('vendor_directory'),('vendor_aliases')) as t(table_name)
    join pg_class c on c.oid=('public.'||t.table_name)::regclass
    join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
    join pg_attribute a on a.attrelid=c.oid and a.attname='is_guest' and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where a.atttypid<>'boolean'::regtype or not a.attnotnull
      or pg_get_expr(d.adbin,d.adrelid) is distinct from 'false'
  ) then
    raise exception 'One or more is_guest columns differ from boolean NOT NULL DEFAULT false.';
  end if;

  select oid into role_oid from pg_roles where rolname='finref_rpc';
  if role_oid is null then raise exception 'Role finref_rpc is missing.'; end if;
  if exists (select 1 from pg_roles where oid=role_oid and
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit)) then
    raise exception 'Role finref_rpc attributes differ from the guest migration result; inspect before rollback.';
  end if;
  if exists (select 1 from pg_auth_members where roleid=role_oid or member=role_oid) then
    raise exception 'finref_rpc has role memberships; inspect them before changing function owners.';
  end if;
  if not exists (select 1 from pg_roles where rolname=current_user and (rolsuper or rolcreaterole)) then
    raise exception 'postgres lacks CREATEROLE/superuser needed for the temporary finref_rpc membership; stop before DDL.';
  end if;

  -- The migration changed this exact function set to finref_rpc ownership.
  foreach object_sig in array array[
    'public.my_role()',
    'public.can_read_request(uuid)',
    'public.record_request_event()',
    'public.stamp_request_scope()',
    'public.submit_request(uuid,jsonb,text,text,integer)',
    'public.review_request(uuid,integer,text,text,jsonb)',
    'public.review_requests_batch(jsonb,text)',
    'public.daily_approval_summary()',
    'public.vendor_review_note_list()',
    'public.vendor_review_note_resolve(uuid)',
    'public.vendor_directory_list()',
    'public.save_vendor(uuid,text,text,text[])',
    'public.resolve_vendor_name_match_with_confidence(text,text,text,numeric)',
    'public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean)',
    'public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb)',
    'public.record_invoice_analysis(uuid,integer,jsonb)',
    'public.record_invoice_analysis(uuid,integer,jsonb,boolean)',
    'public.set_guest_role(text)'
  ] loop
    if to_regprocedure(object_sig) is null then
      raise exception 'Expected function % is missing.', object_sig;
    end if;
    select pg_get_userbyid(p.proowner) into owner_name
      from pg_proc p where p.oid=to_regprocedure(object_sig);
    if owner_name <> 'finref_rpc' then
      raise exception 'Expected % owner finref_rpc, found %.', object_sig, owner_name;
    end if;
  end loop;
  if to_regprocedure('public.create_guest_profile()') is null
    or to_regprocedure('public.consume_guest_analysis_quota(uuid,integer)') is null then
    raise exception 'Expected guest-only helper functions are missing; inspect the live catalog.';
  end if;

  if not exists(select 1 from pg_trigger where tgrelid='public.requests'::regclass
      and tgname='requests_scope_guard' and not tgisinternal)
    or not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass
      and tgname='finref_create_guest_profile_after_signup' and not tgisinternal) then
    raise exception 'Expected guest-mode triggers are missing; inspect the live catalog.';
  end if;

  select indexdef into object_def from pg_indexes
    where schemaname='public' and indexname='vendor_directory_normalized_name_scope_uq';
  if object_def is null or position('unique index' in lower(object_def))=0
    or position('(is_guest, normalized_name)' in lower(object_def))=0 then
    raise exception 'Scoped vendor-name index differs from the expected guest migration result.';
  end if;
  select indexdef into object_def from pg_indexes
    where schemaname='public' and indexname='vendor_directory_tax_code_scope_uq';
  if object_def is null or position('unique index' in lower(object_def))=0
    or position('(is_guest, tax_code_key)' in lower(object_def))=0
    or position('where (tax_code_key is not null)' in lower(object_def))=0 then
    raise exception 'Scoped vendor tax-code index differs from the expected guest migration result.';
  end if;
  if to_regclass('public.vendor_directory_normalized_name_uq') is not null
    or to_regclass('public.vendor_directory_tax_code_uq') is not null then
    raise exception 'Baseline vendor indexes already exist; inspect before restoring index definitions.';
  end if;

  select pg_get_constraintdef(oid) into object_def from pg_constraint
    where conrelid='public.vendor_directory'::regclass and conname='vendor_directory_id_scope_uq';
  if object_def is null or lower(object_def)<>'unique (id, is_guest)' then
    raise exception 'Vendor scope key constraint differs from the expected guest migration result.';
  end if;
  select pg_get_constraintdef(oid) into object_def from pg_constraint
    where conrelid='public.vendor_aliases'::regclass and conname='vendor_aliases_normalized_name_scope_uq';
  if object_def is null or lower(object_def)<>'unique (is_guest, normalized_name)' then
    raise exception 'Vendor-alias scope key constraint differs from the expected guest migration result.';
  end if;
  select pg_get_constraintdef(oid) into object_def from pg_constraint
    where conrelid='public.vendor_aliases'::regclass and conname='vendor_aliases_vendor_scope_fkey';
  if object_def is null or position('foreign key (vendor_id, is_guest)' in lower(object_def))<>1
    or position('vendor_directory(id, is_guest)' in lower(object_def))=0
    or position('on delete cascade' in lower(object_def))=0 then
    raise exception 'Vendor-alias scope foreign key differs from the expected guest migration result.';
  end if;
  if exists(select 1 from pg_constraint where conrelid='public.vendor_aliases'::regclass
      and conname in ('vendor_aliases_normalized_name_key','vendor_aliases_vendor_id_fkey')) then
    raise exception 'Baseline vendor-alias constraints already exist; inspect before restoring them.';
  end if;

  -- Hash every function body the rollback replaces or drops. Values are
  -- derived from baseline 16980fd and guest migration 168ec2b after newline
  -- normalization; any body drift stops before DDL.
  for expected in
    select * from (values
      ('public.can_read_request(uuid)', 'be9e63b931e860ff7824704b74dfead5'),
      ('public.review_request(uuid,integer,text,text,jsonb)', '75f9d69f766ba49e840038d95eedcd01'),
      ('public.review_requests_batch(jsonb,text)', 'fba7f376f2a0e780ac09387fab45871e'),
      ('public.vendor_directory_list()', '054eba6e14088ac417dbae5dbbaf09b2'),
      ('public.save_vendor(uuid,text,text,text[])', '01ac1e196788a954ac21831cf6a25515'),
      ('public.current_data_scope()', 'a032f5d306fe14c25cb3d02664056ce6'),
      ('public.stamp_request_scope()', 'caa84bbfab209bba1c6827a681c94db9'),
      ('public.create_guest_profile()', '7307b5349d1db8a29f5622c2be5af8fd'),
      ('public.set_guest_role(text)', '2d69e51eaf4961efa5e4f6b7cc5bc717'),
      ('public.consume_guest_analysis_quota(uuid,integer)', '09e9ad66c0cc9bc528ad7b989f57bd45'),
      ('public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean)', '902c4838994ddf9fc41ac65a34d5931b'),
      ('public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb)', '0e6dad014eb5eba639dbbaee3dc10bc4'),
      ('public.record_invoice_analysis(uuid,integer,jsonb)', '9e18f8b3b275ef0fd22833a93fae8f57'),
      ('public.record_invoice_analysis(uuid,integer,jsonb,boolean)', 'b810126091735547081a9f459635894c')
    ) as expected_functions(object_sig, expected_hash)
  loop
    if to_regprocedure(expected.object_sig) is null then
      raise exception 'Expected function % is missing before rollback.', expected.object_sig;
    end if;
    select md5(regexp_replace(regexp_replace(p.prosrc,chr(13)||chr(10),chr(10),'g'),chr(13),chr(10),'g'))
      into body_hash from pg_proc p where p.oid=to_regprocedure(expected.object_sig);
    if body_hash <> expected.expected_hash then
      raise exception 'Function body for % differs from the expected migration state.', expected.object_sig;
    end if;
  end loop;

  execute 'select exists(select 1 from public.requests where is_guest)' into has_guest_rows;
  if has_guest_rows then raise exception 'Guest requests exist; preserve and migrate them before rollback.'; end if;
  execute 'select exists(select 1 from public.vendor_directory where is_guest)' into has_guest_rows;
  if has_guest_rows then raise exception 'Guest vendors exist; preserve and migrate them before rollback.'; end if;
  execute 'select exists(select 1 from public.vendor_aliases where is_guest)' into has_guest_rows;
  if has_guest_rows then raise exception 'Guest vendor aliases exist; preserve and migrate them before rollback.'; end if;

  select count(*) into guest_count from public.guest_analysis_usage;
  if guest_count <> 0 then
    raise exception 'guest_analysis_usage contains % rows; preserve them before dropping the guest quota table.', guest_count;
  end if;

  select count(*) into guest_count from auth.users where is_anonymous;
  if guest_count <> 0 then
    raise exception 'There are % anonymous Auth users; preserve or explicitly clean their guest state before rollback.', guest_count;
  end if;
  if exists(select 1 from storage.objects o join auth.users u
      on split_part(o.name,'/',1)=u.id::text
      where o.bucket_id='evidence' and u.is_anonymous) then
    raise exception 'Evidence files owned by anonymous Auth users remain; preserve them before rollback.';
  end if;

  if exists(select 1 from public.vendor_directory group by normalized_name having count(*)>1) then
    raise exception 'Duplicate vendor names prevent restoration of the baseline global unique index.';
  end if;
  if exists(select 1 from public.vendor_directory where tax_code_key is not null
    group by tax_code_key having count(*)>1) then
    raise exception 'Duplicate vendor tax codes prevent restoration of the baseline global unique index.';
  end if;
  if exists(select 1 from public.vendor_aliases group by normalized_name having count(*)>1) then
    raise exception 'Duplicate vendor aliases prevent restoration of the baseline unique constraint.';
  end if;
  if exists(select 1 from public.vendor_aliases a left join public.vendor_directory v on v.id=a.vendor_id
    where v.id is null) then
    raise exception 'Orphan vendor aliases prevent restoration of the baseline foreign key.';
  end if;
end $$;

-- Temporarily let postgres alter objects currently owned by finref_rpc.
-- The preflight above requires there to be no pre-existing membership.
grant finref_rpc to postgres;

-- Restore the exact pre-guest CFO visibility rule from the repository baseline.
create or replace function public.can_read_request(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.requests r where r.id=p_id and (
    r.owner_id=auth.uid() or public.my_role()='treasurer'
      or (public.my_role()='cfo' and (
        r.status='CFO_REVIEW'
        or (r.status='READY_FOR_APPROVAL' and r.amount>20000000)
        or (r.status='TREASURER_REVIEW' and r.amount>20000000)
        or (r.status='APPROVED' and r.escalated_at is not null)
        or (r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED')
          and exists(select 1 from public.vendor_review_notes n where n.request_id=r.id and n.reviewed_at is null))
      ))
  ));
$$;
revoke execute on function public.can_read_request(uuid) from public,anon;
grant execute on function public.can_read_request(uuid) to authenticated;

-- Restore vendor directory RPC bodies from 20261004-z-vendor-directory.sql.
create or replace function public.vendor_directory_list()
returns table(vendor_id uuid,legal_name text,tax_code text,aliases text[],created_at timestamptz,updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(public.my_role(),'') not in ('applicant','treasurer','cfo') then
    raise exception 'Không có quyền xem danh mục nhà cung cấp.';
  end if;
  return query
    select v.id,v.legal_name,nullif(v.tax_code,''),
      array(select a.alias_name from public.vendor_aliases a where a.vendor_id=v.id order by a.normalized_name),
      v.created_at,v.updated_at
    from public.vendor_directory v
    order by v.normalized_name;
end $$;

create or replace function public.save_vendor(p_vendor_id uuid,p_legal_name text,p_tax_code text,p_aliases text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  who text := public.my_role();
  vendor_id uuid;
  existing_vendor_id uuid;
  candidate text;
  normalized_candidate text;
  code text := coalesce(trim(p_tax_code),'');
begin
  if actor is null or coalesce(who,'') not in ('treasurer','cfo') then
    raise exception 'Chỉ Quản lý tài chính hoặc Giám đốc Tài chính được quản lý danh mục nhà cung cấp.';
  end if;
  if p_legal_name is null or length(trim(p_legal_name)) not between 3 and 250 then
    raise exception 'Tên pháp lý nhà cung cấp phải từ 3 đến 250 ký tự.';
  end if;
  if code <> '' and (length(code) not between 5 and 30 or code !~ '^[A-Za-z0-9][A-Za-z0-9 .\/-]{3,29}$') then
    raise exception 'Mã số thuế chỉ được chứa chữ, số, dấu chấm, gạch chéo hoặc gạch ngang.';
  end if;
  if coalesce(cardinality(p_aliases),0) > 50 then
    raise exception 'Mỗi lần chỉ có thể thêm tối đa 50 bí danh.';
  end if;

  if p_vendor_id is null then
    insert into public.vendor_directory(legal_name,tax_code,created_by,updated_by)
      values(trim(p_legal_name),code,actor,actor) returning id into vendor_id;
  else
    update public.vendor_directory set legal_name=trim(p_legal_name),tax_code=code,updated_by=actor,updated_at=now()
      where id=p_vendor_id returning id into vendor_id;
    if vendor_id is null then raise exception 'Không tìm thấy nhà cung cấp cần sửa.'; end if;
  end if;

  foreach candidate in array array_prepend(trim(p_legal_name),coalesce(p_aliases,array[]::text[])) loop
    candidate := trim(candidate);
    if candidate = '' then continue; end if;
    if length(candidate) not between 3 and 250 then
      raise exception 'Mỗi tên/bí danh phải từ 3 đến 250 ký tự.';
    end if;
    normalized_candidate := public.normalize_party_name(candidate);
    select a.vendor_id into existing_vendor_id from public.vendor_aliases a where a.normalized_name=normalized_candidate;
    if existing_vendor_id is not null and existing_vendor_id <> vendor_id then
      raise exception 'Bí danh "%" đã thuộc về nhà cung cấp khác.',candidate;
    end if;
    insert into public.vendor_aliases(vendor_id,alias_name,verified_by,verification_note)
      values(vendor_id,candidate,actor,'Đã được Quản lý tài chính/Giám đốc Tài chính xác minh khi thêm vào danh mục.')
      on conflict (normalized_name) do nothing;
  end loop;
  return vendor_id;
end $$;

-- The guest migration performed only guarded text substitutions to isolate
-- advisory-lock namespaces. Verify those exact preimages before reversing them.
do $$
declare
  definition text;
  guest_expr text;
  base_expr text;
begin
  definition:=pg_get_functiondef('public.review_request(uuid,integer,text,text,jsonb)'::regprocedure);
  guest_expr:='hashtextextended(public.current_data_scope()::text||'':''||tax_value||''/''||invoice_no,0)';
  base_expr:='hashtextextended(tax_value||''/''||invoice_no,0)';
  if length(definition)-length(replace(definition,guest_expr,''))<>length(guest_expr)
    or position(base_expr in definition)>0 then
    raise exception 'review_request invoice lock differs from the expected guest migration result.';
  end if;
  definition:=replace(definition,guest_expr,base_expr);
  guest_expr:='hashtextextended(''finref-daily-approvals:''||public.current_data_scope()::text||'':''||approval_day::text,0)';
  base_expr:='hashtextextended(''finref-daily-approvals:''||approval_day::text,0)';
  if length(definition)-length(replace(definition,guest_expr,''))<>length(guest_expr)
    or position(base_expr in definition)>0 then
    raise exception 'review_request daily lock differs from the expected guest migration result.';
  end if;
  definition:=replace(definition,guest_expr,base_expr);
  execute definition;

  definition:=pg_get_functiondef('public.review_requests_batch(jsonb,text)'::regprocedure);
  guest_expr:='hashtextextended(public.current_data_scope()::text||'':''||k.invoice_key,0)';
  base_expr:='hashtextextended(k.invoice_key,0)';
  if length(definition)-length(replace(definition,guest_expr,''))<>length(guest_expr)
    or position(base_expr in definition)>0 then
    raise exception 'review_requests_batch invoice lock differs from the expected guest migration result.';
  end if;
  definition:=replace(definition,guest_expr,base_expr);
  guest_expr:='hashtextextended(''finref-daily-approvals:''||public.current_data_scope()::text||'':''||approval_day::text,0)';
  base_expr:='hashtextextended(''finref-daily-approvals:''||approval_day::text,0)';
  if length(definition)-length(replace(definition,guest_expr,''))<>length(guest_expr)
    or position(base_expr in definition)>0 then
    raise exception 'review_requests_batch daily lock differs from the expected guest migration result.';
  end if;
  definition:=replace(definition,guest_expr,base_expr);
  execute definition;
end $$;

-- Restore the policy body and remove policies introduced only for finref_rpc.
drop policy if exists profiles_rpc_self on public.profiles;
drop policy if exists requests_rpc_scope on public.requests;
drop policy if exists audit_events_rpc_scope on public.audit_events;
drop policy if exists vendor_review_notes_rpc_scope on public.vendor_review_notes;
drop policy if exists vendor_directory_rpc_scope on public.vendor_directory;
drop policy if exists vendor_aliases_rpc_scope on public.vendor_aliases;
drop policy if exists evidence_rpc_read on storage.objects;
drop policy if exists vendor_review_notes_cfo_read on public.vendor_review_notes;
create policy vendor_review_notes_cfo_read on public.vendor_review_notes
  for select to authenticated using(public.my_role()='cfo');

-- Remove guest-only trigger/functions/overloads, then return the original
-- three-argument invoice-analysis function to its original signature.
drop trigger if exists finref_create_guest_profile_after_signup on auth.users;
drop function public.create_guest_profile();
drop function public.set_guest_role(text);
drop function public.consume_guest_analysis_quota(uuid,integer);
drop function public.record_invoice_analysis(uuid,integer,jsonb);
alter function public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb)
  rename to record_invoice_analysis;
drop function public.record_invoice_analysis(uuid,integer,jsonb,boolean);
drop function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean);
drop trigger if exists requests_scope_guard on public.requests;
drop function public.stamp_request_scope();
drop function public.current_data_scope();

-- Restore the service-only grants that the guest migration changed.
revoke execute on function public.resolve_vendor_name_match(text,text,text) from public,anon,authenticated;
grant execute on function public.resolve_vendor_name_match(text,text,text) to service_role;
revoke execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric)
  from finref_rpc;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric)
  to service_role;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb)
  from public,anon,authenticated,finref_rpc;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;

-- Ownership assumption for this draft: production applied the baseline SQL as
-- postgres. The repo has no catalog snapshot proving the pre-guest owners, so
-- verify that assumption against any saved production metadata before applying.
alter function public.my_role() owner to postgres;
alter function public.can_read_request(uuid) owner to postgres;
alter function public.record_request_event() owner to postgres;
alter function public.submit_request(uuid,jsonb,text,text,integer) owner to postgres;
alter function public.review_request(uuid,integer,text,text,jsonb) owner to postgres;
alter function public.review_requests_batch(jsonb,text) owner to postgres;
alter function public.daily_approval_summary() owner to postgres;
alter function public.vendor_review_note_list() owner to postgres;
alter function public.vendor_review_note_resolve(uuid) owner to postgres;
alter function public.vendor_directory_list() owner to postgres;
alter function public.save_vendor(uuid,text,text,text[]) owner to postgres;
alter function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) owner to postgres;
alter function public.record_invoice_analysis(uuid,integer,jsonb) owner to postgres;

-- Remove scope-specific indexes/constraints and restore the original global
-- uniqueness rules after the duplicate checks above have passed.
drop index public.vendor_directory_normalized_name_scope_uq;
drop index public.vendor_directory_tax_code_scope_uq;
alter table public.vendor_directory drop constraint vendor_directory_id_scope_uq;
alter table public.vendor_aliases drop constraint vendor_aliases_normalized_name_scope_uq;
alter table public.vendor_aliases drop constraint vendor_aliases_vendor_scope_fkey;
create unique index vendor_directory_normalized_name_uq
  on public.vendor_directory(normalized_name);
create unique index vendor_directory_tax_code_uq
  on public.vendor_directory(tax_code_key) where tax_code_key is not null;
alter table public.vendor_aliases add constraint vendor_aliases_normalized_name_key unique(normalized_name);
alter table public.vendor_aliases add constraint vendor_aliases_vendor_id_fkey
  foreign key(vendor_id) references public.vendor_directory(id) on delete cascade;

drop table public.guest_analysis_usage;
alter table public.requests drop column is_guest;
alter table public.vendor_directory drop column is_guest;
alter table public.vendor_aliases drop column is_guest;

-- All app functions have been returned to postgres; remove only the temporary
-- role membership created at the top of this transaction. Keep finref_rpc.
revoke finref_rpc from postgres;

do $$
declare
  object_sig text;
  owner_name text;
  body_hash text;
begin
  foreach object_sig in array array[
    'public.my_role()',
    'public.can_read_request(uuid)',
    'public.record_request_event()',
    'public.submit_request(uuid,jsonb,text,text,integer)',
    'public.review_request(uuid,integer,text,text,jsonb)',
    'public.review_requests_batch(jsonb,text)',
    'public.daily_approval_summary()',
    'public.vendor_review_note_list()',
    'public.vendor_review_note_resolve(uuid)',
    'public.vendor_directory_list()',
    'public.save_vendor(uuid,text,text,text[])',
    'public.resolve_vendor_name_match_with_confidence(text,text,text,numeric)',
    'public.record_invoice_analysis(uuid,integer,jsonb)'
  ] loop
    select pg_get_userbyid(p.proowner) into owner_name
      from pg_proc p where p.oid=to_regprocedure(object_sig);
    if owner_name is distinct from 'postgres' then
      raise exception 'Postflight owner mismatch for %: %.', object_sig, owner_name;
    end if;
  end loop;

  select md5(regexp_replace(regexp_replace(p.prosrc,chr(13)||chr(10),chr(10),'g'),chr(13),chr(10),'g'))
    into body_hash from pg_proc p where p.oid=to_regprocedure('public.review_request(uuid,integer,text,text,jsonb)');
  if body_hash <> '1e167a01081d0ffc4788854ec9af5fc9' then
    raise exception 'Postflight review_request body differs from baseline 16980fd.';
  end if;
  select md5(regexp_replace(regexp_replace(p.prosrc,chr(13)||chr(10),chr(10),'g'),chr(13),chr(10),'g'))
    into body_hash from pg_proc p where p.oid=to_regprocedure('public.review_requests_batch(jsonb,text)');
  if body_hash <> 'b4fec2f4fe76dee3a447da4b761a2e21' then
    raise exception 'Postflight review_requests_batch body differs from baseline 16980fd.';
  end if;

  if exists(select 1 from information_schema.columns where table_schema='public'
      and table_name in ('requests','vendor_directory','vendor_aliases') and column_name='is_guest')
    or to_regclass('public.guest_analysis_usage') is not null
    or to_regprocedure('public.current_data_scope()') is not null
    or to_regprocedure('public.set_guest_role(text)') is not null
    or to_regprocedure('public.create_guest_profile()') is not null
    or to_regprocedure('public.consume_guest_analysis_quota(uuid,integer)') is not null
    or to_regprocedure('public.stamp_request_scope()') is not null
    or to_regprocedure('public.record_invoice_analysis_scoped_legacy(uuid,integer,jsonb)') is not null
    or to_regprocedure('public.record_invoice_analysis(uuid,integer,jsonb,boolean)') is not null
    or to_regprocedure('public.resolve_vendor_name_match_with_confidence(text,text,text,numeric,boolean)') is not null then
    raise exception 'Postflight found guest-only schema or function objects.';
  end if;

  if to_regclass('public.vendor_directory_normalized_name_uq') is null
    or to_regclass('public.vendor_directory_tax_code_uq') is null
    or to_regclass('public.vendor_directory_normalized_name_scope_uq') is not null
    or to_regclass('public.vendor_directory_tax_code_scope_uq') is not null
    or not exists(select 1 from pg_constraint where conrelid='public.vendor_aliases'::regclass
      and conname='vendor_aliases_normalized_name_key')
    or not exists(select 1 from pg_constraint where conrelid='public.vendor_aliases'::regclass
      and conname='vendor_aliases_vendor_id_fkey')
    or exists(select 1 from pg_constraint where conrelid='public.vendor_directory'::regclass
      and conname='vendor_directory_id_scope_uq')
    or exists(select 1 from pg_constraint where conrelid='public.vendor_aliases'::regclass
      and conname in ('vendor_aliases_normalized_name_scope_uq','vendor_aliases_vendor_scope_fkey')) then
    raise exception 'Postflight is missing one or more baseline vendor indexes/constraints.';
  end if;

  if exists(select 1 from pg_policies where policyname in (
      'profiles_rpc_self','requests_rpc_scope','audit_events_rpc_scope',
      'vendor_review_notes_rpc_scope','vendor_directory_rpc_scope',
      'vendor_aliases_rpc_scope','evidence_rpc_read')) then
    raise exception 'Postflight found guest-only policies.';
  end if;
  if not exists(select 1 from pg_policies where schemaname='public'
      and tablename='vendor_review_notes' and policyname='vendor_review_notes_cfo_read')
    or exists(select 1 from pg_policies where schemaname='public'
      and tablename='vendor_review_notes' and policyname='vendor_review_notes_cfo_read'
      and (position('my_role' in coalesce(qual,''))=0
        or position('can_read_request' in coalesce(qual,''))>0)) then
    raise exception 'Postflight CFO notes policy differs from baseline 16980fd.';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.requests'::regclass
      and tgname='requests_scope_guard' and not tgisinternal)
    or exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass
      and tgname='finref_create_guest_profile_after_signup' and not tgisinternal) then
    raise exception 'Postflight found a guest-mode trigger.';
  end if;
  if exists(select 1 from pg_auth_members
      where roleid=(select oid from pg_roles where rolname='finref_rpc')
        or member=(select oid from pg_roles where rolname='finref_rpc')) then
    raise exception 'Postflight found a role membership for finref_rpc; inspect before commit.';
  end if;
end $$;

commit;
notify pgrst,'reload schema';
