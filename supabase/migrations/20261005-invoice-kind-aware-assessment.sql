-- Use invoice-specific amount checks while preserving the final payable total gate.
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
  extracted jsonb := p_analysis->'fields';
  invoice_kind text := upper(trim(coalesce(p_analysis->'fields'->'invoiceKind'->>'value','UNKNOWN')));
  amount_before_tax bigint := coalesce(nullif(p_analysis->'fields'->'amountBeforeTax'->>'value','')::bigint,0);
  vat_amount bigint := coalesce(nullif(p_analysis->'fields'->'vatAmount'->>'value','')::bigint,0);
  discount_amount bigint := abs(coalesce(nullif(p_analysis->'fields'->'discountAmount'->>'value','')::bigint,0));
  total_amount bigint := coalesce(nullif(p_analysis->'fields'->'totalAmount'->>'value','')::bigint,0);
  discount_confidence numeric := coalesce(nullif(p_analysis->'fields'->'discountAmount'->>'confidence','')::numeric,0);
  amount_before_tax_evidence text := coalesce(p_analysis->'fields'->'amountBeforeTax'->>'evidence','');
  discount_evidence text := coalesce(p_analysis->'fields'->'discountAmount'->>'evidence','');
  discount_is_pre_tax boolean;
  vendor_match jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ thủ quỹ.';
  end if;

  vendor_match := public.resolve_vendor_name_match(r.payload->>'vendor',extracted->'vendor'->>'value',
    case when coalesce(nullif(extracted->'taxCode'->>'confidence','')::numeric,0)>=0.80
      then extracted->'taxCode'->>'value' else null end);
  fields_match := coalesce(vendor_match->>'status'='MATCH',false)
    and public.normalize_party_name(extracted->'buyerName'->>'value')
      = public.normalize_party_name(r.payload->>'buyerCompany')
    and public.normalize_invoice_number(extracted->'invoiceNumber'->>'value')
      = public.normalize_invoice_number(r.payload->>'invoiceNumber')
    and total_amount = r.amount;

  discount_is_pre_tax := invoice_kind='VAT'
    and discount_amount>0
    and discount_confidence>=0.90
    and length(trim(discount_evidence))>0
    and amount_before_tax_evidence ~* '(before[[:space:]]+discount|trước[[:space:]]+chiết[[:space:]]+khấu)';

  totals_consistent := case
    when invoice_kind='SALES' then true
    when invoice_kind='VAT' then amount_before_tax + vat_amount
      - case when discount_is_pre_tax then discount_amount else 0 end = total_amount
    else false
  end;

  facts_clear := fields_match and totals_consistent
    and invoice_kind in ('SALES','VAT')
    and coalesce(nullif(extracted->'invoiceKind'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(length(trim(extracted->'invoiceKind'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'buyerName'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'value')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'value')),0) > 0
    and total_amount > 0
    and coalesce(nullif(extracted->'buyerName'->>'confidence','')::numeric,0) >= 0.80
    and coalesce(nullif(extracted->'vendor'->>'confidence','')::numeric,0) >= 0.80
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0) >= 0.90
    and coalesce(length(trim(extracted->'buyerName'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'vendor'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'invoiceNumber'->>'evidence')),0) > 0
    and coalesce(length(trim(extracted->'totalAmount'->>'evidence')),0) > 0
    and (invoice_kind='SALES' or (
      amount_before_tax > 0
      and vat_amount >= 0
      and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0) >= 0.90
      and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0) >= 0.90
      and coalesce(length(trim(amount_before_tax_evidence)),0) > 0
      and coalesce(length(trim(extracted->'vatAmount'->>'evidence')),0) > 0
    ));

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
      'invoice_kind',invoice_kind,'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

-- Keep the manager's manual-check message accurate for both invoice kinds.
create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,
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
    or (who='cfo' and (r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000))))
    then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target := case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why := trim(p_reason);
  else
    perform pg_advisory_xact_lock(hashtextextended(
      public.normalize_party_name(r.payload->>'vendor') || '/' ||
      public.normalize_invoice_number(r.payload->>'invoiceNumber'), 0));
    select exists(select 1 from public.requests x where x.id<>r.id and x.status='APPROVED'
      and public.normalize_party_name(x.payload->>'vendor')=public.normalize_party_name(r.payload->>'vendor')
      and public.normalize_invoice_number(x.payload->>'invoiceNumber')=public.normalize_invoice_number(r.payload->>'invoiceNumber'))
      into duplicate_invoice;
    if duplicate_invoice then
      raise exception 'Hóa đơn này đã có hồ sơ được duyệt cùng nhà cung cấp và số hóa đơn. Hãy yêu cầu làm rõ hoặc từ chối; không thể duyệt trùng.';
    end if;
    if who='treasurer' and r.status='TREASURER_REVIEW'
      and not coalesce(p_checks @> '{"invoice":true,"fields_match":true,"total_includes_vat":true}'::jsonb,false) then
      raise exception 'Hãy xác nhận đã kiểm tra hóa đơn, trường form và tổng thanh toán cuối cùng; hoặc yêu cầu bổ sung.';
    end if;
    loop
      approval_at := clock_timestamp();
      approval_day := (approval_at at time zone 'Asia/Bangkok')::date;
      perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:' || approval_day::text,0));
      approval_at := clock_timestamp();
      exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
    end loop;
    select coalesce(sum(x.amount),0) into approved_today from public.requests x
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
      elsif r.amount>20000000 then why := why || ' Hồ sơ vượt hạn mức 20 triệu.';
      elsif projected_today>100000000 then why := why || ' Tổng duyệt trong ngày vượt 100 triệu.';
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

revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;

commit;
