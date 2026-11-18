create function public.argus_run_history(
  reviewer_id uuid, after_pinned boolean, after_created_at timestamptz, after_id uuid
)
returns setof public.argus_runs
language plpgsql security definer set search_path = '' as $$
begin
  -- Storage publishes the object after the write completes. Make interrupted reservations resumable.
  update public.argus_runs r set status = 'queued'
    where r.owner_id = reviewer_id and r.status = 'uploading' and r.deleting_at is null
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'argus-policy-pdfs' and o.name = reviewer_id::text || '/' || r.id::text || '.pdf'
    );

  return query select r.* from public.argus_runs r
    where r.owner_id = reviewer_id and r.status <> 'uploading'
    and not (r.analysis_mode is not distinct from 'instant' and r.status = 'processing' and r.lease_until > now())
    and (after_id is null or (r.pinned, r.created_at, r.id) < (after_pinned, after_created_at, after_id))
    order by r.pinned desc, r.created_at desc, r.id desc limit 101;
end;
$$;

create function public.argus_mark_retention_delete(run_id uuid, reviewer_id uuid)
returns boolean
language plpgsql set search_path = '' as $$
declare
  days integer;
begin
  -- A deletion already started must finish even if the retention setting changed.
  if exists (
    select 1 from public.argus_runs r where r.id = run_id and r.owner_id = reviewer_id
      and r.status <> 'uploading' and r.deleting_at is not null
  ) then return true; end if;

  -- Serialize the decision with changes to the reviewer's retention setting.
  select p.retention_days into days from public.argus_user_preferences p
    where p.owner_id = reviewer_id for update;
  if days is null then return false; end if;

  update public.argus_runs r set deleting_at = now(), revision = r.revision + 1
    where r.id = run_id and r.owner_id = reviewer_id and r.deleting_at is null
    and r.created_at < now() - make_interval(days => days)
    and r.status <> 'uploading' and (r.status <> 'processing' or r.lease_until <= now());
  if found then return true; end if;
  return exists (
    select 1 from public.argus_runs r
    where r.id = run_id and r.owner_id = reviewer_id and r.deleting_at is not null
  );
end;
$$;

create or replace function public.argus_retention_candidates()
returns table(id uuid, owner_id uuid)
language sql stable set search_path = '' as $$
  select r.id, r.owner_id from public.argus_runs r
  left join public.argus_user_preferences p on p.owner_id = r.owner_id
  where r.status <> 'uploading' and (r.deleting_at is not null or (
    r.created_at < now() - make_interval(days => p.retention_days)
    and (r.status <> 'processing' or r.lease_until <= now())
  ))
  order by r.created_at, r.id limit 100;
$$;

revoke all on function public.argus_run_history(uuid, boolean, timestamptz, uuid),
  public.argus_mark_retention_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.argus_run_history(uuid, boolean, timestamptz, uuid),
  public.argus_mark_retention_delete(uuid, uuid) to service_role;
