create table public.argus_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  upload_key uuid not null,
  filename text not null check (length(filename) between 1 and 220),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 20971520),
  allow_cloud boolean not null default false,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'processing', 'complete', 'failed')),
  result jsonb,
  error text,
  revision integer not null default 0 check (revision >= 0),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, upload_key),
  check ((status = 'processing') = (lease_until is not null)),
  check ((status = 'complete') = (result is not null))
);

create index argus_runs_owner_history on public.argus_runs (owner_id, created_at desc);
alter table public.argus_runs enable row level security;
revoke all on public.argus_runs from public, anon, authenticated;
grant select on public.argus_runs to authenticated;
grant all on public.argus_runs to service_role;
create policy "Read own Argus history" on public.argus_runs
  for select to authenticated
  using (owner_id = (select auth.uid()) and status <> 'uploading');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('argus-policy-pdfs', 'argus-policy-pdfs', false, 20971520, array['application/pdf']);

-- Bucket access is server-only. Guard against a permissive policy for another bucket.
create policy "Argus PDFs are server only" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'argus-policy-pdfs')
  with check (bucket_id <> 'argus-policy-pdfs');

create function public.argus_claim_run(run_id uuid, reviewer_id uuid)
returns setof public.argus_runs
language sql
set search_path = ''
as $$
  update public.argus_runs
  set status = 'processing', revision = revision + 1, error = null,
      lease_until = now() + interval '15 minutes'
  where id = run_id and owner_id = reviewer_id
    and (status in ('queued', 'failed') or (status = 'processing' and lease_until <= now()))
  returning *;
$$;

revoke all on function public.argus_claim_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.argus_claim_run(uuid, uuid) to service_role;
