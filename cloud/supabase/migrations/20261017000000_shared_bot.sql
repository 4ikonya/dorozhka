-- Many coaches, one bot. The bot itself (token, name, webhook secret) moves to public.bot;
-- each coach is a row in telegram_links: their account and the Telegram chat they talk to the bot from.
-- Only the telegram function (service role) touches either table.
create table if not exists public.bot (
  id          boolean primary key default true check (id),
  token       text not null,
  bot_name    text not null,
  hook_secret text not null unique,
  created_at  timestamptz not null default now()
);
alter table public.bot enable row level security;
grant select, insert, update, delete on public.bot to service_role;

-- The bot the first coach connected becomes the shared one; its webhook keeps working as is.
insert into public.bot (token, bot_name, hook_secret)
  select token, bot_name, hook_secret from public.telegram_links
  where chat_id is not null and token is not null
  order by created_at limit 1
on conflict (id) do nothing;

alter table public.telegram_links
  alter column token drop not null,
  alter column bot_name drop not null,
  alter column hook_secret drop not null;
-- One Telegram chat belongs to one coach.
create unique index if not exists telegram_links_chat on public.telegram_links (chat_id);
