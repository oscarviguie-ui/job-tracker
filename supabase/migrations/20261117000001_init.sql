-- Job Tracker — schema, security, matching and scheduling
-- Single-owner app: the first account created becomes the owner; every table is owner-only.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ───────────────────────────── ownership ─────────────────────────────
create table public.app_owner (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_owner enable row level security;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;

-- First account ever created claims the app. Later sign-ups get nothing.
create or replace function public.claim_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.app_owner (user_id)
  select new.id where not exists (select 1 from public.app_owner);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.claim_owner();

create policy "owner reads own row" on public.app_owner for select to authenticated
  using (user_id = (select auth.uid()));

-- ───────────────────────────── settings ─────────────────────────────
create table public.settings (
  id               int primary key default 1 check (id = 1),
  include_keywords text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  locations        text[] not null default '{}',
  follow_up_days   int    not null default 14,
  updated_at       timestamptz not null default now()
);
insert into public.settings (id, include_keywords, exclude_keywords, locations) values (1,
  array['analyst','analyste','graduate','junior','jeune diplômé','VIE','V.I.E','consultant','energy','énergie','power','électricité','electricity','renewable','renouvelable','trading','trader','origination','originator','structurer','structuring','sustainability','carbon','carbone','climat','climate','market','marché','project finance','financement','stage','intern','stagiaire'],
  array['senior','director','directeur','directrice','head of','principal','expérimenté','experienced','apprenti','alternance','alternant','apprenticeship'],
  array['France','Paris','Île-de-France','Ile-de-France','Hauts-de-Seine','La Défense','Courbevoie','Nanterre','Puteaux','Rueil','Issy','Boulogne','Montreuil','Saint-Denis','Levallois','Neuilly','La Garenne','Remote','Genève','Geneva','Bruxelles','Brussels','Madrid']
);
alter table public.settings enable row level security;
create policy "owner all" on public.settings for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ───────────────────────────── companies ─────────────────────────────
create table public.companies (
  id           bigint generated always as identity primary key,
  name         text not null,
  careers_url  text,
  ats          text not null default 'unknown'
               check (ats in ('workday','smartrecruiters','greenhouse','lever','ashby','recruitee','teamtailor','personio','oracle','successfactors','links','unknown')),
  config       jsonb not null default '{}'::jsonb,   -- adapter parameters (host, tenant, site, company, base, url, pattern…)
  search       text,                                  -- optional keyword narrowing at the source (large boards)
  country      text,                                  -- optional country narrowing at the source, e.g. 'France'
  active       boolean not null default true,
  notes        text,
  last_run_at  timestamptz,
  last_status  text not null default 'never' check (last_status in ('never','ok','empty','error','unsupported','running')),
  last_error   text,
  last_total   int,
  last_new     int,
  created_at   timestamptz not null default now()
);
alter table public.companies enable row level security;
create policy "owner all" on public.companies for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ───────────────────────────── postings ─────────────────────────────
create table public.postings (
  id             bigint generated always as identity primary key,
  company_id     bigint not null references public.companies on delete cascade,
  external_id    text not null,
  title          text not null,
  location       text,
  url            text,
  posted_at      date,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  is_open        boolean not null default true,
  baseline       boolean not null default false,      -- already open when the company was first scraped
  matched        boolean not null default false,
  score          int not null default 0,
  state          text not null default 'new' check (state in ('new','tracked','dismissed')),
  application_id bigint,
  unique (company_id, external_id)
);
create index postings_inbox_idx on public.postings (state, matched, is_open, first_seen desc);
alter table public.postings enable row level security;
create policy "owner all" on public.postings for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ───────────────────────────── applications ─────────────────────────────
create table public.applications (
  id            bigint generated always as identity primary key,
  company       text not null,
  company_id    bigint references public.companies on delete set null,
  posting_id    bigint references public.postings on delete set null,
  role          text,
  contract      text,          -- Stage, CDI, CDD, VIE, Graduate, Alternance…
  location      text,
  url           text,
  status        text not null default 'saved'
                check (status in ('saved','applied','interview','offer','accepted','rejected','no_response','withdrawn','skipped')),
  priority      smallint not null default 2 check (priority between 1 and 3),
  date_posted   date,
  applied_on    date,
  response_on   date,
  follow_up_on  date,
  next_step     text,
  contact       text,
  documents     text,          -- CV / cover-letter version sent
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.postings add constraint postings_application_fk
  foreign key (application_id) references public.applications on delete set null;
create index applications_status_idx on public.applications (status);
alter table public.applications enable row level security;
create policy "owner all" on public.applications for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

create table public.application_events (
  id             bigint generated always as identity primary key,
  application_id bigint not null references public.applications on delete cascade,
  at             timestamptz not null default now(),
  kind           text not null check (kind in ('status','note','created')),
  from_status    text,
  to_status      text,
  note           text
);
create index application_events_app_idx on public.application_events (application_id, at desc);
alter table public.application_events enable row level security;
create policy "owner all" on public.application_events for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- Keep dates and the timeline in sync with status changes.
create or replace function public.applications_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'applied' and new.applied_on is null then new.applied_on := current_date; end if;
    if old.status = 'applied' and new.status in ('interview','offer','rejected') and new.response_on is null then
      new.response_on := current_date;
    end if;
  elsif tg_op = 'INSERT' and new.status = 'applied' and new.applied_on is null then
    new.applied_on := current_date;
  end if;
  return new;
end $$;
create trigger applications_touch before insert or update on public.applications
  for each row execute function public.applications_touch();

create or replace function public.applications_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_events (application_id, kind, to_status) values (new.id, 'created', new.status);
  elsif new.status is distinct from old.status then
    insert into public.application_events (application_id, kind, from_status, to_status) values (new.id, 'status', old.status, new.status);
  end if;
  return null;
end $$;
create trigger applications_log after insert or update on public.applications
  for each row execute function public.applications_log();

-- ───────────────────────────── matching ─────────────────────────────
-- Accent- and case-insensitive; keywords match at the start of a word ("analyst" matches "analystes").
create or replace function public.norm(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(extensions.unaccent(coalesce(t, '')));
$$;

create or replace function public.kw_regex(k text) returns text
language sql immutable set search_path = '' as $$
  select '\m' || regexp_replace(public.norm(k), '([.\\+*?\[\]^$(){}=!<>|:/-])', '\\\1', 'g');
$$;

create or replace function public.rematch_postings(p_company_id bigint default null) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.settings; n int;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select * into s from public.settings where id = 1;
  update public.postings p set
    score = (select count(*) from unnest(s.include_keywords) k where public.norm(p.title) ~ public.kw_regex(k)),
    matched =
      (cardinality(s.include_keywords) = 0 or exists (select 1 from unnest(s.include_keywords) k where public.norm(p.title) ~ public.kw_regex(k)))
      and not exists (select 1 from unnest(s.exclude_keywords) k where public.norm(p.title) ~ public.kw_regex(k))
      and (cardinality(s.locations) = 0 or coalesce(p.location, '') = ''
           or exists (select 1 from unnest(s.locations) l where public.norm(p.location) ~ public.kw_regex(l)))
  where p_company_id is null or p.company_id = p_company_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────────────────────── ingestion (called by the scraper) ─────────────────────────────
create or replace function public.ingest_postings(p_company_id bigint, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare run_start timestamptz := now(); first_run boolean; n_new int; n_total int; n_closed int;
begin
  first_run := not exists (select 1 from public.postings where company_id = p_company_id);

  with ins as (
    insert into public.postings (company_id, external_id, title, location, url, posted_at, baseline, first_seen, last_seen)
    select distinct on (i->>'external_id')
           p_company_id, i->>'external_id', left(i->>'title', 500), left(i->>'location', 300), i->>'url',
           nullif(i->>'posted_at', '')::date, first_run, run_start, run_start
    from jsonb_array_elements(p_items) i
    where coalesce(i->>'external_id', '') <> '' and coalesce(i->>'title', '') <> ''
    on conflict (company_id, external_id) do update set
      title = excluded.title, location = excluded.location, url = excluded.url,
      posted_at = coalesce(excluded.posted_at, public.postings.posted_at),
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

-- ───────────────────────────── scheduling ─────────────────────────────
-- The scraper URL and shared secret live in Vault (secrets 'scrape_url' and 'cron_secret').
create or replace function public.scrape_all() returns int
language plpgsql security definer set search_path = '' as $$
declare c record; n int := 0; v_url text; v_secret text;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'scrape_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  for c in select id from public.companies where active and ats not in ('unknown') loop
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('company_id', c.id),
      timeout_milliseconds := 120000);
    update public.companies set last_status = 'running' where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.scrape_all() from public, anon;
grant execute on function public.scrape_all() to authenticated;
revoke execute on function public.rematch_postings(bigint) from public, anon;
grant execute on function public.rematch_postings(bigint) to authenticated, service_role;
grant execute on function public.scrape_all() to service_role;

-- 05:30 UTC = 06:30 Paris (winter) / 07:30 (summer)
select cron.schedule('scrape-all-daily', '30 5 * * *', $$ select public.scrape_all(); $$);

-- The scraper verifies the scheduler's shared secret against Vault (no secret stored in the function's env).
create or replace function public.check_cron_secret(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;
