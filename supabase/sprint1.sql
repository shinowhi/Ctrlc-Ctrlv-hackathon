-- Apply ONCE after schema.sql (also upgrades the existing MVP). No business rows deleted.
begin;
create table public.demo_budgets (
  code text primary key, category text not null, ceiling bigint not null check(ceiling>0),
  committed bigint not null default 0 check(committed>=0)
);
insert into public.demo_budgets(code,category,ceiling) values
 ('MKT-OPS-2026','printing',100000000),('OPS-2026','office_supplies',100000000),('HR-2026','training',100000000);
-- Existing approvals count towards sample budgets; do not silently reset spent money on upgrade.
update public.demo_budgets b set committed=coalesce((select sum(r.amount) from public.requests r
 where r.status='APPROVED' and r.payload->>'budgetCode'=b.code),0);
alter table public.demo_budgets enable row level security;
grant select on public.demo_budgets to authenticated;
create policy budget_read on public.demo_budgets for select to authenticated using(true);
revoke insert,update,delete on public.demo_budgets from anon,authenticated;
grant all on public.demo_budgets to service_role;

create table public.agent_assessments (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id),
 payload jsonb not null, invoice_path text not null, request_path text not null,
 state text not null default 'pending' check(state in ('pending','complete','failed')),
 analysis jsonb, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes', used_at timestamptz
);
create index assessment_owner_time on public.agent_assessments(owner_id,created_at);
alter table public.agent_assessments enable row level security;
revoke all on public.agent_assessments from anon,authenticated;
grant all on public.agent_assessments to service_role;
alter table public.requests add column assessment_id uuid references public.agent_assessments(id),
 add column code text, add column flags jsonb not null default '[]', add column question text,
 add column analysis jsonb, add column decision_actor text, add column policy_version text;

create function public.reserve_assessment(p_payload jsonb,p_invoice_path text,p_request_path text)
returns uuid language plpgsql security definer set search_path='' as $$
declare assessment uuid;
begin
 if auth.uid() is null or public.my_role() is distinct from 'applicant' then raise exception 'Chỉ người nộp được phân tích hồ sơ.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 if (select count(*) from public.agent_assessments where owner_id=auth.uid() and created_at>now()-interval '1 minute')>=6 then raise exception 'Tối đa 6 lượt phân tích/phút. Vui lòng chờ.'; end if;
 if (select count(*) from public.agent_assessments where owner_id=auth.uid() and created_at>now()-interval '1 day')>=100 then raise exception 'Đã đạt 100 lượt phân tích/ngày.'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>15000 then raise exception 'Nội dung hồ sơ không hợp lệ.'; end if;
 if p_invoice_path is null or p_request_path is null or split_part(p_invoice_path,'/',1)<>auth.uid()::text
 or split_part(p_request_path,'/',1)<>auth.uid()::text or split_part(p_invoice_path,'/',2)<>split_part(p_request_path,'/',2)
 or p_invoice_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/invoice\.(pdf|jpg|png)$'
 or p_request_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/request\.(pdf|jpg|png)$'
 or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_invoice_path)
 or not exists(select 1 from storage.objects where bucket_id='evidence' and name=p_request_path)
 then raise exception 'Minh chứng phải được tải lên bởi chính tài khoản này.'; end if;
 insert into public.agent_assessments(owner_id,payload,invoice_path,request_path) values(auth.uid(),p_payload,p_invoice_path,p_request_path) returning id into assessment;
 return assessment;
end $$;

-- Internal deterministic decision function. No user can invoke it directly.
create function public.apply_referee(p_id uuid,p_exception boolean default false,p_cfo boolean default false)
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
   why:='Cần quyết định ngoại lệ theo chính sách mẫu FIN-DEMO-1.';
 elsif r.amount>20000000 and not p_cfo then
   c:='U3';target:='CFO_REVIEW';q:='Hồ sơ '||r.id||' đề nghị '||r.amount||' VNĐ, vượt quyền tự động 20.000.000 VNĐ. GĐTC có phê duyệt không?';why:='Vượt quyền tự động.';
 else
   c:='CLEAR';target:='APPROVED';q:=null;why:=case when p_cfo then 'GĐTC phê duyệt' else 'Tự hoàn tất hồ sơ trong hạn mức 20 triệu' end||case when p_exception then ' với ngoại lệ cho riêng hồ sơ.' else ' theo FIN-DEMO-1.' end;
   if b.code is not null then update public.demo_budgets set committed=committed+r.amount where code=b.code; end if;
 end if;
 update public.requests set status=target,code=c,flags=r.flags,question=q,reason=why,
 escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,policy_version='FIN-DEMO-1',
 decision_actor=case when p_cfo then 'cfo' else coalesce(r.decision_actor,'agent') end,version=version+1,updated_at=now()
 where id=p_id returning * into r;
 return r;
end $$;

alter function public.submit_request(uuid,jsonb,text,text,integer) rename to submit_request_legacy;
revoke execute on function public.submit_request_legacy(uuid,jsonb,text,text,integer) from public,anon,authenticated;
create function public.submit_request(p_id uuid,p_payload jsonb,p_invoice_path text,p_request_path text,p_expected_version integer default 0,p_agent_assessment_id uuid default null)
returns public.requests language plpgsql security definer set search_path='' as $$
declare r public.requests; a public.agent_assessments; evidence jsonb;
begin
 -- Preserve original ownership, amount, immutable file, version validation.
 select * into r from public.requests where id=p_id for update;
 if found and r.owner_id=auth.uid() and r.code='U1' and r.status='TREASURER_REVIEW' and r.version=p_expected_version then
   update public.requests set status='NEEDS_INFO' where id=p_id;
 end if;
 if p_agent_assessment_id is not null then
   select * into a from public.agent_assessments where id=p_agent_assessment_id for update;
   if not found or a.owner_id<>auth.uid() or a.payload is distinct from p_payload or a.invoice_path<>p_invoice_path or a.request_path<>p_request_path
    or a.state<>'complete' or a.expires_at<=now() or a.used_at is not null then raise exception 'Đánh giá không khớp hồ sơ, đã dùng hoặc hết hạn. Hãy phân tích lại.'; end if;
   evidence:=a.analysis;
 else evidence:='{"flags":["Chưa có kết quả đọc minh chứng tin cậy; cần thủ quỹ kiểm tra"],"checks":{}}'; end if;
 r:=public.submit_request_legacy(p_id,p_payload,p_invoice_path,p_request_path,p_expected_version);
 update public.requests set payload=payload||jsonb_build_object('category',coalesce(p_payload->>'category','other')),
 assessment_id=p_agent_assessment_id,analysis=evidence,checks=coalesce(evidence->'checks','{}'),flags=coalesce(evidence->'flags','["Thiếu kết quả phân tích"]'),decision_actor='agent'
 where id=p_id;
 if p_agent_assessment_id is not null then update public.agent_assessments set used_at=now() where id=a.id; end if;
 return public.apply_referee(p_id);
end $$;

create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,p_reason text default '',p_checks jsonb default '{}')
returns public.requests language plpgsql security definer set search_path='' as $$
declare r public.requests; who text:=public.my_role();
begin
 select * into r from public.requests where id=p_id for update;
 if not found or p_expected_version is null or r.version<>p_expected_version then raise exception 'Hồ sơ đã thay đổi. Hãy tải lại.'; end if;
 if auth.uid() is null or not ((who='treasurer' and r.status='TREASURER_REVIEW') or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
 if p_action is null or p_action not in ('resolve','approve','clarify','reject') or coalesce(length(trim(p_reason)),0) not between 1 and 2000 then raise exception 'Cần hành động hợp lệ và câu trả lời/lý do cụ thể (1–2000 ký tự).'; end if;
 if p_action in ('clarify','reject') then
   update public.requests set status=case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end,
    reason=p_reason,question=case when p_action='clarify' then p_reason else null end,decision_actor=who,version=version+1,updated_at=now()
    where id=p_id returning * into r;return r;
 end if;
 if who='treasurer' then
   if p_action<>'resolve' or not coalesce(p_checks @> '{"paper":true,"stamp":true,"signature":true,"match":true}',false) then raise exception 'Phải giải quyết tất cả nghi vấn và xác nhận minh chứng trước.'; end if;
   update public.requests set flags='[]',checks=p_checks,reason=p_reason,decision_actor=who where id=p_id;
   return public.apply_referee(p_id);
 else
   if p_action<>'approve' or jsonb_array_length(r.flags)>0 then raise exception 'Chưa giải quyết nghi vấn.'; end if;
   -- Record the answer before the deterministic final transition; original flags stay in prior audit snapshots.
   update public.requests set reason=p_reason,decision_actor=who where id=p_id;
   return public.apply_referee(p_id,coalesce(r.code='U2',false),true);
 end if;
end $$;

create or replace function public.record_request_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_events(request_id,actor_id,actor_role,old_status,new_status,reason,version,snapshot)
 values(new.id,auth.uid(),coalesce(new.decision_actor,public.my_role()),case when TG_OP='UPDATE' then old.status else null end,new.status,new.reason,new.version,to_jsonb(new));
 return new;
end $$;
revoke execute on function public.apply_referee(uuid,boolean,boolean) from public,anon,authenticated;
revoke execute on function public.reserve_assessment(jsonb,text,text),public.submit_request(uuid,jsonb,text,text,integer,uuid) from public,anon;
grant execute on function public.reserve_assessment(jsonb,text,text),public.submit_request(uuid,jsonb,text,text,integer,uuid) to authenticated;
commit;
