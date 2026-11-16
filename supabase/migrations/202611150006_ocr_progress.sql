alter table public.argus_runs add column ocr_progress jsonb;

create or replace function public.argus_claim_run(run_id uuid, reviewer_id uuid)
returns setof public.argus_runs
language sql
set search_path = ''
as $$
  update public.argus_runs
  set status = 'processing', revision = revision + 1, error = null,
      ocr_progress = null, lease_until = now() + interval '15 minutes'
  where id = run_id and owner_id = reviewer_id and deleting_at is null
    and (status in ('queued', 'failed') or (status = 'processing' and lease_until <= now()))
  returning *;
$$;
