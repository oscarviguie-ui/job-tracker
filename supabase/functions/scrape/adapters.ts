// Careers-page adapters. Each returns a list of normalised postings.
// Most companies run on a handful of applicant-tracking systems (ATS) that expose public JSON or RSS
// behind their careers pages; we read that instead of scraping HTML.

export type Posting = {
  external_id: string;
  title: string;
  location?: string | null;
  url?: string | null;
  posted_at?: string | null; // YYYY-MM-DD
};

export type Company = {
  id?: number;
  name?: string;
  ats: string;
  config: Record<string, string>;
  search?: string | null;
  country?: string | null;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_POSTINGS = 600;

async function get(url: string, accept = "application/json"): Promise<Response> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r;
}
async function getJson(url: string) {
  return (await get(url)).json();
}
async function getText(url: string, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") {
  return (await get(url, accept)).text();
}
async function postJson(url: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", "Accept-Language": "en-US" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

const day = (d: Date) => d.toISOString().slice(0, 10);
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return isNaN(d.getTime()) ? null : day(d);
}
const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ").trim();
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
};

const COUNTRY_ISO: Record<string, string> = {
  france: "fr", belgium: "be", belgique: "be", spain: "es", espagne: "es", switzerland: "ch", suisse: "ch",
  netherlands: "nl", "pays-bas": "nl", germany: "de", allemagne: "de", "united kingdom": "gb", uk: "gb",
  "royaume-uni": "gb", italy: "it", italie: "it", luxembourg: "lu", canada: "ca", portugal: "pt",
};

// ───────────────────────────── Workday ─────────────────────────────
// POST https://{host}/wday/cxs/{tenant}/{site}/jobs  (public JSON behind every *.myworkdayjobs.com site)
function workdayRelativeDate(s?: string): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  const d = new Date();
  if (t.includes("today") || t.includes("aujourd")) return day(d);
  if (t.includes("yesterday") || t.includes("hier")) { d.setDate(d.getDate() - 1); return day(d); }
  const m = t.match(/(\d+)\+?\s*(day|jour)/);
  if (m) { d.setDate(d.getDate() - +m[1]); return day(d); }
  return null;
}
function findFacet(node: unknown, wanted: string, parent?: string): { param: string; id: string } | null {
  if (Array.isArray(node)) {
    for (const n of node) { const f = findFacet(n, wanted, parent); if (f) return f; }
    return null;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const param = (o.facetParameter as string) ?? parent;
    if (typeof o.descriptor === "string" && o.descriptor.toLowerCase() === wanted && parent && typeof o.id === "string") {
      return { param: parent, id: o.id };
    }
    if (o.values) return findFacet(o.values, wanted, param);
  }
  return null;
}
async function workday(c: Company): Promise<Posting[]> {
  const { host, tenant, site } = c.config;
  if (!host || !tenant || !site) throw new Error("Workday config needs host, tenant and site");
  const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const body = (offset: number, facets: Record<string, string[]>) => ({ appliedFacets: facets, limit: 20, offset, searchText: c.search ?? "" });
  let facets: Record<string, string[]> = {};
  let page = await postJson(api, body(0, facets));
  if (c.country) {
    const f = findFacet(page.facets, c.country.toLowerCase());
    if (f) { facets = { [f.param]: [f.id] }; page = await postJson(api, body(0, facets)); }
  }
  const total: number = page.total ?? 0;
  const raw = [...(page.jobPostings ?? [])];
  for (let offset = 20; offset < Math.min(total, MAX_POSTINGS); offset += 20) {
    const p = await postJson(api, body(offset, facets));
    if (!p.jobPostings?.length) break;
    raw.push(...p.jobPostings);
  }
  return raw.filter((j) => j.title && j.externalPath).map((j) => ({
    external_id: j.bulletFields?.[0] ?? j.externalPath,
    title: j.title,
    location: j.locationsText ?? null,
    url: `https://${host}/${site}${j.externalPath}`,
    posted_at: workdayRelativeDate(j.postedOn),
  }));
}

// ───────────────────────────── SmartRecruiters ─────────────────────────────
async function smartrecruiters(c: Company): Promise<Posting[]> {
  const co = c.config.company;
  if (!co) throw new Error("SmartRecruiters config needs company");
  const iso = c.country ? COUNTRY_ISO[c.country.toLowerCase()] ?? c.country.toLowerCase() : null;
  const out: Posting[] = [];
  for (let offset = 0; offset < MAX_POSTINGS; offset += 100) {
    const qs = new URLSearchParams({ limit: "100", offset: String(offset) });
    if (iso) qs.set("country", iso);
    if (c.search) qs.set("q", c.search);
    const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(co)}/postings?${qs}`);
    for (const p of j.content ?? []) {
      out.push({
        external_id: String(p.id), title: p.name,
        location: p.location?.fullLocation ?? [p.location?.city, p.location?.country?.toUpperCase()].filter(Boolean).join(", "),
        url: `https://jobs.smartrecruiters.com/${co}/${p.id}`, posted_at: isoDate(p.releasedDate),
      });
    }
    if (offset + 100 >= (j.totalFound ?? 0)) break;
  }
  return out;
}

// ───────────────────────────── Greenhouse / Lever / Ashby ─────────────────────────────
async function greenhouse(c: Company): Promise<Posting[]> {
  const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${c.config.board}/jobs`);
  return (j.jobs ?? []).map((p: any) => ({
    external_id: String(p.id), title: p.title, location: p.location?.name, url: p.absolute_url,
    posted_at: isoDate(p.first_published ?? p.updated_at),
  }));
}
async function lever(c: Company): Promise<Posting[]> {
  const host = c.config.eu === "true" ? "api.eu.lever.co" : "api.lever.co";
  const j = await getJson(`https://${host}/v0/postings/${c.config.company}?mode=json`);
  return (j ?? []).map((p: any) => ({
    external_id: p.id, title: p.text, location: p.categories?.location ?? p.categories?.allLocations?.join(", "),
    url: p.hostedUrl, posted_at: isoDate(p.createdAt),
  }));
}
async function ashby(c: Company): Promise<Posting[]> {
  const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${c.config.company}`);
  return (j.jobs ?? []).map((p: any) => ({
    external_id: p.id, title: p.title, location: p.location, url: p.jobUrl, posted_at: isoDate(p.publishedAt),
  }));
}

// ───────────────────────────── Recruitee ─────────────────────────────
async function recruitee(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const j = await getJson(`${base}/api/offers/`);
  return (j.offers ?? []).map((p: any) => ({
    external_id: String(p.id), title: p.title,
    location: p.location ?? [p.city, p.country].filter(Boolean).join(", "),
    url: p.careers_url ?? `${base}/o/${p.slug}`, posted_at: isoDate(p.published_at ?? p.created_at),
  }));
}

// ───────────────────────────── Teamtailor (RSS) ─────────────────────────────
async function teamtailor(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const xml = await getText(`${base}/jobs.rss`, "application/rss+xml,application/xml,text/xml");
  const items = xml.split(/<item>/i).slice(1);
  return items.map((it) => {
    const link = tag(it, "link") ?? "";
    const city = [...it.matchAll(/<tt:city>([\s\S]*?)<\/tt:city>/gi)].map((m) => decode(m[1]));
    const country = [...it.matchAll(/<tt:country>([\s\S]*?)<\/tt:country>/gi)].map((m) => decode(m[1]));
    const loc = city.length ? city.map((ct, i) => [ct, country[i]].filter(Boolean).join(", ")).join(" · ") : null;
    return {
      external_id: tag(it, "guid") ?? link, title: tag(it, "title") ?? "", url: link,
      location: loc ?? tag(it, "tt:location") ?? null, posted_at: isoDate(tag(it, "pubDate")),
    };
  });
}

// ───────────────────────────── Personio (XML) ─────────────────────────────
async function personio(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const xml = await getText(`${base}/xml`, "application/xml,text/xml");
  return xml.split(/<position>/i).slice(1).map((it) => {
    const id = tag(it, "id") ?? "";
    return { external_id: id, title: tag(it, "name") ?? "", location: tag(it, "office"), url: `${base}/job/${id}`, posted_at: isoDate(tag(it, "createdAt")) };
  });
}

// ───────────────────────────── Oracle Recruiting Cloud ─────────────────────────────
async function oracle(c: Company): Promise<Posting[]> {
  const { host, site } = c.config;
  const out: Posting[] = [];
  for (let offset = 0; offset < MAX_POSTINGS; offset += 50) {
    const finder = [
      `siteNumber=${site}`, "limit=50", `offset=${offset}`, "sortBy=POSTING_DATES_DESC",
      ...(c.search ? [`keyword="${c.search.replace(/"/g, "")}"`] : []),
    ].join(",");
    const j = await getJson(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;${encodeURIComponent(finder).replace(/%3D/g, "=").replace(/%2C/g, ",")}`,
    );
    const block = j.items?.[0];
    const reqs = block?.requisitionList ?? [];
    for (const r of reqs) {
      out.push({
        external_id: String(r.Id), title: r.Title, location: r.PrimaryLocation,
        url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`, posted_at: isoDate(r.PostedDate),
      });
    }
    if (!reqs.length || offset + 50 >= (block?.TotalJobsCount ?? 0)) break;
  }
  if (c.country) {
    const k = c.country.toLowerCase();
    return out.filter((p) => !p.location || p.location.toLowerCase().includes(k));
  }
  return out;
}

// ───────────────────────────── SAP SuccessFactors career sites ─────────────────────────────
// Recent "Unify" career sites (e.g. jobs.engie.com) load results from a JSON endpoint; older ones expose
// an RSS feed of the 20 newest postings. Try the JSON first, fall back to RSS.
async function successfactors(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const locale = c.config.locale ?? "fr_FR";
  const out = new Map<string, Posting>();
  try {
    for (let page = 0; page < 60 && out.size < MAX_POSTINGS; page++) {
      const j = await postJson(`${base}/services/recruiting/v1/jobs`, {
        locale, pageNumber: page, sortBy: "date", keywords: c.search ?? "", location: c.country ?? "",
        facetFilters: {}, brand: "", skills: [], categoryId: 0, alertId: "", rcmCandidateId: "",
      });
      const rows = j.jobSearchResult ?? [];
      const before = out.size;
      for (const { response: r } of rows) {
        if (!r?.id) continue;
        out.set(String(r.id), {
          external_id: String(r.id), title: decode(r.unifiedStandardTitle ?? ""),
          location: (r.jobLocationShort ?? []).map((l: string) => l.trim().replace(/,\s*\d{4,6}$/, "")).join(" · ") || null,
          url: `${base}/job/${r.urlTitle ?? "job"}/${r.id}-${locale}/`,
          posted_at: frDate(r.unifiedStandardStart ?? ""),
        });
      }
      if (!rows.length || out.size === before) break;
    }
  } catch (_) { /* not a Unify site */ }
  if (out.size) return [...out.values()];
  const xml = await getText(`${base}/services/rss/job/?locale=${locale}&keywords=${encodeURIComponent(c.search ?? "")}`, "application/rss+xml,application/xml,text/xml");
  return xml.split(/<item>/i).slice(1).map((it) => {
    const link = tag(it, "link") ?? "";
    let title = tag(it, "title") ?? "";
    let location: string | null = null;
    const m = title.match(/^(.*)\s\(([^()]+)\)$/); // "Title (City, CC, Zip)"
    if (m) { title = m[1]; location = m[2]; }
    const id = link.match(/\/(\d+)\/?(?:\?|$)/)?.[1] ?? link;
    return { external_id: id, title, location, url: link, posted_at: isoDate(tag(it, "pubDate")) };
  });
}

// ───────────────────────────── Pinpoint ─────────────────────────────
async function pinpoint(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const j = await getJson(`${base}/postings.json`);
  return (j.data ?? []).map((p: any) => ({
    external_id: String(p.id), title: p.title, location: p.location?.name ?? p.location?.city ?? null,
    url: p.url ?? `${base}${p.path ?? ""}`, posted_at: isoDate(p.created_at ?? p.published_at),
  }));
}
const FR_MONTHS: Record<string, number> = { janv: 0, jan: 0, "févr": 1, fevr: 1, feb: 1, mars: 2, mar: 2, avr: 3, apr: 3, mai: 4, may: 4, juin: 5, jun: 5, juil: 6, jul: 6, "août": 7, aout: 7, aug: 7, sept: 8, sep: 8, oct: 9, nov: 10, "déc": 11, dec: 11 };
function frDate(s: string): string | null {
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return day(new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])));
  const m = s.toLowerCase().match(/(\d{1,2})\s+([a-zéû]+)\.?\s+(\d{4})/) ?? null;
  if (m && FR_MONTHS[m[2].slice(0, 4)] !== undefined) return day(new Date(Date.UTC(+m[3], FR_MONTHS[m[2].slice(0, 4)], +m[1])));
  const m2 = s.toLowerCase().match(/([a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m2 && FR_MONTHS[m2[1].slice(0, 3)] !== undefined) return day(new Date(Date.UTC(+m2[3], FR_MONTHS[m2[1].slice(0, 3)], +m2[2])));
  return isoDate(s);
}

// ───────────────────────────── Jibe (iCIMS career sites such as careers.se.com) ─────────────────────────────
// The search page is rendered in the browser from a public JSON endpoint: {base}/api/jobs?page=&limit=.
// `query` narrows it (e.g. "country=France"); descriptions come with it, so pages are heavy — 100 per call.
async function jibe(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const q = c.config.query ? `&${c.config.query}` : "";
  const out = new Map<string, Posting>();
  for (let page = 1; page <= 20 && out.size < 2000; page++) {
    const j = await getJson(`${base}/api/jobs?page=${page}&limit=100${q}`);
    const jobs = j.jobs ?? [];
    for (const { data: d } of jobs) {
      if (!d?.title || d.internal) continue;
      out.set(String(d.req_id ?? d.slug), {
        external_id: String(d.req_id ?? d.slug), title: d.title,
        location: d.full_location ?? d.short_location ?? d.location_name ?? null,
        url: `${base}/jobs/${d.slug}?lang=${d.language ?? "en-us"}`, posted_at: isoDate(d.create_date ?? d.posted_date),
      });
    }
    if (jobs.length < 100) break;
  }
  return [...out.values()];
}

// ───────────────────────────── Phenom (careers.bcg.com, careers.allianz.com, careers.enbw.com…) ─────────────────────────────
// Every Phenom site answers POST {base}/widgets with ddoKey "refineSearch" — the same call its search page makes.
const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function phenom(c: Company): Promise<Posting[]> {
  const base = c.config.base.replace(/\/$/, "");
  const lang = c.config.lang ?? "en_global", country = c.config.country ?? "global";
  const out = new Map<string, Posting>();
  for (let from = 0; from < 3000; ) {
    const j = await postJson(`${base}/widgets`, {
      lang, deviceType: "desktop", country, pageName: "search-results", ddoKey: "refineSearch", sortBy: "Most recent",
      subsearch: "", from, jobs: true, counts: false, all_fields: [], size: 50, clearAll: false, jdsource: "facets",
      isSliderEnable: false, pageId: "page20", siteType: "external", keywords: c.config.keywords ?? c.search ?? "",
      global: true, selected_fields: c.config.filter ? JSON.parse(c.config.filter) : {}, locationData: {},
    });
    const rs = j.refineSearch ?? {};
    const jobs = rs.data?.jobs ?? [];
    for (const p of jobs) {
      const id = String(p[c.config.urlId ?? "jobId"] ?? p.jobId ?? p.jobSeqNo);
      out.set(String(p.jobSeqNo ?? p.jobId), {
        external_id: String(p.jobSeqNo ?? p.jobId), title: p.title,
        location: (p.multi_location?.length > 1 ? `${p.multi_location.length} locations` : null) ?? p.location ?? p.cityStateCountry ?? null,
        url: `${base}/${country}/${lang.split("_")[0]}/job/${id}/${slugify(p.title ?? "")}`,
        posted_at: isoDate(p.postedDate ?? p.dateCreated),
      });
    }
    from += jobs.length;
    if (!jobs.length || from >= (rs.totalHits ?? 0)) break;
  }
  return [...out.values()];
}

// ───────────────────────────── Workable (apply.workable.com/{account}) ─────────────────────────────
async function workable(c: Company): Promise<Posting[]> {
  const acct = c.config.account;
  const out: Posting[] = [];
  let token: string | undefined;
  for (let i = 0; i < 30; i++) {
    const j = await postJson(`https://apply.workable.com/api/v3/accounts/${acct}/jobs`, { query: "", location: [], department: [], worktype: [], remote: [], ...(token ? { token } : {}) });
    for (const p of j.results ?? []) {
      const locs = (p.locations?.length ? p.locations : [p.location]).filter(Boolean);
      out.push({
        external_id: p.shortcode, title: p.title,
        location: locs.length > 1 ? `${locs.length} locations` : [locs[0]?.city, locs[0]?.country].filter(Boolean).join(", ") || (p.remote ? "Remote" : null),
        url: `https://apply.workable.com/${acct}/j/${p.shortcode}/`, posted_at: isoDate(p.published),
      });
    }
    token = j.nextPage;
    if (!token) break;
  }
  return out;
}

// ───────────────────────────── BambooHR ({company}.bamboohr.com/careers) ─────────────────────────────
async function bamboohr(c: Company): Promise<Posting[]> {
  const host = `https://${c.config.company}.bamboohr.com`;
  const j = await getJson(`${host}/careers/list`);
  return (j.result ?? []).map((p: any) => ({
    external_id: String(p.id), title: p.jobOpeningName,
    location: [p.location?.city ?? p.atsLocation?.city, p.location?.state ?? p.atsLocation?.country].filter(Boolean).join(", ") || null,
    url: `${host}/careers/${p.id}`, posted_at: null,
  }));
}

// ───────────────────────────── RSS feeds (Avature portals publish one; so do some company sites) ─────────────────────────────
// Avature puts the location in <description>; anything longer than a line is a real description and ignored.
async function feed(c: Company): Promise<Posting[]> {
  const xml = await getText(c.config.url, "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8");
  return xml.split(/<item[\s>]|<entry[\s>]/i).slice(1).map((it) => {
    const link = tag(it, "link") || decode(it.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "") || tag(it, "guid") || "";
    const desc = stripTags(tag(it, "description") ?? "");
    return {
      external_id: link.match(/\/(\d{4,})\/?(?:[?#]|$)/)?.[1] ?? link, title: stripTags(tag(it, "title") ?? ""),
      location: desc && desc.length <= 80 ? desc : null, url: link, posted_at: isoDate(tag(it, "pubDate") ?? tag(it, "published") ?? tag(it, "updated")),
    };
  }).filter((p) => p.title && p.url);
}

// ───────────────────────────── Sitemaps ─────────────────────────────
// Sites that render their job list in the browser still publish every ad in sitemap.xml for Google.
// `base` is the site (robots.txt names the sitemaps) or a sitemap URL; `pattern` picks the ad URLs, and its
// first group, if any, is the ad's id (so the same ad in several languages counts once). The title comes from the
// URL until the background reader opens the ad and replaces it with the real title, place and date.
export function slugTitle(u: string): string {
  let path = u;
  try { path = decodeURIComponent(new URL(u).pathname); } catch { /* keep */ }
  const segs = path.replace(/\.html?$/i, "").split("/").filter(Boolean).reverse();
  let s = segs.find((x) => /[a-zà-ÿ]{3,}[^/]*[-_+][a-zà-ÿ]{2,}/i.test(x)) ?? segs[0] ?? "";
  s = s.replace(/[-_][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "")
    .replace(/[-_][a-z]{2}[-_][a-z]{2}$/i, "")
    .replace(/[-_]r[-_]?\d{4,}$/i, "").replace(/^\d{4}-\d+-/, "").replace(/^\d+[-_]/, "").replace(/[-_]\d{3,}$/, "")
    .replace(/[-_+]+/g, " ").replace(/\bh f\b/gi, "H/F").replace(/\bf h\b/gi, "F/H").replace(/\bm w d\b/gi, "(m/w/d)").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const JOBISH = /job|offre|career|carriere|vacanc|emploi|position|stelle|recrut/i;
async function sitemapUrls(base: string, keep: RegExp, budget = 25): Promise<{ loc: string; lastmod: string | null }[]> {
  let queue: string[];
  if (/\.xml(\?|$)/i.test(base)) queue = [base];
  else {
    const origin = new URL(base).origin;
    const robots = await getText(`${origin}/robots.txt`, "text/plain,*/*").catch(() => "");
    queue = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (!queue.length) queue = [`${origin}/sitemap.xml`];
  }
  const out: { loc: string; lastmod: string | null }[] = [];
  const seen = new Set<string>();
  while (queue.length && seen.size < budget) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    let xml = "";
    try { xml = await getText(u, "application/xml,text/xml;q=0.9,*/*;q=0.8"); } catch { continue; }
    const entries = [...xml.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/gi)].map((m) => ({ loc: decode(tag(m[2], "loc") ?? ""), lastmod: tag(m[2], "lastmod") }));
    if (/<sitemapindex/i.test(xml)) {
      const kids = entries.map((e) => e.loc).filter(Boolean);
      const jobby = kids.filter((k) => JOBISH.test(k) || keep.test(k));
      queue.push(...(jobby.length ? jobby : kids));
    } else out.push(...entries.filter((e) => keep.test(e.loc)));
  }
  return out;
}
async function sitemap(c: Company): Promise<Posting[]> {
  const keep = new RegExp(c.config.pattern, "i");
  const out = new Map<string, Posting>();
  for (const e of await sitemapUrls(c.config.base, keep)) {
    const id = e.loc.match(keep)?.[1] ?? e.loc.split(/[?#]/)[0];
    if (out.has(id)) continue;
    const title = slugTitle(e.loc);
    if (title.length < 4) continue;
    out.set(id, { external_id: id, title, url: e.loc, location: null, posted_at: c.config.lastmod === "posted" ? isoDate(e.lastmod) : null });
  }
  return [...out.values()].slice(0, 3000);
}

// ───────────────────────────── Generic: links on a listing page ─────────────────────────────
// For custom portals rendered on the server: collect every <a> whose href matches `pattern`.
// Optional paging: put {{offset}} in the URL and set `step` (and `pages`, default 5).
async function links(c: Company): Promise<Posting[]> {
  const pattern = new RegExp(c.config.pattern);
  const step = Number(c.config.step ?? 0);
  const pages = c.config.url.includes("{{offset}}") && step ? Number(c.config.pages ?? 5) : 1;
  const seen = new Map<string, Posting>();
  for (let i = 0; i < pages; i++) {
    const page = c.config.url.replace("{{offset}}", String(i * step));
    const html = await getText(page);
    const before = seen.size;
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decode(m[1]);
      if (!pattern.test(href)) continue;
      const abs = new URL(href, page).toString();
      const title = stripTags(m[2]) || decode(m[0].match(/title\s*=\s*["']([^"']+)/i)?.[1] ?? "");
      if (!title || title.length < 4) continue;
      const id = abs.match(pattern)?.[1] ?? abs.split("?")[0];
      if (!seen.has(id)) seen.set(id, { external_id: id, title, url: abs, location: null, posted_at: null });
    }
    if (seen.size === before) break;
  }
  return [...seen.values()];
}

export const ADAPTERS: Record<string, (c: Company) => Promise<Posting[]>> = {
  workday, smartrecruiters, greenhouse, lever, ashby, recruitee, teamtailor, personio, oracle, successfactors, pinpoint, links,
  jibe, phenom, workable, bamboohr, feed, sitemap,
};

// ───────────────────────────── Detection ─────────────────────────────
// Turn any careers-page or job-posting URL into { ats, config }.
export type Detection = { ats: string; config: Record<string, string>; name?: string; note?: string };

export function detectFromUrl(raw: string): Detection | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  let m;
  if ((m = host.match(/^([\w-]+)\.(wd\d+)\.myworkdayjobs\.com$/))) {
    const parts = path.split("/").filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    if (parts[0] === "wday") return { ats: "workday", config: { host, tenant: parts[2], site: parts[3] } };
    if (parts[0]) return { ats: "workday", config: { host, tenant: m[1], site: parts[0] } };
  }
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && (m = path.match(/^\/([\w.-]+)/))) {
    return { ats: "smartrecruiters", config: { company: m[1] } };
  }
  if (host === "api.smartrecruiters.com" && (m = path.match(/companies\/([\w.-]+)/))) return { ats: "smartrecruiters", config: { company: m[1] } };
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const board = u.searchParams.get("for") ?? path.split("/").filter(Boolean).find((p) => !["embed", "job_board", "v1", "boards"].includes(p));
    if (board) return { ats: "greenhouse", config: { board } };
  }
  if ((m = host.match(/^jobs\.(eu\.)?lever\.co$/))) {
    const co = path.split("/").filter(Boolean)[0];
    if (co) return { ats: "lever", config: { company: co, eu: m[1] ? "true" : "false" } };
  }
  if (host === "jobs.ashbyhq.com") {
    const co = path.split("/").filter(Boolean)[0];
    if (co) return { ats: "ashby", config: { company: co } };
  }
  if (host.endsWith(".recruitee.com") || /^\/o\/[\w-]+/.test(path)) return { ats: "recruitee", config: { base: u.origin } };
  if (host.endsWith(".teamtailor.com") || /^\/jobs\/\d+-/.test(path)) return { ats: "teamtailor", config: { base: u.origin } };
  if ((m = host.match(/^([\w-]+)\.jobs\.personio\.(de|com)$/))) return { ats: "personio", config: { base: u.origin } };
  if (host.endsWith(".oraclecloud.com") && (m = path.match(/\/sites\/([\w-]+)/))) return { ats: "oracle", config: { host, site: m[1] } };
  if (host.endsWith(".pinpointhq.com")) return { ats: "pinpoint", config: { base: u.origin } };
  return null;
}

// Looks inside an unknown careers page for an embedded/linked ATS.
export async function detectFromPage(raw: string): Promise<Detection | null> {
  const direct = detectFromUrl(raw);
  if (direct) return direct;
  let html = "";
  try { html = await getText(raw); } catch (_) { return detectSitemap(raw); }
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const shapes = [/\/JobDetail\/[^/]+\/(\d+)/, /\/job\/[^"']*?\/(\d{5,})\/?$/i, /\/jobs?\/(\d{4,})/i, /\/offres?(?:-d-emploi)?\/[^"']*?([\w-]{6,})$/i, /\/annonce\/(\d+)/i];
  const ownLinks = (min: number): Detection | null => {
    for (const re of shapes) {
      if (new Set(hrefs.filter((h) => re.test(h))).size >= min) {
        return { ats: "links", config: { url: raw, pattern: re.source }, note: "job links listed on the page itself" };
      }
    }
    return null;
  };
  // A page that lists its own postings wins over ATS links it happens to mention (e.g. a subsidiary's board).
  const own = ownLinks(5);
  if (own) {
    // Avature portals page with jobOffset; read up to 25 pages of 20.
    if (/\/SearchJobs/i.test(raw) && /JobDetail/.test(own.config.pattern)) {
      const u = new URL(raw);
      u.searchParams.set("jobRecordsPerPage", "20");
      u.searchParams.delete("jobOffset");
      own.config = { ...own.config, url: `${u.toString()}&jobOffset={{offset}}`, step: "20", pages: "25" };
    }
    return own;
  }
  const candidates = [
    /https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/[^"'\s<>]+/i,
    /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[\w.-]+/i,
    /https?:\/\/(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/[^"'\s<>]+/i,
    /https?:\/\/jobs\.(?:eu\.)?lever\.co\/[\w-]+/i,
    /https?:\/\/jobs\.ashbyhq\.com\/[\w-]+/i,
    /https?:\/\/[\w-]+\.recruitee\.com/i,
    /https?:\/\/[\w-]+\.teamtailor\.com/i,
    /https?:\/\/[\w-]+\.jobs\.personio\.(?:de|com)/i,
    /https?:\/\/[\w-]+\.fa\.[\w-]+\.oraclecloud\.com\/hcmUI\/CandidateExperience\/\w+\/sites\/[\w-]+/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m) { const d = detectFromUrl(m[0]); if (d) return { ...d, note: `found ${m[0]} on the page` }; }
  }
  const origin = new URL(raw).origin;
  if (/teamtailor/i.test(html)) return { ats: "teamtailor", config: { base: origin } };
  if (/recruitee/i.test(html)) return { ats: "recruitee", config: { base: origin } };
  if (/jobs2web|rmk-|successfactors/i.test(html)) return { ats: "successfactors", config: { base: origin } };
  if (/pinpointhq/i.test(html)) return { ats: "pinpoint", config: { base: origin } };
  let m2;
  if ((m2 = html.match(/apply\.workable\.com\/(?!api\b)([\w-]+)/i))) return { ats: "workable", config: { account: m2[1] }, note: `found a Workable board on the page` };
  if ((m2 = html.match(/https?:\/\/([\w-]+)\.bamboohr\.com/i))) return { ats: "bamboohr", config: { company: m2[1] }, note: `found a BambooHR board on the page` };
  if (/phApp\.|phenompeople/i.test(html) && /phApp\./.test(html)) return { ats: "phenom", config: { base: origin } };
  // Avature portals (and a few others) publish their search results as RSS.
  const rss = html.match(/href\s*=\s*["']([^"']*\/(?:SearchJobs|Jobs)\/feed\/?[^"']*)["']/i);
  if (rss) return { ats: "feed", config: { url: new URL(decode(rss[1]), raw).toString().replace(/RecordsPerPage=\d+/i, "RecordsPerPage=500") } };
  // Jibe career sites answer {origin}/api/jobs.
  if (/jibe|icims/i.test(html)) {
    try { const j = await getJson(`${origin}/api/jobs?limit=1`); if (Array.isArray(j.jobs) && j.jobs.length) return { ats: "jibe", config: { base: origin } }; } catch (_) { /* not Jibe */ }
  }
  const few = ownLinks(2);
  if (few) return few;
  return detectSitemap(raw);
}

// Last resort: ads listed in the site's sitemap. Job boards that host many employers are skipped — their sitemap
// is everyone's ads, not this company's.
const BOARDS = /welcometothejungle|linkedin|indeed|jobteaser|glassdoor|hellowork|apec\.fr/i;
export async function detectSitemap(raw: string): Promise<Detection | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (BOARDS.test(u.hostname)) return null;
  const site = u.hostname.split(".").slice(-2).join(".");
  const seg = /\/(jobs?|offres?(?:-d-emploi)?|offre-emploi|vacanc(?:y|ies)|vacancies-list|positions?|stellenangebote|emplois?)\/(?:[^?#]*\/)?[^/?#]*[a-z]{3,}[-_][a-z]{2,}/i;
  const urls = (await sitemapUrls(raw, seg, 12).catch(() => [])).filter((e) => { try { return new URL(e.loc).hostname.endsWith(site); } catch { return false; } });
  if (urls.length < 3) return null;
  const first = new URL(urls[0].loc);
  const key = first.pathname.match(seg)![1];
  const pattern = `${first.hostname.replace(/[.]/g, "\\.")}/(?:[\\w-]+/)*${key}/`;
  return { ats: "sitemap", config: { base: u.origin, pattern }, note: `${urls.length} ads listed in the site's sitemap` };
}
