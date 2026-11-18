-- Matching was one regex per keyword per posting, which timed out once ~80 boards were scraped at the same time.
-- Each keyword list is now compiled into one alternation, titles and locations are normalised once per posting,
-- the per-keyword score is only counted for matched postings, and unchanged rows aren't rewritten.

create or replace function public.rematch_postings(p_company_id bigint default null) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.settings; n int; inc text; rol text; exc text; loc text; rel text;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select * into s from public.settings where id = 1;
  select string_agg('(?:' || public.kw_regex(k) || ')', '|') into inc from unnest(s.include_keywords) k;
  select string_agg('(?:' || public.kw_regex(k) || ')', '|') into rol from unnest(s.role_keywords) k;
  select string_agg('(?:' || public.kw_regex(k) || ')', '|') into exc from unnest(s.exclude_keywords) k;
  select string_agg('(?:' || public.kw_regex(k) || ')', '|') into loc from unnest(s.locations) k;
  select string_agg('(?:' || public.kw_regex(k) || ')', '|') into rel from unnest(s.relocation_locations) k;

  update public.postings p set kind = v.kind, matched = v.ok,
    score = case when v.ok then (select count(*) from unnest(s.include_keywords || s.role_keywords) k where v.t ~ public.kw_regex(k)) else 0 end
  from (
    select q.id, q.t, public.posting_kind(q.title) as kind,
      (inc is null or q.in_field or q.t ~ inc)
      and (rol is null or q.t ~ rol)
      and (exc is null or q.t !~ exc)
      and (loc is null or q.l = '' or q.l ~ '^\d+ (locations?|sites?|lieux|emplacements?)$' or q.l ~ loc
           or (q.big and rel is not null and q.l ~ rel)) as ok
    from (
      select x.id, x.title, c.in_field, c.big, public.norm(x.title) as t, public.norm(coalesce(x.location, '')) as l
      from public.postings x join public.companies c on c.id = x.company_id
      where p_company_id is null or x.company_id = p_company_id
    ) q
  ) v
  where p.id = v.id and (p.matched is distinct from v.ok or p.kind is distinct from v.kind or (v.ok and (p.score = 0 or p_company_id is null)));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.rematch_postings(bigint) from public, anon;
grant execute on function public.rematch_postings(bigint) to authenticated, service_role;
