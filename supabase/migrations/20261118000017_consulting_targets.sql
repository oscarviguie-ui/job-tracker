-- Consulting firms with energy or oil & gas practices, and the keywords that let their titles through.
-- "Energy consulting" holds the specialists (energy-market, reserves and transition advisers); "Consulting" the
-- strategy houses, Big Four and others with an energy practice. Boards were found with the scrape function's
-- detect mode; firms whose sites build their job list in the browser are kept as "check by hand" links.
-- Huge shared boards are narrowed: Oliver Wyman and NERA share Marsh McLennan's Workday (search by name),
-- PwC's campus board is limited to France, Accenture and Guidehouse to "energy".

update public.settings set include_keywords = include_keywords || array(
  select k from unnest(array['oil','"O&G"','petrol','pétrole','pétrolier','upstream','midstream','downstream','hydrocarbure',
    'refinery','raffinerie','utilities','utility','"E&U"','"energy & utilities"']) k
  where k <> all(include_keywords))
where id = 1;

update public.companies set category = 'Energy consulting' where name in ('AFRY', 'Greensolver');

insert into public.companies (name, careers_url, ats, config, category, in_field, big, search, country)
select v.* from (values
  ('E-CUBE Strategy Consultants', 'https://www.e-cube.com/carrieres/', 'unknown', '{}'::jsonb, 'Energy consulting', true, false, null, null),
  ('Blunomy (ex-Enea Consulting)', 'https://www.welcometothejungle.com/fr/companies/enea-consulting/jobs', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Baringa', 'https://job-boards.eu.greenhouse.io/baringa', 'greenhouse', '{"board": "baringa"}', 'Energy consulting', false, true, null, null),
  ('Cornwall Insight', 'https://cornwallinsight.pinpointhq.com', 'pinpoint', '{"base": "https://cornwallinsight.pinpointhq.com"}', 'Energy consulting', true, false, null, null),
  ('LCP Delta', 'https://www.lcp.com/en/careers', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Frontier Economics', 'https://www.frontier-economics.com/uk/en/careers/vacancies-and-apply/', 'unknown', '{}', 'Energy consulting', false, true, null, null),
  ('NERA Economic Consulting', 'https://mmc.wd1.myworkdayjobs.com/MMC', 'workday', '{"host": "mmc.wd1.myworkdayjobs.com", "tenant": "mmc", "site": "MMC"}', 'Energy consulting', false, true, 'NERA', null),
  ('Artelys', 'https://www.artelys.com/fr/carrieres/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Ricardo', 'https://ricardo.com/en/careers', 'unknown', '{}', 'Energy consulting', false, false, null, null),
  ('ICF', 'https://icf.wd5.myworkdayjobs.com/ICFExternal_Career_Site', 'workday', '{"host": "icf.wd5.myworkdayjobs.com", "tenant": "icf", "site": "ICFExternal_Career_Site"}', 'Energy consulting', false, true, null, null),
  ('Everoze', 'https://everoze.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('K2 Management', 'https://www.k2management.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Xodus Group', 'https://www.xodusgroup.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Gaffney Cline', 'https://www.gaffneycline.com/careers', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Carbone 4', 'https://www.carbone4.com/carrieres', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Dunsky Energy + Climate Advisors', 'https://www.dunsky.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Power Advisory', 'https://www.poweradvisoryllc.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('GLJ', 'https://www.gljpc.com/careers', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Sproule', 'https://sproule.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('McDaniel & Associates', 'https://www.mcdan.com/careers/', 'unknown', '{}', 'Energy consulting', true, false, null, null),
  ('Colombus Consulting', 'https://www.colombus-consulting.com/carrieres/', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('Eurogroup Consulting', 'https://www.eurogroupconsulting.com/carrieres/', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('Magellan Consulting', 'https://www.magellan-cg.com/carrieres/', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('Talan', 'https://jobs.smartrecruiters.com/Talan', 'smartrecruiters', '{"company": "Talan"}', 'Consulting', false, false, null, 'France'),
  ('Accuracy', 'https://www.accuracy.com/careers', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('Alcimed', 'https://www.alcimed.com/fr/carrieres/', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('Capgemini Invent', 'https://www.capgemini.com/fr-fr/carrieres/', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('KPMG France', 'https://www.kpmg.fr/fr/home/carrieres.html', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('PwC / Strategy&', 'https://pwc.wd3.myworkdayjobs.com/Global_Campus_Careers', 'workday', '{"host": "pwc.wd3.myworkdayjobs.com", "tenant": "pwc", "site": "Global_Campus_Careers"}', 'Consulting', false, true, null, 'France'),
  ('Forvis Mazars', 'https://www.forvismazars.com/fr/fr/carrieres', 'unknown', '{}', 'Consulting', false, false, null, null),
  ('McKinsey & Company', 'https://www.mckinsey.com/careers/search-jobs', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('BCG', 'https://careers.bcg.com/', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('Bain & Company', 'https://www.bain.com/careers/find-a-role/', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('Oliver Wyman', 'https://mmc.wd1.myworkdayjobs.com/MMC', 'workday', '{"host": "mmc.wd1.myworkdayjobs.com", "tenant": "mmc", "site": "MMC"}', 'Consulting', false, true, 'Oliver Wyman', null),
  ('Kearney', 'https://www.kearney.com/careers', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('Roland Berger', 'https://jobs.smartrecruiters.com/RolandBerger', 'smartrecruiters', '{"company": "RolandBerger"}', 'Consulting', false, true, null, null),
  ('Arthur D. Little', 'https://careers-adlittle.icims.com/jobs', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('L.E.K. Consulting', 'https://www.lek.com/careers', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('Alvarez & Marsal', 'https://www.alvarezandmarsal.com/careers', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('FTI Consulting', 'https://fticonsulting.com/careers', 'unknown', '{}', 'Consulting', false, true, null, null),
  ('AlixPartners', 'https://job-boards.greenhouse.io/alixpartners', 'greenhouse', '{"board": "alixpartners"}', 'Consulting', false, true, null, null)
) v(name, careers_url, ats, config, category, in_field, big, search, country)
where not exists (select 1 from public.companies c where lower(c.name) = lower(v.name));
-- DNV (Oracle), ERM, Guidehouse ("energy"), Accenture ("energy"), Compass Lexecon (Workday) and EY (SuccessFactors)
-- were added from their careers pages, which the detect mode resolved to those boards.
