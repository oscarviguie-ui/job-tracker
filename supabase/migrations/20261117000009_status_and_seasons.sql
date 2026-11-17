-- One status per row instead of three tick boxes. The Excel's ticks become read-only facts derived from it:
--   To apply (saved) / Skipped           → not applied
--   Applied (also legacy no_response, withdrawn) → applied, no response yet
--   Rejected                             → applied, response, not positive
--   Interview / Offer / Accepted         → applied, response, positive
-- Dates still stamp themselves: moving past "To apply" sets the application date, getting a response sets the
-- response date, and moving back clears them.
create or replace function public.applications_touch() returns trigger
language plpgsql set search_path = '' as $$
declare today date := (now() at time zone 'Europe/Paris')::date;
begin
  new.updated_at := now();
  if new.season is null then
    select current_season into new.season from public.settings where id = 1;
  end if;
  new.applied   := new.status not in ('saved', 'skipped');
  new.responded := new.status in ('rejected', 'interview', 'offer', 'accepted');
  new.positive  := new.status in ('interview', 'offer', 'accepted');
  if new.applied and new.applied_on is null and (tg_op = 'INSERT' or not old.applied) then new.applied_on := today; end if;
  if not new.applied and tg_op = 'UPDATE' and old.applied then new.applied_on := null; end if;
  if new.responded and new.response_on is null and (tg_op = 'INSERT' or not old.responded) then new.response_on := today; end if;
  if not new.responded and tg_op = 'UPDATE' and old.responded then new.response_on := null; end if;
  return new;
end $$;
revoke execute on function public.applications_touch() from public, anon, authenticated;

-- Seasons: the current one lives in settings, so a new season can start empty.
alter table public.settings add column if not exists current_season smallint not null default 2;
alter table public.applications alter column season drop default;  -- filled by the trigger (NOT NULL is checked after it)

-- Season 1 rows never applied to are closed, not "to apply".
update public.applications set status = 'skipped' where season = 1 and status = 'saved';
