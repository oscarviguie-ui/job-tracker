// Edge function: turn a job-posting link into a row for the applications log.
//
//   POST { url, debug? }  →  { ok, row: { company, role, contract, location, description, date_posted, starts, url }, source }
//
// date_posted: when the ad went up. starts: when the job starts, as the ad states it ("Feb 2027", "Jan–Mar 2027",
// "ASAP"), read from the job board's own fields, the title, or a labelled phrase in the ad ("Date de début : …").
//
// Reads the applicant-tracking system's own API when the link is from one we know (Workday, SmartRecruiters,
// Greenhouse, Lever, Ashby, Recruitee), otherwise the schema.org JobPosting data that most careers pages embed
// for Google Jobs, otherwise the page's title and meta tags. Callers: the web app (owner's JWT) or admin scripts
// (x-cron-secret).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parseDate, postedFromText, relativeDate, startFrom } from "./dates.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = {
  company: string | null; role: string | null; contract: string | null; location: string | null;
  description: string | null; date_posted: string | null; starts: string | null; url: string;
};
// What a reader found, plus the ad's full text (for dates) and anything known about the start.
type Got = Partial<Row> & { finalUrl?: string; site?: string | null; text?: string; startHint?: string | null };

// ───────────────────────────── helpers ─────────────────────────────
async function fetchText(url: string, init: RequestInit = {}, accept = "text/html,application/xhtml+xml,*/*;q=0.8") {
  const r = await fetch(url, {
    redirect: "follow", ...init,
    headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return { text: await r.text(), finalUrl: r.url };
}
async function fetchJson(url: string, init: RequestInit = {}) {
  return JSON.parse((await fetchText(url, init, "application/json")).text);
}
const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", bull: "•", middot: "·", euro: "€", oelig: "œ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", ccedil: "ç", icirc: "î", iuml: "ï",
  ocirc: "ô", ucirc: "û", ugrave: "ù", Eacute: "É", Egrave: "È", Agrave: "À", Ccedil: "Ç",
};
const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\u00a0/g, " ");
const clean = (s: unknown) => (typeof s === "string" ? decode(s).replace(/\s+/g, " ").trim() : "") || null;

function htmlToText(html: string): string {
  return decode(
    html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d|ul|ol|tr|section)>/gi, "\n").replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}

// A short description for the log: the start of the "missions" part of the ad when we can find it.
const SECTION = /(?:^|\n)\s*(?:vos missions|votre mission|missions?(?: principales?)?|vos responsabilit[eé]s|responsabilit[eé]s|vos activit[eé]s|activit[eé]s|ce que vous ferez|le poste|descriptif du poste|description du poste|description de la mission|your missions?|your role|the role|role description|job description|(?:key |main )?responsibilities|what you(?:'|’)ll do|about the (?:role|job|position))\b[^\n:]{0,25}(?::[ \t]*|\n)/i;
function summarise(raw: string | null | undefined, max = 220): string | null {
  if (!raw) return null;
  let t = /<[a-z][\s\S]*>/i.test(raw) ? htmlToText(raw) : decode(raw);
  const m = t.match(SECTION);
  if (m && m.index !== undefined && m.index < t.length - 80) t = t.slice(m.index + m[0].length);
  t = t.replace(/\n•\s*/g, " • ").replace(/\n+/g, " ").replace(/\s+/g, " ").replace(/^[•\s:–-]+/, "").trim();
  if (t.length <= max) return t || null;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(" • "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")).trim() + (end > max * 0.5 ? "" : "…");
}

const isoDate = parseDate;

// "Position Length" in the log: Stage, CDI, CDD, VIE, Alternance, Graduate Program.
function contractFrom(title: string | null, employmentType: unknown, text = ""): string | null {
  const t = `${title ?? ""}`.toLowerCase();
  if (/\bv\.?\s?i\.?\s?e\b|volontariat international/.test(t)) return "VIE";
  if (/alternan|apprenti|apprenticeship|work-study/.test(t)) return "Alternance";
  if (/graduate (program|programme|scheme)|graduate analyst|young graduate/.test(t)) return "Graduate Program";
  if (/\bstage\b|stagiaire|intern\b|internship|trainee|fin d.?études/.test(t)) return "Stage";
  if (/\bcdd\b|fixed[- ]term|temporary/.test(t)) return "CDD";
  if (/\bcdi\b/.test(t)) return "CDI";
  // Then the ad's own words, then the structured employment type.
  const body = text.slice(0, 3000).toLowerCase();
  if (/\bstagiaire\b|\bstage de (?:fin|\d|six|4|5|6)|\binternship\b|convention de stage/.test(body)) return "Stage";
  if (/volontariat international|\bv\.i\.e\b/.test(body)) return "VIE";
  if (/\bcdd\b/.test(body)) return "CDD";
  if (/\bcdi\b/.test(body)) return "CDI";
  const et = String(employmentType ?? "").toLowerCase();
  if (/intern|stage|stagiaire/.test(et)) return "Stage";
  if (/v\.?i\.?e|volontariat/.test(et)) return "VIE";
  if (/alternan|apprenti/.test(et)) return "Alternance";
  if (/temporary|contract|fixed|cdd/.test(et)) return "CDD";
  if (/full[_ -]?time|permanent|regular|cdi/.test(et)) return "CDI";
  return null;
}
// Drop "H/F", "(F/M/X)" and similar from titles.
const tidyTitle = (t: string | null) =>
  t ? t.replace(/\s*[-–|,]?\s*\(?\b(?:h\s*\/\s*f|f\s*\/\s*h|m\s*\/\s*f|f\s*\/\s*m|w\s*\/\s*m|m\s*\/\s*w)(?:\s*\/\s*[xd])?\)?\s*$/i, "").replace(/\s+/g, " ").trim() : t;
// The log keeps a short place, usually the city: "Nanterre, 92-Hauts-de-Seine, France" → "Nanterre".
const COUNTRIES = /^(france|germany|deutschland|allemagne|spain|espa[ñn]a|espagne|belgium|belgique|switzerland|suisse|schweiz|netherlands|pays-bas|united kingdom|uk|royaume-uni|italy|italia|italie|portugal|luxembourg|canada|united states|usa|norway|norv[eè]ge|sweden|denmark|poland|greece|ireland|japan|singapore|india|brazil|mexico|australia)$/i;
const REGIONS = /^(idf|[iî]le[- ]de[- ]france|\d{2,3}\s*-.*|[A-Z]{2}|provence.*|auvergne.*|hauts-de-france|grand est|occitanie|nouvelle-aquitaine|bretagne|normandie|pays de la loire|centre-val de loire|bourgogne.*|england|scotland|wales|bavaria|bayern|nrw|north rhine.*|catalonia|community of madrid|comunidad de madrid|lombardy|lombardia)$/i;
function tidyCity(s: string | null): string | null {
  if (!s) return null;
  const parts = s.replace(/,?\s*\d{4,6}\b/g, "").split(/\s*[,·|]\s*/).map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/^ville de /i, ""));
  const city = parts.find((x) => !COUNTRIES.test(x) && !REGIONS.test(x)) ?? parts[0];
  if (!city) return null;
  return city === city.toUpperCase() && /[A-Z]{3}/.test(city)
    ? city.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : city;
}

// ───────────────────────────── ATS readers ─────────────────────────────
async function workday(u: URL): Promise<Got | null> {
  const m = u.hostname.match(/^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (!m) return null;
  const parts = u.pathname.split("/").filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
  const jobAt = parts.indexOf("job");
  if (jobAt < 1) return null;
  const site = parts[0];
  const rest = parts.slice(jobAt).join("/");
  const j = await fetchJson(`https://${u.hostname}/wday/cxs/${m[1]}/${site}/${rest}`);
  const p = j.jobPostingInfo ?? {};
  return {
    role: clean(p.title), location: tidyCity(clean(p.location) ?? clean(p.jobRequisitionLocation?.descriptor)),
    // Workday's startDate is the day the ad was published, not when the job starts.
    description: summarise(p.jobDescription), date_posted: isoDate(p.startDate) ?? relativeDate(p.postedOn),
    text: htmlToText(p.jobDescription ?? ""),
    contract: contractFrom(p.title, p.timeType, htmlToText(p.jobDescription ?? "")),
    company: clean(j.hiringOrganization?.name)?.replace(/^[A-Z0-9]+-[A-Z0-9]+\s+/, "").replace(/,.*$/, "") ?? null,
  };
}
async function smartrecruiters(u: URL): Promise<Got | null> {
  if (!/^(jobs|careers)\.smartrecruiters\.com$/.test(u.hostname)) return null;
  const [co, idSlug] = u.pathname.split("/").filter(Boolean);
  const id = idSlug?.match(/^(\d+)/)?.[1];
  if (!co || !id) return null;
  const p = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${co}/postings/${id}`);
  const s = p.jobAd?.sections ?? {};
  return {
    company: clean(p.company?.name), role: clean(p.name),
    location: [p.location?.city, p.location?.remote ? "Remote" : null].filter(Boolean).join(", ") || null,
    description: summarise(s.jobDescription?.text ?? s.companyDescription?.text),
    date_posted: isoDate(p.releasedDate),
    contract: contractFrom(p.name, p.typeOfEmployment?.label, htmlToText(s.jobDescription?.text ?? "")),
    // Custom fields ("Date de début: Février 2027") first, then the ad.
    text: [...(p.customField ?? []).map((f: any) => `${f.fieldLabel}: ${f.valueLabel}`),
      ...["jobDescription", "qualifications", "additionalInformation"].map((k) => htmlToText(s[k]?.text ?? ""))].join("\n"),
  };
}
async function greenhouse(u: URL): Promise<Got | null> {
  if (!/greenhouse\.io$/.test(u.hostname)) return null;
  const id = u.searchParams.get("gh_jid") ?? u.pathname.match(/jobs\/(\d+)/)?.[1];
  const board = u.searchParams.get("for") ?? u.pathname.split("/").filter(Boolean)[0];
  if (!id || !board) return null;
  const p = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
  return { role: clean(p.title), location: clean(p.location?.name), description: summarise(decode(p.content ?? "")),
    date_posted: isoDate(p.first_published ?? p.updated_at), contract: contractFrom(p.title, null, htmlToText(decode(p.content ?? ""))),
    company: clean(p.company_name), text: htmlToText(decode(p.content ?? "")) };
}
async function lever(u: URL): Promise<Got | null> {
  const m = u.hostname.match(/^jobs\.(eu\.)?lever\.co$/);
  if (!m) return null;
  const [co, id] = u.pathname.split("/").filter(Boolean);
  if (!co || !id) return null;
  const p = await fetchJson(`https://api.${m[1] ?? ""}lever.co/v0/postings/${co}/${id}`);
  return { role: clean(p.text), location: clean(p.categories?.location), description: summarise(p.descriptionPlain ?? p.description),
    date_posted: isoDate(p.createdAt), contract: contractFrom(p.text, p.categories?.commitment, p.descriptionPlain ?? ""),
    text: [p.descriptionPlain, ...(p.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`), p.additionalPlain].filter(Boolean).join("\n") };
}
async function ashby(u: URL): Promise<Got | null> {
  if (u.hostname !== "jobs.ashbyhq.com") return null;
  const [co, id] = u.pathname.split("/").filter(Boolean);
  if (!co || !id) return null;
  const j = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${co}`);
  const p = (j.jobs ?? []).find((x: any) => x.id === id);
  if (!p) return null;
  return { role: clean(p.title), location: clean(p.location), description: summarise(p.descriptionHtml ?? p.descriptionPlain),
    date_posted: isoDate(p.publishedAt), contract: contractFrom(p.title, p.employmentType, p.descriptionPlain ?? ""),
    text: p.descriptionPlain ?? htmlToText(p.descriptionHtml ?? "") };
}
async function recruitee(u: URL): Promise<Got | null> {
  const slug = u.pathname.match(/^\/o\/([\w-]+)/)?.[1];
  if (!slug) return null;
  const j = await fetchJson(`${u.origin}/api/offers/${slug}`).catch(() => null);
  const p = j?.offer;
  if (!p) return null;
  return { role: clean(p.title), location: clean(p.location ?? p.city), description: summarise(p.description),
    date_posted: isoDate(p.published_at ?? p.created_at), contract: contractFrom(p.title, p.employment_type_code, htmlToText(p.description ?? "")),
    company: clean(p.company_name), text: htmlToText(p.description ?? "") + "\n" + htmlToText(p.requirements ?? "") };
}

async function oracle(u: URL): Promise<Got | null> {
  if (!u.hostname.endsWith(".oraclecloud.com")) return null;
  const site = u.pathname.match(/\/sites\/([\w-]+)/)?.[1];
  const id = u.pathname.match(/\/job\/(\d+)/)?.[1] ?? u.searchParams.get("jobId");
  if (!site || !id) return null;
  const j = await fetchJson(`https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`);
  const p = j.items?.[0];
  if (!p) return null;
  const desc = [p.ExternalResponsibilitiesStr, p.ExternalDescriptionStr, p.ExternalQualificationsStr].filter(Boolean).join("\n");
  return { role: clean(p.Title), location: tidyCity(clean(p.PrimaryLocation)), date_posted: isoDate(p.ExternalPostedStartDate),
    description: summarise(p.ExternalResponsibilitiesStr || p.ExternalDescriptionStr),
    contract: contractFrom(clean(p.Title), [p.JobSchedule, p.ContractType, p.RequisitionType].filter(Boolean).join(" "), htmlToText(desc)),
    text: htmlToText(desc) };
}
// LinkedIn shows guests a plain-HTML version of each job at jobs-guest/…/jobPosting/<id>.
async function linkedin(u: URL): Promise<Got | null> {
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
  const id = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ?? u.searchParams.get("currentJobId");
  if (!id) return null;
  const { text: h } = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  const grab = (re: RegExp) => clean(h.match(re)?.[1]?.replace(/<[^>]+>/g, " "));
  const criteria = [...h.matchAll(/description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1]) ?? "");
  const descHtml = h.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const role = grab(/top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/);
  // LinkedIn only gives the ad's age ("il y a 4 jours", "2 weeks ago"): exact to the day for recent ads, to the week or
  // month after that. Its public job page has no exact date either (the dates there belong to "similar jobs").
  const posted = relativeDate(grab(/posted-time-ago__text[^>]*>([\s\S]*?)<\/span>/));
  return { role, company: grab(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/), location: tidyCity(grab(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/)),
    description: summarise(descHtml), contract: contractFrom(role, criteria[1] ?? "", htmlToText(descHtml)),
    date_posted: posted, text: htmlToText(descHtml) };
}

// ───────────────────────────── generic page ─────────────────────────────
function findJobPosting(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findJobPosting(n); if (f) return f; } return null; }
  const t = node["@type"];
  if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return node;
  return findJobPosting(node["@graph"]) ?? null;
}
const meta = (html: string, name: string) =>
  clean(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i"))?.[1]);

async function generic(u: URL): Promise<Got> {
  const { text: html, finalUrl } = await fetchText(u.toString());
  let jp: any = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jp = findJobPosting(JSON.parse(m[1].trim())); } catch { /* malformed block */ }
    if (jp) break;
  }
  // Next.js pages (e.g. Welcome to the Jungle) sometimes keep it in __NEXT_DATA__ instead.
  if (!jp) {
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nd) { try { jp = findJobPosting(JSON.parse(nd[1])); } catch { /* ignore */ } }
  }
  const site = meta(html, "og:site_name");
  // Label/value pairs such as <dt>Ville</dt><dd>Courbevoie</dd> (TotalEnergies and other Avature portals).
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const k = clean(m[1].replace(/<[^>]+>/g, " "))?.toLowerCase(), v = clean(m[2].replace(/<[^>]+>/g, " "));
    if (k && v) fields[k] = v;
  }
  const field = (...keys: string[]) => keys.map((k) => fields[k]).find(Boolean) ?? null;
  const fLocation = field("ville", "city", "lieu de travail", "location", "localisation", "lieu");
  const fContract = field("type de contrat", "contract type", "type of contract", "contrat", "type d'emploi", "employment type");
  const fDate = field("date de publication", "publication date", "date posted", "posted on", "date", "publié le", "publiée le");
  const fStart = field("date de début", "date de debut", "début", "start date", "starting date", "date de démarrage", "démarrage",
    "prise de poste", "date de prise de poste", "disponibilité");
  const fieldText = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  // Dates some sites only keep in their page data or markup.
  const rawPosted = isoDate(html.match(/"datePosted"\s*:\s*"([^"]+)"/)?.[1]) ?? meta(html, "article:published_time")
    ?? isoDate(clean(html.match(/data-careersite-propertyid="date"[^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, " ")));
  const rawStart = html.match(/"(?:jobStartDate|start_date)"\s*:\s*"([^"]{4,40})"/)?.[1] ?? null;
  if (jp) {
    const loc = [jp.jobLocation].flat().filter(Boolean)[0]?.address ?? {};
    const desc = typeof jp.description === "string" ? jp.description : "";
    return {
      finalUrl, site,
      role: clean(jp.title), company: clean(jp.hiringOrganization?.name ?? jp.hiringOrganization),
      location: tidyCity(clean(loc.addressLocality) ?? clean(loc.addressRegion) ?? clean(typeof loc.addressCountry === "string" ? loc.addressCountry : loc.addressCountry?.name)),
      description: summarise(desc), date_posted: isoDate(jp.datePosted) ?? isoDate(fDate) ?? isoDate(rawPosted),
      contract: contractFrom(clean(jp.title), jp.employmentType, htmlToText(decode(desc))),
      startHint: clean(jp.jobStartDate) ?? fStart ?? (rawStart && !/^\d{4}-\d{2}-\d{2}/.test(rawStart) ? null : rawStart),
      text: [fieldText, htmlToText(decode(desc))].join("\n"),
    };
  }
  const title = meta(html, "og:title") ?? clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ")) ??
    clean(html.match(/<h2[^>]*title[^>]*>([\s\S]*?)<\/h2>/i)?.[1]?.replace(/<[^>]+>/g, " ")) ?? clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  // Only trust the page body when it's marked up as the main content; elsewhere menus get in the way.
  const body = htmlToText(html.match(/<(main|article)[\s\S]*<\/\1>/i)?.[0] ?? "");
  const fromBody = body && SECTION.test(body) ? summarise(body) : null;
  const desc = meta(html, "og:description") ?? meta(html, "description");
  const description = fromBody ?? (desc && title && desc.toLowerCase().startsWith(title.toLowerCase().slice(0, 20)) ? null : summarise(desc));
  return { finalUrl, site, role: title, location: tidyCity(fLocation), date_posted: isoDate(fDate) ?? isoDate(rawPosted), description,
    contract: contractFrom(title, fContract, body || desc || ""), startHint: fStart ?? rawStart,
    text: [fieldText, body || htmlToText(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? "")].join("\n") };
}

// "Analyst - TotalEnergies | Careers" → role "Analyst", company "TotalEnergies" when the page gave nothing better.
function splitTitle(row: Got, site: string | null | undefined) {
  if (!row.role) return;
  const linkedin = row.role.match(/^(.+?) hiring (.+?) in (.+?)(?: \| LinkedIn)?$/i);
  if (linkedin) { row.company ??= linkedin[1]; row.role = linkedin[2]; row.location ??= linkedin[3]; return; }
  const parts = row.role.split(/\s+[|–—]\s+|\s+-\s+(?=[^-]+$)/);
  if (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (/career|carri|job|emploi|recrut|welcome to the jungle|indeed|linkedin/i.test(tail) || (site && tail.toLowerCase().includes(site.toLowerCase()))) {
      parts.pop();
      if (parts.length > 1 && !row.company) row.company = parts.pop()!;
      row.role = parts.join(" - ");
    }
  }
}

function companyFromHost(host: string): string | null {
  const h = host.replace(/^www\./, "");
  const skip = /^(jobs|careers|career\d*|carrieres|join|apply|recrutement|emplois?|talent|boards|job-boards)\./;
  const base = h.replace(skip, "").split(".")[0];
  if (/^(myworkdayjobs|smartrecruiters|greenhouse|lever|ashbyhq|teamtailor|recruitee|personio|jobteaser|welcometothejungle|linkedin|indeed|oraclecloud|successfactors|sapsf|taleo|icims)$/.test(base)) return null;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
}

const SHARED_BOARDS = /^(jobs|careers)\.smartrecruiters\.com$|^(boards|job-boards)\.(eu\.)?greenhouse\.io$|^jobs\.(eu\.)?lever\.co$|^jobs\.ashbyhq\.com$|^apply\.workable\.com$/;
type Known = { companies: { name: string; careers_url: string | null; config: any }[]; posting: { title: string; location: string | null; posted_at: string | null; company: string | null } | null };
async function extract(raw: string, known: Known): Promise<{ row: Row; source: string; text: string }> {
  const companies = known.companies;
  const u = new URL(raw.trim());
  let source = "page";
  let got: Got = {};
  for (const [name, fn] of [["Workday", workday], ["SmartRecruiters", smartrecruiters], ["Greenhouse", greenhouse], ["Lever", lever], ["Ashby", ashby], ["Recruitee", recruitee], ["Oracle", oracle], ["LinkedIn", linkedin]] as const) {
    try { const r = await fn(u); if (r?.role) { got = r; source = name; break; } } catch { /* fall back to the page */ }
  }
  if (!got.role) {
    try {
      got = await generic(u);
      source = got.role ? (got.description || got.company ? "page data" : "page title") : "nothing found";
    } catch (e) {
      if (!known.posting) throw e;
      source = "your inbox";
    }
  }
  // Something the daily scraper already saw at this address fills the gaps (ENGIE pages, for example, hide the details).
  if (known.posting) {
    got.role ??= known.posting.title; got.location ??= known.posting.location;
    got.date_posted ??= known.posting.posted_at; got.company ??= known.posting.company;
  }
  splitTitle(got, got.site);
  // Company: one you already follow on the same site, else what the page says, else the site's name.
  const pages = [u, new URL(got.finalUrl ?? u.toString())];
  const hosts = pages.map((p) => p.hostname);
  // Same board: same site, and on boards many companies share (jobs.smartrecruiters.com/AFRY vs /Wavestone1),
  // the same company path too.
  const board = (p: URL) => SHARED_BOARDS.test(p.hostname) ? `${p.hostname}/${p.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? ""}` : p.hostname;
  const followed = companies.find((c) => {
    try { return !!c.careers_url && pages.some((p) => board(p) === board(new URL(c.careers_url!))); } catch { return false; }
  });
  if (followed && !/^(www\.)?(linkedin|welcometothejungle|indeed|jobteaser)\./.test(u.hostname) && !/jobteaser\.com$/.test(u.hostname)) got.company = followed.name;
  got.company ??= clean(got.site) ?? companyFromHost(hosts[1]);
  // Dates: the posting date the board gave, else one stated in the ad. The start date comes from a field the
  // board keeps, else the title or the ad's own words; a month without a year is placed after the posting date.
  const text = got.text ?? "";
  got.date_posted ??= postedFromText(text);
  const fromHint = got.startHint ? startFrom(null, `Start date: ${got.startHint}`, got.date_posted) : null;
  const start = fromHint ?? startFrom(got.role, text, got.date_posted);
  return {
    source, text,
    row: {
      company: got.company ?? null, role: tidyTitle(got.role ?? null), contract: got.contract ?? null,
      location: tidyCity(got.location ?? null), description: got.description ?? null, date_posted: got.date_posted ?? null,
      starts: start?.text ?? null, url: raw.trim(),
    },
  };
}

// ───────────────────────── reading ads in the background ─────────────────────────
// Called every 10 minutes by pg_cron (public.enrich_postings). First the start date stated in each new title, for
// every scraped posting; then the full ad of the newest postings that match your filters, for the start date it
// states and a one-line summary. Each posting is read once; a closed or unreadable ad keeps what its title gave.
// deno-lint-ignore no-explicit-any
async function enrich(db: any, limit: number) {
  const started = Date.now(), out = { titles: 0, titleStarts: 0, ads: 0, adStarts: 0 };
  for (;;) {
    const { data } = await db.from("postings").select("id, title, posted_at, first_seen").is("start_checked", null).limit(1000);
    if (!data?.length) break;
    // deno-lint-ignore no-explicit-any
    const rows = data.map((p: any) => {
      const st = startFrom(p.title, null, p.posted_at ?? String(p.first_seen).slice(0, 10));
      if (st) out.titleStarts++;
      return { id: p.id, starts: st?.text ?? null, starts_on: st?.from ?? null, checked: "title" };
    });
    const { error } = await db.rpc("set_posting_details", { p: rows });
    if (error) throw new Error(error.message);
    out.titles += rows.length;
    if (Date.now() - started > 50000) return out;
  }
  const { data: todo } = await db.from("postings").select("id, url, title, location, posted_at, first_seen, companies(name)")
    .eq("matched", true).eq("is_open", true).eq("state", "new").or("start_checked.is.null,start_checked.eq.title")
    .order("posted_sort", { ascending: false }).limit(limit);
  const { data: companies } = await db.from("companies").select("name, careers_url, config");
  // deno-lint-ignore no-explicit-any
  const queue: any[] = [...(todo ?? [])], results: unknown[] = [];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      let row: Row | null = null;
      try {
        row = (await extract(p.url, { companies: companies ?? [], posting: { title: p.title, location: p.location, posted_at: p.posted_at, company: p.companies?.name ?? null } })).row;
      } catch { /* closed or unreadable */ }
      const ref = row?.date_posted ?? p.posted_at ?? String(p.first_seen).slice(0, 10);
      const st = row?.starts ? startFrom(null, `Start date: ${row.starts}`, ref) : null;
      if (st) out.adStarts++;
      results.push({ id: p.id, starts: st?.text ?? null, starts_on: st?.from ?? null, summary: row?.description ?? null, posted_at: row?.date_posted ?? null, checked: "ad" });
    }
  }));
  if (results.length) {
    const { error } = await db.rpc("set_posting_details", { p: results });
    if (error) throw new Error(error.message);
  }
  out.ads = results.length;
  return out;
}

// deno-lint-ignore no-explicit-any
async function authorised(req: Request, db: any): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const { data } = await db.rpc("check_cron_secret", { p_secret: secret });
    return data === true;
  }
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data, error } = await userClient.rpc("is_owner");
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  if (!(await authorised(req, db))) return json({ error: "unauthorised" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.enrich) {
    if (!req.headers.get("x-cron-secret")) return json({ error: "background job only" }, 403);
    try { return json(await enrich(db, Math.min(60, Number(body.enrich.limit) || 30))); }
    catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
  }
  let url: URL;
  try { url = new URL(String(body.url ?? "").trim()); } catch { return json({ ok: false, error: "That doesn't look like a link." }); }
  const { data: companies } = await db.from("companies").select("name, careers_url, config");
  const plain = url.toString().replace(/&amp;/g, "&");
  const { data: seen } = await db.from("postings").select("title, location, posted_at, url, companies(name)")
    .in("url", [plain, plain.replace(/&/g, "&amp;"), (() => { try { return decodeURI(plain); } catch { return plain; } })()]).limit(1);
  const posting = seen?.[0] ? { title: seen[0].title, location: seen[0].location, posted_at: seen[0].posted_at, company: (seen[0] as any).companies?.name ?? null } : null;
  try {
    const { row, source, text } = await extract(url.toString(), { companies: companies ?? [], posting });
    const extra = body.debug ? { text: text.slice(0, 8000) } : {};
    if (!row.role && !row.company) return json({ ok: false, error: "The page didn't say what the job is. Fill the row by hand.", row, source, ...extra });
    return json({ ok: true, row, source, ...extra });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const error = /^40[13]\b/.test(msg)
      ? "This site only shows the ad to signed-in users, so the row needs filling by hand."
      : /^404\b/.test(msg) ? "That page no longer exists (the ad may be closed). Fill the row by hand."
      : `Couldn't open the page (${msg.slice(0, 120)}). Fill the row by hand.`;
    return json({ ok: false, error, row: { url: url.toString() } });
  }
});
