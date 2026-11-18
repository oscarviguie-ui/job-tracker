-- Inbox filters: where a posting is (country and, for France, Canada and the UK, a region), when it starts, how old
-- it is, its company, sector and type, all multi-select, with counts. Plus a background job that reads the full ad
-- of each posting that matches your filters, for its start date and a one-line summary.

-- ── where ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Locations come in every shape ("Puteaux, IDF, France", "MONTREAL, QC, CAN", "CA-Calgary-Office", "London - Shell
-- Centre", "2 Locations"). Explicit country names win, then provinces and state codes, then city names.
create or replace function public.place_country(loc text) returns text
language sql immutable set search_path = '' as $$
  select case
    when n = '' then null
    when n ~ '^\s*\d+\s+(locations?|sites?|lieux|emplacements?|villes?)\s*$' then 'Several places'
    when n ~ '\m(canada|can)\M' then 'Canada'
    when n ~ '\m(united states|usa|u\.s\.a?|new mexico)\M' then 'United States'
    when n ~ '\m(united kingdom|great britain|england|scotland|wales|northern ireland|royaume-uni)\M' then 'United Kingdom'
    when n ~ '\mfrance\M' then 'France'
    when n ~ '\m(switzerland|suisse|schweiz|svizzera)\M' then 'Switzerland'
    when n ~ '\m(netherlands|nederland|pays-bas|holland)\M' then 'Netherlands'
    when n ~ '\m(germany|deutschland|allemagne)\M' then 'Germany'
    when n ~ '\m(belgium|belgique|belgie)\M' then 'Belgium'
    when n ~ '\mluxembourg\M' then 'Luxembourg'
    when n ~ '\m(spain|espana|espagne)\M' then 'Spain'
    when n ~ '\m(italy|italia|italie)\M' then 'Italy'
    when n ~ '\mportugal\M' then 'Portugal'
    when n ~ '\m(norway|norge|norvege)\M' then 'Norway'
    when n ~ '\m(sweden|sverige|suede)\M' then 'Sweden'
    when n ~ '\m(denmark|danmark|danemark)\M' then 'Denmark'
    when n ~ '\m(ireland|irlande)\M' then 'Ireland'
    when n ~ '\m(austria|osterreich|autriche)\M' then 'Austria'
    when n ~ '\m(poland|polska|pologne)\M' then 'Poland'
    when n ~ '\m(finland|suomi|finlande)\M' then 'Finland'
    when n ~ '\msingapore\M' then 'Singapore'
    when n ~ '\m(united arab emirates|uae|dubai|abu dhabi)\M' then 'United Arab Emirates'
    when n ~ '\m(saudi arabia|riyadh|dhahran)\M' then 'Saudi Arabia'
    when n ~ '\m(qatar|doha)\M' then 'Qatar'
    when n ~ '\m(india|mumbai|bangalore|bengaluru|pune|chennai|hyderabad|gurgaon|gurugram|new delhi|noida|dlf cybercity)\M' then 'India'
    when n ~ '\m(china|shanghai|beijing|shenzhen|hong kong)\M' then 'China'
    when n ~ '\m(japan|tokyo)\M' then 'Japan'
    when n ~ '\m(australia|sydney|melbourne|brisbane)\M' then 'Australia'
    when n ~ '\m(brazil|brasil|sao paulo|rio de janeiro|campinas|taubate)\M' then 'Brazil'
    when n ~ '\m(mexico|ciudad de mexico|cdmx|monterrey)\M' then 'Mexico'
    when n ~ '\m(philippines|manila|quezon|taguig|makati)\M' then 'Philippines'
    when n ~ '\m(morocco|maroc|casablanca|rabat)\M' then 'Morocco'
    when n ~ '\m(romania|roumanie|bucharest|bucuresti)\M' then 'Romania'
    when n ~ '\m(hungary|hongrie|budapest)\M' then 'Hungary'
    when n ~ '\m(turkey|turkiye|turquie|istanbul|ankara)\M' then 'Turkey'
    when n ~ '\m(indonesia|jakarta)\M' then 'Indonesia'
    when n ~ '\m(malaysia|kuala lumpur|putrajaya)\M' then 'Malaysia'
    when n ~ '\m(vietnam|viet nam|ho chi minh|hanoi|bac ninh)\M' then 'Vietnam'
    when n ~ '\m(bulgaria|sofia)\M' then 'Bulgaria'
    when n ~ '\m(argentina|buenos aires)\M' then 'Argentina'
    when n ~ '\m(chile|santiago)\M' then 'Chile'
    when n ~ '\m(colombia|bogota|medellin)\M' then 'Colombia'
    when n ~ '\m(peru|lima)\M' then 'Peru'
    when n ~ '\m(uruguay|montevideo)\M' then 'Uruguay'
    when n ~ '\m(greece|grece|athens)\M' then 'Greece'
    when n ~ '\m(slovakia|bratislava)\M' then 'Slovakia'
    when n ~ '\m(czech|czechia|prague|praha)\M' then 'Czechia'
    when n ~ '\m(cambodia|phnom penh)\M' then 'Cambodia'
    when n ~ '\m(thailand|bangkok)\M' then 'Thailand'
    when n ~ '\m(south korea|korea|seoul)\M' then 'South Korea'
    when n ~ '\m(taiwan|taipei)\M' then 'Taiwan'
    when n ~ '\m(israel|tel aviv)\M' then 'Israel'
    when n ~ '\m(egypt|cairo)\M' then 'Egypt'
    when n ~ '\m(south africa|johannesburg|cape town)\M' then 'South Africa'
    when n ~ '\m(nigeria|lagos)\M' then 'Nigeria'
    when n ~ '\m(kenya|nairobi)\M' then 'Kenya'
    when n ~ '\m(new zealand|auckland|wellington)\M' then 'New Zealand'
    when n ~ '\m(pennsylvania|new jersey|texas|california|new york|illinois|massachusetts|delaware|connecticut|georgia|virginia|north carolina|south carolina|ohio|michigan|colorado|louisiana|oklahoma|florida|arizona|minnesota|maryland|north dakota)\M' then 'United States'
    -- provinces, regions and codes
    when n ~ '\m(ontario|quebec|alberta|british columbia|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland)\M'
      or n ~ ',\s*(on|qc|ab|bc|mb|sk|ns|nb|nl)\M' or n ~ '^ca-' then 'Canada'
    when n ~ '\m(ile-de-france|idf)\M' or n ~ ',\s*fr\M' or n ~ '\m\d{2}\s*-\s*[a-z]' then 'France'
    when n ~ ',\s*(gb|uk)\M' then 'United Kingdom'
    when n ~ ',\s*(tx|ny|il|ma|wa|co|ga|nj|pa|ok|nc|va|dc|ca|la|ct|md|mn|oh|mi|az|fl|de|sc|nd)\M' then 'United States'
    -- cities
    when n ~ '\m(toronto|montreal|calgary|vancouver|ottawa|edmonton|longueuil|burlington|mississauga|winnipeg|halifax|brampton|oakville|markham|regina|saskatoon|levis)\M' then 'Canada'
    when n ~ '\m(houston|new york|brooklyn|chicago|boston|san francisco|san ramon|washington|denver|dallas|stamford|seattle|los angeles|pittsburgh|austin|philadelphia|schenectady|niskayuna|greenville|whippany|charlotte|atlanta|miami)\M' then 'United States'
    when n ~ '\m(london|canary wharf|manchester|aberdeen|edinburgh|glasgow|birmingham|bristol|leeds|knutsford|northampton|reading|swindon)\M' then 'United Kingdom'
    when n ~ '\m(geneva|geneve|genf|zurich|lausanne|basel|bale|zug|lugano|bern|berne)\M' then 'Switzerland'
    when n ~ '\m(amsterdam|rotterdam|the hague|den haag|la haye|utrecht|eindhoven|groningen|arnhem)\M' then 'Netherlands'
    when n ~ '\m(frankfurt|munich|munchen|dusseldorf|duesseldorf|essen|berlin|hamburg|cologne|koln|stuttgart|hannover|dortmund)\M' then 'Germany'
    when n ~ '\m(brussels|bruxelles|brussel|antwerp|anvers|antwerpen|ghent|gent|liege)\M' then 'Belgium'
    when n ~ '\m(madrid|barcelona|bilbao|valencia|sevilla|seville|boadilla)\M' then 'Spain'
    when n ~ '\m(milan|milano|rome|roma|turin|torino|genoa|genova)\M' then 'Italy'
    when n ~ '\m(oslo|stavanger|bergen)\M' then 'Norway'
    when n ~ '\m(stockholm|gothenburg|goteborg|malmo)\M' then 'Sweden'
    when n ~ '\m(copenhagen|kobenhavn|aarhus|fredericia)\M' then 'Denmark'
    when n ~ '\mdublin\M' then 'Ireland'
    when n ~ '\m(lisbon|lisboa|porto)\M' then 'Portugal'
    when n ~ '\m(vienna|wien)\M' then 'Austria'
    when n ~ '\m(warsaw|warszawa|krakow|katowice|elblag|wroclaw|gdansk)\M' then 'Poland'
    when n ~ '\m(helsinki|espoo)\M' then 'Finland'
    when n ~ '\m(paris|la defense|courbevoie|puteaux|nanterre|garenne|rueil|boulogne|issy|levallois|neuilly|montrouge|clichy|saint-denis|saint-ouen|massy|saclay|palaiseau|velizy|guyancourt|cergy|versailles|loges-en-josas|jouy|antony|arcueil|ivry|vitry|montreuil|pantin|lyon|villeurbanne|marseille|toulouse|nantes|bordeaux|lille|grenoble|sassenage|strasbourg|nice|montpellier|rennes|pau|le havre|rouen|dunkerque|fos-sur-mer|aix-en-provence|toulon|tours|orleans|dijon|clermont-ferrand|metz|nancy|reims|caen|angers|brest|la rochelle|saint-nazaire|cherbourg|cadarache|flamanville|belfort|mulhouse|annecy|chambery|avignon|nimes|perpignan|bayonne)\M' then 'France'
    when n ~ '\m(remote|teletravail|home[- ]?based|anywhere|virtual)\M' then 'Remote'
    else 'Other'
  end
  from (select public.norm(loc) as n) x;
$$;

create or replace function public.place_region(loc text) returns text
language sql immutable set search_path = '' as $$
  select case public.place_country(loc)
    when 'France' then case when n ~ '(paris|ile-de-france|\midf\M|la defense|courbevoie|puteaux|nanterre|garenne|rueil|boulogne|issy|levallois|neuilly|montrouge|clichy|saint-denis|saint-ouen|massy|saclay|palaiseau|velizy|guyancourt|cergy|versailles|loges-en-josas|jouy|antony|arcueil|ivry|vitry|montreuil|pantin|hauts-de-seine|yvelines|essonne|val-de-marne|seine-saint-denis|val-d.oise|seine-et-marne|\m(75|77|78|91|92|93|94|95)\s*-)'
                            then 'Paris area' else 'Elsewhere in France' end
    when 'Canada' then case
      when n ~ '\m(ontario|toronto|ottawa|burlington|mississauga|brampton|oakville|markham|london)\M' or n ~ ',\s*on\M' then 'Ontario'
      when n ~ '\m(quebec|montreal|longueuil|laval)\M' or n ~ ',\s*qc\M' then 'Québec'
      when n ~ '\m(alberta|calgary|edmonton)\M' or n ~ ',\s*ab\M' then 'Alberta'
      when n ~ '\m(british columbia|vancouver)\M' or n ~ ',\s*bc\M' then 'British Columbia'
      else 'Elsewhere in Canada' end
    when 'United Kingdom' then case when n ~ '\mlondon\M' then 'London' else 'Elsewhere in the UK' end
  end
  from (select public.norm(loc) as n) x;
$$;

alter table public.postings add column if not exists country text generated always as (public.place_country(location)) stored;
alter table public.postings add column if not exists region text generated always as (public.place_region(location)) stored;
-- From the full ad (see enrich_postings): a one-line summary, and how far the start date has been looked for.
alter table public.postings add column if not exists summary text;
alter table public.postings add column if not exists start_checked text check (start_checked in ('title', 'ad'));

-- ── the inbox, filtered ────────────────────────────────────────────────────────────────────────────────────────
-- p: { tab: new|all|dismissed, q, companies[], categories[], kinds[], places[], starts[], posted[] }. An absent or
-- empty list means no filter. places: "Country" or "Country|Region". starts: "YYYY-MM", "asap" or "none".
-- posted: today | yesterday | week (2–6 days) | lastweek (7–13) | month (14–30) | older.
-- Each facet's counts apply every filter except its own, so ticking a value never hides the alternatives.
-- Paused companies drop out of the inbox.
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
            when 'all' then po.is_open and c.active
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
revoke execute on function public.inbox(jsonb) from public, anon;
grant execute on function public.inbox(jsonb) to authenticated;

-- ── reading the full ad ────────────────────────────────────────────────────────────────────────────────────────
-- The extract function, called with { enrich }, reads start dates from every new title, then opens the full ad of
-- the newest postings that match your filters (a few dozen per call) for their start date and a summary.
-- set_posting_details writes its results back in bulk.
create or replace function public.set_posting_details(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.postings po set
    starts = coalesce(x.starts, po.starts),
    starts_on = case when x.starts is not null then x.starts_on else po.starts_on end,
    summary = coalesce(x.summary, po.summary),
    posted_at = coalesce(po.posted_at, x.posted_at),
    start_checked = x.checked
  from jsonb_to_recordset(p) as x(id bigint, starts text, starts_on date, summary text, posted_at date, checked text)
  where po.id = x.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.set_posting_details(jsonb) from public, anon, authenticated;
grant execute on function public.set_posting_details(jsonb) to service_role;

create or replace function public.enrich_postings() returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  if (select auth.uid()) is not null and not public.is_owner() then raise exception 'not allowed'; end if;
  select replace(decrypted_secret, '/scrape', '/extract') into v_url from vault.decrypted_secrets where name = 'scrape_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  return net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('enrich', jsonb_build_object('limit', 30)), timeout_milliseconds := 140000);
end $$;
revoke execute on function public.enrich_postings() from public, anon;
grant execute on function public.enrich_postings() to authenticated;

-- Every 10 minutes: cheap when there's nothing to read, and new postings get their details within the hour.
select cron.unschedule('enrich-postings') where exists (select 1 from cron.job where jobname = 'enrich-postings');
select cron.schedule('enrich-postings', '*/10 * * * *', 'select public.enrich_postings()');
