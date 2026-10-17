-- Store invoice currency as metadata; amounts and approval limits remain in VND.
BEGIN;
create or replace function public.submit_request(p_id uuid,p_payload jsonb,p_invoice_path text,
  p_request_path text,p_expected_version integer default 0)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  clean jsonb := '{}'::jsonb;
  field text;
  value_text text;
  missing_fields text[] := array[]::text[];
  amt bigint;
  was_existing boolean;
  next_status text;
begin
  if auth.uid() is null or public.my_role() is distinct from 'applicant' then
    raise exception 'Chỉ người nộp đơn được gửi hồ sơ.';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Thông tin form không hợp lệ.'; end if;
  value_text:=upper(coalesce(nullif(trim(p_payload->>'currency'),''),'VND'));
  if value_text not in ('VND','USD','CNY','EUR') then
    raise exception 'Đơn vị tiền tệ không hợp lệ. Chọn VND, USD, CNY hoặc EUR.';
  end if;
  clean:=clean||jsonb_build_object('currency',value_text);
  foreach field in array array['requesterType','requester','department','buyerMode','budgetCode','purpose','vendor','invoiceNumber','invoiceDate'] loop
    value_text:=trim(coalesce(p_payload->>field,''));
    if length(value_text)>1000 then raise exception 'Trường % tối đa 1000 ký tự.',field; end if;
    clean:=clean||jsonb_build_object(field,value_text);
    if value_text='' then missing_fields:=array_append(missing_fields,field); end if;
  end loop;
  if clean->>'requesterType' not in ('employee','department') then
    if not ('requesterType'=any(missing_fields)) then missing_fields:=array_append(missing_fields,'requesterType'); end if;
  end if;
  if clean->>'buyerMode' not in ('PERSON','ORGANIZATION','NO_NAME') then
    if not ('buyerMode'=any(missing_fields)) then missing_fields:=array_append(missing_fields,'buyerMode'); end if;
  end if;
  value_text:=trim(coalesce(p_payload->>'buyerCompany',''));
  if length(value_text)>1000 then raise exception 'Tên người mua tối đa 1000 ký tự.'; end if;
  if clean->>'buyerMode' in ('PERSON','ORGANIZATION') and value_text='' then
    missing_fields:=array_append(missing_fields,'buyerCompany');
  end if;
  clean:=clean||jsonb_build_object('buyerCompany',case when clean->>'buyerMode'='NO_NAME' then '' else value_text end);
  if clean->>'invoiceDate'<>'' then
    if (clean->>'invoiceDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      missing_fields:=array_append(missing_fields,'invoiceDate');
    else
      begin
        if to_char((clean->>'invoiceDate')::date,'YYYY-MM-DD')<>(clean->>'invoiceDate') then
          missing_fields:=array_append(missing_fields,'invoiceDate');
        end if;
      exception when invalid_datetime_format or datetime_field_overflow then
        missing_fields:=array_append(missing_fields,'invoiceDate');
      end;
    end if;
  end if;
  if coalesce(p_payload->>'amount','') ~ '^[0-9]{1,12}$' then
    amt:=(p_payload->>'amount')::bigint;
    if amt<1 then amt:=null; end if;
  else amt:=null; end if;
  if amt is null then missing_fields:=array_append(missing_fields,'amount'); end if;
  clean:=clean||jsonb_build_object('amount',amt);
  if coalesce(length(trim(p_payload->>'invoiceType')),0)>1000 then raise exception 'Trường invoiceType tối đa 1000 ký tự.'; end if;
  if nullif(trim(p_payload->>'invoiceType'),'') is not null then clean:=clean||jsonb_build_object('invoiceType',trim(p_payload->>'invoiceType')); end if;
  if p_invoice_path is null or split_part(p_invoice_path,'/',1)<>auth.uid()::text
    or p_invoice_path !~ '/invoice\.pdf$'
    or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path)
    or (p_request_path is not null and (
      split_part(p_request_path,'/',1)<>auth.uid()::text
      or split_part(p_invoice_path,'/',2)<>split_part(p_request_path,'/',2)
      or p_request_path !~ '/request\.(pdf|jpg|png)$'
      or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
    )) then
    raise exception 'Cần tải hóa đơn PDF của chính tài khoản này; đơn đề nghị đính kèm (nếu có) phải thuộc cùng hồ sơ.';
  end if;
  select * into r from public.requests where id=p_id for update;
  was_existing:=found;
  next_status:=case when cardinality(missing_fields)>0 then 'NEEDS_INFO' else 'TREASURER_REVIEW' end;
  if was_existing then
    if r.owner_id<>auth.uid() or r.status<>'NEEDS_INFO' or p_expected_version is null or r.version<>p_expected_version then
      raise exception 'Hồ sơ đã thay đổi hoặc không được phép bổ sung. Hãy tải lại.';
    end if;
    delete from public.vendor_review_notes where request_id=p_id;
    update public.requests set payload=clean,amount=amt,invoice_path=p_invoice_path,request_path=p_request_path,
      status=next_status,
      checks=case when next_status='NEEDS_INFO' then jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(missing_fields)) else null end,
      reason=case when next_status='NEEDS_INFO' then 'Hồ sơ còn thiếu thông tin bắt buộc; đã trả người nộp để bổ sung.' else 'Người nộp đã bổ sung đủ form; chờ đánh giá hóa đơn.' end,
      escalated_at=null,approved_at=null,version=version+1,updated_at=now()
      where id=p_id returning * into r;
  else
    if p_expected_version is null or p_expected_version<>0 then raise exception 'Không tìm thấy phiên bản hồ sơ.'; end if;
    insert into public.requests(id,owner_id,payload,amount,invoice_path,request_path,status,checks,reason)
      values(p_id,auth.uid(),clean,amt,p_invoice_path,p_request_path,next_status,
        case when next_status='NEEDS_INFO' then jsonb_build_object('decision_code','U1','form_missing_fields',to_jsonb(missing_fields)) else null end,
        case when next_status='NEEDS_INFO' then 'Hồ sơ còn thiếu thông tin bắt buộc; đã trả người nộp để bổ sung.' else 'Đã gửi đủ form; chờ đánh giá hóa đơn.' end)
      returning * into r;
  end if;
  return r;
end $$;
COMMIT;

