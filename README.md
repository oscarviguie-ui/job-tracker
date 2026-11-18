# Job tracker

A personal job-search tracker that runs from anywhere:

- **Inbox** — every morning a scraper reads the careers pages of the companies you follow and shows new postings that match your keywords and locations, newest posting date first, then by start date (soonest first), then by type. Each posting is tagged from its title as a **graduate programme**, internship, VIE, apprenticeship or job, and the inbox can be narrowed to one type. Track one to turn it into an application, or dismiss it.
- **Applications** — the Excel "Applications Log" columns (Company, Position, Type, Location, Description, Date Posted, Link) plus **Starts**, the job's start date, with one **Status** per row: To apply, Applied, Interview, Offer, Accepted, Rejected, Skipped. Moving a row forward stamps its application and reply dates, and the Excel's metrics (applications, response rate, positive rate) are worked out from the statuses. Paste a job link (or type a company) and choose **Save for later** or **Already applied**; the row fills itself from the posting. Rows are grouped into **seasons** (rounds of applications): pick "Start Season N" in the season menu to begin a new round, and rows still "To apply" come with you. Every new link is checked against all seasons so you don't apply to the same job twice. Every column has an Excel-style **sort and filter** menu (the ▾ beside its name; on a phone, **Sort & filter**): tick the values to keep, search the list, and combine filters across columns. Types are grouped (Stage and internship are both Internship; Graduate programme is its own group) and dates by month. Filters are remembered in the browser. Set **When you can start** in Settings and rows you're still working on whose start date falls outside those months turn red.
- **Companies** — add a company by pasting its careers-page URL; the app works out which system it runs on and previews what it finds. Pause, edit or run any company by hand.
- **Settings** — keywords to include and exclude, locations, the months you can start in, follow-up delay, CSV export.

The web app is a static site in [`docs/`](docs/) (served by GitHub Pages). Data, auth and the scraper live in Supabase.

On a phone the log becomes a list of cards with the status menu on each card, and a **Paste** button fills the link box from the clipboard. Add the site to your home screen to use it like an app; on Android it then shows up in the share sheet, so sharing a LinkedIn job to it drops the link straight into the add box.

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
- `supabase/functions/brand/` — finds each company's website and logo, so rows can be spotted by their logo. The website comes from the row's own links (when they aren't a job board), the careers page of a company you follow, or an exact-name match in Clearbit's public company directory; the logo is the site's icon from Google's favicon service. Companies without one show coloured initials. If a logo is wrong, type the right website in the row's **Company website** field; that choice is kept for good.
- `supabase/functions/extract/` — turns one job link into a log row. It reads the job board's own API when it knows it (Workday, SmartRecruiters, Greenhouse, Lever, Ashby, Recruitee, Oracle, LinkedIn's public job view), otherwise the schema.org `JobPosting` data most careers pages publish for Google Jobs, otherwise the page title. Sites that only show ads to signed-in users (JobTeaser, for example) can't be read; the link is kept and you fill the row by hand.

### Dates

- **Date Posted** comes from the job board's own data (Workday, SmartRecruiters, Greenhouse, Lever, Ashby, Recruitee, Oracle, schema.org `datePosted`), else from a date stated on the page ("Publiée le 12/11/2026", "Posted 5 days ago"). LinkedIn only shows an ad's age ("il y a 2 semaines"), so its dates are exact for ads under a week old and approximate after that.
- **Starts** is read from a start-date field when the board has one, else from the title ("Stage – Février 2027") or a labelled phrase in the ad: "Date de début : février 2027", "à pourvoir dès que possible", "démarrage possible en mai/juin/juillet", "Start date: 1 December 2026 or 1 February 2027". It's stored as the ad states it, tidied ("Feb 2027", "May–Jul 2027", "Jan or Mar 2027", "ASAP"). Many ads don't give one; the cell stays empty for you to fill, and anything you type ("fevrier 27", "02/2027") is tidied the same way.
- The date reader is one file, [`docs/dates.js`](docs/dates.js), used by both the web app and the extract function (`supabase/functions/extract/dates.js` is a link to it).

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
3. Deploy the functions: `supabase functions deploy scrape --no-verify-jwt` and `supabase functions deploy extract --no-verify-jwt` and `supabase functions deploy brand --no-verify-jwt` (all three check the cron secret or the owner's login themselves).
4. Put your project URL and publishable key in `docs/config.js` (the publishable key is meant to be public; RLS protects the data).
5. Enable GitHub Pages from `main` / `docs`.
6. Open the site and create your account. **The first account created becomes the owner**; any later sign-up is refused access to the data.
7. In Supabase → Authentication → URL configuration, set the Site URL to your Pages URL so confirmation emails link back to it.

A free Supabase project pauses after a week without traffic; the daily cron job doesn't count. `.github/workflows/keepalive.yml` pings the API twice a week to keep it awake.

## Security

- Every table has row-level security: only the owner's account can read or write.
- The scraper's admin key never leaves Supabase. The browser only holds the publishable key.
- The cron secret lives in Supabase Vault, not in this repo.
