-- Lower active invoice confidence thresholds and match numeric invoice IDs despite leading zeroes.
begin;

create or replace function public.normalize_invoice_number(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when normalized.value ~ '^[0-9]+$'
    then coalesce(nullif(regexp_replace(normalized.value, '^0+', ''), ''), '0')
    else normalized.value end
  from (select lower(regexp_replace(trim(coalesce(p_value,'')), '[[:space:]]+', ' ', 'g')) as value) normalized;
$$;

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
  if auth.role() is distinct from 'service_role' then
    raise exception 'Chỉ AI backend được gọi thao tác này.';
  end if;
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

create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,
  p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare r public.requests; who text := public.my_role(); target text; why text; duplicate_invoice boolean;
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
    -- Serialize final approvals for the same vendor/invoice pair and block already-approved duplicates.
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
    if who='treasurer' then
      if r.status='TREASURER_REVIEW' and not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true}'::jsonb,false) then
        raise exception 'U1: hãy xác nhận đã kiểm tra hóa đơn, trường form và tổng thanh toán gồm VAT; hoặc yêu cầu bổ sung.';
      end if;
      target := case when r.amount>20000000 then 'CFO_REVIEW' else 'APPROVED' end;
      why := case when r.amount>20000000 then 'U3: chuyển người đứng đầu nhánh tài chính vì tổng thanh toán gồm VAT vượt 20 triệu.' else 'Quản lý tài chính đã bấm duyệt trong hạn mức.' end;
    else
      target := 'APPROVED'; why := 'Người đứng đầu nhánh tài chính đã bấm duyệt cuối.';
    end if;
  end if;
  update public.requests set status=target,reason=why,
    checks=case when who='treasurer' and p_action='approve' and r.status='TREASURER_REVIEW' then p_checks else checks end,
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
revoke execute on function public.normalize_invoice_number(text) from public,anon,authenticated;

commit;
notify pgrst, 'reload schema';