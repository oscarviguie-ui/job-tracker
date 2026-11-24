-- 1. A status for postings that closed before you applied: "Missed". Like Skipped, it doesn't count as applied.
alter table public.applications drop constraint applications_status_check;
alter table public.applications add constraint applications_status_check check (status = any (array[
  'saved', 'applied', 'interview', 'offer', 'accepted', 'rejected', 'no_response', 'withdrawn', 'skipped', 'missed']));

create or replace function public.applications_touch() returns trigger
language plpgsql set search_path = '' as $$
declare today date := (now() at time zone 'Europe/Paris')::date;
begin
  new.updated_at := now();
  if new.season is null then
    select current_season into new.season from public.settings where id = 1;
  end if;
  new.applied   := new.status not in ('saved', 'skipped', 'missed');
  new.responded := new.status in ('rejected', 'interview', 'offer', 'accepted');
  new.positive  := new.status in ('interview', 'offer', 'accepted');
  if new.applied and new.applied_on is null and (tg_op = 'INSERT' or not old.applied) then new.applied_on := today; end if;
  if not new.applied and tg_op = 'UPDATE' and old.applied then new.applied_on := null; end if;
  if new.responded and new.response_on is null and (tg_op = 'INSERT' or not old.responded) then new.response_on := today; end if;
  if not new.responded and tg_op = 'UPDATE' and old.responded then new.response_on := null; end if;
  return new;
end $$;

-- 2. A job in your log leaves the inbox, however it got there (Track button, pasted link, typed by hand).
-- The same ad often has several addresses (language prefix, tracking parameters), so links are compared on a key:
-- host and path without language segments, plus a job-id parameter if the address carries one.
create or replace function public.url_key(u text) returns text
language sql immutable set search_path = '' as $$
  select nullif(
    regexp_replace(regexp_replace(regexp_replace(
      lower(split_part(split_part(regexp_replace(btrim(coalesce(u, '')), '^[a-z]+://(www\.)?', '', 'i'), '#', 1), '?', 1)),
      '/[a-z]{2}[-_][a-z]{2}(?=/|$)', '', 'g'), '/+$', ''), '&amp;', '&', 'g')
    || coalesce('?' || lower(substring(lower(u) from '[?&]((?:gh_jid|jobid|job_id|jid|reqid|req_id|id)=[^&#]+)')), ''),
  '');
$$;
create index if not exists postings_url_key on public.postings (public.url_key(url));

create or replace function public.link_application_posting() returns trigger
language plpgsql security definer set search_path = '' as $$
declare co bigint := coalesce(new.company_id, (select id from public.companies where lower(name) = lower(new.company) limit 1));
begin
  -- Three separate matches, so each can use its index.
  update public.postings set state = 'tracked', application_id = new.id where id = new.posting_id and state <> 'tracked';
  if new.url is not null then
    update public.postings set state = 'tracked', application_id = new.id
     where public.url_key(url) = public.url_key(new.url) and state <> 'tracked';
  end if;
  if co is not null and coalesce(new.role, '') <> '' then
    update public.postings set state = 'tracked', application_id = new.id
     where company_id = co and public.norm(title) = public.norm(new.role) and state <> 'tracked';
  end if;
  return null;
end $$;
drop trigger if exists applications_link_posting on public.applications;
create trigger applications_link_posting after insert or update of url, role, company, company_id, posting_id on public.applications
  for each row execute function public.link_application_posting();

-- Deleting a row from the log puts its posting back in the inbox.
create or replace function public.unlink_application_posting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.postings set state = 'new', application_id = null where application_id = old.id and state = 'tracked';
  return old;
end $$;
drop trigger if exists applications_unlink_posting on public.applications;
create trigger applications_unlink_posting before delete on public.applications
  for each row execute function public.unlink_application_posting();

revoke all on function public.link_application_posting() from public, anon, authenticated;
revoke all on function public.unlink_application_posting() from public, anon, authenticated;

-- Link what's already in the log (without touching the log rows themselves).
update public.postings po set state = 'tracked', application_id = a.id
  from public.applications a where po.id = a.posting_id and po.state <> 'tracked';
update public.postings po set state = 'tracked', application_id = a.id
  from (select id, public.url_key(url) k from public.applications where url is not null) a
 where public.url_key(po.url) = a.k and po.state <> 'tracked';
update public.postings po set state = 'tracked', application_id = a.id
  from (select a.id, a.role, coalesce(a.company_id, (select c.id from public.companies c where lower(c.name) = lower(a.company) limit 1)) co
          from public.applications a where coalesce(a.role, '') <> '') a
 where po.company_id = a.co and public.norm(po.title) = public.norm(a.role) and po.state <> 'tracked';

-- 3. Tracked postings no longer appear in "All open postings" either: they live in the log.
create or replace function public.inbox(p jsonb) returns jsonb
language sql stable set search_path = '' as $$
  with prm as (
    select coalesce(p->>'tab', 'new') as tab, nullif(btrim(p->>'q'), '') as q,
      (select array_agg(x::bigint) from jsonb_array_elements_text(p->'companies') x) as cos,
      (select array_agg(x) from jsonb_array_elements_text(p->'categories') x) as cats,
      (select array_agg(x) from jsonb_array_elements_text(p->'kinds') x) as kinds,
      (select array_agg(x) from jsonb_array_elements_text(p->'places') x) as places,
      (select array_agg(x) from jsonb_array_elements_text(p->'starts') x) as starts,
      (select array_agg(x) from jsonb_array_elements_text(p->'posted') x) as posted,
      (now() at time zone 'Europe/Paris')::date as today
  ),
  base as (
    select po.id, po.company_id, c.name as company, coalesce(c.category, '') as category, po.title, po.location,
      po.country, po.region, po.url, po.posted_at, po.first_seen, po.posted_sort, po.starts, po.starts_on, po.kind,
      po.kind_rank, po.score, po.state, po.matched, po.is_open, po.baseline, po.summary, po.application_id,
      case when po.starts = 'ASAP' then 'asap' when po.starts_on is null then 'none' else to_char(po.starts_on, 'YYYY-MM') end as skey,
      case when prm.today - po.posted_sort <= 0 then 'today' when prm.today - po.posted_sort = 1 then 'yesterday'
           when prm.today - po.posted_sort <= 6 then 'week' when prm.today - po.posted_sort <= 13 then 'lastweek'
           when prm.today - po.posted_sort <= 30 then 'month' else 'older' end as pkey
    from public.postings po join public.companies c on c.id = po.company_id, prm
    where case prm.tab
            when 'dismissed' then po.state = 'dismissed'
            when 'all' then po.is_open and c.active and po.state <> 'tracked'
            else po.state = 'new' and po.matched and po.is_open and c.active end
      and (prm.q is null or public.norm(po.title) like '%' || public.norm(prm.q) || '%' or public.norm(c.name) like '%' || public.norm(prm.q) || '%')
  ),
  m as materialized (
    select b.*,
      (prm.cos is null or b.company_id = any(prm.cos)) as fc,
      (prm.cats is null or b.category = any(prm.cats)) as fg,
      (prm.kinds is null or b.kind = any(prm.kinds)) as fk,
      (prm.places is null or coalesce(b.country, '') = any(prm.places) or coalesce(b.country, '') || '|' || coalesce(b.region, '') = any(prm.places)) as fp,
      (prm.starts is null or b.skey = any(prm.starts)) as fs,
      (prm.posted is null or b.pkey = any(prm.posted)) as ft
    from base b, prm
  )
  select jsonb_build_object(
    'total', (select count(*) from m where fc and fg and fk and fp and fs and ft),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) - 'fc' - 'fg' - 'fk' - 'fp' - 'fs' - 'ft') from (
        select * from m where fc and fg and fk and fp and fs and ft
        order by posted_sort desc, starts_on nulls last, kind_rank, score desc limit 300) r), '[]'::jsonb),
    'facets', jsonb_build_object(
      'companies', coalesce((select jsonb_object_agg(company_id, n) from (select company_id, count(*) n from m where fg and fk and fp and fs and ft group by 1) x), '{}'::jsonb),
      'categories', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from m where fc and fk and fp and fs and ft group by 1) x), '{}'::jsonb),
      'kinds', coalesce((select jsonb_object_agg(coalesce(kind, 'job'), n) from (select kind, count(*) n from m where fc and fg and fp and fs and ft group by 1) x), '{}'::jsonb),
      'places', coalesce((select jsonb_agg(jsonb_build_array(country, region, n)) from (select coalesce(country, '') country, region, count(*) n from m where fc and fg and fk and fs and ft group by 1, 2) x), '[]'::jsonb),
      'starts', coalesce((select jsonb_object_agg(skey, n) from (select skey, count(*) n from m where fc and fg and fk and fp and ft group by 1) x), '{}'::jsonb),
      'posted', coalesce((select jsonb_object_agg(pkey, n) from (select pkey, count(*) n from m where fc and fg and fk and fp and fs group by 1) x), '{}'::jsonb)
    ));
$$;
