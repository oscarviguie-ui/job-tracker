-- More ways to read careers sites: sitemaps and a headless browser give a title from the URL or link text and
-- no place. The background reader then opens each matching ad and fills in the real title and place.

-- A rerun must not wipe a place the reader found, and a sitemap's URL-made title must not replace the ad's own.
create or replace function public.ingest_postings(p_company_id bigint, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_start timestamptz := now(); first_run boolean; n_new int; n_total int; n_closed int;
  rough_titles boolean := (select ats in ('sitemap', 'browser') from public.companies where id = p_company_id);
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
      title = case when rough_titles then public.postings.title else excluded.title end,
      location = coalesce(excluded.location, public.postings.location), url = excluded.url,
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

-- The reader can now also give the ad's real title and place; matching is rerun for those companies.
create or replace function public.set_posting_details(p jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare n int; cos bigint[];
begin
  update public.postings po set
    starts = coalesce(x.starts, po.starts),
    starts_on = case when x.starts is not null then x.starts_on else po.starts_on end,
    summary = coalesce(x.summary, po.summary),
    posted_at = coalesce(po.posted_at, x.posted_at),
    title = coalesce(nullif(x.title, ''), po.title),
    location = coalesce(po.location, nullif(x.location, '')),
    start_checked = x.checked
  from jsonb_to_recordset(p) as x(id bigint, starts text, starts_on date, summary text, posted_at date, checked text, title text, location text)
  where po.id = x.id;
  get diagnostics n = row_count;
  select array_agg(distinct po.company_id) into cos
    from public.postings po join jsonb_to_recordset(p) as x(id bigint, title text, location text) on po.id = x.id
   where x.title is not null or x.location is not null;
  if cos is not null then perform public.rematch_postings(c) from unnest(cos) c; end if;
  return n;
end $$;
revoke execute on function public.set_posting_details(jsonb) from public, anon, authenticated;
grant execute on function public.set_posting_details(jsonb) to service_role;

-- Browser-read companies are filled by the GitHub Actions job, not by the scraper.
create or replace function public.scrape_all() returns int
language plpgsql security definer set search_path = '' as $$
declare c record; n int := 0; v_url text; v_secret text;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'scrape_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  for c in select id from public.companies where active and ats not in ('unknown', 'browser') loop
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('company_id', c.id),
      timeout_milliseconds := 120000);
    update public.companies set last_status = 'running' where id = c.id;
    n := n + 1;
  end loop;
  begin perform net.wake(); exception when others then null; end;
  return n;
end $$;
