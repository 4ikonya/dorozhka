-- Wrong 6-digit login codes typed in the bot, per chat: at most 5 in 10 minutes (see the telegram function).
-- Rows older than a day are deleted by the function. Only the function (service role) touches the table.
create table if not exists public.login_code_failures (
  chat_id bigint not null,
  at      timestamptz not null default now()
);
create index if not exists login_code_failures_chat_at on public.login_code_failures (chat_id, at);
alter table public.login_code_failures enable row level security;
grant select, insert, delete on public.login_code_failures to service_role;
