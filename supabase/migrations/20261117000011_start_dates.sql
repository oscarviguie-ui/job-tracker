-- When the job starts, as the ad states it ("Feb 2027", "Jan–Mar 2027", "ASAP"), filled by the extract function
-- and editable by hand. And the months you can start in, so the log can flag jobs that start too early or too late.
alter table public.applications add column if not exists starts text;
alter table public.settings add column if not exists available_from date;
alter table public.settings add column if not exists available_until date;
