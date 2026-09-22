-- Run ONCE to restore MVP functions. Deploy MVP frontend at the same time.
-- Keeps additive columns/tables and all business records; no data deletion.
begin;
drop function public.submit_request(uuid,jsonb,text,text,integer,uuid);
alter function public.submit_request_legacy(uuid,jsonb,text,text,integer) rename to submit_request;
grant execute on function public.submit_request(uuid,jsonb,text,text,integer) to authenticated;
revoke execute on function public.reserve_assessment(jsonb,text,text) from authenticated;
create or replace function public.review_request(p_id uuid,p_expected_version integer,p_action text,
  p_reason text default '',p_checks jsonb default '{}'::jsonb)
returns public.requests language plpgsql security definer set search_path = '' as $$
declare r public.requests; who text := public.my_role(); target text; why text;
begin
  select * into r from public.requests where id=p_id for update;
  if not found or p_expected_version is null or r.version <> p_expected_version then
    raise exception 'Hồ sơ đã thay đổi. Hãy tải lại trước khi xử lý.';
  end if;
  if auth.uid() is null or not ((who='treasurer' and r.status='TREASURER_REVIEW')
    or (who='cfo' and r.status='CFO_REVIEW')) then raise exception 'Không có quyền xử lý hồ sơ ở trạng thái này.'; end if;
  if p_action is null or p_action not in ('approve','clarify','reject') then raise exception 'Hành động không hợp lệ.'; end if;
  if coalesce(length(p_reason),0) > 2000 then raise exception 'Lý do tối đa 2000 ký tự.'; end if;
  if p_action in ('clarify','reject') then
    if coalesce(length(trim(p_reason)),0)=0 then raise exception 'Hãy ghi rõ lý do hoặc nội dung cần bổ sung.'; end if;
    target := case when p_action='clarify' then 'NEEDS_INFO' else 'REJECTED' end;
    why := trim(p_reason);
  else
    if who='treasurer' then
      if not (coalesce(p_checks @> '{"paper":true,"stamp":true,"signature":true,"match":true,"budget":true,"policy":true}'::jsonb,false)) then
        raise exception 'U1/U2: chưa xác nhận đủ minh chứng, ngân sách và chính sách. Yêu cầu bổ sung hoặc từ chối.';
      end if;
      target := case when r.amount>20000000 then 'CFO_REVIEW' else 'APPROVED' end;
      why := case when r.amount>20000000 then 'U3: đã kiểm tra, chuyển Giám đốc Tài chính vì vượt 20 triệu.' else 'Thủ quỹ đã kiểm tra và duyệt trong hạn mức.' end;
    else
      if not coalesce(r.checks @> '{"paper":true,"stamp":true,"signature":true,"match":true,"budget":true,"policy":true}'::jsonb,false)
        then raise exception 'Chưa có xác nhận đầy đủ của thủ quỹ.'; end if;
      target := 'APPROVED'; why := 'Giám đốc Tài chính đã phê duyệt khoản chi.';
    end if;
  end if;
  update public.requests set status=target,reason=why,
    checks=case when who='treasurer' and p_action='approve' then p_checks else checks end,
    escalated_at=case when target='CFO_REVIEW' then now() else escalated_at end,
    version=version+1,updated_at=now() where id=p_id returning * into r;
  return r;
end $$;
create or replace function public.record_request_event() returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.audit_events(request_id,actor_id,actor_role,old_status,new_status,reason,version,snapshot)
  values(new.id,auth.uid(),public.my_role(),case when TG_OP='UPDATE' then old.status else null end,
    new.status,new.reason,new.version,to_jsonb(new));
  return new;
end $$;
commit;
