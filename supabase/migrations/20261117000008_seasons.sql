-- Application rounds. Season 1 is the first round (imported from the Excel log); new rows go to the current season.
alter table public.applications add column if not exists season smallint not null default 2;
update public.applications set season = 1 where created_at < '2026-11-17 14:00+01';
create index if not exists applications_season_idx on public.applications (season, id);
