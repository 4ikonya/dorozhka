-- This project does not grant table rights to the API roles by default, so grant them here.
-- The coach's app only reads its own rows (RLS still applies); writes go through save_state.
grant select on public.app_state, public.app_state_backups to authenticated;

-- The telegram function uses the service role for everything it reads and writes.
grant select, insert, update, delete on
  public.app_state, public.app_state_backups, public.telegram_links, public.sent_reminders
  to service_role;
