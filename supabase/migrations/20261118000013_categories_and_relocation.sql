-- Companies get a category (major, utility, bank, fund…) and a "big company" flag.
-- Geography: postings in your home locations come from every company; postings in your relocation cities
-- only from big companies (worth moving for).

alter table public.companies add column if not exists category text;
alter table public.companies add column if not exists big boolean not null default false;
alter table public.settings add column if not exists relocation_locations text[] not null default '{}';

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
           or exists (select 1 from unnest(s.locations) l where public.norm(p.location) ~ public.kw_regex(l))
           or (c.big and exists (select 1 from unnest(s.relocation_locations) l where public.norm(p.location) ~ public.kw_regex(l))))
  from public.companies c
  where c.id = p.company_id and (p_company_id is null or p.company_id = p_company_id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.rematch_postings(bigint) from public, anon;
grant execute on function public.rematch_postings(bigint) to authenticated, service_role;

-- Re-match a company's postings when its in_field or big flag changes.
drop trigger if exists companies_rematch on public.companies;
create trigger companies_rematch after update of in_field, big on public.companies
  for each row when (old.in_field is distinct from new.in_field or old.big is distinct from new.big)
  execute function public.companies_rematch();

update public.settings set relocation_locations = array[
  'London', 'United Kingdom', 'Geneva', 'Genève', 'Zurich', 'Zürich', 'Lausanne', 'Brussels', 'Bruxelles',
  'Amsterdam', 'Rotterdam', 'The Hague', 'Den Haag', 'Luxembourg', 'Madrid', 'Barcelona', 'Milan', 'Milano',
  'Copenhagen', 'København', 'Oslo', 'Stavanger', 'Stockholm', 'Düsseldorf', 'Essen', 'Frankfurt', 'Munich', 'München',
  'Calgary', 'Toronto', 'Montreal', 'Montréal', 'Vancouver', 'Ottawa', 'Edmonton', 'Canada']
where id = 1 and cardinality(relocation_locations) = 0;
