create schema if not exists argus_internal;

create table argus_internal.maintenance_schedule (
  singleton boolean primary key default true check (singleton),
  bearer text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);

alter table argus_internal.maintenance_schedule enable row level security;
revoke all on schema argus_internal from public, anon, authenticated, service_role;
revoke all on table argus_internal.maintenance_schedule from public, anon, authenticated, service_role;

create function public.argus_maintenance_scheduled(candidate text default null)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from argus_internal.maintenance_schedule s
    where candidate is null or s.bearer = candidate
  );
$$;

revoke all on function public.argus_maintenance_scheduled(text) from public, anon, authenticated;
grant execute on function public.argus_maintenance_scheduled(text) to service_role;
