-- Apply the agreed sales-invoice buyer exemption and let an exact verified
-- supplier alias independently establish supplier identity when OCR is weak.
begin;

-- A verified tax code can stand on its own when the seller-name OCR is weak.
-- A confident conflicting seller name or a conflicting registered tax code
-- remains a hard mismatch.
create or replace function public.resolve_vendor_name_match_with_confidence(
  p_form_name text,p_invoice_name text,p_invoice_tax_code text,p_invoice_name_confidence numeric
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  form_name text := public.normalize_party_name(p_form_name);
  invoice_name text := public.normalize_party_name(p_invoice_name);
  invoice_tax_code text := public.normalize_vendor_tax_code(p_invoice_tax_code);
  form_vendor_id uuid;
  invoice_vendor_id uuid;
  tax_vendor_id uuid;
  registered_tax_code text;
  invoice_name_is_clear boolean := coalesce(p_invoice_name_confidence,0)>=0.80;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Chỉ AI backend được phân giải tên nhà cung cấp.';
  end if;
  if form_name = '' then return jsonb_build_object('status','NO_MATCH'); end if;

  select a.vendor_id into form_vendor_id from public.vendor_aliases a where a.normalized_name=form_name;
  if invoice_name <> '' then
    select a.vendor_id into invoice_vendor_id from public.vendor_aliases a where a.normalized_name=invoice_name;
  end if;
  if invoice_tax_code is not null then
    select v.id into tax_vendor_id from public.vendor_directory v where v.tax_code_key=invoice_tax_code;
  end if;

  if tax_vendor_id is not null then
    if form_vendor_id is distinct from tax_vendor_id then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
    end if;
    if invoice_vendor_id is not null and invoice_vendor_id is distinct from tax_vendor_id
      and invoice_name_is_clear then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_CONFLICT');
    end if;
    if invoice_name <> '' and invoice_vendor_id is null and invoice_name <> form_name and invoice_name_is_clear then
      return jsonb_build_object('status','MISMATCH','method','TAX_CODE_NAME_UNVERIFIED');
    end if;
    if invoice_vendor_id = tax_vendor_id then
      return jsonb_build_object('status','MATCH','method','VERIFIED_ALIAS');
    end if;
    return jsonb_build_object('status','MATCH','method','VERIFIED_TAX_CODE');
  end if;

  if invoice_name = '' then return jsonb_build_object('status','NO_MATCH'); end if;
  if form_name = invoice_name then
    if form_vendor_id is not null then
      select v.tax_code_key into registered_tax_code from public.vendor_directory v where v.id=form_vendor_id;
      if registered_tax_code is not null and invoice_tax_code is not null and registered_tax_code <> invoice_tax_code then
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

revoke execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.resolve_vendor_name_match_with_confidence(text,text,text,numeric) to service_role;

create or replace function public.record_invoice_analysis(p_id uuid,p_expected_version integer,p_analysis jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  facts_clear boolean;
  fields_match boolean;
  totals_consistent boolean;
  buyer_name_not_required boolean;
  vendor_name_clear boolean;
  vendor_tax_code_clear boolean;
  vendor_alias_clear boolean;
  vendor_identity_clear boolean;
  target text;
  why text;
  extracted jsonb := p_analysis->'fields';
  invoice_kind text := upper(trim(coalesce(p_analysis->'fields'->'invoiceKind'->>'value','UNKNOWN')));
  buyer_name text := coalesce(p_analysis->'fields'->'buyerName'->>'value','');
  amount_before_tax bigint := coalesce(nullif(p_analysis->'fields'->'amountBeforeTax'->>'value','')::bigint,0);
  vat_amount bigint := coalesce(nullif(p_analysis->'fields'->'vatAmount'->>'value','')::bigint,0);
  discount_amount bigint := abs(coalesce(nullif(p_analysis->'fields'->'discountAmount'->>'value','')::bigint,0));
  total_amount bigint := coalesce(nullif(p_analysis->'fields'->'totalAmount'->>'value','')::bigint,0);
  vendor_confidence numeric := coalesce(nullif(p_analysis->'fields'->'vendor'->>'confidence','')::numeric,0);
  tax_code_confidence numeric := coalesce(nullif(p_analysis->'fields'->'taxCode'->>'confidence','')::numeric,0);
  discount_confidence numeric := coalesce(nullif(p_analysis->'fields'->'discountAmount'->>'confidence','')::numeric,0);
  amount_before_tax_evidence text := coalesce(p_analysis->'fields'->'amountBeforeTax'->>'evidence','');
  discount_evidence text := coalesce(p_analysis->'fields'->'discountAmount'->>'evidence','');
  tax_code_evidence text := coalesce(p_analysis->'fields'->'taxCode'->>'evidence','');
  vendor_evidence text := coalesce(p_analysis->'fields'->'vendor'->>'evidence','');
  discount_is_pre_tax boolean;
  vendor_match jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Chỉ AI backend được gọi thao tác này.'; end if;
  select * into r from public.requests where id=p_id for update;
  if not found or r.version <> p_expected_version or r.status <> 'TREASURER_REVIEW' then
    raise exception 'Hồ sơ đã thay đổi hoặc không còn chờ thủ quỹ.';
  end if;

  -- The agreed product policy exempts every SALES invoice from buyer-name OCR.
  -- Other invoice kinds retain the evidence-backed 85% exemption rule.
  buyer_name_not_required := invoice_kind='SALES' or (
    length(trim(buyer_name))=0
    and upper(trim(coalesce(extracted->'buyerRequirement'->>'value','UNKNOWN')))='NOT_REQUIRED'
    and coalesce(nullif(extracted->'buyerRequirement'->>'confidence','')::numeric,0)>=0.85
    and length(trim(coalesce(extracted->'buyerRequirement'->>'evidence','')))>0
  );

  vendor_name_clear := length(trim(coalesce(extracted->'vendor'->>'value','')))>0
    and vendor_confidence>=0.80 and length(trim(vendor_evidence))>0;
  vendor_match := public.resolve_vendor_name_match_with_confidence(r.payload->>'vendor',
    case when length(trim(coalesce(extracted->'vendor'->>'value','')))>0 and length(trim(vendor_evidence))>0
      then extracted->'vendor'->>'value' else null end,
    case when tax_code_confidence>=0.80 and length(trim(tax_code_evidence))>0
      then extracted->'taxCode'->>'value' else null end,
    vendor_confidence);
  vendor_tax_code_clear := coalesce(vendor_match->>'method'='VERIFIED_TAX_CODE',false)
    and tax_code_confidence>=0.80
    and length(trim(coalesce(extracted->'taxCode'->>'value','')))>0
    and length(trim(tax_code_evidence))>0;
  vendor_alias_clear := coalesce(vendor_match->>'status'='MATCH',false)
    and vendor_match->>'method'='VERIFIED_ALIAS'
    and length(trim(coalesce(extracted->'vendor'->>'value','')))>0
    and length(trim(vendor_evidence))>0;
  vendor_identity_clear := coalesce(vendor_match->>'status'='MATCH',false)
    and (vendor_name_clear or vendor_tax_code_clear or vendor_alias_clear);

  fields_match := vendor_identity_clear
    and (buyer_name_not_required or public.normalize_party_name(buyer_name)
      = public.normalize_party_name(r.payload->>'buyerCompany'))
    and public.normalize_invoice_number(extracted->'invoiceNumber'->>'value')
      = public.normalize_invoice_number(r.payload->>'invoiceNumber')
    and total_amount = r.amount;

  discount_is_pre_tax := invoice_kind='VAT'
    and discount_amount>0 and discount_confidence>=0.90
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
    and coalesce(nullif(extracted->'invoiceKind'->>'confidence','')::numeric,0)>=0.90
    and coalesce(length(trim(extracted->'invoiceKind'->>'evidence')),0)>0
    and (buyer_name_not_required or (
      length(trim(buyer_name))>0
      and coalesce(nullif(extracted->'buyerName'->>'confidence','')::numeric,0)>=0.80
      and coalesce(length(trim(extracted->'buyerName'->>'evidence')),0)>0
    ))
    and (vendor_name_clear or vendor_tax_code_clear or vendor_alias_clear)
    and coalesce(length(trim(extracted->'invoiceNumber'->>'value')),0)>0
    and total_amount>0
    and coalesce(nullif(extracted->'invoiceNumber'->>'confidence','')::numeric,0)>=0.90
    and coalesce(nullif(extracted->'totalAmount'->>'confidence','')::numeric,0)>=0.90
    and coalesce(length(trim(extracted->'invoiceNumber'->>'evidence')),0)>0
    and coalesce(length(trim(extracted->'totalAmount'->>'evidence')),0)>0
    and (invoice_kind='SALES' or (
      amount_before_tax>0 and vat_amount>=0
      and coalesce(nullif(extracted->'amountBeforeTax'->>'confidence','')::numeric,0)>=0.90
      and coalesce(nullif(extracted->'vatAmount'->>'confidence','')::numeric,0)>=0.90
      and coalesce(length(trim(amount_before_tax_evidence)),0)>0
      and coalesce(length(trim(extracted->'vatAmount'->>'evidence')),0)>0
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
      'invoice_kind',invoice_kind,'buyer_name_requirement',case when buyer_name_not_required then 'NOT_REQUIRED' else 'REQUIRED' end,
      'vendor_identity_method',coalesce(vendor_match->>'method','UNVERIFIED'),
      'budget_checked',false,'policy_checked',false,'ai',p_analysis),
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;

revoke execute on function public.record_invoice_analysis(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_invoice_analysis(uuid,integer,jsonb) to service_role;

commit;
