-- Adds the server-only RPC used to save AI invoice analysis.
-- Safe for an existing database created from schema.sql and upgraded with sprint1.sql.
-- This changes the database function surface only; it does not rewrite request rows.
begin;

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

revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;

commit;
notify pgrst, 'reload schema';
