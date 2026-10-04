-- Verified vendor names and aliases shared by applicants, finance reviewers and invoice assessment.
begin;

create or replace function public.normalize_vendor_tax_code(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(regexp_replace(upper(normalize(trim(coalesce(p_value,'')), NFKC)), '[^A-Z0-9]', '', 'g'), '');
$$;

create table public.vendor_directory (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null check (length(trim(legal_name)) between 3 and 250),
  normalized_name text generated always as (public.normalize_party_name(legal_name)) stored,
  tax_code text not null default '',
  tax_code_key text generated always as (public.normalize_vendor_tax_code(tax_code)) stored,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tax_code = '' or (length(trim(tax_code)) between 5 and 30 and trim(tax_code) ~ '^[A-Za-z0-9][A-Za-z0-9 .\/-]{3,29}$'))
);
create unique index vendor_directory_normalized_name_uq on public.vendor_directory(normalized_name);
create unique index vendor_directory_tax_code_uq on public.vendor_directory(tax_code_key) where tax_code_key is not null;

create table public.vendor_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendor_directory(id) on delete cascade,
  alias_name text not null check (length(trim(alias_name)) between 3 and 250),
  normalized_name text generated always as (public.normalize_party_name(alias_name)) stored,
  verified_by uuid references auth.users(id),
  verification_note text not null default '',
  created_at timestamptz not null default now(),
  unique (normalized_name)
);
create index vendor_aliases_vendor_id on public.vendor_aliases(vendor_id);

alter table public.vendor_directory enable row level security;
alter table public.vendor_aliases enable row level security;
revoke all on public.vendor_directory,public.vendor_aliases from public,anon,authenticated;
grant all on public.vendor_directory,public.vendor_aliases to service_role;

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

create or replace function public.resolve_vendor_name_match(p_form_name text,p_invoice_name text,p_invoice_tax_code text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  form_name text := public.normalize_party_name(p_form_name);
  invoice_name text := public.normalize_party_name(p_invoice_name);
  invoice_tax_code text := public.normalize_vendor_tax_code(p_invoice_tax_code);
  form_vendor_id uuid;
  invoice_vendor_id uuid;
  registered_tax_code text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Chỉ AI backend được phân giải tên nhà cung cấp.';
  end if;
  if form_name = '' or invoice_name = '' then return jsonb_build_object('status','NO_MATCH'); end if;

  select a.vendor_id into form_vendor_id from public.vendor_aliases a where a.normalized_name=form_name;
  select a.vendor_id into invoice_vendor_id from public.vendor_aliases a where a.normalized_name=invoice_name;
  if form_name = invoice_name then
    if form_vendor_id is not null and invoice_tax_code is not null then
      select v.tax_code_key into registered_tax_code from public.vendor_directory v where v.id=form_vendor_id;
      if registered_tax_code is not null and registered_tax_code <> invoice_tax_code then
        return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
      end if;
    end if;
    return jsonb_build_object('status','MATCH','method','NORMALIZED_NAME');
  end if;

  if form_vendor_id is null or invoice_vendor_id is null or form_vendor_id <> invoice_vendor_id then
    return jsonb_build_object('status','NO_MATCH');
  end if;
  if invoice_tax_code is not null then
    select v.tax_code_key into registered_tax_code from public.vendor_directory v where v.id=form_vendor_id;
    if registered_tax_code is not null and registered_tax_code <> invoice_tax_code then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
    end if;
  end if;
  return jsonb_build_object('status','MATCH','method','VERIFIED_ALIAS');
end $$;

-- Seed the user-confirmed first supplier using its legal name and tax code from invoice 00008628.
do $$
declare
  seeded_vendor_id uuid;
  current_tax_code text;
  candidate text;
  owner_id uuid;
begin
  select v.id,v.tax_code_key into seeded_vendor_id,current_tax_code
    from public.vendor_directory v
    where v.normalized_name=public.normalize_party_name('CÔNG TY TNHH ĐIỆN TỬ BẢO ANH');
  if seeded_vendor_id is null then
    if exists(select 1 from public.vendor_directory v where v.tax_code_key=public.normalize_vendor_tax_code('0312500505')) then
      raise exception 'MST 0312500505 đã được gán cho nhà cung cấp khác; cần đối chiếu danh mục trước khi thêm.';
    end if;
    insert into public.vendor_directory(legal_name,tax_code)
      values('CÔNG TY TNHH ĐIỆN TỬ BẢO ANH','0312500505') returning id into seeded_vendor_id;
  elsif current_tax_code is not null and current_tax_code<>public.normalize_vendor_tax_code('0312500505') then
    raise exception 'Tên CÔNG TY TNHH ĐIỆN TỬ BẢO ANH đang có MST khác; cần đối chiếu danh mục trước khi thêm bí danh.';
  else
    update public.vendor_directory set tax_code='0312500505',updated_at=now()
      where id=seeded_vendor_id and tax_code_key is null;
  end if;

  foreach candidate in array array['CÔNG TY TNHH ĐIỆN TỬ BẢO ANH','BAO ANH ELECTRONICS'] loop
    select a.vendor_id into owner_id from public.vendor_aliases a
      where a.normalized_name=public.normalize_party_name(candidate);
    if owner_id is not null and owner_id<>seeded_vendor_id then
      raise exception 'Tên/bí danh "%" đã thuộc về nhà cung cấp khác.',candidate;
    end if;
    insert into public.vendor_aliases(vendor_id,alias_name,verification_note)
      values(seeded_vendor_id,candidate,'Người dùng xác nhận cùng nhà cung cấp ngày 2026-10-04; MST đối chiếu từ hóa đơn 00008628.')
      on conflict (normalized_name) do nothing;
  end loop;
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
  extracted jsonb := p_analysis->'fields';
  vendor_match jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ thủ quỹ.';
  end if;

  vendor_match := public.resolve_vendor_name_match(r.payload->>'vendor',extracted->'vendor'->>'value',
    case when coalesce(nullif(extracted->'taxCode'->>'confidence','')::numeric,0)>=0.85
      then extracted->'taxCode'->>'value' else null end);
  fields_match := coalesce(vendor_match->>'status'='MATCH',false)
    and public.normalize_party_name(extracted->'buyerName'->>'value')
      = public.normalize_party_name(r.payload->>'buyerCompany')
    and public.normalize_invoice_number(extracted->'invoiceNumber'->>'value')
      = public.normalize_invoice_number(r.payload->>'invoiceNumber')
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) = r.amount;

  totals_consistent := coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0)
    + coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0)
    = coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0);

  facts_clear := fields_match and totals_consistent
    and coalesce(length(trim(extracted->'buyerName'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'value')),0) > 0
    and coalesce(nullif(extracted->'amountBeforeTax'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'totalAmount'->>'value','')::bigint,0) > 0
    and coalesce(nullif(extracted->'vatAmount'->>'value','')::bigint,0) >= 0
    and coalesce(nullif(extracted->'buyerName'->>'confidence','')::numeric,0) >= 0.80
    and coalesce(nullif(extracted->'vendor'->>'confidence','')::numeric,0) >= 0.80
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(length(trim(extracted->'buyerName'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'amountBeforeTax'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vatAmount'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'totalAmount'->>'evidence')),0) > 0;

  target := case when not facts_clear then 'TREASURER_REVIEW'
    when r.amount>20000000 then 'CFO_REVIEW' else 'READY_FOR_APPROVAL' end;
  why := case
    when not facts_clear then left(coalesce(nullif(p_analysis->'assessment'->>'reason',''), 'AI phát hiện dữ kiện chưa chắc hoặc chưa khớp; chuyển quản lý tài chính kiểm tra trước.'),2000)
    when r.amount>20000000 then 'AI hoàn tất các kiểm tra hóa đơn; hồ sơ vượt thẩm quyền 20 triệu/hóa đơn nên được đưa vào hàng chờ Giám đốc Tài chính duyệt.'
    else 'AI hoàn tất các kiểm tra hóa đơn; hồ sơ đủ điều kiện chờ quản lý tài chính duyệt. Hạn mức 100 triệu/ngày được kiểm tra khi duyệt.'
  end;
  update public.requests set status=target,reason=why,
    escalated_at=case when target='CFO_REVIEW' then coalesce(escalated_at,now()) else escalated_at end,
    checks=jsonb_build_object('invoice_fields_match',fields_match,'invoice_totals_consistent',totals_consistent,
      'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

revoke all on function public.vendor_directory_list(),public.save_vendor(uuid,text,text,text[]),public.resolve_vendor_name_match(text,text,text) from public,anon;
revoke execute on function public.vendor_directory_list(),public.save_vendor(uuid,text,text,text[]),public.resolve_vendor_name_match(text,text,text) from authenticated;
grant execute on function public.vendor_directory_list() to authenticated,service_role;
grant execute on function public.save_vendor(uuid,text,text,text[]) to authenticated,service_role;
grant execute on function public.resolve_vendor_name_match(text,text,text),public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;

commit;
