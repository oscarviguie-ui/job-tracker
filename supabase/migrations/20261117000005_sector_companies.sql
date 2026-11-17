-- At energy specialists (Aurora, Greensolver…) titles rarely say "energy": "Advisory Analyst" is already in the field.
-- For companies flagged in_field, only the level keywords, exclusions and locations apply.
alter table public.companies add column if not exists in_field boolean not null default false;

create or replace function public.rematch_postings(p_company_id bigint default null) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.settings; n int;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select * into s from public.settings where id = 1;
  update public.postings p set
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

-- Re-match a company's postings when its in_field flag changes.
create or replace function public.companies_rematch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.rematch_postings(new.id);
  return new;
end $$;
drop trigger if exists companies_rematch on public.companies;
create trigger companies_rematch after update of in_field on public.companies
  for each row when (old.in_field is distinct from new.in_field) execute function public.companies_rematch();

update public.settings set include_keywords =
  array_remove(include_keywords, 'hydrog') || array['hydrogen', 'hydrogène', '"EnR"']
where id = 1 and 'hydrog' = any(include_keywords);
