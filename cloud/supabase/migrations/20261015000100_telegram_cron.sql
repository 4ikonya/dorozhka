-- Every minute pg_cron calls the telegram function's /tick. The shared secret is generated here,
-- inside the database, and never appears in any file.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.secrets (name text primary key, value text not null);
insert into private.secrets (name, value)
  values ('cron', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

-- The function asks the database whether the secret it received is right.
create or replace function public.check_cron_secret(candidate text)
returns boolean
language sql
security definer
set search_path = private
as $$ select exists (select 1 from private.secrets where name = 'cron' and value = candidate) $$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'dorozhka-telegram-tick';
select cron.schedule(
  'dorozhka-telegram-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url     := 'https://qzgiovxsucmaalrwdhha.supabase.co/functions/v1/telegram/tick',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-secret', (select value from private.secrets where name = 'cron')),
    body    := '{}'::jsonb
  );
  $job$
);
