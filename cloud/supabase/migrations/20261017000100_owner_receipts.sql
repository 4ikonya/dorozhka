-- The monthly receipts report is a personal feature of the first coach (the service owner), not offered to others.
-- The owner is the coach who connected the bot before it became shared (their link still carries the token).
alter table public.telegram_links add column if not exists receipts_report boolean not null default false;
update public.telegram_links set receipts_report = true where token is not null;
