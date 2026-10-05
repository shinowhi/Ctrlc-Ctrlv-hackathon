-- Add accentless forms of verified legal supplier names and OCR aliases.
-- Keep these as explicit aliases so name normalization does not depend on OCR accents.
begin;

do $$
declare
  alias_entry record;
  target_vendor_id uuid;
  alias_owner_id uuid;
begin
  for alias_entry in
    select * from (values
      ('CÔNG TY CỔ PHẦN HOÀNG LINH','CONG TY CO PHAN HOANG LINH'),
      ('CÔNG TY CỔ PHẦN THÉP TRƯỜNG SA','CONG TY CO PHAN THEP TRUONG SA'),
      ('CÔNG TY CỔ PHẦN XÂY DỰNG AN KHÁNH NINH THUẬN','CONG TY CO PHAN XAY DUNG AN KHANH NINH THUAN'),
      ('CÔNG TY TNHH ĐÀ LẠT PHT','CONG TY TNHH DA LAT PHT'),
      ('CÔNG TY TNHH ĐIỆN TỬ BẢO ANH','CONG TY TNHH DIEN TU BAO ANH'),
      ('CÔNG TY TNHH ĐỨC THI','CONG TY TNHH DUC THI'),
      ('CÔNG TY TNHH HẢI HÀ PHÁT','CONG TY TNHH HAI HA PHAT'),
      ('CÔNG TY TNHH THIÊN TỰ PHƯỚC','CONG TY TNHH THIEN TU PHUOC'),
      ('CÔNG TY TNHH TM DV NÔNG DƯỢC ĐA ME','CONG TY TNHH TM DV NONG DUOC DA ME'),
      ('CÔNG TY TNHH TÙNG LÂM ĐÀ LẠT','CONG TY TNHH TUNG LAM DA LAT'),
      ('HỘ KINH DOANH L.A GREEN','HO KINH DOANH L.A GREEN'),
      ('HỘ KINH DOANH NGUYỄN VĂN NAM','HO KINH DOANH NGUYEN VAN NAM'),
      ('CÔNG TY TNHH TM DV NÔNG DƯỢC ĐA ME','NONG DUOC DA ME'),
      ('CÔNG TY TNHH TÙNG LÂM ĐÀ LẠT','TUNG LAM'),
      ('CÔNG TY CỔ PHẦN THÉP TRƯỜNG SA','THEP TRUONG')
    ) as s(legal_name,alias_name)
  loop
    select v.id into target_vendor_id
      from public.vendor_directory v
      where v.normalized_name=public.normalize_party_name(alias_entry.legal_name);

    if target_vendor_id is null then
      raise exception 'Không tìm thấy nhà cung cấp "%" để thêm bí danh không dấu.',alias_entry.legal_name;
    end if;

    select a.vendor_id into alias_owner_id
      from public.vendor_aliases a
      where a.normalized_name=public.normalize_party_name(alias_entry.alias_name);
    if alias_owner_id is not null and alias_owner_id<>target_vendor_id then
      raise exception 'Bí danh không dấu "%" đã thuộc về nhà cung cấp khác.',alias_entry.alias_name;
    end if;

    insert into public.vendor_aliases(vendor_id,alias_name,verification_note)
      values(target_vendor_id,alias_entry.alias_name,
        'Biến thể không dấu của tên pháp lý hoặc bí danh đã đối chiếu từ hóa đơn; 2026-10-05.')
      on conflict (normalized_name) do nothing;
  end loop;
end $$;

commit;
