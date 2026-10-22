-- Receipt photos move out of the journal JSON into a private Storage bucket. Each coach's photos are under
-- <owner uuid>/<payment id>.<ext>; a coach can read and write only their own folder, the app shows a photo
-- through a short-lived signed URL. The telegram function (service role, bypasses RLS) reads them for the
-- monthly report and deletes them after sending or a year after the payment.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_owner_select on storage.objects;
drop policy if exists receipts_owner_insert on storage.objects;
drop policy if exists receipts_owner_update on storage.objects;
drop policy if exists receipts_owner_delete on storage.objects;
create policy receipts_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy receipts_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy receipts_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy receipts_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
-- Storage checks the coach's rights with these policies; the table rights themselves (Supabase grants them on
-- storage.objects by default) are stated here as well, as every table this project uses.
grant select, insert, update, delete on storage.objects to authenticated;

-- Once a day the function drops receipt photos older than a year (from the journals and from Storage).
select cron.unschedule(jobid) from cron.job where jobname = 'dorozhka-receipts-cleanup';
select cron.schedule(
  'dorozhka-receipts-cleanup',
  '47 3 * * *',
  $job$
  select net.http_post(
    url     := 'https://qzgiovxsucmaalrwdhha.supabase.co/functions/v1/telegram/cleanup',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-secret', (select value from private.secrets where name = 'cron')),
    body    := '{}'::jsonb
  );
  $job$
);
