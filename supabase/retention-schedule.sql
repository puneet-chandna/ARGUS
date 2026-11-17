-- Configure the Supabase Cron extension first. Replace YOUR-ARGUS-HOST with
-- the existing HTTPS host running this project's Argus app.
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into argus_internal.maintenance_schedule default values on conflict do nothing;

select cron.schedule('argus-retention', '30 2 * * *', $job$
  select net.http_post(
    url := 'https://YOUR-ARGUS-HOST/api/maintenance',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.bearer, 'Content-Type', 'application/json'),
    timeout_milliseconds := 180000
  )
  from argus_internal.maintenance_schedule s;
$job$);

commit;
