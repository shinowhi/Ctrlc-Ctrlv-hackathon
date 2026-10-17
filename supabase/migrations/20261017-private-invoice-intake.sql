-- Forward-only. Does not delete/rewrite existing cloud data.
-- Deploy this migration and both new API handlers together.
begin;

-- Block storage-first clients, including stale copies of the frontend.
drop policy if exists evidence_upload on storage.objects;
create policy evidence_no_client_upload on storage.objects as restrictive
  for insert to authenticated with check (bucket_id <> 'evidence');
create policy evidence_no_client_update on storage.objects as restrictive
  for update to authenticated using (bucket_id <> 'evidence') with check (bucket_id <> 'evidence');
update storage.buckets set public=false where id='evidence';
revoke execute on function public.submit_request(uuid,jsonb,text,text,integer) from public,anon,authenticated,service_role;
revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated,service_role;
-- Do not create new identity-bearing supplier records/aliases through this MVP.
revoke execute on function public.save_vendor(uuid,text,text,text[]) from public,anon,authenticated,service_role;

create function public.private_intake_ready() returns integer
language sql stable security definer set search_path='' as $$ select 1 $$;
revoke all on function public.private_intake_ready() from public,anon,authenticated;
grant execute on function public.private_intake_ready() to service_role;

create function public.submit_private_request(p_id uuid,p_owner uuid,p_expected_version integer,p_path text,p_summary jsonb)
returns public.requests language plpgsql security definer set search_path='' as $$
declare
  r public.requests; existed boolean; f jsonb:='{}'::jsonb; matches jsonb:='{}'::jsonb;
  missing jsonb:='[]'::jsonb; k text; v text; n numeric; c numeric; amt bigint;
  next_status text; safe_summary jsonb; date_value text;
begin
  if not exists(select 1 from public.profiles where id=p_owner and role='applicant') then raise exception 'Invalid applicant'; end if;
  if jsonb_typeof(p_summary) is distinct from 'object' or p_expected_version is null or p_expected_version<0 then raise exception 'Invalid summary'; end if;
  if p_path !~ ('^'||p_owner::text||'/[0-9a-f-]{36}/invoice\.pdf$')
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_path) then raise exception 'Redacted evidence required'; end if;
  foreach k in array array['amountBeforeTax','vatAmount','discountAmount','totalAmount','amountDue'] loop
    if jsonb_typeof(p_summary->'fields'->k->'value') is distinct from 'number'
      or jsonb_typeof(p_summary->'fields'->k->'confidence') is distinct from 'number' then raise exception 'Invalid financial field'; end if;
    n:=(p_summary->'fields'->k->>'value')::numeric; c:=(p_summary->'fields'->k->>'confidence')::numeric;
    if n<0 or n>999999999999 or trunc(n)<>n or c<0 or c>1 then raise exception 'Invalid financial value'; end if;
    f:=f||jsonb_build_object(k,jsonb_build_object('value',n,'confidence',c));
  end loop;
  date_value:=coalesce(p_summary->'fields'->'invoiceDate'->>'value','');
  if date_value<>'' then
    if date_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(date_value::date,'YYYY-MM-DD')<>date_value then raise exception 'Invalid date'; end if;
  end if;
  v:=p_summary->'fields'->'invoiceKind'->>'value';
  if v is null or v not in ('SALES','VAT','UNKNOWN') then raise exception 'Invalid invoice kind'; end if;
  f:=f||jsonb_build_object('invoiceDate',jsonb_build_object('value',date_value),'invoiceKind',jsonb_build_object('value',v));
  foreach k in array array['buyer','vendor','invoiceNumber','total'] loop
    v:=p_summary->'matching'->>k;
    if v is null or v not in ('MATCH','MISMATCH','UNKNOWN') then raise exception 'Invalid comparison'; end if;
    matches:=matches||jsonb_build_object(k,v);
  end loop;
  if jsonb_typeof(p_summary->'missing') is distinct from 'array' or jsonb_array_length(p_summary->'missing')>12 then raise exception 'Invalid missing fields'; end if;
  for v in select jsonb_array_elements_text(p_summary->'missing') loop
    if v not in ('requesterType','requester','department','buyerMode','buyerCompany','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount') then raise exception 'Invalid missing field'; end if;
    missing:=missing||jsonb_build_array(v);
  end loop;
  if p_summary->'amount'<>'null'::jsonb then
    if jsonb_typeof(p_summary->'amount') is distinct from 'number' then raise exception 'Invalid amount'; end if;
    n:=(p_summary->>'amount')::numeric;
    if n<1 or n>999999999999 or trunc(n)<>n then raise exception 'Invalid amount'; end if;
    amt:=n::bigint;
  end if;
  if amt is null and not (missing ? 'amount') then missing:=missing||'"amount"'::jsonb; end if;
  safe_summary:=jsonb_build_object('fields',f,'matching',matches,'currency','VND',
    'totalsConsistent',case when jsonb_typeof(p_summary->'totalsConsistent')='boolean' then p_summary->'totalsConsistent' else 'null'::jsonb end,
    'duplicateCheck','MANUAL_REQUIRED','vendorDirectoryCheck','MANUAL_REQUIRED');
  next_status:=case when jsonb_array_length(missing)>0 then 'NEEDS_INFO' else 'TREASURER_REVIEW' end;
  select * into r from public.requests where id=p_id for update;
  existed:=found;
  if existed and (r.owner_id<>p_owner or r.status<>'NEEDS_INFO' or r.version<>p_expected_version) then raise exception 'Request changed'; end if;
  if not existed and p_expected_version<>0 then raise exception 'Request changed'; end if;
  if existed then
    update public.requests set
      payload=jsonb_build_object('amount',amt,'invoiceDate',date_value), amount=amt,
      invoice_path=p_path,request_path=null,status=next_status,
      checks=jsonb_build_object('privacy_version',1,'form_missing_fields',missing,'ai',safe_summary,'duplicate_check','MANUAL_REQUIRED','redaction_reviewed',true),
      reason='Bản đã che được người nộp xác nhận. Quản lý cần đối chiếu và kiểm tra trùng thủ công.',
      escalated_at=null,approved_at=null,version=version+1,updated_at=now() where id=p_id returning * into r;
  else
    insert into public.requests(id,owner_id,payload,amount,invoice_path,status,checks,reason)
    values(p_id,p_owner,jsonb_build_object('amount',amt,'invoiceDate',date_value),amt,p_path,next_status,
      jsonb_build_object('privacy_version',1,'form_missing_fields',missing,'ai',safe_summary,'duplicate_check','MANUAL_REQUIRED','redaction_reviewed',true),
      'Bản đã che được người nộp xác nhận. Quản lý cần đối chiếu và kiểm tra trùng thủ công.') returning * into r;
  end if;
  return r;
end $$;
revoke all on function public.submit_private_request(uuid,uuid,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.submit_private_request(uuid,uuid,integer,text,jsonb) to service_role;

-- Keep historical requests on their existing rules. Private requests use a
-- separate branch that never receives/stores identifiers or free-text notes.
alter function public.review_request(uuid,integer,text,text,jsonb) rename to review_request_before_privacy;
revoke all on function public.review_request_before_privacy(uuid,integer,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.review_request(p_id uuid,p_expected_version integer,p_action text,p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path='' as $$
declare
  r public.requests; who text:=public.my_role(); target text; why text;
  approval_at timestamptz; approval_day date; approved_today numeric;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version<>p_expected_version then raise exception 'Hồ sơ đã thay đổi. Hãy tải lại.'; end if;
  if r.checks->>'privacy_version' is distinct from '1' then return public.review_request_before_privacy(p_id,p_expected_version,p_action,p_reason,p_checks); end if;
  if auth.uid() is null or not ((who='treasurer' and r.status='TREASURER_REVIEW') or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if p_reason is null or p_reason not in ('VERIFIED','NEEDS_REVIEW','MISMATCH','DUPLICATE','INSUFFICIENT') then raise exception 'Chọn lý do có sẵn; không nhập dữ liệu cá nhân.'; end if;
  if p_action='approve' then
    if p_reason<>'VERIFIED' or not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true,"duplicate_checked":true}'::jsonb,false) then
      raise exception 'Cần xác nhận đã đối chiếu chứng từ, tổng tiền và kiểm tra trùng thủ công. Không suy ra từ bản đã che.';
    end if;
    loop
      approval_at:=clock_timestamp(); approval_day:=(approval_at at time zone 'Asia/Bangkok')::date;
      perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:'||approval_day::text,0));
      approval_at:=clock_timestamp(); exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
    end loop;
    select coalesce(sum(amount),0) into approved_today from public.requests where status='APPROVED'
      and approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
      and approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
    target:=case when who='treasurer' and (r.amount>20000000 or approved_today+r.amount>100000000) then 'CFO_REVIEW' else 'APPROVED' end;
    why:=case when target='CFO_REVIEW' then 'Đã đối chiếu và kiểm tra trùng thủ công; chuyển Giám đốc do vượt hạn mức.' else 'Người có thẩm quyền đã đối chiếu, kiểm tra trùng thủ công và duyệt.' end;
  else
    target:=case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why:=case p_reason when 'DUPLICATE' then 'Người phụ trách xác định hồ sơ trùng.' when 'MISMATCH' then 'Dữ kiện chưa khớp khi đối chiếu.' when 'INSUFFICIENT' then 'Chưa đủ căn cứ để duyệt.' else 'Cần người nộp kiểm tra và bổ sung hồ sơ.' end;
  end if;
  update public.requests set status=target,reason=why,
    checks=checks||jsonb_build_object('manual_review_code',p_reason,'manager_verified',p_action='approve',
      'duplicate_check',case when p_action='approve' then 'MANUALLY_CHECKED' else 'MANUAL_REQUIRED' end),
    approved_at=case when target='APPROVED' then approval_at else approved_at end,
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;
revoke all on function public.review_request(uuid,integer,text,text,jsonb) from public,anon;
grant execute on function public.review_request(uuid,integer,text,text,jsonb) to authenticated;

alter function public.review_requests_batch(jsonb,text) rename to review_requests_batch_before_privacy;
revoke all on function public.review_requests_batch_before_privacy(jsonb,text) from public,anon,authenticated,service_role;
create function public.review_requests_batch(p_requests jsonb,p_reason text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if jsonb_typeof(p_requests) is distinct from 'array' then raise exception 'Danh sách không hợp lệ.'; end if;
  -- Lock in stable order before checking to prevent concurrent resubmission from
  -- replacing a historical row with a private row between check and approval.
  perform 1 from public.requests r where r.id in (select (x->>'id')::uuid from jsonb_array_elements(p_requests) x) order by r.id for update;
  if exists(select 1 from public.requests r where r.checks->>'privacy_version'='1'
    and r.id in (select (x->>'id')::uuid from jsonb_array_elements(p_requests) x)) then
    raise exception 'Hồ sơ bảo mật cần duyệt riêng sau khi kiểm tra trùng thủ công.';
  end if;
  return public.review_requests_batch_before_privacy(p_requests,p_reason);
end $$;
revoke all on function public.review_requests_batch(jsonb,text) from public,anon;
grant execute on function public.review_requests_batch(jsonb,text) to authenticated;
commit;
notify pgrst,'reload schema';
