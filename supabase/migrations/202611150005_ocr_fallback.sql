alter table public.argus_ocr_budget
  drop constraint argus_ocr_budget_reader_check,
  add column window_day date,
  add constraint argus_ocr_budget_reader_check
    check (reader in ('sarvam', 'nvidia-super-vl', 'gemini-flash')),
  add constraint argus_ocr_budget_gemini_daily
    check (reader <> 'gemini-flash' or (request_limit = 100 and window_day is not null));

insert into public.argus_ocr_budget (reader, request_limit, window_day)
  values ('gemini-flash', 100, (statement_timestamp() at time zone 'America/Los_Angeles')::date);

create or replace function public.argus_reserve_ocr(run_id uuid, reviewer_id uuid, claim_revision integer, reader_name text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  provider_day date := (statement_timestamp() at time zone 'America/Los_Angeles')::date;
begin
  perform 1 from public.argus_runs
    where id = run_id and owner_id = reviewer_id
      and status = 'processing' and revision = claim_revision
      and allow_cloud and lease_until > statement_timestamp()
    for update;
  if not found then
    return false;
  end if;

  if reader_name = 'gemini-flash' then
    update public.argus_ocr_budget
      set used = case when window_day < provider_day then 1 else used + 1 end,
          window_day = provider_day
      where reader = reader_name
        and (window_day < provider_day or (window_day = provider_day and used < request_limit));
  else
    update public.argus_ocr_budget set used = used + 1
      where reader = reader_name and used < request_limit;
  end if;
  return found;
end;
$$;
