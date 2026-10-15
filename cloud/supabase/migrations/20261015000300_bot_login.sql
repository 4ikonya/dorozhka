-- Login through the coach's Telegram bot. The site asks for a request, the coach confirms it in the
-- bot, and the site trades the approved request for a session. Only the telegram function touches it.
create table if not exists public.login_requests (
  nonce       text primary key,
  code        text not null,
  owner       uuid references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  used_at     timestamptz
);
alter table public.login_requests enable row level security;
grant select, insert, update, delete on public.login_requests to service_role;
