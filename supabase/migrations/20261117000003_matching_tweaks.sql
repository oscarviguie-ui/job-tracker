-- Workday lists multi-site postings as "2 Locations"; treat that like an unknown location so the title decides.
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
           or public.norm(p.location) ~ '^\d+ (locations?|sites?|lieux|emplacements?)$'
           or exists (select 1 from unnest(s.locations) l where public.norm(p.location) ~ public.kw_regex(l)))
  where p_company_id is null or p.company_id = p_company_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.rematch_postings(bigint) from public, anon;
grant execute on function public.rematch_postings(bigint) to authenticated, service_role;

-- Nudge pg_net's worker after queueing the daily batch so requests go out straight away.
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
  begin perform net.wake(); exception when others then null; end;
  return n;
end $$;
revoke execute on function public.scrape_all() from public, anon;
grant execute on function public.scrape_all() to authenticated, service_role;
