-- The browser that asked for a login: the bot shows it (with the IP and time) before the coach confirms,
-- and again in the «Выполнен вход» notice.
alter table public.login_requests add column if not exists ua text;
