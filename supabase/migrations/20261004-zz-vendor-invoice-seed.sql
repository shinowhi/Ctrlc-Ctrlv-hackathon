-- Seed suppliers found on the user-provided invoice PDFs.
-- Store only names printed as the seller; buyer names and e-invoice providers are excluded.
begin;

do $$
declare
  supplier record;
  vendor_id uuid;
  current_tax_code text;
  alias_owner_id uuid;
begin
  for supplier in
    select * from (values
      ('HỘ KINH DOANH L.A GREEN','068195010279',
       'Đối chiếu người bán và MST trên các hóa đơn invoice-01 đến invoice-18 trong thư mục Hóa Đơn (testcase), 2026-10-04.'),
      ('CÔNG TY TNHH HẢI HÀ PHÁT','3603371497',
       'Đối chiếu người bán và MST trên invoice-19-source-20.pdf, số hóa đơn 168, 2026-10-04.'),
      ('CÔNG TY TNHH TM DV NÔNG DƯỢC ĐA ME','5801481311',
       'Đối chiếu người bán và MST trên invoice-20-source-21.pdf, số hóa đơn 00000052, 2026-10-04.'),
      ('CÔNG TY TNHH ĐỨC THI','5800603006',
       'Đối chiếu người bán và MST trên invoice-21-source-22.pdf, số hóa đơn 00011137, 2026-10-04.')
    ) as s(legal_name,tax_code,source_note)
  loop
    select v.id,v.tax_code_key into vendor_id,current_tax_code
      from public.vendor_directory v
      where v.normalized_name=public.normalize_party_name(supplier.legal_name);

    if vendor_id is null then
      if exists(select 1 from public.vendor_directory v
        where v.tax_code_key=public.normalize_vendor_tax_code(supplier.tax_code)) then
        raise exception 'MST % đã thuộc về nhà cung cấp khác; cần đối chiếu danh mục trước khi thêm "%".',
          supplier.tax_code,supplier.legal_name;
      end if;
      insert into public.vendor_directory(legal_name,tax_code)
        values(supplier.legal_name,supplier.tax_code) returning id into vendor_id;
    elsif current_tax_code is not null
      and current_tax_code<>public.normalize_vendor_tax_code(supplier.tax_code) then
      raise exception 'Tên "%" đang được lưu với MST khác; cần đối chiếu trước khi cập nhật.',supplier.legal_name;
    else
      update public.vendor_directory set tax_code=supplier.tax_code,updated_at=now()
        where id=vendor_id and tax_code_key is null;
    end if;

    -- The canonical seller spelling is also registered for exact alias lookup.
    select a.vendor_id into alias_owner_id from public.vendor_aliases a
      where a.normalized_name=public.normalize_party_name(supplier.legal_name);
    if alias_owner_id is not null and alias_owner_id<>vendor_id then
      raise exception 'Tên người bán "%" đã thuộc về nhà cung cấp khác.',supplier.legal_name;
    end if;
    insert into public.vendor_aliases(vendor_id,alias_name,verification_note)
      values(vendor_id,supplier.legal_name,supplier.source_note)
      on conflict (normalized_name) do nothing;
  end loop;
end $$;

commit;
