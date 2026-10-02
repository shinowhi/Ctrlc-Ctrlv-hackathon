-- Enforce per-request and per-day approval authority in one transaction.
begin;

alter table public.requests add column if not exists approved_at timestamptz;
update public.requests
set approved_at = updated_at
where status = 'APPROVED' and approved_at is null;
alter table public.requests drop constraint if exists requests_approval_timestamp_required;
alter table public.requests add constraint requests_approval_timestamp_required
  check (status <> 'APPROVED' or approved_at is not null);
create index if not exists requests_approved_at
  on public.requests(approved_at) where status = 'APPROVED';

-- Pending cases escalated under the former direct-to-CFO flow must now receive
-- Finance review first. The row trigger records this transition in the audit log.
update public.requests
set status='TREASURER_REVIEW',
    reason=left(concat_ws(' ',nullif(trim(reason),''),
      'Luồng hạn mức cập nhật: Quản lý Tài chính cần kiểm tra trước khi chuyển Giám đốc cấp quyền.'),2000),
    escalated_at=null,version=version+1,updated_at=now()
where status='CFO_REVIEW';

-- CFOs can inspect every request above the per-request authority limit, including
-- while Finance is still reviewing it. This does not grant an approval action.
create or replace function public.can_read_request(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.requests r
    where r.id = p_id and (
      r.owner_id = auth.uid()
      or public.my_role() = 'treasurer'
      or (public.my_role() = 'cfo' and (r.escalated_at is not null or r.amount > 20000000))
    )
  );
$$;

-- AI findings and flags go to Finance first. The AI never approves and the
-- request amount/daily total are decided after Finance has reviewed the case.
create or replace function public.record_invoice_analysis(
  p_id uuid, p_expected_version integer, p_analysis jsonb)
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
  if auth.role() is distinct from 'service_role' then
    raise exception 'Chỉ AI backend được gọi thao tác này.';
  end if;
  select * into r from public.requests where id = p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ quản lý tài chính.';
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
    version=version+1,updated_at=now()
  where id=p_id returning * into r;
  return r;
end $$;

create or replace function public.review_request(
  p_id uuid, p_expected_version integer, p_action text,
  p_reason text default '', p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  who text := public.my_role();
  target text;
  why text;
  duplicate_invoice boolean;
  approval_at timestamptz;
  approval_day date;
  approved_today numeric;
  projected_today numeric;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version <> p_expected_version then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.';
  end if;
  if auth.uid() is null or not (
    (who='treasurer' and r.status in ('TREASURER_REVIEW','READY_FOR_APPROVAL'))
    or (who='cfo' and r.status='CFO_REVIEW')
  ) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then
    raise exception 'Hành động không hợp lệ.';
  end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;

  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then
      raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.';
    end if;
    target := case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why := trim(p_reason);
  else
    -- Serialize same-invoice decisions and reject already-approved duplicates.
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

    -- A date-scoped transaction lock prevents concurrent approvals from both
    -- consuming the same remaining daily allowance. Recheck at midnight.
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
      if coalesce(length(trim(p_reason)),0)=0 then
        raise exception 'Giám đốc cần ghi lý do cấp quyền trước khi duyệt.';
      end if;
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
    version=version+1,updated_at=now()
  where id=p_id returning * into r;
  return r;
end $$;

create or replace function public.daily_approval_summary()
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

revoke execute on function public.can_read_request(uuid),public.record_invoice_analysis(uuid,integer,jsonb),
  public.daily_approval_summary() from public,anon,authenticated;
grant execute on function public.can_read_request(uuid) to authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
grant execute on function public.daily_approval_summary() to authenticated;

commit;
notify pgrst, 'reload schema';
