-- «Дорожка» for one coach. The app keeps its whole state as one JSON document per owner,
-- the same shape the laptop version stores in SQLite, so data moves over unchanged.

create table if not exists public.app_state (
  owner      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null,
  version    integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;
create policy app_state_owner_read on public.app_state
  for select to authenticated using (owner = auth.uid());

-- One snapshot per day, kept 30 days, written by save_state.
create table if not exists public.app_state_backups (
  owner uuid not null references auth.users (id) on delete cascade,
  day   date not null,
  data  jsonb not null,
  primary key (owner, day)
);
alter table public.app_state_backups enable row level security;
create policy app_state_backups_owner_read on public.app_state_backups
  for select to authenticated using (owner = auth.uid());

-- Bot token and chat. No client policies: only the telegram function (service role) touches it.
create table if not exists public.telegram_links (
  owner       uuid primary key references auth.users (id) on delete cascade,
  token       text not null,
  bot_name    text not null,
  chat_id     bigint,
  hook_secret text not null unique,
  created_at  timestamptz not null default now()
);
alter table public.telegram_links enable row level security;

create table if not exists public.sent_reminders (
  owner   uuid not null references auth.users (id) on delete cascade,
  key     text not null,
  sent_at timestamptz not null default now(),
  primary key (owner, key)
);
alter table public.sent_reminders enable row level security;

-- Save with optimistic concurrency. Returns the new version, or the stored row when another
-- device saved first (is_conflict = true), so the app can show the fresher data.
create or replace function public.save_state(expected integer, new_data jsonb)
returns table (new_version integer, is_conflict boolean, current_data jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  me  uuid := auth.uid();
  cur public.app_state%rowtype;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(new_data -> 'sessions') is distinct from 'array'
     or jsonb_typeof(new_data -> 'clients') is distinct from 'array' then
    raise exception 'invalid state' using errcode = '22023';
  end if;

  select * into cur from public.app_state s where s.owner = me for update;

  if not found then
    if expected <> 0 then
      return query select 0, true, null::jsonb;
      return;
    end if;
    insert into public.app_state (owner, data, version) values (me, new_data, 1);
    return query select 1, false, null::jsonb;
    return;
  end if;

  if cur.version <> expected then
    return query select cur.version, true, cur.data;
    return;
  end if;

  insert into public.app_state_backups (owner, day, data)
    values (me, current_date, cur.data)
    on conflict (owner, day) do nothing;
  delete from public.app_state_backups b where b.owner = me and b.day < current_date - 30;

  update public.app_state s set data = new_data, version = cur.version + 1, updated_at = now()
    where s.owner = me;
  return query select cur.version + 1, false, null::jsonb;
end;
$$;

revoke all on function public.save_state(integer, jsonb) from public, anon;
grant execute on function public.save_state(integer, jsonb) to authenticated;
