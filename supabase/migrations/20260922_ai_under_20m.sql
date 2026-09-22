-- Apply after schema.sql and sprint1.sql. Existing decisions and budgets stay intact.
begin;
create or replace function public.apply_referee(p_id uuid,p_exception boolean default false,p_cfo boolean default false)
returns public.requests language plpgsql security definer set search_path='' as $$
declare r public.requests; b public.demo_budgets; target text; c text; q text; why text; dup boolean;
begin
 select * into r from public.requests where id=p_id for update;
 if not found or r.status in ('APPROVED','REJECTED') then raise exception 'Hồ sơ không còn được xử lý.'; end if;
 -- Same invoice and same budget decisions serialize, including concurrent requests.
 perform pg_advisory_xact_lock(hashtextextended(lower(trim(r.payload->>'vendor'))||'/'||lower(trim(r.payload->>'invoiceNumber')),0));
 select exists(select 1 from public.requests x where x.id<>r.id and x.status='APPROVED'
   and lower(trim(x.payload->>'vendor'))=lower(trim(r.payload->>'vendor'))
   and lower(trim(x.payload->>'invoiceNumber'))=lower(trim(r.payload->>'invoiceNumber'))) into dup;
 if dup then r.flags:=r.flags||jsonb_build_array('Hóa đơn đã có trong một hồ sơ được phê duyệt.'); end if;
 select * into b from public.demo_budgets where code=r.payload->>'budgetCode' for update;
 if jsonb_array_length(r.flags)>0 or not coalesce(r.checks @> '{"paper":true,"stamp":true,"signature":true,"match":true}',false) then
   c:='U1';target:='TREASURER_REVIEW';q:='Hồ sơ '||r.id||': '||coalesce((select string_agg(value,'; ') from jsonb_array_elements_text(r.flags)),'chưa xác minh đủ minh chứng')||' Vui lòng cung cấp dữ kiện/chứng từ đúng hoặc thủ quỹ xác minh kèm lý do.';
   why:='Tạm dừng: dữ kiện còn nghi vấn.';
 elsif not p_exception and (b.code is null or b.category is distinct from r.payload->>'category' or b.ceiling-b.committed<r.amount) then
   c:='U2';target:='CFO_REVIEW';q:='Hồ sơ '||r.id||', danh mục '||coalesce(r.payload->>'category','chưa rõ')||', ngân sách '||coalesce(r.payload->>'budgetCode','chưa rõ')||', số tiền '||r.amount||' VNĐ: '||case when b.code is null then 'mã ngân sách chưa được quy định' when b.category is distinct from r.payload->>'category' then 'danh mục không thuộc ngân sách này' else 'ngân sách còn '||(b.ceiling-b.committed)||' VNĐ' end||'. GĐTC có phê duyệt ngoại lệ cho riêng hồ sơ này không?';
   why:='Cần quyết định ngoại lệ theo chính sách mẫu FIN-DEMO-2.';
 elsif r.amount>=20000000 and not p_cfo then
   c:='U3';target:='CFO_REVIEW';q:='Hồ sơ '||r.id||' đề nghị '||r.amount||' VNĐ, đạt hoặc vượt ngưỡng 20.000.000 VNĐ. GĐTC có phê duyệt không?';why:='Vượt quyền tự động.';
 else
   c:='CLEAR';target:='APPROVED';q:=null;why:=case when p_cfo then 'GĐTC phê duyệt' else 'Tự hoàn tất hồ sơ dưới 20 triệu' end||case when p_exception then ' với ngoại lệ cho riêng hồ sơ.' else ' theo FIN-DEMO-2.' end;
   if b.code is not null then update public.demo_budgets set committed=committed+r.amount where code=b.code; end if;
 end if;
 update public.requests set status=target,code=c,flags=r.flags,question=q,reason=why,
 escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,policy_version='FIN-DEMO-2',
 decision_actor=case when p_cfo then 'cfo' else coalesce(r.decision_actor,'agent') end,version=version+1,updated_at=now()
 where id=p_id returning * into r;
 return r;
end $$;

revoke execute on function public.apply_referee(uuid,boolean,boolean) from public,anon,authenticated;
commit;
