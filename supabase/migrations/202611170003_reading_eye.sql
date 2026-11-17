alter table public.argus_runs
  drop constraint argus_runs_status_check,
  add constraint argus_runs_status_check
    check (status in ('uploading', 'queued', 'processing', 'complete', 'failed', 'cancelled')),
  add column progress jsonb,
  add column pages_total integer,
  add column analysis_mode text check (analysis_mode in ('instant', 'live')),
  add column cache_result text check (cache_result in ('hit', 'partial', 'miss')),
  add column duration_ms integer,
  add column stage_ms jsonb,
  add column ocr_seconds_per_page double precision;

create index argus_run_ocr_samples on public.argus_runs (owner_id, created_at desc)
  where status = 'complete' and ocr_seconds_per_page is not null;

create or replace function public.argus_claim_run(run_id uuid, reviewer_id uuid)
returns setof public.argus_runs
language sql
set search_path = ''
as $$
  update public.argus_runs
  set status = 'processing', revision = revision + 1, error = null,
      progress = null, ocr_progress = null, lease_until = now() + interval '15 minutes'
  where id = run_id and owner_id = reviewer_id and deleting_at is null
    and (status in ('queued', 'failed', 'cancelled') or (status = 'processing' and lease_until <= now()))
  returning *;
$$;
