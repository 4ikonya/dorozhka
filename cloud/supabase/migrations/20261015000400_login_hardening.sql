-- Login attempts are limited per caller address (see the telegram function).
alter table public.login_requests add column if not exists ip text;
create index if not exists login_requests_ip_created on public.login_requests (ip, created_at);

-- The app talks to the database only through RLS-checked reads and save_state.
-- TRUNCATE ignores RLS, so take it (and the other unused table rights) away from the API roles.
revoke truncate, trigger, references, maintain on all tables in schema public from anon, authenticated;
