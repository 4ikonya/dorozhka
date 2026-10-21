-- One way to save a journal, for the app and for the telegram function alike:
--   public.save_state_for(owner, expected, new_data) — service role only (attendance buttons, dropping sent photos);
--   public.save_state(expected, new_data)           — the signed-in coach, for their own row.
-- Both check the shape and size of the document, the version, and keep the daily backup.
--
-- Size: receipt photos live in Storage (not in the document), so a journal is a few hundred KB even after years.
-- 2 MB leaves a wide margin. A document that is already bigger (old photos still inside) may still be saved as long
-- as it does not grow, so moving the photos out (which shrinks it) always works.
create or replace function public.save_state_for(p_owner uuid, expected integer, new_data jsonb)
returns table (new_version integer, is_conflict boolean, current_data jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  cur  public.app_state%rowtype;
  size integer := octet_length(new_data::text);
  max_size constant integer := 2 * 1024 * 1024;
begin
  if p_owner is null then
    raise exception 'no owner' using errcode = '22023';
  end if;
  if jsonb_typeof(new_data -> 'sessions') is distinct from 'array'
     or jsonb_typeof(new_data -> 'clients') is distinct from 'array'
     or jsonb_typeof(new_data -> 'payments') is distinct from 'array'
     or jsonb_typeof(new_data -> 'groups') is distinct from 'array' then
    raise exception 'invalid state' using errcode = '22023';
  end if;

  select * into cur from public.app_state s where s.owner = p_owner for update;

  if size > max_size and (not found or size > octet_length(cur.data::text)) then
    raise exception 'state too large: % bytes', size using errcode = '54000';
  end if;

  if not found then
    if expected <> 0 then
      return query select 0, true, null::jsonb;
      return;
    end if;
    insert into public.app_state (owner, data, version) values (p_owner, new_data, 1);
    return query select 1, false, null::jsonb;
    return;
  end if;

  if cur.version <> expected then
    return query select cur.version, true, cur.data;
    return;
  end if;

  insert into public.app_state_backups (owner, day, data)
    values (p_owner, current_date, cur.data)
    on conflict (owner, day) do nothing;
  delete from public.app_state_backups b where b.owner = p_owner and b.day < current_date - 30;

  update public.app_state s set data = new_data, version = cur.version + 1, updated_at = now()
    where s.owner = p_owner;
  return query select cur.version + 1, false, null::jsonb;
end;
$$;
revoke all on function public.save_state_for(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_state_for(uuid, integer, jsonb) to service_role;

create or replace function public.save_state(expected integer, new_data jsonb)
returns table (new_version integer, is_conflict boolean, current_data jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return query select * from public.save_state_for(me, expected, new_data);
end;
$$;
revoke all on function public.save_state(integer, jsonb) from public, anon;
grant execute on function public.save_state(integer, jsonb) to authenticated;
