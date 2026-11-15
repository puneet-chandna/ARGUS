alter table public.argus_runs
  add column display_name text check (length(display_name) between 1 and 160),
  add column pinned boolean not null default false,
  add column deleting_at timestamptz;

drop index public.argus_runs_owner_history;
create index argus_runs_owner_history on public.argus_runs (owner_id, pinned desc, created_at desc);

create or replace function public.argus_claim_run(run_id uuid, reviewer_id uuid)
returns setof public.argus_runs
language sql
set search_path = ''
as $$
  update public.argus_runs
  set status = 'processing', revision = revision + 1, error = null,
      lease_until = now() + interval '15 minutes'
  where id = run_id and owner_id = reviewer_id and deleting_at is null
    and (status in ('queued', 'failed') or (status = 'processing' and lease_until <= now()))
  returning *;
$$;

create function public.argus_save_verified_ocr(
  run_id uuid, reviewer_id uuid, cache_profile text, verified_extraction jsonb, verified_text jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  digest text;
begin
  select checksum into digest from public.argus_runs
    where id = run_id and owner_id = reviewer_id and status = 'complete' and deleting_at is null
    for update;
  if found then
    insert into public.argus_ocr_cache (owner_id, checksum, profile, extraction, grounded_text)
      values (reviewer_id, digest, cache_profile, verified_extraction, verified_text)
      on conflict (owner_id, checksum, profile) do nothing;
  end if;
end;
$$;

create function public.argus_finish_delete(run_id uuid, reviewer_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  digest text;
begin
  delete from public.argus_runs
    where id = run_id and owner_id = reviewer_id and deleting_at is not null
    returning checksum into digest;
  if found and not exists (
    select 1 from public.argus_runs
      where owner_id = reviewer_id and checksum = digest and deleting_at is null
  ) then
    delete from public.argus_ocr_cache where owner_id = reviewer_id and checksum = digest;
  end if;
end;
$$;

revoke all on function public.argus_save_verified_ocr(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.argus_save_verified_ocr(uuid, uuid, text, jsonb, jsonb) to service_role;
revoke all on function public.argus_finish_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.argus_finish_delete(uuid, uuid) to service_role;
grant delete on public.argus_ocr_cache to service_role;
