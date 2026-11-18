-- Country and region as plain columns set by a trigger, only when a posting is added or its location changes.
-- As generated columns they were recomputed on every update (the scraper touches every row each morning).
alter table public.postings drop column if exists country;
alter table public.postings drop column if exists region;
alter table public.postings add column country text;
alter table public.postings add column region text;

create or replace function public.postings_place() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.country := public.place_country(new.location);
  new.region := public.place_region(new.location);
  return new;
end $$;
revoke execute on function public.postings_place() from public, anon, authenticated;

drop trigger if exists postings_place_ins on public.postings;
drop trigger if exists postings_place_upd on public.postings;
create trigger postings_place_ins before insert on public.postings
  for each row execute function public.postings_place();
create trigger postings_place_upd before update of location on public.postings
  for each row when (old.location is distinct from new.location) execute function public.postings_place();

update public.postings set country = public.place_country(location), region = public.place_region(location);
create index if not exists postings_open_matched on public.postings (state, matched, is_open);
