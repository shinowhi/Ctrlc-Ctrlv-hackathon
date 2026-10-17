-- Exact decimal invoice amounts, original currency, and no unconverted FX approvals.
BEGIN;
alter table public.requests alter column amount type numeric(18,2) using amount::numeric;
alter table public.requests drop constraint if exists requests_amount_valid_for_status;
alter table public.requests add constraint requests_amount_valid_for_status check (
 (status='NEEDS_INFO' and amount is null) or (amount is not null and amount>0 and amount<=999999999999.99)
);
create or replace function public.submit_private_request(p_id uuid,p_owner uuid,p_expected_version integer,p_path text,p_summary jsonb)
returns public.requests language plpgsql security definer set search_path='' as $$
declare
  r public.requests; existed boolean; f jsonb:='{}'::jsonb; matches jsonb:='{}'::jsonb;
  missing jsonb:='[]'::jsonb; k text; v text; n numeric; c numeric; amt numeric; currency_code text; detected_currency text;
  next_status text; safe_summary jsonb; date_value text;
begin
  currency_code:=coalesce(p_summary->>'currency','VND');
  detected_currency:=coalesce(p_summary->>'detectedCurrency','');
  if currency_code not in ('VND','USD','CNY','EUR') or detected_currency not in ('','VND','USD','CNY','EUR') then raise exception 'Invalid currency'; end if;
  if not exists(select 1 from public.profiles where id=p_owner and role='applicant') then raise exception 'Invalid applicant'; end if;
  if jsonb_typeof(p_summary) is distinct from 'object' or p_expected_version is null or p_expected_version<0 then raise exception 'Invalid summary'; end if;
  if p_path !~ ('^'||p_owner::text||'/[0-9a-f-]{36}/invoice\.pdf$')
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_path) then raise exception 'Redacted evidence required'; end if;
  foreach k in array array['amountBeforeTax','vatAmount','discountAmount','totalAmount','amountDue'] loop
    if jsonb_typeof(p_summary->'fields'->k->'value') is distinct from 'number'
      or jsonb_typeof(p_summary->'fields'->k->'confidence') is distinct from 'number' then raise exception 'Invalid financial field'; end if;
    n:=(p_summary->'fields'->k->>'value')::numeric; c:=(p_summary->'fields'->k->>'confidence')::numeric;
    if n<0 or n>999999999999.99 or trunc(n*100)<>n*100 or c<0 or c>1 then raise exception 'Invalid financial value'; end if;
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
    if n<=0 or n>999999999999.99 or trunc(n*100)<>n*100 then raise exception 'Invalid amount'; end if;
    if currency_code='VND' and trunc(n)<>n then raise exception 'VND requires an integer'; end if;
    amt:=n;
  end if;
  if amt is null and not (missing ? 'amount') then missing:=missing||'"amount"'::jsonb; end if;
  safe_summary:=jsonb_build_object('fields',f,'matching',matches,'currency',currency_code,'detectedCurrency',detected_currency,
    'totalsConsistent',case when jsonb_typeof(p_summary->'totalsConsistent')='boolean' then p_summary->'totalsConsistent' else 'null'::jsonb end,
    'duplicateCheck','MANUAL_REQUIRED','vendorDirectoryCheck','MANUAL_REQUIRED');
  next_status:=case when jsonb_array_length(missing)>0 then 'NEEDS_INFO' else 'TREASURER_REVIEW' end;
  select * into r from public.requests where id=p_id for update;
  existed:=found;
  if existed and (r.owner_id<>p_owner or r.status<>'NEEDS_INFO' or r.version<>p_expected_version) then raise exception 'Request changed'; end if;
  if not existed and p_expected_version<>0 then raise exception 'Request changed'; end if;
  if existed then
    update public.requests set
      payload=jsonb_build_object('amount',amt,'invoiceDate',date_value,'currency',currency_code), amount=amt,
      invoice_path=p_path,request_path=null,status=next_status,
      checks=jsonb_build_object('privacy_version',1,'form_missing_fields',missing,'ai',safe_summary,'duplicate_check','MANUAL_REQUIRED','redaction_reviewed',true),
      reason='Bản đã che được người nộp xác nhận. Quản lý cần đối chiếu và kiểm tra trùng thủ công.',
      escalated_at=null,approved_at=null,version=version+1,updated_at=now() where id=p_id returning * into r;
  else
    insert into public.requests(id,owner_id,payload,amount,invoice_path,status,checks,reason)
    values(p_id,p_owner,jsonb_build_object('amount',amt,'invoiceDate',date_value,'currency',currency_code),amt,p_path,next_status,
      jsonb_build_object('privacy_version',1,'form_missing_fields',missing,'ai',safe_summary,'duplicate_check','MANUAL_REQUIRED','redaction_reviewed',true),
      'Bản đã che được người nộp xác nhận. Quản lý cần đối chiếu và kiểm tra trùng thủ công.') returning * into r;
  end if;
  return r;
end $$;

create or replace function public.guard_invoice_currency_approval()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='APPROVED' and coalesce(new.payload->>'currency','VND')<>'VND' then
    raise exception 'Ngoại tệ cần tỷ giá quy đổi được xác nhận trước khi duyệt theo hạn mức VNĐ.';
  end if;
  return new;
end $$;
create trigger invoice_currency_approval_guard before insert or update on public.requests
for each row execute function public.guard_invoice_currency_approval();
COMMIT;
NOTIFY pgrst, 'reload schema';
