-- Letters: a private locker for cover letters, reachable from any device.
-- Each row names one uploaded file (Word, PDF, text…) kept in the private "letters" storage bucket.

create table if not exists public.letters (
  id          bigint generated always as identity primary key,
  name        text not null,
  category    text,                          -- type of role it's written for
  file_path   text not null,                 -- object path in the "letters" bucket
  file_name   text not null,
  file_size   bigint,
  mime        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.letters enable row level security;
create policy "owner all" on public.letters for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- Private bucket: files are only reached through short-lived signed links made for the owner.
insert into storage.buckets (id, name, public, file_size_limit)
values ('letters', 'letters', false, 20971520)
on conflict (id) do nothing;

create policy "owner letters" on storage.objects for all to authenticated
  using (bucket_id = 'letters' and (select public.is_owner()))
  with check (bucket_id = 'letters' and (select public.is_owner()));
