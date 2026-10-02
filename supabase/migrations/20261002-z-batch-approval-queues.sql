-- Live approval queues and atomic approve-all actions.
begin;

-- A clear invoice above the manager's per-invoice authority goes straight to the CFO queue.
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

-- Move already analyzed, high-value invoices into the CFO queue as well.
update public.requests set status='CFO_REVIEW',escalated_at=coalesce(escalated_at,now()),
  reason='Hồ sơ đã qua kiểm tra AI; số tiền vượt thẩm quyền 20 triệu/hóa đơn nên chờ Giám đốc Tài chính duyệt.',
  version=version+1,updated_at=now()
where status='READY_FOR_APPROVAL' and amount>20000000;

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

create or replace function public.review_requests_batch(p_requests jsonb,p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who text := public.my_role();
  item_count integer;
  distinct_count integer;
  invalid_count integer;
  locked_count integer;
  requested_total numeric;
  approved_today numeric;
  projected_total numeric;
  target text;
  approval_at timestamptz;
  approval_day date;
  batch_reason text;
  duplicate_invoice boolean;
begin
  if auth.uid() is null or coalesce(who,'') not in ('treasurer','cfo') then
    raise exception 'Chỉ quản lý tài chính hoặc Giám đốc Tài chính được duyệt theo đợt.';
  end if;
  if jsonb_typeof(p_requests) is distinct from 'array' or jsonb_array_length(p_requests)=0 then
    raise exception 'Danh sách duyệt phải có ít nhất một hóa đơn.';
  end if;
  if coalesce(length(p_reason),0)>2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if who='cfo' and coalesce(length(trim(p_reason)),0)=0 then
    raise exception 'Giám đốc cần ghi lý do cấp quyền trước khi duyệt.';
  end if;
  select count(*),count(distinct x.id),count(*) filter(where x.id is null or x.version is null)
    into item_count,distinct_count,invalid_count
    from jsonb_to_recordset(p_requests) as x(id uuid,version integer);
  if item_count=0 or item_count<>distinct_count or invalid_count>0 then
    raise exception 'Danh sách hóa đơn không hợp lệ hoặc có mã bị lặp.';
  end if;
  perform r.id from public.requests r
    join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
    order by r.id for update;
  get diagnostics locked_count = row_count;
  if locked_count<>item_count then raise exception 'Một hoặc nhiều hóa đơn không còn trong danh sách duyệt.'; end if;
  if exists(select 1 from public.requests r
      join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
      where r.version<>x.version) then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại danh sách trước khi duyệt.';
  end if;
  if who='treasurer' and exists(select 1 from public.requests r
      join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
      where r.status<>'READY_FOR_APPROVAL' or r.amount>20000000) then
    raise exception 'Quản lý chỉ được duyệt đợt gồm hóa đơn đã đủ điều kiện và không quá 20 triệu mỗi hóa đơn.';
  end if;
  if who='cfo' and exists(select 1 from public.requests r
      join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id
      where not (r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000))) then
    raise exception 'Đợt của Giám đốc chỉ nhận hồ sơ trong hàng chờ CFO hoặc hóa đơn đủ điều kiện trên 20 triệu.';
  end if;
  -- Acquire invoice locks in a stable order so duplicate detection is safe under concurrency.
  perform pg_advisory_xact_lock(hashtextextended(k.invoice_key,0))
    from (select distinct lower(regexp_replace(trim(coalesce(r.payload->>'vendor','')), '[[:space:]]+', ' ', 'g')) || '/' ||
      public.normalize_invoice_number(r.payload->>'invoiceNumber') as invoice_key
      from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id) k
    order by k.invoice_key;
  select exists(select 1 from public.requests chosen join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=chosen.id
    join public.requests approved on approved.id<>chosen.id and approved.status='APPROVED'
      and lower(regexp_replace(trim(coalesce(approved.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
        =lower(regexp_replace(trim(coalesce(chosen.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
      and public.normalize_invoice_number(approved.payload->>'invoiceNumber')
        =public.normalize_invoice_number(chosen.payload->>'invoiceNumber'))
    or exists(select 1 from public.requests a join jsonb_to_recordset(p_requests) as xa(id uuid,version integer) on xa.id=a.id
      join public.requests b on b.id>a.id
      join jsonb_to_recordset(p_requests) as xb(id uuid,version integer) on xb.id=b.id
      where lower(regexp_replace(trim(coalesce(a.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
          =lower(regexp_replace(trim(coalesce(b.payload->>'vendor','')), '[[:space:]]+', ' ', 'g'))
        and public.normalize_invoice_number(a.payload->>'invoiceNumber')
          =public.normalize_invoice_number(b.payload->>'invoiceNumber'))
    into duplicate_invoice;
  if duplicate_invoice then raise exception 'Đợt có hóa đơn trùng với hồ sơ đã duyệt hoặc trùng lẫn nhau.'; end if;
  loop
    approval_at:=clock_timestamp();
    approval_day:=(approval_at at time zone 'Asia/Bangkok')::date;
    perform pg_advisory_xact_lock(hashtextextended('finref-daily-approvals:'||approval_day::text,0));
    approval_at:=clock_timestamp();
    exit when approval_day=(approval_at at time zone 'Asia/Bangkok')::date;
  end loop;
  select coalesce(sum(r.amount),0) into requested_total
    from public.requests r join jsonb_to_recordset(p_requests) as x(id uuid,version integer) on x.id=r.id;
  select coalesce(sum(r.amount),0) into approved_today from public.requests r
    where r.status='APPROVED'
      and r.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
      and r.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
  projected_total:=approved_today+requested_total;
  target:=case when who='cfo' then 'APPROVED'
    when projected_total<=100000000 then 'APPROVED' else 'CFO_REVIEW' end;
  batch_reason:=case when who='cfo'
    then 'Giám đốc Tài chính duyệt đợt. Lý do: '||trim(p_reason)||case when projected_total>100000000 then ' Tổng đã duyệt sau đợt vượt hạn mức ngày 100 triệu theo ngoại lệ được ghi nhận.' else '' end
    when target='APPROVED'
    then 'Quản lý tài chính duyệt toàn bộ danh sách hóa đơn đủ điều kiện trong thẩm quyền và ngân sách ngày.'
    else 'Đợt duyệt của quản lý sẽ làm tổng ngày vượt 100 triệu; toàn bộ hóa đơn được chuyển Giám đốc Tài chính quyết định.' end;
  update public.requests r set status=target,reason=batch_reason,
    approved_at=case when target='APPROVED' then approval_at else r.approved_at end,
    escalated_at=case when target='CFO_REVIEW' then coalesce(r.escalated_at,approval_at) else r.escalated_at end,
    version=r.version+1,updated_at=approval_at
    where r.id in (select x.id from jsonb_to_recordset(p_requests) as x(id uuid,version integer));
  return jsonb_build_object('status',target,'invoice_count',item_count,'requested_total',requested_total,
    'approved_today_before',approved_today,'projected_total',projected_total,'daily_limit',100000000,
    'remaining',greatest(100000000-projected_total,0),'business_date',approval_day);
end $$;

create or replace function public.daily_approval_summary()
returns table(approved_total bigint,daily_limit bigint,warning_threshold bigint,remaining bigint,business_date date)
language plpgsql stable security definer set search_path = '' as $$
declare approval_day date := (now() at time zone 'Asia/Bangkok')::date; total bigint;
begin
  if auth.uid() is null or coalesce(public.my_role(),'') not in ('treasurer','cfo') then
    raise exception 'Chỉ quản lý tài chính hoặc Giám đốc Tài chính được xem tổng duyệt trong ngày.';
  end if;
  select coalesce(sum(r.amount),0)::bigint into total from public.requests r
  where r.status='APPROVED'
    and r.approved_at >= (approval_day::timestamp at time zone 'Asia/Bangkok')
    and r.approved_at < ((approval_day+1)::timestamp at time zone 'Asia/Bangkok');
  return query select total,100000000::bigint,80000000::bigint,
    greatest(100000000::bigint-total,0),approval_day;
end $$;

revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
revoke execute on function public.review_requests_batch(jsonb,text) from public,anon;
revoke execute on function public.daily_approval_summary() from public,anon;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;
grant execute on function public.review_requests_batch(jsonb,text) to authenticated;
grant execute on function public.daily_approval_summary() to authenticated;

commit;
notify pgrst,'reload schema';
