-- Coaches sign in with Google; the Telegram bot only sends reminders and buttons. A coach links their chat
-- from the journal's settings: the app asks the telegram function for a one-time request and opens the bot
-- with it, the coach confirms in the bot. Only the telegram function (service role) touches the table.
create table if not exists public.link_requests (
  nonce      text primary key,
  owner      uuid not null references auth.users (id) on delete cascade,
  ip         text,
  ua         text,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists link_requests_owner_created on public.link_requests (owner, created_at);
alter table public.link_requests enable row level security;
grant select, insert, update, delete on public.link_requests to service_role;

-- The login through the bot is gone.
drop table if exists public.login_requests;
drop table if exists public.login_code_failures;

-- A coach who used to sign in through the bot has an account tg<chat>@users.dorozhka.example. They sign in with
-- Google (a new, empty account) and link the same chat: the bot offers to move the old journal. The Google
-- identity moves to the old account, the new one is deleted, and the old account takes the Google address.
-- Everything that belongs to the journal (app_state, backups, telegram_links, receipt photos under <owner>/)
-- stays with the old account id as it is.
create or replace function public.merge_into_legacy(p_old uuid, p_new uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_meta  jsonb;
  v_data  jsonb;
begin
  if p_old = p_new then raise exception 'Это один и тот же аккаунт'; end if;
  perform 1 from auth.users where id in (p_old, p_new) for update;
  if not exists (select 1 from auth.users where id = p_old and email ~ '^tg-?[0-9]+@users\.dorozhka\.example$') then
    raise exception 'Старый журнал не найден';
  end if;
  if exists (select 1 from auth.identities where user_id = p_old and provider = 'google') then
    raise exception 'Старый журнал уже связан с Google';
  end if;
  select email, raw_user_meta_data into v_email, v_meta from auth.users where id = p_new;
  if v_email is null or not exists (select 1 from auth.identities where user_id = p_new and provider = 'google') then
    raise exception 'Аккаунт Google не найден';
  end if;
  -- Only an empty journal may be replaced: nothing the coach entered under Google is lost.
  select data into v_data from public.app_state where owner = p_new;
  if coalesce(jsonb_array_length(v_data -> 'clients'), 0) + coalesce(jsonb_array_length(v_data -> 'sessions'), 0)
     + coalesce(jsonb_array_length(v_data -> 'payments'), 0) > 0 then
    raise exception 'В журнале Google уже есть данные';
  end if;

  update auth.identities set user_id = p_old where user_id = p_new;
  -- Cascades to the new account's sessions, its empty journal and its link requests.
  delete from auth.users where id = p_new;
  delete from auth.identities where user_id = p_old and provider = 'email';
  update auth.users
     set email = v_email,
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"provider": "google", "providers": ["google"]}'::jsonb,
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || coalesce(v_meta, '{}'::jsonb),
         updated_at = now()
   where id = p_old;
end;
$$;
revoke all on function public.merge_into_legacy(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_into_legacy(uuid, uuid) to service_role;
