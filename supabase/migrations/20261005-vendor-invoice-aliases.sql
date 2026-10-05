-- Register suppliers and OCR variants grounded in the invoices already submitted.
-- Only seller names are included; buyer names and invoice-service providers are excluded.
begin;

do $$
declare
  supplier record;
  vendor_id uuid;
  current_tax_code text;
  alias_owner_id uuid;
  candidate text;
begin
  for supplier in
    select * from (values
      ('HỘ KINH DOANH L.A GREEN','068195010279',
        array['HỌ KINH DOANH L.A GREEN','KINH DOANH L.A GREEN']::text[],
        'Seller trên invoice-01 đến invoice-18; MST 068195010279 khớp PDF. AI đọc thành HỌ KINH DOANH L.A GREEN hoặc KINH DOANH L.A GREEN.'),
      ('CÔNG TY TNHH HẢI HÀ PHÁT','3603371497',
        array[]::text[],
        'Seller trên hóa đơn số 168; MST 3603371497 khớp PDF.'),
      ('CÔNG TY TNHH TM DV NÔNG DƯỢC ĐA ME','5801481311',
        array['Nông Dược Đa Me']::text[],
        'Seller trên hóa đơn 00000052; bí danh là cách AI đọc trên cùng PDF, MST 5801481311 khớp.'),
      ('CÔNG TY TNHH ĐỨC THI','5800603006',
        array['CÔNG TY TNHH ĐỨC THỊ']::text[],
        'Seller trên hóa đơn 00011137; bí danh là cách AI đọc trên cùng PDF, MST 5800603006 khớp.'),
      ('CÔNG TY TNHH ĐIỆN TỬ BẢO ANH','0312500505',
        array['BAO ANH ELECTRONICS']::text[],
        'Người dùng xác nhận bí danh trên hóa đơn 00008628; MST 0312500505 khớp.'),
      ('CÔNG TY TNHH THIÊN TỰ PHƯỚC','5800573947',
        array['THIEN TU PHUOC']::text[],
        'Seller trên hóa đơn 00001997, 00002007, 00002016, 00002032 và 00002040; AI bỏ dấu và tiền tố pháp lý, MST 5800573947 khớp.'),
      ('CÔNG TY TNHH TÙNG LÂM ĐÀ LẠT','5800076409',
        array['TÙNG LÂM']::text[],
        'Seller trên hóa đơn 00002145; AI rút gọn tên, MST 5800076409 khớp.'),
      ('CÔNG TY CỔ PHẦN THÉP TRƯỜNG SA','6001448821',
        array['THÉP TRƯỜNG']::text[],
        'Seller trên hóa đơn 00004920; AI rút gọn tên, MST 6001448821 khớp.'),
      ('CÔNG TY TNHH ĐÀ LẠT PHT','5801428981',
        array[]::text[],
        'Seller trên hóa đơn 00000033; MST 5801428981 khớp PDF.'),
      ('HỘ KINH DOANH NGUYỄN VĂN NAM','',
        array[]::text[],
        'Seller trên hóa đơn 00000157. Để trống MST vì PDF không cho thấy MST người bán đáng tin cậy.'),
      ('CÔNG TY CỔ PHẦN HOÀNG LINH','3500649983',
        array[]::text[],
        'Seller trên hóa đơn 2798; MST 3500649983 khớp PDF.'),
      ('CÔNG TY CỔ PHẦN XÂY DỰNG AN KHÁNH NINH THUẬN','4500410749',
        array[]::text[],
        'Seller trên hóa đơn 4026; MST 4500410749 khớp PDF.')
    ) as s(legal_name,tax_code,aliases,source_note)
  loop
    select v.id,v.tax_code_key into vendor_id,current_tax_code
      from public.vendor_directory v
      where v.normalized_name=public.normalize_party_name(supplier.legal_name);

    if vendor_id is null then
      if supplier.tax_code<>'' and exists(
        select 1 from public.vendor_directory v
        where v.tax_code_key=public.normalize_vendor_tax_code(supplier.tax_code)
      ) then
        raise exception 'MST % đã thuộc về nhà cung cấp khác; cần đối chiếu trước khi thêm "%".',
          supplier.tax_code,supplier.legal_name;
      end if;
      insert into public.vendor_directory(legal_name,tax_code)
        values(supplier.legal_name,supplier.tax_code) returning id into vendor_id;
    elsif supplier.tax_code<>'' and current_tax_code is not null
      and current_tax_code<>public.normalize_vendor_tax_code(supplier.tax_code) then
      raise exception 'Tên "%" đang được lưu với MST khác; cần đối chiếu trước khi cập nhật.',supplier.legal_name;
    elsif supplier.tax_code<>'' and current_tax_code is null then
      if exists(
        select 1 from public.vendor_directory v
        where v.tax_code_key=public.normalize_vendor_tax_code(supplier.tax_code)
          and v.id<>vendor_id
      ) then
        raise exception 'MST % đã thuộc về nhà cung cấp khác; cần đối chiếu trước khi cập nhật "%".',
          supplier.tax_code,supplier.legal_name;
      end if;
      update public.vendor_directory set tax_code=supplier.tax_code,updated_at=now()
        where id=vendor_id;
    end if;

    foreach candidate in array array_prepend(supplier.legal_name,coalesce(supplier.aliases,array[]::text[])) loop
      candidate := trim(candidate);
      select a.vendor_id into alias_owner_id from public.vendor_aliases a
        where a.normalized_name=public.normalize_party_name(candidate);
      if alias_owner_id is not null and alias_owner_id<>vendor_id then
        raise exception 'Tên/bí danh "%" đã thuộc về nhà cung cấp khác.',candidate;
      end if;
      insert into public.vendor_aliases(vendor_id,alias_name,verification_note)
        values(vendor_id,candidate,supplier.source_note)
        on conflict (normalized_name) do nothing;
    end loop;
  end loop;
end $$;

commit;
