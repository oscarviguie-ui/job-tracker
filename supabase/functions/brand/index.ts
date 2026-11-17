// Edge function: find a company's website and logo so the log can show it.
//
//   POST { companies: [{ name, links?: string[] }], force?: { name, domain } }
//     → { brands: [{ key, name, domain, icon_url, icon_size, source }] }
//
// Website, in order: links that point at the company's own site (not a job board), the careers page of a
// company you follow with the same name, then Clearbit's public company-name suggestions.
// Logo: the site's icon from Google's favicon service, kept only if the site really has one.
// Results are stored in public.brands; a website set by hand (force) is kept as 'manual' and never replaced.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

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

// Same normalisation as the web app's companyKey().
const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export const companyKey = (name: string) =>
  fold(name).replace(/\b(sa|se|sas|ag|ltd|group|groupe|france)\b/g, "").replace(/[^a-z0-9]/g, "");

// Hosts that belong to job boards and applicant-tracking systems, not to the employer.
const BOARDS = /(^|\.)(myworkdayjobs|smartrecruiters|greenhouse|lever|ashbyhq|teamtailor|recruitee|personio|jobteaser|welcometothejungle|linkedin|lnkd|indeed|glassdoor|oraclecloud|successfactors|sapsf|taleo|icims|jobs2web|beetween|intervieweb|makesense|recsolu|pinpointhq|nos-recrutements|workable|jobvite|bamboohr|hellowork|apec|google|bit|monster|cadremploi)\.[a-z.]+$/i;
const SECOND_LEVEL = /^(co|com|org|net|gov|ac|edu)$/;
function siteOf(link: string): string | null {
  let host: string;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
  if (BOARDS.test(host)) return null;
  const parts = host.split(".");
  if (parts.length < 2) return null;
  const n = parts.length >= 3 && SECOND_LEVEL.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}

// Names as typed in the log ("ICIS (RELX)", "EDF - Agregio solutions", "KPMG France") → names a directory knows.
function variants(name: string): string[] {
  const v = [name, name.replace(/\(.*?\)/g, " "), name.split(/\s[-–|]\s/)[0], name.replace(/\b(france|group|groupe|sa|se|sas)\b/gi, " ")]
    .map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length >= 2);
  return [...new Set(v)];
}
// Clearbit's public company-name suggestions. Only exact name matches are trusted: a near miss ("Sia" → "Siamphone")
// would put the wrong logo on the row, which is worse than initials.
async function suggest(name: string): Promise<string[]> {
  for (const q of variants(name)) {
    try {
      const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const list = (await r.json()) as { name: string; domain: string }[];
      const k = companyKey(q);
      const label = (d: string) => d.split(".")[0].replace(/[^a-z0-9]/g, "");
      const ok = list.filter((x) => x.domain && (companyKey(x.name) === k || label(x.domain) === k));
      ok.sort((a, b) => Number(!/\.(com|fr|eu|group)$/.test(a.domain)) - Number(!/\.(com|fr|eu|group)$/.test(b.domain)));
      if (ok.length) return ok.map((x) => x.domain).slice(0, 2);
    } catch { /* try the next spelling */ }
  }
  return [];
}

// Google's favicon service answers 404 when a site has no icon (with fallback_opts), so a 200 means a real logo.
// Some sites only answer on www., so that is tried too.
const iconUrl = (host: string) =>
  `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${host}&size=128`;
async function icon(domain: string): Promise<{ url: string; size: number } | null> {
  for (const host of domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`]) {
    try {
      const url = iconUrl(host);
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) { await r.body?.cancel(); continue; }
      const b = new Uint8Array(await r.arrayBuffer());
      // PNG width lives in the IHDR chunk at byte 16.
      const size = b[0] === 0x89 && b[1] === 0x50 ? (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19] : 32;
      return { url, size };
    } catch { /* try the next host */ }
  }
  return null;
}

type Input = { name: string; links?: string[] };
type Brand = { key: string; name: string; domain: string | null; icon_url: string | null; icon_size: number | null; source: string; checked_at: string };

async function resolve(c: Input, followed: { name: string; careers_url: string | null }[], forced?: string): Promise<Brand> {
  const key = companyKey(c.name);
  const candidates: string[] = [];
  if (forced) candidates.push(forced.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase());
  else {
    for (const l of c.links ?? []) { const s = siteOf(l); if (s) candidates.push(s); }
    for (const f of followed) {
      const fk = companyKey(f.name);
      if (f.careers_url && fk.length >= 3 && (fk === key || fk.startsWith(key) || key.startsWith(fk))) {
        const s = siteOf(f.careers_url); if (s) candidates.push(s);
      }
    }
    candidates.push(...(await suggest(c.name)));
  }
  // Candidates are in order of trust; the first one with a real icon wins.
  const seen = new Set<string>();
  let best: { domain: string; url: string; size: number } | null = null;
  for (const d of candidates) {
    if (seen.has(d)) continue;
    seen.add(d);
    const ic = await icon(d);
    if (ic) { best = { domain: d, ...ic }; break; }
    if (seen.size >= 4) break;
  }
  return {
    key, name: c.name, domain: best?.domain ?? candidates[0] ?? null, icon_url: best?.url ?? null, icon_size: best?.size ?? null,
    source: forced ? "manual" : "auto", checked_at: new Date().toISOString(),
  };
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
  const { data: followed } = await db.from("companies").select("name, careers_url");

  if (body.force?.name) {
    const b = await resolve({ name: String(body.force.name) }, [], String(body.force.domain ?? ""));
    if (!body.force.domain) b.source = "auto";
    await db.from("brands").upsert(b);
    return json({ brands: [b] });
  }

  const input: Input[] = (Array.isArray(body.companies) ? body.companies : []).filter((c: Input) => c?.name).slice(0, 30);
  const keys = [...new Set(input.map((c) => companyKey(c.name)).filter(Boolean))];
  const { data: manual } = await db.from("brands").select("key").in("key", keys).eq("source", "manual");
  const skip = new Set((manual ?? []).map((m: { key: string }) => m.key));
  const todo = new Map<string, Input>();
  for (const c of input) {
    const k = companyKey(c.name);
    if (!k || skip.has(k)) continue;
    const prev = todo.get(k);
    todo.set(k, prev ? { name: prev.name, links: [...(prev.links ?? []), ...(c.links ?? [])] } : c);
  }
  const out: Brand[] = [];
  const queue = [...todo.values()];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) out.push(await resolve(c, followed ?? []));
  }));
  if (out.length) await db.from("brands").upsert(out);
  return json({ brands: out });
});
