-- Matching was too loose with one keyword list ("stage" alone let every internship through).
-- Titles now need a field keyword (energy, trading, climate…) AND a level keyword (stage, analyst, junior…).
-- A keyword in double quotes matches the whole word only: "market" no longer matches "marketing".

alter table public.settings add column if not exists role_keywords text[] not null default '{}';

create or replace function public.kw_regex(k text) returns text
language sql immutable set search_path = '' as $$
  select case
    when k ~ '^\s*".+"\s*$' then
      '\m' || regexp_replace(public.norm(btrim(k, ' "')), '([.\\+*?\[\]^$(){}=!<>|:/-])', '\\\1', 'g') || '\M'
    else
      '\m' || regexp_replace(public.norm(btrim(k)), '([.\\+*?\[\]^$(){}=!<>|:/-])', '\\\1', 'g')
  end;
$$;

create or replace function public.rematch_postings(p_company_id bigint default null) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.settings; n int;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select * into s from public.settings where id = 1;
  update public.postings p set
    score = (select count(*) from unnest(s.include_keywords || s.role_keywords) k where public.norm(p.title) ~ public.kw_regex(k)),
    matched =
      (cardinality(s.include_keywords) = 0 or exists (select 1 from unnest(s.include_keywords) k where public.norm(p.title) ~ public.kw_regex(k)))
      and (cardinality(s.role_keywords) = 0 or exists (select 1 from unnest(s.role_keywords) k where public.norm(p.title) ~ public.kw_regex(k)))
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

update public.settings set
  include_keywords = array[
    'energ', 'power', 'électricité', 'electricity', 'renewable', 'renouvelable', 'trading', 'trader',
    'origination', 'originator', 'structurer', 'structuring', 'sustainab', 'durable', 'carbon', 'décarbon',
    'climat', 'climate', '"market"', '"markets"', 'marché', 'marchés', 'commodit', 'matières premières',
    '"gas"', '"gaz"', 'LNG', 'GNL', 'hydrog', 'solaire', 'solar', 'wind', 'éolien', 'stockage', 'storage',
    'PPA', 'project finance', 'financement', 'finance', 'M&A', 'strat', 'transition', 'nucléaire', 'nuclear'],
  role_keywords = array[
    'stage', 'stagiaire', '"intern"', 'internship', 'trainee', 'analyst', 'analyste', 'graduate', 'junior',
    'jeune diplômé', 'fin d''études', 'fin d’études', '"VIE"', 'V.I.E', 'consultant', 'associate'],
  updated_at = now()
where id = 1;

select public.rematch_postings(null);
