begin;

create or replace function public.can_read_request(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.requests r where r.id=p_id and (
    r.owner_id=auth.uid() or public.my_role()='treasurer'
      or (public.my_role()='cfo' and (
        r.status='CFO_REVIEW' or (r.status='READY_FOR_APPROVAL' and r.amount>20000000)
        or (r.status='APPROVED' and r.escalated_at is not null)
        or (r.status in ('READY_FOR_APPROVAL','CFO_REVIEW','APPROVED')
          and exists(select 1 from public.vendor_review_notes n where n.request_id=r.id and n.reviewed_at is null))
      ))
  ));
$$;

revoke execute on function public.can_read_request(uuid) from public,anon;
grant execute on function public.can_read_request(uuid) to authenticated;

commit;
notify pgrst,'reload schema';
