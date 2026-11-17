# Job tracker

A personal job-search tracker that runs from anywhere:

- **Inbox** — every morning a scraper reads the careers pages of the companies you follow and shows new postings that match your keywords and locations. Track one to turn it into an application, or dismiss it.
- **Applications** — the Excel log, with more: inline status changes, a board view, follow-up dates, history of every status change, notes, contacts and documents.
- **Companies** — add a company by pasting its careers-page URL; the app works out which system it runs on and previews what it finds. Pause, edit or run any company by hand.
- **Settings** — keywords to include and exclude, locations, follow-up delay, CSV export.

The web app is a static site in [`docs/`](docs/) (served by GitHub Pages). Data, auth and the scraper live in Supabase.

## How it fits together

```
GitHub Pages (docs/)  ──supabase-js──▶  Supabase Postgres (RLS: owner only)
                                         │
                       pg_cron 05:30 UTC ─┤ scrape_all()
                                         ▼
                              Edge Function `scrape` ──▶ careers sites (ATS APIs)
                                         │
                              ingest_postings() ── match keywords/locations ──▶ Inbox
```

- `supabase/migrations/` — schema, row-level security, matching, ingestion and the daily cron job.
- `supabase/functions/scrape/` — the scraper. `adapters.ts` holds one small reader per applicant-tracking system.

### Supported careers sites

| System | Example URL to paste |
| --- | --- |
| Workday | `https://airliquidehr.wd3.myworkdayjobs.com/AirLiquideExternalCareer` |
| SmartRecruiters | `https://jobs.smartrecruiters.com/AFRY` |
| Greenhouse, Lever, Ashby | `https://boards.greenhouse.io/<board>` · `https://jobs.lever.co/<co>` · `https://jobs.ashbyhq.com/<co>` |
| Teamtailor | `https://carrieresfrance.bearingpoint.com` |
| Recruitee | `https://join.allego.eu` |
| Personio | `https://<co>.jobs.personio.de` |
| Oracle Recruiting Cloud | `https://hcxg.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1` |
| SAP SuccessFactors | `https://jobs.engie.com` |
| Pinpoint | `https://careers.auroraer.com` |
| Server-rendered listing pages (e.g. Avature) | any page that lists job links |

Sites that build their list in the browser with JavaScript (Welcome to the Jungle, some custom portals) can't be read this way. Add them anyway with system "unknown": they stay in your list as a bookmark with a link to the careers page.

### Matching

A posting reaches the inbox when its title contains a **field** keyword (energy, trading, climate…) **and** a **level** keyword (stage, analyst, junior…), none of the hidden words, and its location contains one of your locations (or has no location). Matching ignores case and accents and works on the start of words; a keyword in double quotes (`"market"`) must match a whole word. For specialists where every role is in the field (Aurora, Greensolver…), tick "every role here is in my field" on the company and only the level, hidden words and locations apply. The first scrape of a company is a baseline: what's already online is stored but not flagged as new. Changing settings re-matches everything.

## Setting it up from scratch

1. Create a Supabase project and run the migrations in order (SQL editor or `supabase db push`).
2. In the Vault, add two secrets: `scrape_url` = `https://<project>.supabase.co/functions/v1/scrape`, `cron_secret` = any long random string.
3. Deploy the function: `supabase functions deploy scrape --no-verify-jwt` (it checks the cron secret or the owner's login itself).
4. Put your project URL and publishable key in `docs/config.js` (the publishable key is meant to be public; RLS protects the data).
5. Enable GitHub Pages from `main` / `docs`.
6. Open the site and create your account. **The first account created becomes the owner**; any later sign-up is refused access to the data.
7. In Supabase → Authentication → URL configuration, set the Site URL to your Pages URL so confirmation emails link back to it.

A free Supabase project pauses after a week without traffic; the daily cron job doesn't count. `.github/workflows/keepalive.yml` pings the API twice a week to keep it awake.

## Security

- Every table has row-level security: only the owner's account can read or write.
- The scraper's admin key never leaves Supabase. The browser only holds the publishable key.
- The cron secret lives in Supabase Vault, not in this repo.
