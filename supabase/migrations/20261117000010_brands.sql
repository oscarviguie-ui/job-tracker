-- Company branding for the log: one row per company (keyed by a normalised name), with its website and logo.
-- Filled by the `brand` edge function; a website typed by hand (source 'manual') is never overwritten.
create table if not exists public.brands (
  key         text primary key,          -- lower-case company name without accents, spaces or legal suffixes
  name        text not null,
  domain      text,
  icon_url    text,
  icon_size   smallint,
  source      text not null default 'auto' check (source in ('auto', 'manual')),
  checked_at  timestamptz not null default now()
);
alter table public.brands enable row level security;
create policy "owner all" on public.brands for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
grant select, insert, update, delete on public.brands to authenticated;
grant all on public.brands to service_role;
