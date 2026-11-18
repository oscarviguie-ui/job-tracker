// Edge function: scrape one company's careers board, or detect/preview a new one.
//
//   POST { company_id }         → fetch postings, store them, update the company's status
//   POST { detect: url, ... }   → work out the ATS behind a URL and preview what it returns (nothing stored)
//   POST { browser: "targets" | "ingest", ... } → the headless-browser job (GitHub Actions) asks which pages to open
//                                and hands back the job links it found there
//
// Callers: pg_cron via public.scrape_all() (x-cron-secret header, checked against Vault) or the web app (owner's JWT).
// The browser job carries no secret: GitHub signs a short-lived OIDC token for each run, and only a run of
// .github/workflows/browser-scrape.yml on this repo's main branch is accepted.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { ADAPTERS, type Company, detectFromPage } from "./adapters.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function authorised(req: Request, db: ReturnType<typeof createClient>): Promise<boolean> {
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

const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const BROWSER_WORKFLOW = "oscarviguie-ui/job-tracker/.github/workflows/browser-scrape.yml@refs/heads/main";
async function fromBrowserJob(req: Request): Promise<boolean> {
  const token = req.headers.get("x-github-oidc");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, GITHUB_JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: "job-tracker-scrape" });
    return payload.repository === "oscarviguie-ui/job-tracker" && payload.job_workflow_ref === BROWSER_WORKFLOW && payload.ref === "refs/heads/main";
  } catch (_) { return false; }
}

// deno-lint-ignore no-explicit-any
async function browserJob(db: any, body: any) {
  if (body.browser === "targets") {
    const { data } = await db.from("companies").select("id, careers_url, config").eq("ats", "browser").eq("active", true).order("id");
    // deno-lint-ignore no-explicit-any
    return json((data ?? []).map((c: any) => ({ id: c.id, url: c.config?.url ?? c.careers_url, pattern: c.config?.pattern ?? null, more: c.config?.more ?? null })));
  }
  const id = Number(body.company_id);
  const { data: c } = await db.from("companies").select("id, ats").eq("id", id).single();
  if (!c || c.ats !== "browser") return json({ error: "not a browser company" }, 400);
  // deno-lint-ignore no-explicit-any
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 1500).map((i: any) => ({
    external_id: String(i.external_id ?? "").slice(0, 300), title: String(i.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    url: /^https?:\/\//.test(String(i.url)) ? String(i.url).slice(0, 1000) : null, location: null, posted_at: null,
  // deno-lint-ignore no-explicit-any
  })).filter((i: any) => i.external_id && i.title.length >= 4 && i.url);
  // An empty page usually means the site didn't render for us, not that every job closed: keep what we had.
  if (body.error || !items.length) {
    await db.from("companies").update({ last_status: "error", last_run_at: new Date().toISOString(), last_error: String(body.error ?? "The page showed no job links").slice(0, 300) }).eq("id", id);
    return json({ ok: false });
  }
  const { data: result, error } = await db.rpc("ingest_postings", { p_company_id: id, p_items: items });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, ...result });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  if (req.headers.get("x-github-oidc")) {
    if (!(await fromBrowserJob(req))) return json({ error: "unauthorised" }, 401);
    return browserJob(db, await req.json().catch(() => ({})));
  }
  if (!(await authorised(req, db))) return json({ error: "unauthorised" }, 401);

  const body = await req.json().catch(() => ({}));

  // ── Probe: raw look at a page, for building new adapters ──
  if (body.probe) {
    const r = await fetch(String(body.probe), {
      method: body.method ?? "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Accept: body.accept ?? "*/*", ...(body.headers ?? {}) },
      body: body.payload ? JSON.stringify(body.payload) : undefined,
    });
    const text = await r.text();
    const pattern = body.pattern ? new RegExp(body.pattern, "gi") : null;
    return json({
      status: r.status, type: r.headers.get("content-type"), length: text.length,
      head: text.slice(Number(body.from ?? 0), Number(body.from ?? 0) + Number(body.chars ?? 3000)),
      matches: pattern ? [...text.matchAll(pattern)].slice(0, 40).map((m) => m[0].slice(0, 300)) : undefined,
    });
  }

  // ── Detect + preview ──
  if (body.detect) {
    const det = body.ats && body.config ? { ats: body.ats, config: body.config } : await detectFromPage(String(body.detect));
    if (!det) return json({ ok: false, error: "Could not recognise an applicant-tracking system at this URL." });
    const company: Company = { ats: det.ats, config: det.config, search: body.search ?? null, country: body.country ?? null };
    try {
      const postings = await ADAPTERS[det.ats](company);
      return json({ ok: true, detection: det, total: postings.length, sample: postings.slice(0, 8) });
    } catch (e) {
      return json({ ok: false, detection: det, error: String((e as Error).message ?? e) });
    }
  }

  // ── Scrape one company ──
  const id = Number(body.company_id);
  if (!id) return json({ error: "company_id or detect required" }, 400);
  const { data: company, error } = await db.from("companies").select("*").eq("id", id).single();
  if (error || !company) return json({ error: "company not found" }, 404);

  if (company.ats === "browser") return json({ ok: true, skipped: "read by the daily browser job" });
  const adapter = ADAPTERS[company.ats];
  if (!adapter) {
    await db.from("companies").update({ last_status: "unsupported", last_run_at: new Date().toISOString(), last_error: `No adapter for "${company.ats}" yet` }).eq("id", id);
    return json({ ok: false, error: "unsupported" });
  }
  try {
    const postings = await adapter(company as Company);
    const { data: result, error: ingestError } = await db.rpc("ingest_postings", { p_company_id: id, p_items: postings });
    if (ingestError) throw new Error(ingestError.message);
    return json({ ok: true, company: company.name, ...result });
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    await db.from("companies").update({ last_status: "error", last_error: msg, last_run_at: new Date().toISOString() }).eq("id", id);
    return json({ ok: false, company: company.name, error: msg });
  }
});
