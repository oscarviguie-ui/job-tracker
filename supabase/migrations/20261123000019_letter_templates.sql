-- Cover-letter templates: a few base letters by type of role, edited by hand and reused.
-- Each application can keep the letter actually sent and the template it started from.

create table if not exists public.letter_templates (
  id          bigint generated always as identity primary key,
  name        text not null,
  use_for     text,                         -- which roles or companies it is meant for
  language    text not null default 'EN' check (language in ('EN','FR')),
  body        text not null default '',
  position    int  not null default 0,      -- order on the Letters page
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.letter_templates enable row level security;
create policy "owner all" on public.letter_templates for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

alter table public.applications add column if not exists template_id bigint references public.letter_templates on delete set null;
alter table public.applications add column if not exists cover_letter text;
