-- The applications log mirrors the original Excel tracker: three tick boxes drive everything.
--   Applied            → stamps the application date (cleared when unticked)
--   Response Received  → stamps the response date (cleared when unticked)
--   Positive Response  → implies a response
-- status is kept in step for exports and the inbox, but the tick boxes are the source of truth.
alter table public.applications
  add column if not exists description text,
  add column if not exists applied boolean not null default false,
  add column if not exists responded boolean not null default false,
  add column if not exists positive boolean not null default false;

update public.applications set
  applied = status not in ('saved', 'skipped'),
  responded = status in ('rejected', 'interview', 'offer', 'accepted'),
  positive = status in ('interview', 'offer', 'accepted');

create or replace function public.applications_touch() returns trigger
language plpgsql set search_path = '' as $$
declare today date := (now() at time zone 'Europe/Paris')::date;
begin
  new.updated_at := now();
  if new.positive then new.responded := true; end if;
  if new.applied and new.applied_on is null
     and (tg_op = 'INSERT' or not old.applied) then new.applied_on := today; end if;
  if not new.applied and tg_op = 'UPDATE' and old.applied then new.applied_on := null; end if;
  if new.responded and new.response_on is null
     and (tg_op = 'INSERT' or not old.responded) then new.response_on := today; end if;
  if not new.responded and tg_op = 'UPDATE' and old.responded then new.response_on := null; end if;
  new.status := case
    when new.positive then case when new.status in ('offer', 'accepted') then new.status else 'interview' end
    when new.responded then 'rejected'
    when new.applied then case when new.status = 'withdrawn' then 'withdrawn' else 'applied' end
    else case when new.status = 'skipped' then 'skipped' else 'saved' end
  end;
  return new;
end $$;
revoke execute on function public.applications_touch() from public, anon, authenticated;

-- Links stored from HTML attributes sometimes kept "&amp;"; store the real address.
create or replace function public.postings_clean_url() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.url := replace(new.url, '&amp;', '&');
  return new;
end $$;
revoke execute on function public.postings_clean_url() from public, anon, authenticated;
drop trigger if exists postings_clean_url on public.postings;
create trigger postings_clean_url before insert or update of url on public.postings
  for each row execute function public.postings_clean_url();
update public.postings set url = replace(url, '&amp;', '&') where url like '%&amp;%';
