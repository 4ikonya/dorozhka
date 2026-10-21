-- sent_reminders only has to remember a key while the message could still be due: reminders, attendance buttons,
-- the digest and the 21:00 nudge are all within a day, so three days is plenty. receipts:YYYY-MM is checked on the
-- 20th–22nd of its month, keep it for a year so a report is never sent twice. Cleaned once a day at 03:17 UTC.
select cron.unschedule(jobid) from cron.job where jobname = 'dorozhka-sent-reminders-cleanup';
select cron.schedule(
  'dorozhka-sent-reminders-cleanup',
  '17 3 * * *',
  $job$
  delete from public.sent_reminders
   where (key not like 'receipts:%' and sent_at < now() - interval '3 days')
      or sent_at < now() - interval '400 days';
  $job$
);

-- A coach who blocked the bot: Telegram answers 403 and the tick stops trying until the coach writes to the bot again.
alter table public.telegram_links add column if not exists blocked_at timestamptz;
