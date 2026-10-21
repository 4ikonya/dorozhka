-- The bot is shared (public.bot) since 20261017000000. The per-coach bot fields in telegram_links are left over from
-- the time every coach brought their own bot; the first coach's row still holds a copy of the bot token. Nothing
-- reads them any more: the service owner is marked by receipts_report. Remove the copy of the token.
update public.telegram_links set token = null, bot_name = null, hook_secret = null
 where token is not null or bot_name is not null or hook_secret is not null;
