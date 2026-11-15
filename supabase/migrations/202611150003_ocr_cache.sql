create table public.argus_ocr_cache (
  owner_id uuid not null references auth.users(id) on delete cascade,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  profile text not null check (profile ~ '^[0-9a-f]{64}$'),
  extraction jsonb not null check (jsonb_typeof(extraction) = 'object'),
  grounded_text jsonb not null check (jsonb_typeof(grounded_text) = 'array'),
  created_at timestamptz not null default now(),
  primary key (owner_id, checksum, profile)
);

alter table public.argus_ocr_cache enable row level security;
revoke all on public.argus_ocr_cache from public, anon, authenticated;
grant select, insert on public.argus_ocr_cache to service_role;
