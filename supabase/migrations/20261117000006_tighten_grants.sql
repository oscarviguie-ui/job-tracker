-- Trigger functions never need to be called through the API.
-- (is_owner stays callable: RLS policies evaluate it for every request and it only ever answers about the caller.
--  rematch_postings and scrape_all stay callable by signed-in users: both refuse anyone but the owner.)
revoke execute on function public.applications_log() from public, anon, authenticated;
revoke execute on function public.claim_owner() from public, anon, authenticated;
revoke execute on function public.applications_touch() from public, anon, authenticated;
