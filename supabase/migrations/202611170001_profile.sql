create table public.argus_profiles (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 80),
  organization text not null default '' check (length(organization) <= 120),
  time_zone text check (length(time_zone) <= 100),
  clock text not null default '24' check (clock in ('24', '12')),
  avatar_type text check (avatar_type in ('image/png', 'image/jpeg')),
  avatar_data text check (length(avatar_data) <= 2666668),
  avatar_revision uuid,
  check ((avatar_type is null) = (avatar_data is null))
);

create table public.argus_user_preferences (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  appearance text not null default 'light' check (appearance in ('light', 'dark', 'system')),
  density text not null default 'comfortable' check (density in ('comfortable', 'compact')),
  landing text not null default 'new' check (landing in ('new', 'last')),
  decision_filter text not null default 'all' check (decision_filter in ('all', 'resolved', 'ambiguous', 'unsupported')),
  decimals integer not null default 1 check (decimals in (1, 2)),
  percent_sign boolean not null default true,
  retention_days integer check (retention_days in (30, 90, 365)),
  delete_originals boolean not null default false
);

create table public.argus_audit_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null default statement_timestamp(),
  action text not null check (action in ('signed_in', 'analyzed', 'ocr_approved', 'exported', 'exported_activity', 'exported_data', 'deleted')),
  target text,
  ocr_mode text check (ocr_mode in ('local', 'external')),
  status text not null check (status in ('success', 'failed', 'resolved', 'ambiguous', 'unsupported'))
);
create index argus_audit_owner_time on public.argus_audit_events (owner_id, occurred_at desc, id desc);
create index argus_audit_owner_action_time on public.argus_audit_events (owner_id, action, occurred_at desc);
create index argus_runs_owner_created on public.argus_runs (owner_id, created_at desc);

alter table public.argus_profiles enable row level security;
alter table public.argus_user_preferences enable row level security;
alter table public.argus_audit_events enable row level security;
revoke all on public.argus_profiles, public.argus_user_preferences, public.argus_audit_events from public, anon, authenticated;
grant select on public.argus_profiles, public.argus_user_preferences, public.argus_audit_events to authenticated;
grant all on public.argus_profiles, public.argus_user_preferences, public.argus_audit_events to service_role;
create policy "Read own profile" on public.argus_profiles for select to authenticated using (owner_id = (select auth.uid()));
create policy "Read own preferences" on public.argus_user_preferences for select to authenticated using (owner_id = (select auth.uid()));
create policy "Read own audit" on public.argus_audit_events for select to authenticated using (owner_id = (select auth.uid()));

alter table public.argus_runs
  add column ocr_mode text check (ocr_mode in ('local', 'external')),
  add column pdf_deleted_at timestamptz,
  add column pdf_cleanup_pending boolean not null default false;

create index argus_pending_pdf_cleanup on public.argus_runs (created_at, id) where pdf_cleanup_pending;

create function public.argus_log_run_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.deleting_at is not null then
      insert into public.argus_audit_events(owner_id, action, target, ocr_mode, status)
      values(old.owner_id, 'deleted', coalesce(old.display_name, old.filename), old.ocr_mode, 'success');
    end if;
    return old;
  end if;
  if old.status = 'uploading' and new.status = 'queued' and new.allow_cloud then
    insert into public.argus_audit_events(owner_id, action, target, ocr_mode, status)
    values(new.owner_id, 'ocr_approved', new.filename, 'external', 'success');
  elsif old.status = 'processing' and new.status in ('complete', 'failed') then
    insert into public.argus_audit_events(owner_id, action, target, ocr_mode, status)
    values(new.owner_id, 'analyzed', coalesce(new.display_name, new.filename), new.ocr_mode,
      case when new.result->>'status' in ('resolved', 'ambiguous', 'unsupported') then new.result->>'status'
        when new.status = 'failed' then 'failed' else 'success' end);
  end if;
  return new;
end;
$$;
revoke all on function public.argus_log_run_event() from public, anon, authenticated;
create trigger argus_audit_run_update after update of status on public.argus_runs
for each row when (old.status is distinct from new.status) execute function public.argus_log_run_event();
create trigger argus_audit_run_delete after delete on public.argus_runs
for each row execute function public.argus_log_run_event();

create function public.argus_log_auth_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.argus_audit_events(owner_id, action, status) values(new.user_id, 'signed_in', 'success');
  return new;
end;
$$;
revoke all on function public.argus_log_auth_session() from public, anon, authenticated;
create trigger argus_audit_sign_in after insert on auth.sessions
for each row execute function public.argus_log_auth_session();

create function public.argus_my_sessions()
returns table(id uuid, user_agent text, last_active timestamptz, current_device boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.user_agent, greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'UTC'),
    s.id::text = (select auth.jwt()->>'session_id')
  from auth.sessions s
  where s.user_id = (select auth.uid()) and (s.not_after is null or s.not_after > now())
  order by 4 desc, 3 desc;
$$;
create function public.argus_revoke_my_session(target uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.sessions s where s.id = target and s.user_id = (select auth.uid())
    and s.id::text <> (select auth.jwt()->>'session_id');
  return found;
end;
$$;
revoke all on function public.argus_my_sessions(), public.argus_revoke_my_session(uuid) from public, anon, authenticated;
grant execute on function public.argus_my_sessions(), public.argus_revoke_my_session(uuid) to authenticated;

create function public.argus_retention_candidates()
returns table(id uuid, owner_id uuid)
language sql stable set search_path = '' as $$
  select r.id, r.owner_id from public.argus_runs r
  join public.argus_user_preferences p on p.owner_id = r.owner_id and p.retention_days is not null
  where r.created_at < now() - make_interval(days => p.retention_days)
    and r.status <> 'uploading' and (r.status <> 'processing' or r.lease_until <= now())
  order by r.created_at, r.id limit 100;
$$;
revoke all on function public.argus_retention_candidates() from public, anon, authenticated;
grant execute on function public.argus_retention_candidates() to service_role;
