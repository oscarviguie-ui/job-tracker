-- Every scraped posting gets a category from its title (graduate programme, internship, VIE, apprenticeship, job)
-- and, when the title states it, a start date. The inbox lists postings by date posted (newest first), then start
-- date (soonest first), then category.

alter table public.postings add column if not exists kind text;
alter table public.postings add column if not exists starts text;      -- as the ad states it, tidied: "Feb 2027", "ASAP"
alter table public.postings add column if not exists starts_on date;   -- first day of that start, for ordering
-- Boards that don't publish a posting date fall back to the day the scraper first saw the ad.
alter table public.postings add column if not exists posted_sort date
  generated always as (coalesce(posted_at, (first_seen at time zone 'UTC')::date)) stored;
alter table public.postings add column if not exists kind_rank smallint
  generated always as (case kind when 'graduate' then 1 when 'internship' then 2 when 'vie' then 3 when 'job' then 4 else 5 end) stored;

-- Order matters: "Graduate Internship" is an internship, "Trainee Programme" a graduate programme,
-- "traineeship" (EU institutions) an internship. VIE must be written V.I.E or VIE in a title that isn't all capitals,
-- so the French word "vie" ("cycle de vie", "VIE SERIE") doesn't count.
create or replace function public.posting_kind(t text) returns text
language sql immutable set search_path = '' as $$
  select case
    when t ~ '\mV\.I\.E\M' or n ~ 'volontariat international' or (t ~ '\mVIE\M' and t <> upper(t)) then 'vie'
    when n ~ '\m(alternan|apprenti|work[- ]study|werkstudent|dual stud)' then 'apprenticeship'
    when n ~ '\m(stage\M|stagiaire|interns?\M|internships?\M|traineeships?\M|praktik|summer (analyst|associate|intern)|off[- ]cycle|placement year|industrial placement|fin d.etudes)' then 'internship'
    when n ~ '\m(graduates?\M|grad scheme|jeunes? diplome|trainee\M|trainees\M|rotational|young professionals?\M|early careers?\M|new grad|(analyst|associate|leadership|development|management) program)' then 'graduate'
    else 'job'
  end
  from (select public.norm(t) as n) x;
$$;

create or replace function public.rematch_postings(p_company_id bigint default null) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.settings; n int;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select * into s from public.settings where id = 1;
  update public.postings p set
    kind = public.posting_kind(p.title),
    score = (select count(*) from unnest(s.include_keywords || s.role_keywords) k where public.norm(p.title) ~ public.kw_regex(k)),
    matched =
      (cardinality(s.include_keywords) = 0 or c.in_field
         or exists (select 1 from unnest(s.include_keywords) k where public.norm(p.title) ~ public.kw_regex(k)))
      and (cardinality(s.role_keywords) = 0 or exists (select 1 from unnest(s.role_keywords) k where public.norm(p.title) ~ public.kw_regex(k)))
      and not exists (select 1 from unnest(s.exclude_keywords) k where public.norm(p.title) ~ public.kw_regex(k))
      and (cardinality(s.locations) = 0 or coalesce(p.location, '') = ''
           or public.norm(p.location) ~ '^\d+ (locations?|sites?|lieux|emplacements?)$'
           or exists (select 1 from unnest(s.locations) l where public.norm(p.location) ~ public.kw_regex(l)))
  from public.companies c
  where c.id = p.company_id and (p_company_id is null or p.company_id = p_company_id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.rematch_postings(bigint) from public, anon;
grant execute on function public.rematch_postings(bigint) to authenticated, service_role;

-- ingest_postings accepts optional `starts` / `starts_on` per posting; the web app also reads them from titles.
create or replace function public.ingest_postings(p_company_id bigint, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare run_start timestamptz := now(); first_run boolean; n_new int; n_total int; n_closed int;
begin
  first_run := not exists (select 1 from public.postings where company_id = p_company_id);

  with ins as (
    insert into public.postings (company_id, external_id, title, location, url, posted_at, starts, starts_on, baseline, first_seen, last_seen)
    select distinct on (i->>'external_id')
           p_company_id, i->>'external_id', left(i->>'title', 500), left(i->>'location', 300), i->>'url',
           nullif(i->>'posted_at', '')::date, nullif(i->>'starts', ''), nullif(i->>'starts_on', '')::date,
           first_run, run_start, run_start
    from jsonb_array_elements(p_items) i
    where coalesce(i->>'external_id', '') <> '' and coalesce(i->>'title', '') <> ''
    on conflict (company_id, external_id) do update set
      title = excluded.title, location = excluded.location, url = excluded.url,
      posted_at = coalesce(excluded.posted_at, public.postings.posted_at),
      starts = coalesce(excluded.starts, public.postings.starts),
      starts_on = coalesce(excluded.starts_on, public.postings.starts_on),
      last_seen = run_start, is_open = true
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) into n_new, n_total from ins;

  update public.postings set is_open = false
   where company_id = p_company_id and is_open and last_seen < run_start;
  get diagnostics n_closed = row_count;

  perform public.rematch_postings(p_company_id);

  update public.companies set last_run_at = run_start, last_status = case when n_total = 0 then 'empty' else 'ok' end,
         last_error = null, last_total = n_total, last_new = n_new
   where id = p_company_id;

  return jsonb_build_object('total', n_total, 'new', n_new, 'closed', n_closed, 'first_run', first_run);
end $$;
revoke execute on function public.ingest_postings(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_postings(bigint, jsonb) to service_role;

create index if not exists postings_inbox_order on public.postings (posted_sort desc, starts_on, kind_rank);

update public.postings set kind = public.posting_kind(title);
