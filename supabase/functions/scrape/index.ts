// Edge function: scrape one company's careers board, or detect/preview a new one.
//
//   POST { company_id }         → fetch postings, store them, update the company's status
//   POST { detect: url, ... }   → work out the ATS behind a URL and preview what it returns (nothing stored)
//
// Callers: pg_cron via public.scrape_all() (x-cron-secret header, checked against Vault) or the web app (owner's JWT).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
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
