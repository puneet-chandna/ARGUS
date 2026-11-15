create table public.argus_ocr_budget (
  reader text primary key check (reader in ('sarvam', 'nvidia-super-vl')),
  request_limit integer not null default 0 check (request_limit >= 0),
  used integer not null default 0 check (used between 0 and request_limit)
);

insert into public.argus_ocr_budget (reader) values ('sarvam'), ('nvidia-super-vl');
alter table public.argus_ocr_budget enable row level security;
revoke all on public.argus_ocr_budget from public, anon, authenticated;
grant select, update on public.argus_ocr_budget to service_role;

create function public.argus_reserve_ocr(run_id uuid, reviewer_id uuid, claim_revision integer, reader_name text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.argus_runs
    where id = run_id and owner_id = reviewer_id
      and status = 'processing' and revision = claim_revision
      and allow_cloud and lease_until > now()
    for update;
  if not found then
    return false;
  end if;

  update public.argus_ocr_budget set used = used + 1
    where reader = reader_name and used < request_limit;
  return found;
end;
$$;

revoke all on function public.argus_reserve_ocr(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.argus_reserve_ocr(uuid, uuid, integer, text) to service_role;
