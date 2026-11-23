import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { startFrom } from "./dates.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────────── vocabulary ─────────────────────────────
// One status per row. The Excel's three ticks are facts derived from it (the database keeps them in step):
// Applied = anything past "To apply" except Skipped; Response = Rejected, Interview, Offer, Accepted;
// Positive = Interview, Offer, Accepted. Dates stamp themselves when a row moves forward.
const STATUSES = [
  { id: "saved", label: "To apply", tone: "pending" },
  { id: "applied", label: "Applied", tone: "applied" },
  { id: "interview", label: "Interview", tone: "positive" },
  { id: "offer", label: "Offer", tone: "offer" },
  { id: "accepted", label: "Accepted", tone: "offer" },
  { id: "rejected", label: "Rejected", tone: "negative" },
  { id: "skipped", label: "Skipped", tone: "skipped" },
  // older values, shown if a row has them but not offered
  { id: "no_response", label: "Applied", tone: "applied", legacy: true },
  { id: "withdrawn", label: "Withdrawn", tone: "skipped", legacy: true },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
const ATS_LABEL = {
  workday: "Workday", smartrecruiters: "SmartRecruiters", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby",
  recruitee: "Recruitee", teamtailor: "Teamtailor", personio: "Personio", oracle: "Oracle", successfactors: "SuccessFactors",
  pinpoint: "Pinpoint", links: "Careers page", unknown: "Check by hand",
};

// ───────────────────────────── state ─────────────────────────────
const S = {
  user: null,
  view: "applications",
  companies: [],
  apps: [],
  settings: null,
  inbox: [],             // postings for the current inbox tab
  inboxTab: "new",       // new | all | dismissed
  inboxQuery: "",
  inboxF: loadInboxFilters(),    // inbox filters, each a list of ticked values: { kinds, places, starts, posted, categories, companies }
  inboxFacets: null,             // counts per value, from the database (each facet ignores its own filter)
  inboxTotal: 0,                 // postings that pass the filters (the list shows the newest 300)
  imenu: null,                   // the open inbox filter menu: { key }
  cursor: 0,
  appsQuery: "",
  sort: { key: null, dir: 1 },   // null = the log's own order (oldest row first, like the Excel)
  colFilters: loadColFilters(),  // Excel-style column filters: { key: { in: [values] } | { has: "text" } }
  fmenu: null,                   // the open column menu: { key }
  pendingLink: null,             // a link shared to the app, waiting for Save for later / Already applied
  season: null,                  // which round of applications the log shows; null = the current one
  drawer: null,          // { type: 'app'|'company', id|null }
  detect: null,          // detection preview in Companies
  coSectors: [],                 // Companies page: sectors shown (none = all)
  coShow: "all",                 // all | watched | paused | manual
  coQuery: "",
  coAdd: false,                  // the "add a company" form is open
  newCount: 0,
  brands: {},                    // company key → { domain, icon_url } from the brand function
  letters: [],                   // stored cover letters (Letters page)
  letterReplace: null,           // id of the letter whose file is being replaced
};

function localGet(k, d) { try { return localStorage.getItem("jt:" + k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem("jt:" + k, v); } catch { /* private mode */ } }
function loadColFilters() { try { return JSON.parse(localGet("colFilters", "{}")) ?? {}; } catch { return {}; } }
function loadInboxFilters() { try { return JSON.parse(localGet("inboxF", "{}")) ?? {}; } catch { return {}; } }

// ───────────────────────────── helpers ─────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? "") ? esc(u) : "");
const today = () => new Date().toISOString().slice(0, 10);
const fold = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const daysBetween = (a, b = today()) => Math.round((new Date(b) - new Date(a)) / 86400000);
function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d.length === 10 ? d + "T12:00:00" : d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
function relTime(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - new Date(ts)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function fail(error, what) {
  console.error(error);
  toast(`${what}: ${error.message ?? error}`);
}

// ───────────────────────────── data ─────────────────────────────
async function loadCore() {
  const [c, a, s, n, b, t] = await Promise.all([
    sb.from("companies").select("*").order("name"),
    sb.from("applications").select("*").order("id", { ascending: true }),
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("postings").select("id", { count: "exact", head: true }).eq("state", "new").eq("matched", true).eq("is_open", true),
    sb.from("brands").select("*"),
    sb.from("letters").select("*").order("category").order("name"),
  ]);
  for (const r of [c, a, s, n]) if (r.error) throw r.error;
  S.brands = Object.fromEntries((b.data ?? []).map((x) => [x.key, x]));
  S.companies = c.data;
  S.apps = a.data;
  S.settings = s.data;
  S.newCount = n.count ?? 0;
  S.letters = t.data ?? [];     // the Letters page still opens (empty) if the table isn't there yet
}
async function loadInbox() {
  // Filtering and counting happen in the database (public.inbox), so "All open postings" stays quick with 14 000 ads.
  // Order: newest posting date first (boards without one fall back to the day the ad was first seen), then soonest
  // start, then type (graduate programmes, internships, VIE, jobs).
  const { data, error } = await sb.rpc("inbox", { p: { tab: S.inboxTab, q: S.inboxQuery, ...S.inboxF } });
  if (error) throw error;
  for (const p of data.rows) {
    p.companies = { name: p.company };
    // Until the ad has been read, a start date stated in the title still shows.
    const st = p.starts ? { text: p.starts, from: p.starts_on } : startFrom(p.title, null, p.posted_at ?? today());
    p._starts = st?.text ?? null;
    p._startsOn = st?.from ?? null;
  }
  S.inbox = data.rows;
  S.inboxTotal = data.total;
  S.inboxFacets = data.facets;
  S.cursor = Math.min(S.cursor, Math.max(0, data.rows.length - 1));
}
async function refreshCount() {
  const { count } = await sb.from("postings").select("id", { count: "exact", head: true }).eq("state", "new").eq("matched", true).eq("is_open", true);
  S.newCount = count ?? 0;
}

// ───────────────────────────── shell ─────────────────────────────
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--grid)"/><rect x="6" y="19" width="4" height="7" fill="var(--s-applied)"/><rect x="12" y="13" width="4" height="13" fill="var(--s-interview)"/><rect x="18" y="9" width="4" height="17" fill="var(--s-offer)"/><rect x="24" y="5" width="4" height="21" fill="var(--s-accepted)"/></svg>`;
const ICONS = {
  inbox: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/></svg>`,
  applications: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M3 10h18"/></svg>`,
  companies: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5l7-2v18M11 9l9 2v10M7 8h1M7 12h1M7 16h1M15 14h1M15 17h1M2 21h20"/></svg>`,
  letters: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
};

function shell(content) {
  const tab = (id, label, extra = "") =>
    `<a href="#${id}" ${S.view === id ? 'aria-current="page"' : ""}>${ICONS[id]}<span>${label}</span>${extra}</a>`;
  return `<div class="shell">
    <header class="topbar"><div class="topbar-inner">
      <div class="brand">${LOGO}<span>Job Tracker</span></div>
      <nav class="nav" aria-label="Sections">
        ${tab("applications", "Applications")}
        ${tab("inbox", "Inbox", S.newCount ? `<span class="count">${S.newCount > 99 ? "99+" : S.newCount}</span>` : "")}
        ${tab("companies", "Companies")}
        ${tab("letters", "Letters")}
        ${tab("settings", "Settings")}
      </nav>
      <div class="spacer"></div>
    </div></header>
    <main id="main" class="${S.view === "applications" ? "wide" : ""}">${content}</main>
  </div>${S.drawer ? drawerHtml() : ""}`;
}

async function render() {
  const app = $("#app");
  if (!S.user) { app.innerHTML = authView(); bindAuth(); return; }
  const views = { inbox: inboxView, applications: appsView, companies: companiesView, letters: lettersView, settings: settingsView };
  app.innerHTML = shell((views[S.view] ?? appsView)());
  bindView();
  setTimeout(ensureBrands, 300);
}

// ───────────────────────────── auth ─────────────────────────────
function authView(msg = "", err = false) {
  return `<div class="auth"><div class="auth-card">
    <div class="brand">${LOGO}<span>Job Tracker</span></div>
    <h1>Sign in</h1>
    <p class="sub">New postings from your target companies every morning, and every application in one place.</p>
    <form id="auth-form" novalidate>
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
      <div class="row">
        <button class="btn primary" type="submit" name="mode" value="in">Sign in</button>
        <button class="btn" type="submit" name="mode" value="up">Create account</button>
      </div>
      <div id="auth-msg">${msg ? `<div class="note ${err ? "err" : ""}">${esc(msg)}</div>` : ""}</div>
    </form>
  </div></div>`;
}
function bindAuth() {
  const form = $("#auth-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = e.submitter?.value ?? "in";
    const email = form.email.value.trim();
    const password = form.password.value;
    const msg = $("#auth-msg");
    if (!email || password.length < 8) { msg.innerHTML = `<div class="note err">Enter your email and a password of at least 8 characters.</div>`; return; }
    e.submitter.disabled = true;
    if (mode === "up") {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      e.submitter.disabled = false;
      if (error) { msg.innerHTML = `<div class="note err">${esc(error.message)}</div>`; return; }
      if (!data.session) { msg.innerHTML = `<div class="note">Account created. Open the confirmation email, then come back and sign in.</div>`; return; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      e.submitter.disabled = false;
      if (error) { msg.innerHTML = `<div class="note err">${esc(error.message)}</div>`; return; }
    }
  });
}

// ───────────────────────────── inbox ─────────────────────────────
function inboxView() {
  const tabs = [["new", "New for you"], ["all", "All open postings"], ["dismissed", "Dismissed"]];
  const rows = S.inbox, filtered = activeInboxFilters().length > 0;
  let body;
  if (!rows.length) {
    const active = S.companies.filter((c) => c.active && c.ats !== "unknown").length;
    body = `<div class="feed"><div class="empty">${
      filtered ? `<h2>Nothing matches these filters</h2><p>Untick a few values, or clear the filters.</p><button class="btn" data-act="clear-inbox-filters">Clear filters</button>`
      : S.inboxTab === "new"
        ? active
          ? `<h2>You're up to date</h2><p>New postings that match your keywords land here after each morning check. Last check: ${esc(relTime(lastRun()))}.</p><button class="btn" data-act="run-all">Check all companies now</button>`
          : `<h2>No companies to watch yet</h2><p>Add the careers pages you care about and they'll be checked every morning.</p><a class="btn primary" href="#companies">Add companies</a>`
        : `<h2>Nothing here</h2><p>Try another search.</p>`
    }</div></div>`;
  } else {
    let lastDay = "";
    body = `<div class="feed" id="feed">${rows.map((p, i) => {
      const dayKey = String(p.posted_sort ?? "").slice(0, 10);
      const head = dayKey !== lastDay ? `<div class="day-head">Posted ${esc(dayLabel(dayKey))}</div>` : "";
      lastDay = dayKey;
      return head + postingRow(p, i);
    }).join("")}</div>
    ${S.inboxTotal > rows.length ? `<p class="faint small feed-more">Showing the newest ${rows.length} of ${S.inboxTotal}. Narrow the filters to see the rest.</p>` : ""}`;
  }
  const title = S.inboxTab === "new" ? `${S.newCount} new ${S.newCount === 1 ? "posting" : "postings"}` : S.inboxTab === "all" ? "All open postings" : "Dismissed";
  return `
    <div class="page-head">
      <div class="grow">
        <h1>${title}</h1>
        <p class="sub">${S.inboxTab === "new" ? "Postings from the companies you watch that match your keywords, newest first. Track the ones worth applying to; dismiss the rest." : S.inboxTab === "all" ? "Every open posting from the companies you watch, matching your keywords or not." : "Postings you dismissed. Restore one to put it back in New."}</p>
      </div>
      ${S.inboxTab === "new" && rows.length ? `<button class="btn" data-act="dismiss-visible">Dismiss ${filtered ? "these" : "all"} ${rows.length}</button>` : ""}
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Which postings">${tabs.map(([id, l]) => `<button data-inbox-tab="${id}" aria-pressed="${S.inboxTab === id}">${l}</button>`).join("")}</div>
      <input class="search" type="search" id="inbox-q" placeholder="Search titles and companies" value="${esc(S.inboxQuery)}">
      <span class="faint small hide-m">Keys: j / k to move, o to open, t to track, d to dismiss</span>
    </div>
    <div class="ifilters" role="group" aria-label="Filters">
      ${IDIMS.map((d) => inboxChip(d)).join("")}
      ${filtered ? `<span class="ifilters-count">${S.inboxTotal} ${S.inboxTotal === 1 ? "posting" : "postings"}</span><button type="button" class="linklike" data-act="clear-inbox-filters">Clear filters</button>` : ""}
    </div>
    ${body}`;
}
const KINDS = [["graduate", "Graduate programme"], ["internship", "Internship"], ["vie", "VIE"], ["apprenticeship", "Apprenticeship"], ["job", "Job"]];
const KIND_LABEL = { graduate: "Graduate programme", internship: "Internship", vie: "VIE", apprenticeship: "Apprenticeship" };
const KIND_CONTRACT = { graduate: "Graduate Program", internship: "Stage", vie: "VIE", apprenticeship: "Alternance" };
function dayLabel(d) {
  if (!d) return "";
  const diff = daysBetween(d);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return `on ${fmtDate(d)}`;
}
function lastRun() {
  return S.companies.map((c) => c.last_run_at).filter(Boolean).sort().at(-1);
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function postingRow(p, i) {
  const tracked = p.state === "tracked";
  const flag = p._starts ? windowFlag(readStart(p._starts)) : null;
  return `<div class="post ${i === S.cursor ? "active" : ""}" data-i="${i}" data-posting="${p.id}">
    <div class="post-body">
      <a class="post-title" href="${safeUrl(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="post-meta">
        <span class="company">${logoHtml(p.companies?.name, "sm")}${esc(p.companies?.name)}</span>
        ${KIND_LABEL[p.kind] ? `<span class="tag kind-${esc(p.kind)}">${KIND_LABEL[p.kind]}</span>` : ""}
        ${p.location ? `<span>${esc(p.location)}</span>` : ""}
        ${p._starts ? `<span class="p-start${flag ? ` start-${flag.kind}` : ""}"${flag ? ` title="${esc(flag.why)}"` : ""}>Starts ${esc(p._starts)}</span>` : ""}
        ${p.posted_at ? `<span>Posted ${esc(postedAgo(p.posted_at))}</span>` : `<span title="This board doesn't publish posting dates">First seen ${esc(postedAgo(String(p.first_seen).slice(0, 10)))}</span>`}
        ${!p.baseline && S.inboxTab === "new" ? `<span class="tag new">New listing</span>` : ""}
        ${!p.is_open ? `<span class="tag closed">Closed</span>` : ""}
        ${!p.matched && S.inboxTab !== "new" ? `<span class="tag">Outside your keywords</span>` : ""}
      </div>
      ${p.summary ? `<p class="post-summary">${esc(p.summary)}</p>` : ""}
    </div>
    <div class="post-actions">
      ${p.url ? `<a class="btn sm" href="${safeUrl(p.url)}" target="_blank" rel="noopener" title="${esc(p.url)}">${ICON_OPEN}<span>Open ad</span><span class="post-host">${esc(hostOf(p.url))}</span></a>` : ""}
      ${tracked ? `<span class="tag">Tracked</span>` : `<button class="btn sm primary" data-act="track" data-id="${p.id}">Track <kbd>t</kbd></button>`}
      ${p.state === "new" ? `<button class="btn sm" data-act="dismiss" data-id="${p.id}">Dismiss <kbd>d</kbd></button>` : ""}
      ${p.state === "dismissed" ? `<button class="btn sm" data-act="restore" data-id="${p.id}">Restore</button>` : ""}
    </div>
  </div>`;
}

// ── inbox filters: one multi-select menu per dimension, with counts from the database ──
const IDIMS = [
  { key: "places", label: "Where", search: true },
  { key: "starts", label: "Starts" },
  { key: "posted", label: "Posted" },
  { key: "kinds", label: "Type" },
  { key: "categories", label: "Sector" },
  { key: "companies", label: "Company", search: true },
];
const POSTED = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "2–6 days ago"], ["lastweek", "1–2 weeks ago"], ["month", "2–4 weeks ago"], ["older", "Over a month ago"]];
const PLACE_LAST = ["Several places", "Remote", "Other", ""];
const placeLabel = (c) => (c === "" ? "Not stated" : c === "Other" ? "Elsewhere" : c);
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthKeyLabel = (k) => `${MONTHS_SHORT[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
const activeInboxFilters = () => IDIMS.filter((d) => S.inboxF[d.key]?.length);
// Every value a menu can show: [{ v, label, n, region? }], in display order. Ticked values with no postings stay listed.
function inboxOptions(key) {
  const f = S.inboxFacets ?? {}, ticked = S.inboxF[key] ?? [];
  let opts = [];
  if (key === "kinds") opts = KINDS.map(([v, label]) => ({ v, label, n: f.kinds?.[v] ?? 0 }));
  if (key === "posted") opts = POSTED.map(([v, label]) => ({ v, label, n: f.posted?.[v] ?? 0 }));
  if (key === "starts") {
    const months = Object.keys(f.starts ?? {}).concat(ticked).filter((k) => /^\d{4}-\d{2}$/.test(k));
    opts = [{ v: "asap", label: "ASAP", n: f.starts?.asap ?? 0 },
      ...[...new Set(months)].sort().map((v) => ({ v, label: monthKeyLabel(v), n: f.starts?.[v] ?? 0 })),
      { v: "none", label: "Not stated", n: f.starts?.none ?? 0 }];
  }
  if (key === "categories") {
    const cats = [...new Set([...CATEGORIES, ...Object.keys(f.categories ?? {}), ...ticked])];
    opts = cats.map((v) => ({ v, label: v || "No sector", n: f.categories?.[v] ?? 0 }));
  }
  if (key === "companies") {
    const name = (id) => S.companies.find((c) => String(c.id) === String(id))?.name ?? `#${id}`;
    const ids = [...new Set([...Object.keys(f.companies ?? {}), ...ticked.map(String)])];
    opts = ids.map((v) => ({ v, label: name(v), n: f.companies?.[v] ?? 0 })).sort((a, b) => a.label.localeCompare(b.label, "fr", { sensitivity: "base" }));
  }
  if (key === "places") {
    // Countries, each followed by its regions (France: Paris area / elsewhere; Canada: provinces; UK: London / elsewhere).
    const byCountry = new Map();
    for (const [c, r, n] of f.places ?? []) {
      const e = byCountry.get(c) ?? { n: 0, regions: new Map() };
      e.n += n;
      if (r) e.regions.set(r, (e.regions.get(r) ?? 0) + n);
      byCountry.set(c, e);
    }
    for (const t of ticked) {
      const [c, r] = t.split("|");
      const e = byCountry.get(c) ?? { n: 0, regions: new Map() };
      if (r && !e.regions.has(r)) e.regions.set(r, 0);
      byCountry.set(c, e);
    }
    const rank = (c) => (PLACE_LAST.includes(c) ? 1 : 0);
    for (const [c, e] of [...byCountry].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
      opts.push({ v: c, label: placeLabel(c), n: e.n, country: true, hasRegions: e.regions.size > 0 });
      for (const [r, n] of [...e.regions].sort((a, b) => b[1] - a[1])) opts.push({ v: `${c}|${r}`, label: r, n, region: c });
    }
  }
  return opts.filter((o) => o.n > 0 || ticked.includes(o.v) || (o.country && ticked.some((t) => t.startsWith(o.v + "|"))));
}
function inboxSummary(key) {
  const vals = S.inboxF[key] ?? [];
  const opts = inboxOptions(key), label = (v) => opts.find((o) => o.v === v)?.label ?? v;
  const names = vals.map((v) => (key === "places" && v.includes("|") ? v.split("|")[1] : label(v)));
  return names.length <= 2 ? names.join(", ") : `${names.length} selected`;
}
function inboxChip(d) {
  const on = S.inboxF[d.key]?.length;
  return `<button type="button" class="ichip${on ? " on" : ""}${S.imenu?.key === d.key ? " open" : ""}" data-imenu="${d.key}" aria-haspopup="dialog">
    <b>${d.label}</b>${on ? `<span>${esc(inboxSummary(d.key))}</span>` : ""}${ICON_CARET}</button>`;
}

let imenuRoot = null;
function imenuHtml() {
  const d = IDIMS.find((x) => x.key === S.imenu.key), mobile = mobileQuery.matches;
  const ticked = S.inboxF[d.key], opts = inboxOptions(d.key);
  // Nothing ticked means no filter: every box starts ticked, like Excel.
  const isOn = (o) => !ticked?.length || ticked.includes(o.v) || (o.region && ticked.includes(o.region))
    || (o.country && o.hasRegions && ticked.some((t) => t.startsWith(o.v + "|")) && opts.filter((x) => x.region === o.v).every((x) => ticked.includes(x.v)));
  const st = S.settings ?? {};
  const windowBtn = d.key === "starts" && (st.available_from || st.available_until)
    ? `<button type="button" class="btn sm ghost" data-iwindow>Only my start window (${esc(windowLabel())})</button>` : "";
  return `${mobile ? `<div class="scrim" data-icancel></div>` : ""}
  <div class="fmenu imenu ${mobile ? "sheet" : ""}" role="dialog" aria-label="Filter: ${esc(d.label)}">
    <div class="imenu-head"><b>${esc(d.label)}</b>${windowBtn}</div>
    ${d.search || opts.length > 9 ? `<input type="search" id="imenu-q" placeholder="Search" aria-label="Search the values" enterkeyhint="done">` : ""}
    <div class="fmenu-list" id="imenu-list">
      <label class="fmenu-all"><input type="checkbox" id="imenu-all"><span>(Select all)</span></label>
      ${opts.map((o) => `<label data-v="${esc(fold(o.label + " " + (o.region ?? "")))}" class="${o.region ? "sub" : o.country && o.hasRegions ? "parent" : ""}" ${o.region ? `data-parent="${esc(o.region)}"` : ""}>
        <input type="checkbox" value="${esc(o.v)}" ${o.country && o.hasRegions ? "data-country" : ""} ${isOn(o) ? "checked" : ""}><span>${esc(o.label)}</span><b>${o.n}</b></label>`).join("")}
      ${opts.length ? "" : `<p class="faint small" style="margin:6px 10px">No postings to filter.</p>`}
    </div>
    <div class="fmenu-foot">${ticked?.length ? `<button type="button" class="btn sm ghost" data-iclear>Clear</button>` : ""}<span class="spacer"></span>
      <button type="button" class="btn sm" data-icancel>Cancel</button><button type="button" class="btn sm primary" data-iok>Apply</button></div>
  </div>`;
}
function windowLabel() {
  const st = S.settings ?? {};
  const a = st.available_from ? monthName(st.available_from) : "", b = st.available_until ? monthName(st.available_until) : "";
  return a && b ? `${a} – ${b}` : a ? `from ${a}` : `until ${b}`;
}
function openImenu(key, anchor) {
  if (!imenuRoot) {
    imenuRoot = Object.assign(document.createElement("div"), { id: "imenu-root" });
    document.body.append(imenuRoot);
    imenuRoot.addEventListener("click", onImenuClick);
    imenuRoot.addEventListener("input", onImenuInput);
    imenuRoot.addEventListener("change", onImenuChange);
    imenuRoot.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[type=search]")) { e.preventDefault(); applyImenu(); } });
  }
  S.imenu = { key };
  imenuRoot.innerHTML = imenuHtml();
  syncImenu();
  document.querySelectorAll("[data-imenu]").forEach((b) => b.classList.toggle("open", b.dataset.imenu === key));
  const menu = imenuRoot.querySelector(".fmenu");
  if (!mobileQuery.matches && anchor) {
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8));
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, innerHeight - menu.offsetHeight - 8);
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
    menu.querySelector("#imenu-q")?.focus();
  }
}
function closeImenu() {
  S.imenu = null;
  if (imenuRoot) imenuRoot.innerHTML = "";
  document.querySelectorAll("[data-imenu].open").forEach((b) => b.classList.remove("open"));
}
const imenuBoxes = () => [...imenuRoot.querySelectorAll("#imenu-list label[data-v] input")];
function syncImenu() {
  // A country's box follows its regions: ticked when all are, half-ticked when some are.
  for (const c of imenuRoot.querySelectorAll("input[data-country]")) {
    const subs = imenuBoxes().filter((b) => b.closest("label").dataset.parent === c.value);
    const n = subs.filter((b) => b.checked).length;
    c.checked = n === subs.length;
    c.indeterminate = n > 0 && n < subs.length;
  }
  const all = imenuRoot.querySelector("#imenu-all"), vis = imenuBoxes().filter((b) => !b.closest("label").hidden);
  const n = vis.filter((b) => b.checked).length;
  all.checked = vis.length > 0 && n === vis.length;
  all.indeterminate = n > 0 && n < vis.length;
  imenuRoot.querySelector("[data-iok]").disabled = n === 0;
}
function onImenuInput(e) {
  if (e.target.id !== "imenu-q") return;
  const q = fold(e.target.value.trim());
  for (const b of imenuBoxes()) {
    const label = b.closest("label");
    label.hidden = !!q && !label.dataset.v.includes(q);
    if (q) b.checked = !label.hidden;
  }
  syncImenu();
}
function onImenuChange(e) {
  const t = e.target;
  if (t.id === "imenu-all") imenuBoxes().filter((b) => !b.closest("label").hidden).forEach((b) => { b.checked = t.checked; });
  else if (t.dataset.country !== undefined) imenuBoxes().filter((b) => b.closest("label").dataset.parent === t.value).forEach((b) => { b.checked = t.checked; });
  syncImenu();
}
function onImenuClick(e) {
  e.stopPropagation();
  const t = e.target.closest("[data-icancel], [data-iok], [data-iclear], [data-iwindow]");
  if (!t) return;
  if (t.hasAttribute("data-iok")) return applyImenu();
  if (t.hasAttribute("data-iclear")) return setInboxFilter(S.imenu.key, null);
  if (t.hasAttribute("data-iwindow")) {
    // Months inside the window from Settings, and ASAP when today is inside it.
    const st = S.settings ?? {}, from = (st.available_from ?? "0000-00").slice(0, 7), until = (st.available_until ?? "9999-99").slice(0, 7);
    for (const b of imenuBoxes()) b.checked = b.value === "asap" ? today().slice(0, 7) >= from && today().slice(0, 7) <= until : /^\d{4}-\d{2}$/.test(b.value) && b.value >= from && b.value <= until;
    return syncImenu();
  }
  closeImenu();
}
function applyImenu() {
  const key = S.imenu?.key;
  if (!key) return;
  const boxes = imenuBoxes().filter((b) => b.dataset.country === undefined || !imenuBoxes().some((x) => x.closest("label").dataset.parent === b.value));
  const searching = !!imenuRoot.querySelector("#imenu-q")?.value.trim();
  const chosen = boxes.filter((b) => b.checked && (!searching || !b.closest("label").hidden)).map((b) => b.value);
  if (!chosen.length) return;
  // Everything ticked is no filter. A country whose regions are all ticked is sent as the country.
  if (!searching && chosen.length === boxes.length) return setInboxFilter(key, null);
  let vals = chosen;
  if (key === "places") {
    const countries = new Set(imenuBoxes().filter((b) => b.dataset.country !== undefined).map((b) => b.value));
    vals = [];
    for (const c of countries) {
      const subs = imenuBoxes().filter((b) => b.closest("label").dataset.parent === c);
      if (subs.length && subs.every((b) => chosen.includes(b.value))) vals.push(c);
      else vals.push(...subs.filter((b) => chosen.includes(b.value)).map((b) => b.value));
    }
    vals.push(...chosen.filter((v) => !v.includes("|") && !countries.has(v)));
  }
  setInboxFilter(key, vals);
}
async function setInboxFilter(key, vals) {
  closeImenu();
  if (vals?.length) S.inboxF[key] = vals; else delete S.inboxF[key];
  localSet("inboxF", JSON.stringify(S.inboxF));
  S.cursor = 0;
  try { await loadInbox(); } catch (err) { return fail(err, "Couldn't filter"); }
  render();
}
addEventListener("resize", () => { if (S.imenu && !mobileQuery.matches) closeImenu(); });

async function trackPosting(id) {
  const p = S.inbox.find((x) => x.id === id);
  if (!p) return;
  const { data, error } = await sb.from("applications").insert({
    season: currentSeason(), status: "saved", company: p.companies?.name ?? "", company_id: p.company_id, posting_id: p.id, role: p.title,
    location: p.location, url: p.url, date_posted: p.posted_at, contract: KIND_CONTRACT[p.kind] ?? guessContract(p.title), starts: p._starts ?? null,
    description: p.summary ?? null,
  }).select().single();
  if (error) return fail(error, "Couldn't track it");
  await sb.from("postings").update({ state: "tracked", application_id: data.id }).eq("id", id);
  S.apps.push(data);
  removeFromInbox(id, "tracked");
  toast(`Added to the log: ${p.title}`);
  // Fill Description (and anything else missing) from the posting page, in the background.
  try {
    const { data: x } = await sb.functions.invoke("extract", { body: { url: p.url } });
    if (x?.ok) {
      const patch = {};
      for (const k of ["description", "contract", "location", "date_posted", "starts"]) if (!data[k] && x.row[k]) patch[k] = x.row[k];
      if (Object.keys(patch).length) await savePatch(data.id, patch, true);
    }
  } catch { /* the row is there either way */ }
}
function guessContract(t = "") {
  const s = t.toLowerCase();
  if (/\bv\.?i\.?e\b/.test(s)) return "VIE";
  if (/stag|intern/.test(s)) return "Stage";
  if (/altern|apprenti/.test(s)) return "Alternance";
  if (/graduate|jeune dipl/.test(s)) return "Graduate Program";
  if (/\bcdd\b|fixed[- ]term/.test(s)) return "CDD";
  if (/\bcdi\b/.test(s)) return "CDI";
  return null;
}
async function setPostingState(id, state) {
  const { error } = await sb.from("postings").update({ state }).eq("id", id);
  if (error) return fail(error, "Couldn't update it");
  removeFromInbox(id, state);
}
async function removeFromInbox(id, state) {
  if (S.inboxTab === "all") {
    const p = S.inbox.find((x) => x.id === id);
    if (p) p.state = state;
  } else {
    S.inbox = S.inbox.filter((x) => x.id !== id);
    S.cursor = Math.min(S.cursor, Math.max(0, S.inbox.length - 1));
  }
  await refreshCount();
  render();
}

// ───────────────────────────── company logos ─────────────────────────────
// A logo next to every company name, so rows can be told apart at a glance. Logos come from each company's
// website (found by the brand function, stored in the brands table). Until one is found, or if a company has
// none, the tile shows the company's initials on a colour derived from its name, so it still reads as a mark.
function brandFor(name) {
  const k = companyKey(name ?? "");
  if (!k) return null;
  return S.brands[k] ?? Object.values(S.brands).find((b) => b.icon_url && sameCompany(b.name, name)) ?? null;
}
function initials(name) {
  name = name ?? "";
  const words = name.replace(/[^\p{L}\p{N} &'-]/gu, " ").split(/[\s&'-]+/).filter((w) => w && !/^(de|du|des|la|le|les|et|and|of|the|sa|se|sas|group|groupe)$/i.test(w));
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "?";
  const caps = w.match(/\p{Lu}/gu);
  return caps && caps.length >= 2 && w !== w.toUpperCase() ? caps.slice(0, 2).join("") : w.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}
const hueOf = (name = "") => [...companyKey(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
function logoHtml(name, cls = "") {
  const b = brandFor(name);
  const ini = esc(initials(name));
  return `<span class="logo ${cls}" data-logo="${esc(companyKey(name ?? ""))}" data-name="${esc(name ?? "")}" data-ini="${ini}" style="--hue:${hueOf(name)}" aria-hidden="true">${
    b?.icon_url ? `<img src="${esc(b.icon_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<b>${ini}</b>`}</span>`;
}
// A logo that fails to load falls back to the initials.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img?.matches?.(".logo img")) img.parentElement.innerHTML = `<b>${img.parentElement.dataset.ini}</b>`;
}, true);
function updateLogos() {
  document.querySelectorAll(".logo[data-logo]").forEach((el) => {
    const b = brandFor(el.dataset.name);
    if (b?.icon_url && !el.querySelector("img")) el.innerHTML = `<img src="${esc(b.icon_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  });
}
// Look up companies that don't have a logo yet, a batch at a time, in the background.
const brandTried = new Set();
let brandBusy = false;
async function ensureBrands() {
  if (brandBusy || !S.user) return;
  const byKey = new Map();
  const add = (name, link) => {
    const k = companyKey(name ?? "");
    if (!k || S.brands[k] || brandTried.has(k)) return;
    const e = byKey.get(k) ?? { name, links: [] };
    if (link) e.links.push(link);
    byKey.set(k, e);
  };
  [...S.apps].reverse().forEach((a) => add(a.company, a.url));
  S.companies.forEach((c) => add(c.name, c.careers_url));
  const todo = [...byKey.entries()].slice(0, 25);
  if (!todo.length) return;
  todo.forEach(([k]) => brandTried.add(k));
  brandBusy = true;
  try {
    const { data } = await sb.functions.invoke("brand", { body: { companies: todo.map(([, v]) => ({ name: v.name, links: v.links.slice(0, 5) })) } });
    for (const b of data?.brands ?? []) S.brands[b.key] = b;
    updateLogos();
  } catch { /* logos are a nicety; initials stay */ }
  brandBusy = false;
  if (byKey.size > todo.length) ensureBrands();
}

// ───────────────────────────── applications log ─────────────────────────────
// The Excel's columns, with one Status per row in place of the three tick boxes.
// Computer: a full-width table. Phone: a card per row.
const COLS = [
  { key: "company", label: "Company", kind: "text", w: 168 },
  { key: "role", label: "Position", kind: "text", w: 0 },        // 0 = shares the remaining width
  { key: "contract", label: "Type", kind: "text", w: 88, title: "Position Length" },
  { key: "starts", label: "Starts", kind: "start", w: 118, title: "When the job starts, as the ad states it" },
  { key: "location", label: "Location", kind: "text", w: 104 },
  { key: "description", label: "Description", kind: "long", w: 0 },
  { key: "date_posted", label: "Posted", kind: "date", w: 76, title: "Date Posted" },
  { key: "url", label: "Link", kind: "link", w: 66 },
  { key: "status", label: "Status", kind: "status", w: 128 },
  { key: "applied_on", label: "Applied", kind: "date", w: 76, title: "Application Date" },
  { key: "response_on", label: "Reply", kind: "reply", w: 104, title: "Response Date · Response Time (days)" },
];
const CONTRACT_SUGGESTIONS = ["Stage", "CDI", "CDD", "VIE", "Alternance", "Graduate Program"];
const mobileQuery = matchMedia("(max-width: 760px)");

const statusOf = (a) => STATUS[a.status] ?? STATUS.saved;
const rowTone = (a) => statusOf(a).tone;
const responseDays = (a) => (a.applied_on && a.response_on ? daysBetween(a.applied_on, a.response_on) : null);
// Days since applying with no reply yet; only meaningful in the season you're working on.
const waitingDays = (a) => (a.status === "applied" && a.applied_on && (a.season ?? 2) === currentSeason() ? daysBetween(a.applied_on) : null);
function shortDate(d) {
  if (!d) return "";
  const dt = new Date(d.slice(0, 10) + "T12:00:00");
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }) });
}
const fmtSheetDate = shortDate;
// How old an ad is: "today", "3 d ago" for the last month, then the date.
function postedAgo(d) {
  if (!d) return "";
  const n = daysBetween(d);
  return n <= 0 ? "today" : n <= 30 ? `${n} d ago` : shortDate(d);
}

// Start dates are kept as the ad (or you) wrote them, tidied: "Feb 2027", "Jan–Mar 2027", "ASAP".
// The same reader as the link extractor turns them back into a day, for sorting and for your start window.
const readStart = (text) => (text ? startFrom(null, `Start date: ${text}`, today()) : null);
const tidyStart = (text) => readStart(text)?.text ?? text;
const startDay = (a) => readStart(a.starts)?.from ?? null;
// Flag rows you could still act on whose start falls outside the window set in Settings. A range or an either/or
// ("Jan–Mar", "Dec or Feb") is only flagged when none of it fits.
function startFlag(a) {
  if (!["saved", "applied", "interview", "offer"].includes(a.status) || (a.season ?? 2) !== currentSeason()) return null;
  return windowFlag(readStart(a.starts));
}
// Outside the months set in Settings → When you can start (used by the log and the inbox).
function windowFlag(st) {
  const s = S.settings ?? {};
  if (!st) return null;
  if (s.available_from && st.to.slice(0, 7) < s.available_from.slice(0, 7)) return { kind: "early", why: `Starts before ${monthName(s.available_from)}, the earliest you can start` };
  if (s.available_until && st.from.slice(0, 7) > s.available_until.slice(0, 7)) return { kind: "late", why: `Starts after ${monthName(s.available_until)}, the latest start that works for you` };
  return null;
}
const monthName = (d) => new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });

// Seasons are rounds of applications. The current one is a setting, so a new season can start empty.
const currentSeason = () => S.settings?.current_season ?? 2;
const shownSeason = () => S.season ?? currentSeason();
const seasonRows = (n = shownSeason()) => S.apps.filter((a) => (a.season ?? 2) === n);
const rowNumber = (a) => seasonRows(a.season ?? 2).indexOf(a) + 1;
// The log's rows: this season, through the search box and the column filters, in the chosen order.
// sheetRows(key) leaves out that column's own filter and the ordering: it's what the column's menu offers.
function sheetRows(skip) {
  const q = fold(S.appsQuery.trim());
  let list = seasonRows().filter((a) => passesFilters(a, skip)
    && (!q || [a.company, a.role, a.location, a.description, a.contract, a.notes].some((v) => fold(v).includes(q))));
  if (skip !== undefined) return list;
  const { key, dir } = S.sort;
  if (!key) return [...list].reverse(); // newest first: what you just added is at the top
  // Empty dates sort last either way round.
  const order = (a) => (key === "status" ? STATUSES.findIndex((x) => x.id === a.status)
    : key === "contract" ? (a.contract ? (KIND_ORDER.indexOf(contractKind(a.contract)) + 1 || 50) : dir > 0 ? 99 : 0)
    : key === "starts" ? startDay(a) ?? (dir > 0 ? "9999" : "")
    : key === "date_posted" ? a.date_posted ?? (dir > 0 ? "9999" : "") : a[key] ?? "");
  return [...list].sort((a, b) => {
    const va = order(a), vb = order(b);
    return dir * (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "fr", { numeric: true, sensitivity: "base" }));
  });
}

// ── Excel-style column filters ──
// Each column's menu lists the values in that column (what's left after the other filters), with counts,
// like Excel's AutoFilter. Types are grouped ("internship" and "Stage" are both Internship), dates by month.
const KIND_ORDER = ["Graduate programme", "Internship", "VIE", "Apprenticeship", "Fixed-term (CDD)", "Permanent (CDI)"];
function contractKind(v) {
  const s = fold(v).trim();
  if (!s) return "";
  if (/\bv\.?i\.?e\b|volontariat/.test(s)) return "VIE";
  if (/altern|apprenti/.test(s)) return "Apprenticeship";
  if (/stag|\bintern|traineeship|summer|off.?cycle|placement/.test(s)) return "Internship";
  if (/grad|jeune.*dipl|trainee|rotational|young prof|program/.test(s)) return "Graduate programme";
  if (/\bcdd\b|fixed|temporar/.test(s)) return "Fixed-term (CDD)";
  if (/\bcdi\b|full|perman/.test(s)) return "Permanent (CDI)";
  return String(v).trim();
}
const STATUS_GROUP = { no_response: "applied", withdrawn: "skipped" };
const DATE_KEYS = ["date_posted", "applied_on", "response_on"];
// The value a row shows in a column's filter list ("" = blank).
function fval(a, key) {
  const v = a[key];
  if (key === "status") return STATUS[STATUS_GROUP[a.status] ?? a.status]?.label ?? STATUS.saved.label;
  if (key === "contract") return contractKind(v);
  if (key === "starts") { const r = readStart(v); return r ? (r.text === "ASAP" ? "ASAP" : monthName(r.from)) : String(v ?? "").trim(); }
  if (DATE_KEYS.includes(key)) return v ? monthName(v) : "";
  if (key === "url") return v ? "Has a link" : "";
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function passesFilters(a, skip) {
  for (const [k, f] of Object.entries(S.colFilters)) {
    if (k === skip || !f) continue;
    if (typeof f.has === "string") { if (!fold(a[k]).includes(fold(f.has))) return false; }
    else if (Array.isArray(f.in) && !f.in.includes(fval(a, k))) return false;
  }
  return true;
}
const activeFilters = () => Object.entries(S.colFilters).filter(([k, f]) => f && COLS.some((c) => c.key === k));
function setFilter(key, f) {
  if (f) S.colFilters[key] = f; else delete S.colFilters[key];
  localSet("colFilters", JSON.stringify(S.colFilters));
}
function clearFilters() { S.colFilters = {}; localSet("colFilters", "{}"); }
// "Nov 2026" → "2026-11" so months sort in time order; ASAP first, anything unreadable last.
const monthSortKey = (x) => {
  if (x === "ASAP") return "0000";
  const d = new Date(`1 ${x} 12:00`);
  return isNaN(d.getTime()) ? `9999${x}` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
function sortValues(key, values) {
  const rank = key === "status" ? (x) => STATUSES.findIndex((s) => !s.legacy && s.label === x)
    : key === "contract" ? (x) => (KIND_ORDER.indexOf(x) + 1 || 50) : null;
  const newestFirst = DATE_KEYS.includes(key), byMonth = newestFirst || key === "starts";
  return values.sort((x, y) => (x === "") - (y === "")
    || (rank ? rank(x) - rank(y) : 0)
    || (byMonth ? (newestFirst ? -1 : 1) * monthSortKey(x).localeCompare(monthSortKey(y)) : 0)
    || x.localeCompare(y, "fr", { sensitivity: "base", numeric: true }));
}
const ICON_CARET = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FUNNEL = `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" fill="currentColor"/></svg>`;
function filterSummary(f) {
  if (typeof f.has === "string") return `contains “${esc(f.has)}”`;
  const vals = f.in.map((v) => (v ? esc(v) : "(Blanks)"));
  return !vals.length ? "nothing" : vals.length <= 2 ? vals.join(", ") : `${vals.length} values`;
}
// The line under the toolbar: what's filtered, how many rows are left, and on a phone the way into the filters.
function filterBar() {
  const on = activeFilters(), mobile = mobileQuery.matches;
  if (!on.length && !mobile) return `<div class="fbar" id="fbar" hidden></div>`;
  const shown = sheetRows().length, total = seasonRows().length;
  return `<div class="fbar" id="fbar">
    ${mobile ? `<button type="button" class="btn sm" data-fmenu="${on[0]?.[0] ?? "contract"}">${ICON_FUNNEL} Sort &amp; filter</button>` : ""}
    ${on.length ? `<span>Showing ${shown} of ${total}</span>` : ""}
    ${on.map(([k, f]) => `<span class="fchip"><button type="button" data-fmenu="${k}" title="Change this filter"><b>${esc(COLS.find((c) => c.key === k).label)}:</b> ${filterSummary(f)}</button><button type="button" data-fclear="${k}" aria-label="Remove the ${esc(COLS.find((c) => c.key === k).label)} filter">×</button></span>`).join("")}
    ${on.length > 1 ? `<button type="button" class="linklike" data-act="clear-filters">Clear all</button>` : ""}
  </div>`;
}

// The column menu: sort, then a searchable list of values to tick (Excel's AutoFilter).
// On a computer it drops down from the header; on a phone it's a sheet with a column picker.
let fmenuRoot = null;
function fmenuHtml() {
  const key = S.fmenu.key, col = COLS.find((c) => c.key === key), f = S.colFilters[key], mobile = mobileQuery.matches;
  const [asc, desc] = col.kind === "date" || col.kind === "reply" ? ["Oldest first", "Newest first"]
    : col.kind === "start" ? ["Soonest first", "Latest first"] : key === "status" || key === "contract" ? ["In order", "Reverse"] : ["A → Z", "Z → A"];
  const sorted = (d) => S.sort.key === key && S.sort.dir === d;
  let body;
  if (key === "description") {
    body = `<label class="field"><span>Description contains</span><input type="search" id="fmenu-has" value="${esc(f?.has ?? "")}" placeholder="e.g. hydrogen" enterkeyhint="done"></label>`;
  } else {
    const counts = new Map();
    for (const a of sheetRows(key)) { const v = fval(a, key); counts.set(v, (counts.get(v) ?? 0) + 1); }
    for (const v of f?.in ?? []) if (!counts.has(v)) counts.set(v, 0);
    const values = sortValues(key, [...counts.keys()]);
    const ticked = (v) => !f?.in || f.in.includes(v);
    body = `<input type="search" id="fmenu-q" placeholder="Search ${esc(col.label.toLowerCase())}" aria-label="Search the values" enterkeyhint="done">
      <div class="fmenu-list" id="fmenu-list">
        <label class="fmenu-all"><input type="checkbox" id="fmenu-all"><span>(Select all)</span></label>
        ${values.map((v) => `<label data-v="${esc(fold(v || "(blanks)"))}"><input type="checkbox" value="${esc(v)}" ${ticked(v) ? "checked" : ""}><span>${v ? esc(v) : "<i>(Blanks)</i>"}</span><b>${counts.get(v)}</b></label>`).join("")}
        ${values.length ? "" : `<p class="faint small" style="margin:6px 10px">No values in this column.</p>`}
      </div>`;
  }
  return `${mobile ? `<div class="scrim" data-fcancel></div>` : ""}
  <div class="fmenu ${mobile ? "sheet" : ""}" role="dialog" aria-label="Sort and filter: ${esc(col.label)}">
    ${mobile ? `<label class="fmenu-col"><span>Column</span><select id="fmenu-col">${COLS.map((c) => `<option value="${c.key}" ${c.key === key ? "selected" : ""}>${c.label}${S.colFilters[c.key] ? " •" : ""}</option>`).join("")}</select></label>` : ""}
    <div class="fmenu-sort"><button type="button" data-fsort="1" aria-pressed="${sorted(1)}">${asc}</button><button type="button" data-fsort="-1" aria-pressed="${sorted(-1)}">${desc}</button></div>
    ${body}
    <div class="fmenu-foot">${f ? `<button type="button" class="btn sm ghost" data-fclear-this>Clear filter</button>` : ""}<span class="spacer"></span>
      <button type="button" class="btn sm" data-fcancel>Cancel</button><button type="button" class="btn sm primary" data-fok>OK</button></div>
  </div>`;
}
function openFmenu(key, anchor) {
  if (!fmenuRoot) {
    fmenuRoot = Object.assign(document.createElement("div"), { id: "fmenu-root" });
    document.body.append(fmenuRoot);
    fmenuRoot.addEventListener("click", onFmenuClick);
    fmenuRoot.addEventListener("input", onFmenuInput);
    fmenuRoot.addEventListener("change", onFmenuChange);
    fmenuRoot.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[type=search]")) { e.preventDefault(); applyFmenu(); } });
  }
  S.fmenu = { key };
  fmenuRoot.innerHTML = fmenuHtml();
  syncSelectAll();
  const menu = fmenuRoot.querySelector(".fmenu");
  if (!mobileQuery.matches && anchor) {
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8));
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, innerHeight - menu.offsetHeight - 8);
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
    menu.querySelector("#fmenu-q, #fmenu-has")?.focus();
  }
}
function closeFmenu() {
  S.fmenu = null;
  if (fmenuRoot) fmenuRoot.innerHTML = "";
}
const fmenuBoxes = () => [...fmenuRoot.querySelectorAll(".fmenu-list label[data-v] input")];
const visibleBoxes = () => fmenuBoxes().filter((b) => !b.closest("label").hidden);
function syncSelectAll() {
  const all = fmenuRoot.querySelector("#fmenu-all");
  if (!all) return;
  const vis = visibleBoxes(), n = vis.filter((b) => b.checked).length;
  all.checked = vis.length > 0 && n === vis.length;
  all.indeterminate = n > 0 && n < vis.length;
  fmenuRoot.querySelector("[data-fok]").disabled = n === 0;
}
function onFmenuInput(e) {
  if (e.target.id !== "fmenu-q") return;
  // Like Excel: searching narrows the list and ticks what matches; OK keeps only those.
  const q = fold(e.target.value.trim());
  for (const b of fmenuBoxes()) {
    const label = b.closest("label");
    label.hidden = !!q && !label.dataset.v.includes(q);
    if (q) b.checked = !label.hidden;
  }
  syncSelectAll();
}
function onFmenuChange(e) {
  if (e.target.id === "fmenu-col") return openFmenu(e.target.value);
  if (e.target.id === "fmenu-all") visibleBoxes().forEach((b) => { b.checked = e.target.checked; });
  syncSelectAll();
}
function onFmenuClick(e) {
  e.stopPropagation(); // the page's own click handler never sees clicks inside the menu
  const t = e.target.closest("[data-fcancel], [data-fok], [data-fsort], [data-fclear-this]");
  if (!t) return;
  const key = S.fmenu?.key;
  if (t.dataset.fsort) {
    S.sort = { key, dir: Number(t.dataset.fsort) };
    closeFmenu();
    return render();
  }
  if (t.hasAttribute("data-fok")) return applyFmenu();
  if (t.hasAttribute("data-fclear-this")) { setFilter(key, null); closeFmenu(); return render(); }
  closeFmenu();
}
function applyFmenu() {
  const key = S.fmenu?.key;
  if (!key) return;
  if (key === "description") {
    const t = fmenuRoot.querySelector("#fmenu-has").value.trim();
    setFilter(key, t ? { has: t } : null);
  } else {
    const searching = !!fmenuRoot.querySelector("#fmenu-q")?.value.trim();
    const boxes = fmenuBoxes(), chosen = (searching ? visibleBoxes() : boxes).filter((b) => b.checked).map((b) => b.value);
    if (!chosen.length) return;
    setFilter(key, !searching && chosen.length === boxes.length ? null : { in: chosen });
  }
  closeFmenu();
  render();
}
addEventListener("resize", () => { if (S.fmenu && !mobileQuery.matches) closeFmenu(); });

// ── pieces shared by the table and the cards ──
const statusSelect = (a) => `<select class="status-pill tone-${rowTone(a)}" data-status-of="${a.id}" aria-label="Status">${
  STATUSES.filter((x) => !x.legacy || x.id === a.status).map((x) => `<option value="${x.id}" ${x.id === a.status ? "selected" : ""}>${x.label}</option>`).join("")}</select>`;
const dateBtn = (a, field, empty = "") =>
  `<button type="button" class="date-btn ${a[field] ? "" : "is-empty"}" data-date="${field}" title="Change the date">${a[field] ? esc(shortDate(a[field])) : empty}</button>`;
const ICON_OPEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;
function replyHtml(a) {
  if (a.responded) {
    const d = responseDays(a);
    return `${dateBtn(a, "response_on")}${d !== null ? `<span class="days" title="Response time">${d} d</span>` : ""}`;
  }
  const w = waitingDays(a);
  return w !== null ? `<span class="waiting" title="Days since you applied, no reply yet">${w} d waiting</span>` : "";
}

function cellHtml(a, c) {
  const v = a[c.key];
  switch (c.kind) {
    case "text":
      if (c.key === "company") return `<td class="c-company"><div class="co-cell">${logoHtml(v)}<div class="ed" data-field="company" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></div></td>`;
      return `<td class="c-${c.key}"><div class="ed" data-field="${c.key}" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></td>`;
    case "long":
      return `<td class="c-desc"><div class="ed clamp" data-field="${c.key}" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></td>`;
    case "start": {
      const f = startFlag(a);
      return `<td class="c-start${f ? ` start-${f.kind}` : ""}"${f ? ` title="${esc(f.why)}"` : ""}><div class="ed" data-field="starts" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></td>`;
    }
    case "date":
      if (c.key === "date_posted" && v) return `<td class="c-date" title="Posted ${esc(postedAgo(v))}">${dateBtn(a, c.key)}</td>`;
      return `<td class="c-date">${c.key === "applied_on" && !a.applied ? "" : dateBtn(a, c.key)}</td>`;
    case "link":
      return `<td class="c-link">${v ? `<a class="open-link" href="${safeUrl(v)}" target="_blank" rel="noopener" title="${esc(v)}" aria-label="Open the posting">${ICON_OPEN}</a>` : ""}<button type="button" class="link-edit" data-edit-link title="${v ? "Change the link" : "Add a link"}">${v ? "✎" : "+"}</button></td>`;
    case "status":
      return `<td class="c-status">${statusSelect(a)}</td>`;
    case "reply":
      return `<td class="c-reply">${replyHtml(a)}</td>`;
  }
  return "<td></td>";
}
function rowHtml(a, n) {
  return `<tr data-row="${a.id}" class="tone-${rowTone(a)}">
    <th class="gutter" scope="row"><button data-open="${a.id}" title="Open the full record: notes, contacts, history">${n}</button></th>
    ${COLS.map((c) => cellHtml(a, c)).join("")}
  </tr>`;
}
// Phone: one card per row. Tap the text to edit everything; the status changes in place.
function cardHtml(a, n) {
  const f = startFlag(a);
  const meta = [a.contract && esc(a.contract), a.starts && `<span class="card-start${f ? ` start-${f.kind}` : ""}"${f ? ` title="${esc(f.why)}"` : ""}>starts ${esc(a.starts)}</span>`,
    a.location && esc(a.location)].filter(Boolean).join(" · ");
  const d = responseDays(a), w = waitingDays(a);
  const when = a.responded ? `${a.response_on ? `reply ${esc(shortDate(a.response_on))}` : "replied"}${d !== null ? ` · ${d} d` : ""}`
    : a.applied ? `applied ${a.applied_on ? esc(shortDate(a.applied_on)) : ""}${w !== null ? ` · ${w} d waiting` : ""}`
    : a.date_posted ? `posted ${esc(postedAgo(a.date_posted))}` : "";
  return `<article class="card tone-${rowTone(a)}" data-row="${a.id}">
    <button type="button" class="card-main" data-open="${a.id}">
      ${logoHtml(a.company, "lg")}
      <span class="card-text">
        <span class="card-top"><b class="co">${esc(a.company) || '<span class="faint">No company</span>'}</b><span class="n">#${n}</span></span>
        ${a.role ? `<span class="card-role">${esc(a.role)}</span>` : ""}
        ${meta ? `<span class="card-meta">${meta}</span>` : ""}
        ${a.description ? `<span class="card-desc">${esc(a.description)}</span>` : ""}
      </span>
    </button>
    <div class="card-foot">
      ${statusSelect(a)}
      <span class="card-when">${when}</span>
      ${a.url ? `<a class="card-link" href="${safeUrl(a.url)}" target="_blank" rel="noopener" aria-label="Open the posting">${ICON_OPEN}</a>` : ""}
    </div>
  </article>`;
}
const itemHtml = (a) => (mobileQuery.matches ? cardHtml(a, rowNumber(a)) : rowHtml(a, rowNumber(a)));

// The Excel's Performance Metrics, in one line.
function ratios() {
  const A = seasonRows();
  const filled = A.filter((a) => a.applied).length;
  const responses = A.filter((a) => a.responded).length;
  const positive = A.filter((a) => a.positive).length;
  const pct = (n, digits) => (filled ? `${((100 * n) / filled).toFixed(digits)}%` : "–");
  const waits = A.map(responseDays).filter((x) => x !== null).sort((x, y) => x - y);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  return `<dl class="ratios">
    <div><dt>applied</dt><dd>${filled}</dd></div>
    <div title="${responses} responses"><dt>response rate</dt><dd>${pct(responses, 0)}</dd></div>
    <div title="${positive} positive responses"><dt>positive</dt><dd>${pct(positive, 1)}</dd></div>
    ${median === null ? "" : `<div class="hide-xs"><dt>typical reply</dt><dd>${median} d</dd></div>`}
  </dl>`;
}
// Where the season stands: a bar of statuses that doubles as a quick filter on the Status column.
const onlyStatus = (label) => S.colFilters.status?.in?.length === 1 && S.colFilters.status.in[0] === label;
function statusBar() {
  const A = seasonRows();
  if (!A.length) return "";
  const groups = STATUSES.filter((x) => !x.legacy).map((x) => ({ ...x, n: A.filter((a) => a.status === x.id || (x.id === "applied" && a.status === "no_response") || (x.id === "skipped" && a.status === "withdrawn")).length })).filter((g) => g.n);
  return `<div class="mix" role="group" aria-label="Filter by status">
    <div class="mix-bar">${groups.map((g) => `<span class="tone-${g.tone}" style="flex:${g.n}"></span>`).join("")}</div>
    <div class="mix-legend">${groups.map((g) => `<button data-filter="${g.id}" class="tone-${g.tone}" aria-pressed="${onlyStatus(g.label)}"><i></i>${g.label}<b>${g.n}</b></button>`).join("")}
      ${S.colFilters.status ? `<button data-filter="" class="clear">Show all</button>` : ""}</div>
  </div>`;
}
function appsView() {
  const list = sheetRows();
  const cur = currentSeason(), shown = shownSeason();
  const seasons = [...new Set([cur, ...S.apps.map((a) => a.season ?? 2)])].sort((a, b) => b - a);
  const archive = shown !== cur;
  const mobile = mobileQuery.matches;
  const head = COLS.map((c) => {
    const on = S.sort.key === c.key;
    const fOn = !!S.colFilters[c.key];
    return `<th class="h-${c.kind}${fOn ? " filtered" : ""}" ${c.w ? `style="width:${c.w}px"` : ""} data-sort="${c.key}" title="${c.title ?? c.label}" aria-sort="${on ? (S.sort.dir > 0 ? "ascending" : "descending") : "none"}">${c.label}${on ? `<i class="arrow">${S.sort.dir > 0 ? "↑" : "↓"}</i>` : ""}<button type="button" class="fbtn${fOn ? " on" : ""}" data-fmenu="${c.key}" aria-label="Sort and filter ${c.label}${fOn ? " (filtered)" : ""}" title="Sort and filter">${fOn ? ICON_FUNNEL : ICON_CARET}</button></th>`;
  }).join("");
  const empty = seasonRows().length
    ? `<div class="empty">No rows match. <button class="btn sm" data-act="clear-filters">Show all</button></div>`
    : `<div class="empty"><h2>Season ${shown} is empty</h2><p>Paste a job link above. <b>Save for later</b> keeps it to apply when you have time; <b>Already applied</b> logs one you've just sent.</p></div>`;
  return `
    <div class="log-head">
      <h1>Applications</h1>
      <select id="season-select" class="season-select" aria-label="Season">
        ${seasons.map((n) => `<option value="${n}" ${n === shown ? "selected" : ""}>Season ${n}${n === cur ? "" : " (record)"}</option>`).join("")}
        <option value="new">Start Season ${cur + 1}…</option>
      </select>
      ${ratios()}
    </div>
    ${archive ? `<p class="archive-note">Season ${shown} is the record of that round. New links go to Season ${cur} and are checked against every season.</p>` : `
    <form id="link-form" class="add-bar" autocomplete="off">
      <div class="add-field">
        <input type="text" id="link-input" name="url" inputmode="url" placeholder="Paste a job link, or type a company" aria-label="Job link or company name" required value="${esc(S.pendingLink ?? "")}">
        ${mobile && navigator.clipboard?.readText ? `<button type="button" class="paste-btn" data-act="paste">Paste</button>` : ""}
      </div>
      <button class="btn" type="submit" name="mode" value="later" title="Adds the row as To apply">Save for later</button>
      <button class="btn primary" type="submit" name="mode" value="applied" title="Adds the row as Applied, dated today">Already applied</button>
    </form>`}
    <div class="log-tools">
      ${statusBar()}
      <input class="search" type="search" id="apps-q" placeholder="Search" value="${esc(S.appsQuery)}" aria-label="Search the log">
    </div>
    ${filterBar()}
    ${mobile
      ? `<div class="cards" id="rows">${list.map(itemHtml).join("")}</div>${list.length ? "" : empty}`
      : `<div class="log-scroll" id="log-scroll">
          <table class="log" id="log">
            <thead><tr><th class="gutter" aria-label="Row"></th>${head}</tr></thead>
            <tbody id="rows">${list.map(itemHtml).join("")}</tbody>
          </table>
          ${list.length ? "" : empty}
        </div>
        <p class="faint small log-foot">Click a cell to edit it. The ▾ next to a column name sorts and filters it, like Excel. Dates fill themselves when the status moves on; click one to change it. The row number opens notes, contacts and history.${S.sort.key ? ` <button class="linklike" data-act="clear-sort">Back to newest first</button>` : ""}</p>`}
    <datalist id="contracts">${CONTRACT_SUGGESTIONS.map((c) => `<option value="${c}">`).join("")}</datalist>`;
}

// Re-draw one row in place (keeps scroll and focus elsewhere), plus the figures above.
function refreshRow(id) {
  const a = S.apps.find((x) => x.id === id);
  const el = document.querySelector(`[data-row="${id}"]`);
  if (el && a) {
    const focusedField = document.activeElement?.closest(`[data-row="${id}"]`) ? document.activeElement.dataset.field : null;
    el.outerHTML = itemHtml(a);
    if (focusedField) document.querySelector(`[data-row="${id}"] [data-field="${focusedField}"]`)?.focus();
  }
  refreshSummary();
}
function refreshSummary() {
  const r = $(".ratios");
  if (r) r.outerHTML = ratios();
  const fb = $("#fbar");
  if (fb) fb.outerHTML = filterBar();
  const m = $(".mix");
  if (m) m.outerHTML = statusBar();
}
async function savePatch(id, patch, quiet = false) {
  const { data, error } = await sb.from("applications").update(patch).eq("id", id).select().single();
  if (error) { fail(error, "Couldn't save"); refreshRow(id); return null; }
  S.apps = S.apps.map((a) => (a.id === id ? data : a));
  if (!quiet) refreshRow(id);
  return data;
}
async function commitCell(ed) {
  const id = Number(ed.closest("[data-row]").dataset.row);
  const field = ed.dataset.field;
  const a = S.apps.find((x) => x.id === id);
  let value = ed.textContent.replace(/ /g, " ").trim();
  if (field !== "description") value = value.replace(/\s+/g, " ");
  if (field === "starts" && value) { value = tidyStart(value); ed.textContent = value; }
  if ((a[field] ?? "") === value) return;
  if (field === "company" && !value) { ed.textContent = a.company; return toast("A row needs a company name."); }
  const saved = await savePatch(id, { [field]: value || null }, true);
  if (saved && field === "starts") {
    // Re-check the start window on the spot without redrawing the row (that would steal focus while tabbing).
    const td = ed.closest("td"), f = startFlag(saved);
    td.className = `c-start${f ? ` start-${f.kind}` : ""}`;
    if (f) td.title = f.why; else td.removeAttribute("title");
  }
}
function editDate(btn) {
  const id = Number(btn.closest("[data-row]").dataset.row);
  const field = btn.dataset.date;
  const a = S.apps.find((x) => x.id === id);
  const input = document.createElement("input");
  input.type = "date";
  input.className = "date-input";
  input.value = a[field] ?? "";
  btn.replaceWith(input);
  input.focus();
  try { input.showPicker?.(); } catch { /* some browsers only open it on a direct click */ }
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value || null;
    if (save && v !== (a[field] ?? null)) await savePatch(id, { [field]: v });
    else refreshRow(id);
  };
  input.addEventListener("change", () => finish(true));
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); if (e.key === "Enter") input.blur(); });
}
function editLink(td) {
  const id = Number(td.closest("[data-row]").dataset.row);
  const a = S.apps.find((x) => x.id === id);
  td.innerHTML = `<input type="url" class="link-input" value="${esc(a.url ?? "")}" placeholder="https://…">`;
  const input = td.querySelector("input");
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim() || null;
    if (save && v !== (a.url ?? null)) await savePatch(id, { url: v });
    else refreshRow(id);
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); if (e.key === "Enter") input.blur(); });
}
// First link in a piece of text (LinkedIn's share sheet sends "Title … https://…").
const firstUrl = (t) => (t ?? "").match(/https?:\/\/[^\s<>"']+/)?.[0]?.replace(/[).,;]+$/, "") ?? null;
async function pasteLink() {
  try {
    const text = await navigator.clipboard.readText();
    const url = firstUrl(text);
    if (!url) return toast("There's no link on the clipboard.");
    const input = $("#link-input");
    input.value = url;
    input.focus();
  } catch {
    toast("The browser didn't allow pasting. Long-press the box and paste instead.");
    $("#link-input")?.focus();
  }
}
// A new round of applications. Rows still "To apply" come along; everything else stays as the record.
async function startSeason() {
  const cur = currentSeason(), next = cur + 1;
  const carry = S.apps.filter((a) => (a.season ?? 2) === cur && a.status === "saved");
  const msg = `Start Season ${next}?\n\nNew links will go to Season ${next}, and Season ${cur} stays as a record you can look back at.`
    + (carry.length ? `\n\nYour ${carry.length} "To apply" ${carry.length === 1 ? "row moves" : "rows move"} to Season ${next}.` : "");
  if (!confirm(msg)) return render();
  const { error } = await sb.from("settings").update({ current_season: next }).eq("id", 1);
  if (error) return fail(error, "Couldn't start the season");
  if (carry.length) {
    const { error: e2 } = await sb.from("applications").update({ season: next }).in("id", carry.map((a) => a.id));
    if (e2) fail(e2, "Couldn't move the To apply rows");
    else carry.forEach((a) => { a.season = next; });
  }
  S.settings.current_season = next;
  S.season = null;
  render();
  toast(`Season ${next} started`);
}

// ── Has this job been logged before, in any season? ──
function urlKey(u) {
  try {
    const x = new URL(u);
    const li = x.hostname.endsWith("linkedin.com") && (x.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ?? x.searchParams.get("currentJobId"));
    if (li) return `linkedin:${li}`;
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/(applications\/new|apply)\/?$/, "").replace(/\/+$/, "")).toLowerCase();
  } catch { return null; }
}
const companyKey = (c) => fold(c).replace(/\b(sa|se|sas|ag|ltd|group|groupe|france)\b/g, "").replace(/[^a-z0-9]/g, "");
const ROLE_NOISE = new Set(["stage", "stagiaire", "intern", "internship", "h", "f", "m", "x", "w", "d", "de", "du", "des", "la", "le", "les", "et", "en", "and", "the", "of", "for", "pour", "a", "au", "cdi", "cdd", "vie"]);
const roleWords = (r) => new Set(fold(r).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !ROLE_NOISE.has(w)));
function sameCompany(a, b) {
  const x = companyKey(a), y = companyKey(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))));
}
function similarRole(a, b) {
  const x = roleWords(a), y = roleWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
function findRepeat(url, row) {
  const key = urlKey(url);
  const byUrl = key && S.apps.find((a) => a.url && urlKey(a.url) === key);
  if (byUrl) return { a: byUrl, why: "the same link" };
  if (row?.company && row?.role) {
    const like = S.apps.find((a) => sameCompany(a.company, row.company) && similarRole(a.role, row.role));
    if (like) return { a: like, why: "a very similar job" };
  }
  return null;
}
const describeRow = (a) => `${a.company}${a.role ? ` – ${a.role}` : ""} (Season ${a.season ?? 2}, row ${rowNumber(a)}: ${statusOf(a).label}${a.applied_on ? `, applied ${shortDate(a.applied_on)}` : ""})`;

// Paste a link → read the posting → new row at the bottom, like typing in the next empty Excel row.
//   mode "later":   saved to apply when there's time (Applied unticked)
//   mode "applied": already sent, e.g. a LinkedIn Easy Apply (Applied ticked, dated today)
async function addFromLink(raw, mode = "later") {
  let url;
  const text = raw.trim();
  try { url = new URL(firstUrl(text) ?? text).toString(); } catch { url = null; }
  if (!url) return addTypedRow(text, mode);
  const early = findRepeat(url);
  if (early && !confirm(`You've logged this link before:\n\n${describeRow(early.a)}\n\nAdd it again?`)) {
    S.season = early.a.season ?? 2;
    render();
    return focusRow(early.a.id);
  }
  const input = $("#link-input");
  const buttons = [...document.querySelectorAll("#link-form button")];
  if (input) { input.value = ""; input.disabled = true; }
  buttons.forEach((b) => { b.disabled = true; });
  S.pendingLink = null;
  const reading = `<span class="spinner"></span>Reading ${esc(new URL(url).hostname)}…`;
  const pending = document.createElement(mobileQuery.matches ? "div" : "tr");
  pending.className = "pending-row";
  pending.innerHTML = mobileQuery.matches ? reading : `<th class="gutter"></th><td colspan="${COLS.length}">${reading}</td>`;
  $("#rows")?.prepend(pending);
  let row = { url }, note = "";
  try {
    const { data, error } = await sb.functions.invoke("extract", { body: { url } });
    if (error) throw error;
    if (data?.ok) row = { ...data.row, url };
    else note = data?.error ?? "Couldn't read that page.";
  } catch (err) {
    note = `Couldn't read that page (${err.message ?? err}).`;
  }
  const done = () => {
    pending.remove();
    if (input) input.disabled = false;
    buttons.forEach((b) => { b.disabled = false; });
  };
  const late = !early && findRepeat(url, row);
  if (late && !confirm(`This looks like ${late.why} you've logged before:\n\n${describeRow(late.a)}\n\nAdd it anyway?`)) {
    done();
    S.season = late.a.season ?? 2;
    render();
    return focusRow(late.a.id);
  }
  const insert = {
    season: currentSeason(), status: mode === "applied" ? "applied" : "saved",
    company: row.company || "", role: row.role ?? null, contract: row.contract ?? null, location: row.location ?? null,
    description: row.description ?? null, date_posted: row.date_posted ?? null, starts: row.starts ?? null, url,
    company_id: S.companies.find((c) => sameCompany(c.name, row.company))?.id ?? null,
  };
  const { data, error } = await sb.from("applications").insert(insert).select().single();
  done();
  if (error) return fail(error, "Couldn't add the row");
  S.apps.push(data);
  S.sort = { key: null, dir: 1 };
  S.season = null;
  S.appsQuery = "";
  if (!sheetRows().includes(data)) { clearFilters(); toast("Filters cleared so the new row shows."); }
  render();
  focusRow(data.id, note && !mobileQuery.matches ? "company" : null);
  if (note && mobileQuery.matches) openApp(data.id);
  const when = data.starts ? ` · starts ${data.starts}` : " · the ad gives no start date";
  toast(note ? `${note} The link is saved.`
    : (mode === "applied" ? `Logged as applied: ${data.company}` : `Saved for later: ${data.company}`) + when);
}
// Typed a company name instead of a link: a row to fill by hand.
async function addTypedRow(company, mode) {
  if (!company) return;
  const like = S.apps.find((a) => sameCompany(a.company, company));
  if (like && !confirm(`You already have a row for ${like.company}:\n\n${describeRow(like)}\n\nAdd another?`)) return;
  const { data, error } = await sb.from("applications").insert({
    company, season: currentSeason(), status: mode === "applied" ? "applied" : "saved",
    company_id: S.companies.find((c) => sameCompany(c.name, company))?.id ?? null,
  }).select().single();
  if (error) return fail(error, "Couldn't add a row");
  S.apps.push(data);
  S.sort = { key: null, dir: 1 };
  S.season = null;
  S.appsQuery = "";
  S.pendingLink = null;
  if (!sheetRows().includes(data)) clearFilters();
  if (mobileQuery.matches) { render(); return openApp(data.id); }
  render();
  focusRow(data.id, "role");
}
function focusRow(id, field) {
  const tr = document.querySelector(`[data-row="${id}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: "center" });
  tr.classList.add("flash");
  setTimeout(() => tr.classList.remove("flash"), 1600);
  if (field) tr.querySelector(`[data-field="${field}"]`)?.focus();
}

// ───────────────────────────── companies ─────────────────────────────
function companyHealth(c) {
  if (!c.active) return `<span class="health never">Paused</span>`;
  if (c.ats === "unknown") return `<span class="health manual" title="This site can't be read automatically. Open it from the company name.">Check by hand</span>`;
  const map = {
    ok: `${c.last_total} open ${c.last_total === 1 ? "posting" : "postings"}`,
    empty: "No postings found",
    error: "Check failed",
    unsupported: "Not supported yet",
    never: "Not checked yet",
    running: "Checking…",
  };
  return `<span class="health ${c.last_status}" title="${esc(c.last_error ?? "")}">${map[c.last_status] ?? c.last_status}</span>`;
}
const CATEGORIES = ["Oil & gas major", "Utility & grid", "Trading house", "Engineering & equipment", "Bank", "Infrastructure & pension fund",
  "Development bank", "Agency & regulator", "Market data & research", "Energy consulting", "Consulting"];
function companiesView() {
  const d = S.detect, cos = S.companies, auto = (c) => c.ats !== "unknown";
  const read = cos.filter((c) => c.active && auto(c)).length, manual = cos.filter((c) => c.active && !auto(c)).length;
  const off = cos.filter((c) => !c.active).length;
  const matches = cos.reduce((n, c) => n + (c.active ? c.matched_open ?? 0 : 0), 0);
  const sectors = [...new Set([...CATEGORIES, ...cos.map((c) => c.category ?? "")])].filter((x) => cos.some((c) => (c.category ?? "") === x));
  const q = fold(S.coQuery.trim());
  const show = { all: () => true, watched: (c) => c.active, paused: (c) => !c.active, manual: (c) => !auto(c) };
  const shown = cos.filter((c) => (!S.coSectors.length || S.coSectors.includes(c.category ?? "")) && show[S.coShow](c) && (!q || fold(c.name).includes(q)));
  const seg = [["all", "All", cos.length], ["watched", "Watched", cos.length - off], ["paused", "Not watched", off], ["manual", "Checked by hand", cos.filter((c) => !auto(c)).length]];
  const sectorOpts = (cur) => [...new Set([...CATEGORIES, ...sectors])].filter(Boolean)
    .map((x) => `<option value="${esc(x)}" ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("") + `<option value="" ${!cur ? "selected" : ""}>No sector</option>`;
  const groups = sectors.map((sec) => [sec, shown.filter((c) => (c.category ?? "") === sec).sort((x, y) => x.name.localeCompare(y.name, "fr", { sensitivity: "base" }))]).filter(([, l]) => l.length);
  const row = (c) => `<tr class="${c.active ? "" : "off"}">
      <td class="w-check"><input type="checkbox" data-watch="${c.id}" ${c.active ? "checked" : ""} aria-label="Watch ${esc(c.name)}"></td>
      <td class="co"><span class="co-cell">${logoHtml(c.name, "sm")}${c.careers_url ? `<a href="${safeUrl(c.careers_url)}" target="_blank" rel="noopener" title="Open the careers page">${esc(c.name)}</a>` : esc(c.name)}</span>
        <span class="co-sub">${esc(c.category || "No sector")}${c.big ? " · Big" : ""} · ${companyHealth(c)}</span></td>
      <td class="hide-m"><select class="co-sector" data-co-sector-of="${c.id}" aria-label="Sector of ${esc(c.name)}">${sectorOpts(c.category ?? "")}</select></td>
      <td class="flag hide-m"><input type="checkbox" data-co-flag="big" data-id="${c.id}" ${c.big ? "checked" : ""} aria-label="${esc(c.name)} is a big company"></td>
      <td class="flag hide-m"><input type="checkbox" data-co-flag="in_field" data-id="${c.id}" ${c.in_field ? "checked" : ""} aria-label="Every role at ${esc(c.name)} is in my field"></td>
      <td class="hide-m">${c.ats === "unknown" ? `<span class="health manual">Can't be read automatically</span>` : `<span class="src">${esc(ATS_LABEL[c.ats] ?? c.ats)}</span> ${companyHealth(c)}`}</td>
      <td class="num">${c.active && c.matched_open ? `<a href="#inbox" data-co-inbox="${c.id}" title="Show these postings in the inbox">${c.matched_open}</a>` : ""}</td>
      <td class="hide-m muted small">${c.ats !== "unknown" ? esc(relTime(c.last_run_at)) : ""}</td>
      <td class="row-actions-cell"><div class="row-actions">
        ${c.ats !== "unknown" && c.active ? `<button class="btn sm ghost" data-act="run-one" data-id="${c.id}">Check now</button>` : ""}
        <button class="btn sm ghost" data-act="edit-company" data-id="${c.id}">Edit</button>
      </div></td>
    </tr>`;
  return `
    <div class="page-head">
      <div class="grow"><h1>Companies</h1><p class="sub">The careers pages the scraper reads every morning at 06:30. Untick a company to stop watching it, and its postings leave your inbox. A sector's tick box watches or drops the whole sector.</p></div>
      <button class="btn" data-act="run-all">Check all now</button>
      <button class="btn ${S.coAdd || d ? "" : "primary"}" data-act="toggle-add">${S.coAdd || d ? "Close" : "Add a company"}</button>
    </div>
    <div class="co-stats">
      <div><b>${read}</b><span>read automatically every morning</span></div>
      <div><b>${manual}</b><span>watched, but their sites can't be read: open them by hand</span></div>
      <div><b>${off}</b><span>not watched</span></div>
      <div><b>${matches}</b><span>open postings match your keywords</span></div>
    </div>
    ${S.coAdd || d ? `<form class="panel panel-pad" id="add-company" style="margin-bottom:18px">
      <div class="add-company">
        <label class="field"><span>Company</span><input type="text" name="name" placeholder="e.g. Engie" required value="${esc(d?.name ?? "")}"></label>
        <label class="field"><span>Careers page or a job link</span><input type="url" name="url" placeholder="https://…" required value="${esc(d?.url ?? "")}"></label>
        <button class="btn primary" type="submit" ${d?.loading ? "disabled" : ""}>${d?.loading ? "Checking…" : "Check"}</button>
      </div>
      <p class="faint small" style="margin:8px 0 0">Paste the careers page, or any job link from the company: the app finds the job board behind it and shows what it can read before adding it.</p>
      ${d && !d.loading ? detectResult(d) : ""}
    </form>` : ""}
    <div class="toolbar">
      <input class="search" type="search" id="co-q" placeholder="Search companies" value="${esc(S.coQuery)}">
      <div class="seg" role="group" aria-label="Show">${seg.map(([k, l, n]) => `<button data-co-show="${k}" aria-pressed="${S.coShow === k}">${l} <span class="faint">${n}</span></button>`).join("")}</div>
    </div>
    <div class="ifilters" role="group" aria-label="Sectors">
      ${sectors.map((x) => `<button type="button" class="ichip${S.coSectors.includes(x) ? " on" : ""}" data-co-sector="${esc(x)}" aria-pressed="${S.coSectors.includes(x)}"><b>${esc(x || "No sector")}</b><i>${cos.filter((c) => (c.category ?? "") === x).length}</i></button>`).join("")}
      ${S.coSectors.length ? `<button type="button" class="linklike" data-act="co-all-sectors">All sectors</button>` : ""}
    </div>
    <div class="table-wrap"><table class="co-table">
      <thead><tr><th class="w-check"><span class="sr">Watch</span></th><th>Company</th><th class="hide-m">Sector</th>
        <th class="flag hide-m" title="Big company: postings in your relocation cities count too">Big</th>
        <th class="flag hide-m" title="Every role here is in my field: only the level keywords, hidden words and locations apply">All roles</th>
        <th class="hide-m">Source</th><th class="num" title="Open postings that match your keywords">Matches</th><th class="hide-m">Checked</th><th></th></tr></thead>
      ${groups.map(([sec, list]) => {
        const on = list.filter((c) => c.active).length;
        return `<tbody>
        <tr class="sec-head"><td class="w-check"><input type="checkbox" data-watch-sector="${esc(sec)}" data-ids="${list.map((c) => c.id).join(",")}" ${on === list.length ? "checked" : ""} data-some="${on > 0 && on < list.length}" aria-label="Watch every company in ${esc(sec || "No sector")}"></td>
          <th colspan="8">${esc(sec || "No sector")} <span>${on} of ${list.length} watched</span></th></tr>
        ${list.map(row).join("")}</tbody>`;
      }).join("")}
    </table>${shown.length ? "" : `<div class="empty">${cos.length ? "No company matches." : "No companies yet."}</div>`}</div>`;
}
function detectResult(d) {
  if (!d.ok) {
    return `<div class="detect-result"><b>${d.detection ? `Found ${esc(ATS_LABEL[d.detection.ats])}, but the check failed.` : "No supported job board found at that link."}</b>
      <p class="muted small" style="margin:6px 0 10px">${esc(d.error ?? "")} You can still add it; it'll be listed as not supported until an adapter exists.</p>
      <button class="btn sm" type="button" data-act="save-detected">Add anyway</button></div>`;
  }
  return `<div class="detect-result">
    <b>${esc(ATS_LABEL[d.detection.ats])}: ${d.total} open ${d.total === 1 ? "posting" : "postings"} found.</b>
    ${d.sample.length ? `<ul>${d.sample.slice(0, 5).map((p) => `<li>${esc(p.title)}${p.location ? ` <span class="faint">(${esc(p.location)})</span>` : ""}</li>`).join("")}</ul>` : ""}
    <div class="toolbar" style="margin:12px 0 0">
      <button class="btn sm primary" type="button" data-act="save-detected">Add ${esc(d.name)}</button>
      <span class="faint small">Large boards can be narrowed with a country or keyword after adding (Edit).</span>
    </div></div>`;
}
async function detect(name, url) {
  S.detect = { name, url, loading: true };
  render();
  const { data, error } = await sb.functions.invoke("scrape", { body: { detect: url } });
  S.detect = { name, url, loading: false, ...(error ? { ok: false, error: error.message } : data) };
  render();
}
async function saveDetected() {
  const d = S.detect;
  const row = { name: d.name, careers_url: d.url, ats: d.detection?.ats ?? "unknown", config: d.detection?.config ?? {} };
  const { data, error } = await sb.from("companies").insert(row).select().single();
  if (error) return fail(error, "Couldn't add the company");
  S.companies.push(data);
  S.companies.sort((a, b) => a.name.localeCompare(b.name));
  S.detect = null;
  S.coAdd = false;
  toast(`Added ${data.name}`);
  render();
  if (data.ats !== "unknown") runOne(data.id);
}
// Watching: the morning check reads only watched companies, and the inbox only shows their postings.
async function setWatched(ids, active) {
  await updateCompanies(ids, { active }, ids.length > 1 ? `${active ? "Watching" : "Stopped watching"} ${ids.length} companies` : null);
  await refreshCount();
  render();
}
async function updateCompanies(ids, patch, note, rematched = false) {
  const { error } = await sb.from("companies").update(patch).in("id", ids);
  if (error) { fail(error, "Couldn't save"); return render(); }
  S.companies.forEach((c) => { if (ids.includes(c.id)) Object.assign(c, patch); });
  // Big and "every role in my field" re-match the company's postings in the database; fetch the new counts.
  if (rematched) { await Promise.all([loadMatchCounts(), refreshCount()]); }
  if (note) toast(note);
  render();
}
async function runOne(id) {
  const c = S.companies.find((x) => x.id === id);
  if (c) c.last_status = "running";
  render();
  const { data, error } = await sb.functions.invoke("scrape", { body: { company_id: id } });
  if (error) toast(`Check failed: ${error.message}`);
  else if (data?.ok) toast(`${data.company}: ${data.total} open, ${data.new} new`);
  else toast(`${data?.company ?? "Check"} failed: ${data?.error}`);
  await Promise.all([loadCore(), loadMatchCounts()]);
  render();
}
async function runAll() {
  const { data, error } = await sb.rpc("scrape_all");
  if (error) return fail(error, "Couldn't start the check");
  toast(`Checking ${data} companies…`);
  S.companies.forEach((c) => { if (c.active && c.ats !== "unknown") c.last_status = "running"; });
  render();
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks++;
    await Promise.all([loadCore(), loadMatchCounts()]);
    if (S.view === "inbox") await loadInbox();
    const running = S.companies.some((c) => c.last_status === "running");
    if (!S.drawer) render();
    if (!running || ticks > 30) { clearInterval(timer); toast("Check finished"); }
  }, 4000);
}
async function loadMatchCounts() {
  const { data } = await sb.from("postings").select("company_id").eq("matched", true).eq("is_open", true).limit(5000);
  const counts = {};
  for (const r of data ?? []) counts[r.company_id] = (counts[r.company_id] ?? 0) + 1;
  S.companies.forEach((c) => { c.matched_open = counts[c.id] ?? 0; });
}

// ───────────────────────────── settings ─────────────────────────────
function chipEditor(name, values, placeholder) {
  return `<div class="chips" data-chips="${name}">
    ${values.map((v, i) => `<span class="chip">${esc(v)}<button type="button" aria-label="Remove ${esc(v)}" data-chip-remove="${name}" data-i="${i}">×</button></span>`).join("")}
    <input type="text" placeholder="${esc(placeholder)}" data-chip-input="${name}" aria-label="${esc(placeholder)}">
  </div>`;
}
function settingsView() {
  const s = S.settings;
  return `
    <div class="page-head"><div class="grow"><h1>Settings</h1>
      <p class="sub">A posting reaches your inbox when its title names your field and your level, avoids the hidden words, and is in one of your locations (or a relocation city, for big companies). Matching ignores case and accents. A keyword matches the start of a word (“analyst” also matches “analystes”); put it in double quotes to match the whole word only: <code>"market"</code> skips “marketing”.</p></div></div>
    <form id="settings-form" class="settings-grid">
      <section><h2>Field: titles mentioning any of</h2>${chipEditor("include_keywords", s.include_keywords, "Add a keyword and press Enter")}
        <p class="faint small" style="margin:0">Skipped for companies marked “every role here is in my field”. Leave empty to accept any field.</p></section>
      <section><h2>Level: and any of</h2>${chipEditor("role_keywords", s.role_keywords ?? [], "Add a keyword and press Enter")}
        <p class="faint small" style="margin:0">Leave empty to accept any level.</p></section>
      <section><h2>Hide titles containing</h2>${chipEditor("exclude_keywords", s.exclude_keywords, "Add a keyword and press Enter")}</section>
      <section><h2>Locations: any company</h2>${chipEditor("locations", s.locations, "Add a city, region or country")}
        <p class="faint small" style="margin:0">Postings without a location are always kept.</p></section>
      <section><h2>Relocation cities: big companies only</h2>${chipEditor("relocation_locations", s.relocation_locations ?? [], "Add a city or country")}
        <p class="faint small" style="margin:0">Places you'd move to for a big company. Mark companies as big on the Companies page.</p></section>
      <section><h2>When you can start</h2>
        <div class="window-fields">
          <label class="field"><span>Earliest start</span><input type="month" name="available_from" value="${esc((s.available_from ?? "").slice(0, 7))}"></label>
          <label class="field"><span>Latest start</span><input type="month" name="available_until" value="${esc((s.available_until ?? "").slice(0, 7))}"></label>
        </div>
        <p class="faint small" style="margin:0">Rows you're still working on whose start date falls outside these months are flagged in the log. Leave empty to flag nothing.</p></section>
      <section style="max-width:340px"><label class="field"><span>Flag applications with no reply after (days)</span>
        <input type="number" name="follow_up_days" min="1" max="120" value="${s.follow_up_days}"></label></section>
      <div class="toolbar"><button class="btn primary" type="submit">Save filters</button><span class="faint small">Saving re-checks every stored posting against the new filters.</span></div>
    </form>
    <div class="panel panel-pad" style="max-width:820px;margin-top:30px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="flex:1"><b>Signed in</b><div class="muted small">${esc(S.user.email)}</div></div>
      <button class="btn" data-act="export">Download applications (CSV)</button>
      <button class="btn ghost" data-act="sign-out">Sign out</button>
    </div>`;
}
async function saveSettings(form) {
  const patch = {
    include_keywords: S.settings.include_keywords, role_keywords: S.settings.role_keywords ?? [],
    exclude_keywords: S.settings.exclude_keywords, locations: S.settings.locations, relocation_locations: S.settings.relocation_locations ?? [],
    follow_up_days: Number(form.follow_up_days.value) || 14, updated_at: new Date().toISOString(),
    available_from: form.available_from.value ? `${form.available_from.value}-01` : null,
    available_until: form.available_until.value ? `${form.available_until.value}-01` : null,
  };
  const { error } = await sb.from("settings").update(patch).eq("id", 1);
  if (error) return fail(error, "Couldn't save");
  Object.assign(S.settings, patch);
  const { data: n, error: e2 } = await sb.rpc("rematch_postings", { p_company_id: null });
  if (e2) return fail(e2, "Saved, but re-checking failed");
  await refreshCount();
  toast(`Filters saved. ${n} postings re-checked, ${S.newCount} in your inbox.`);
  render();
}
function exportCsv() {
  const cols = [["season", "Season"], ["company", "Company"], ["role", "Position"], ["contract", "Position Length"], ["starts", "Start Date"], ["location", "Location"],
    ["description", "Description"], ["date_posted", "Date Posted"], ["url", "Link"], ["status", "Status"], ["applied", "Applied"],
    ["applied_on", "Application Date"], ["responded", "Response Received"], ["response_on", "Response Date"],
    ["wait", "Response Time (days)"], ["positive", "Positive Response"], ["contact", "Contacts"], ["next_step", "Next step"], ["notes", "Notes"]];
  const cell = (v) => `"${String(typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v ?? "").replace(/"/g, '""')}"`;
  const val = (a, k) => (k === "wait" ? responseDays(a) : k === "status" ? statusOf(a).label : a[k]);
  const csv = [cols.map(([, l]) => l).join(","), ...S.apps.map((a) => cols.map(([k]) => cell(val(a, k))).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `applications-${today()}.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

// ───────────────────────────── letters ─────────────────────────────
// A private locker for cover letters: upload Word, PDF or any file, open or download it from any device.
// Files live in the private "letters" storage bucket; each row here names one and gives it a type.
const LETTER_TYPES = ["Energy consulting", "Energy major", "Project finance / banks", "Trading / markets", "Project development", "Other"];
const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileExt = (name = "") => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toUpperCase();
function letterRow(l) {
  return `<div class="letter" data-letter="${l.id}">
    <span class="ext">${esc(fileExt(l.file_name) || "FILE")}</span>
    <div class="letter-main">
      <input type="text" value="${esc(l.name)}" data-letter-field="name" aria-label="Name">
      <div class="letter-meta">
        <input type="text" value="${esc(l.category ?? "")}" data-letter-field="category" list="letter-types" placeholder="Type of role" aria-label="Type of role">
        <span class="faint small">${esc(l.file_name)} · ${fmtSize(l.file_size)} · ${esc(fmtDate(l.updated_at))}</span>
      </div>
    </div>
    <div class="letter-acts">
      <button class="btn sm primary" data-act="open-letter" data-id="${l.id}">Open</button>
      <button class="btn sm" data-act="download-letter" data-id="${l.id}">Download</button>
      <button class="btn sm ghost" data-act="replace-letter" data-id="${l.id}">Replace</button>
      <button class="btn sm ghost danger" data-act="delete-letter" data-id="${l.id}">Delete</button>
    </div>
  </div>`;
}
function lettersView() {
  return `
    <div class="page-head"><div class="grow"><h1>Letters</h1>
      <p class="sub">Your cover letters, kept privately and reachable from any device. Upload Word, PDF or text files; rename them and tag the type of role they're for.</p></div>
      <button class="btn primary" data-act="upload-letter">Upload letters</button></div>
    <input type="file" id="letter-file" multiple hidden accept=".docx,.doc,.pdf,.odt,.rtf,.txt,.md,.pages">
    <datalist id="letter-types">${LETTER_TYPES.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    ${S.letters.length ? `<div class="panel letters">${S.letters.map(letterRow).join("")}</div>`
      : `<div class="panel panel-pad muted">No letters yet. Upload your final versions and they'll be here on your phone and laptop.</div>`}`;
}
function bindLetters() {
  $("#letter-file")?.addEventListener("change", async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    const replacing = S.letterReplace;
    S.letterReplace = null;
    if (!files.length) return;
    if (replacing) return replaceLetter(replacing, files[0]);
    for (const f of files) await uploadLetter(f);
    render();
  });
  document.querySelectorAll("[data-letter-field]").forEach((inp) => inp.addEventListener("change", async () => {
    const id = Number(inp.closest("[data-letter]").dataset.letter);
    const key = inp.dataset.letterField;
    const v = inp.value.trim();
    if (key === "name" && !v) return toast("A letter needs a name.");
    const { data, error } = await sb.from("letters").update({ [key]: v || null, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) return fail(error, "Couldn't save");
    S.letters = S.letters.map((l) => (l.id === id ? data : l));
    toast("Saved");
  }));
}
const storagePath = (f) => `${crypto.randomUUID()}/${f.name.replace(/[^\w.\-]+/g, "_")}`;
async function putFile(f) {
  if (f.size > 20 * 1048576) { toast(`${f.name} is over 20 MB.`); return null; }
  const path = storagePath(f);
  const { error } = await sb.storage.from("letters").upload(path, f, { contentType: f.type || undefined });
  if (error) { fail(error, `Couldn't upload ${f.name}`); return null; }
  return { file_path: path, file_name: f.name, file_size: f.size, mime: f.type || null };
}
async function uploadLetter(f) {
  toast(`Uploading ${f.name}…`);
  const file = await putFile(f);
  if (!file) return;
  const name = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || f.name;
  const { data, error } = await sb.from("letters").insert({ name, ...file }).select().single();
  if (error) { await sb.storage.from("letters").remove([file.file_path]); return fail(error, "Couldn't save the letter"); }
  S.letters.push(data);
  toast(`${f.name} uploaded`);
}
async function replaceLetter(id, f) {
  const old = S.letters.find((l) => l.id === id);
  if (!confirm(`Replace the file of "${old.name}" with ${f.name}?`)) return;
  toast(`Uploading ${f.name}…`);
  const file = await putFile(f);
  if (!file) return;
  const { data, error } = await sb.from("letters").update({ ...file, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) { await sb.storage.from("letters").remove([file.file_path]); return fail(error, "Couldn't replace the file"); }
  await sb.storage.from("letters").remove([old.file_path]);
  S.letters = S.letters.map((l) => (l.id === id ? data : l));
  toast("File replaced");
  render();
}
async function openLetter(id, download) {
  const l = S.letters.find((x) => x.id === id);
  // Open the tab straight away (phones block tabs opened after a wait), then point it at a short-lived private link.
  const w = download ? null : window.open("", "_blank");
  const { data, error } = await sb.storage.from("letters").createSignedUrl(l.file_path, 600, download ? { download: l.file_name } : undefined);
  if (error) { w?.close(); return fail(error, "Couldn't open the file"); }
  if (w) w.location.href = data.signedUrl;
  else location.href = data.signedUrl;
}
async function deleteLetter(id) {
  const l = S.letters.find((x) => x.id === id);
  if (!confirm(`Delete "${l.name}"? The file is removed for good.`)) return;
  const { error } = await sb.from("letters").delete().eq("id", id);
  if (error) return fail(error, "Couldn't delete");
  await sb.storage.from("letters").remove([l.file_path]);
  S.letters = S.letters.filter((x) => x.id !== id);
  render();
}

// ───────────────────────────── drawer ─────────────────────────────
let drawerEvents = [];
function drawerHtml() {
  const d = S.drawer;
  if (d.type === "company") return companyDrawer(S.companies.find((c) => c.id === d.id));
  const a = S.apps.find((x) => x.id === d.id);
  const f = (name, label, type = "text", cls = "") =>
    `<label class="field ${cls}"><span>${label}</span><input type="${type}" name="${name}" value="${esc(a[name] ?? "")}"></label>`;
  return `<div class="scrim" data-act="close"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Application">
    <div class="drawer-head"><h2>${esc(a.company || "New row")}</h2>
      ${a.url ? `<a class="btn sm" href="${safeUrl(a.url)}" target="_blank" rel="noopener">Open posting</a>` : ""}
      <button class="btn sm ghost" data-act="close" aria-label="Close">Close</button></div>
    <form class="drawer-body" id="app-form">
      <div class="fields">
        ${f("company", "Company")}
        <label class="field"><span>Company website <span class="faint">(for the logo)</span></span><input type="text" name="brand_domain" placeholder="e.g. engie.com" value="${esc(brandFor(a.company)?.domain ?? "")}"></label>
        ${f("role", "Position", "text", "wide")}
        <label class="field"><span>Start date</span><input type="text" name="starts" placeholder="e.g. Feb 2027, Jan–Mar 2027, ASAP" value="${esc(a.starts ?? "")}"></label>
        ${f("date_posted", "Date Posted", "date")}
        <label class="field wide"><span>Status</span><select name="status">${STATUSES.filter((x) => !x.legacy || x.id === a.status).map((x) => `<option value="${x.id}" ${x.id === a.status ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
        ${f("applied_on", "Application Date", "date")}
        ${f("response_on", "Response Date", "date")}
        <label class="field"><span>Position Length</span><input type="text" name="contract" list="contracts" value="${esc(a.contract ?? "")}"></label>
        ${f("location", "Location")}
        ${f("url", "Link", "url")}
        <label class="field wide"><span>Description</span><textarea name="description" rows="4">${esc(a.description ?? "")}</textarea></label>
        ${f("contact", "Contacts", "text", "wide")}
        ${f("next_step", "Next step", "text", "wide")}
        ${f("documents", "CV and cover letter sent", "text", "wide")}
        <label class="field wide"><span>Notes</span><textarea name="notes" rows="4">${esc(a.notes ?? "")}</textarea></label>
      </div>
      ${d.id ? `<section><h2 style="margin-bottom:10px">History</h2>
        <ul class="timeline" id="timeline">${timelineHtml()}</ul>
        <div class="toolbar" style="margin:12px 0 0"><input type="text" id="note-input" placeholder="Add a note to the history" style="flex:1"><button class="btn sm" type="button" data-act="add-note">Add</button></div>
      </section>` : ""}
    </form>
    <div class="drawer-foot">
      <button class="btn ghost danger" data-act="delete-app">Delete row</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn primary" data-act="save-app">Save changes</button>
    </div>
  </aside>`;
}
function timelineHtml() {
  if (!drawerEvents.length) return `<li><time></time><span class="faint">Loading…</span></li>`;
  return drawerEvents.map((e) => {
    const what = e.kind === "created" ? "Added to the log"
      : e.kind === "status" ? `${STATUS[e.from_status]?.label ?? e.from_status} → ${STATUS[e.to_status]?.label ?? e.to_status}`
      : esc(e.note);
    return `<li><time>${esc(fmtDate(e.at))}</time><span>${e.kind === "note" ? what : `<span class="pill" style="--c: var(--s-${e.to_status})">${what}</span>`}</span></li>`;
  }).join("");
}
async function openApp(id) {
  drawerEvents = [];
  S.drawer = { type: "app", id };
  render();
  if (!id) return;
  const { data } = await sb.from("application_events").select("*").eq("application_id", id).order("at", { ascending: false });
  drawerEvents = data ?? [];
  const t = $("#timeline");
  if (t) t.innerHTML = timelineHtml() || `<li class="faint">No history yet.</li>`;
}
async function saveApp() {
  const form = $("#app-form");
  const fd = new FormData(form);
  const row = {};
  for (const k of ["company", "role", "status", "contract", "starts", "location", "description", "url", "date_posted", "applied_on", "response_on", "next_step", "contact", "documents", "notes"]) {
    const v = (fd.get(k) ?? "").toString().trim();
    row[k] = v === "" ? null : v;
  }
  if (!row.company) return toast("Add the company name first.");
  if (row.starts) row.starts = tidyStart(row.starts);
  const id = S.drawer.id;
  const site = (fd.get("brand_domain") ?? "").toString().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  if (site && site !== (brandFor(row.company)?.domain ?? "")) {
    sb.functions.invoke("brand", { body: { force: { name: row.company, domain: site } } }).then(({ data }) => {
      for (const b of data?.brands ?? []) S.brands[b.key] = b;
      document.querySelectorAll(`.logo[data-logo="${companyKey(row.company)}"]`).forEach((el) => { el.innerHTML = `<b>${el.dataset.ini}</b>`; });
      updateLogos();
    });
  }
  const { data, error } = await sb.from("applications").update(row).eq("id", id).select().single();
  if (error) return fail(error, "Couldn't save");
  S.apps = S.apps.map((a) => (a.id === id ? data : a));
  S.drawer = null;
  toast("Saved");
  render();
}
async function addNote() {
  const input = $("#note-input");
  const note = input.value.trim();
  if (!note) return;
  const { data, error } = await sb.from("application_events").insert({ application_id: S.drawer.id, kind: "note", note }).select().single();
  if (error) return fail(error, "Couldn't add the note");
  drawerEvents.unshift(data);
  input.value = "";
  $("#timeline").innerHTML = timelineHtml();
}
async function deleteApp() {
  const a = S.apps.find((x) => x.id === S.drawer.id);
  if (!confirm(`Delete the ${a.company || "empty"} row and its history? This can't be undone.`)) return;
  const { error } = await sb.from("applications").delete().eq("id", a.id);
  if (error) return fail(error, "Couldn't delete");
  S.apps = S.apps.filter((x) => x.id !== a.id);
  S.drawer = null;
  toast("Deleted");
  render();
}
function companyDrawer(c) {
  return `<div class="scrim" data-act="close"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Company">
    <div class="drawer-head"><h2>${esc(c.name)}</h2><button class="btn sm ghost" data-act="close">Close</button></div>
    <form class="drawer-body" id="company-form">
      <div class="fields">
        <label class="field wide"><span>Name</span><input type="text" name="name" value="${esc(c.name)}"></label>
        <label class="field wide"><span>Careers page</span><input type="url" name="careers_url" value="${esc(c.careers_url ?? "")}"></label>
        <label class="field"><span>Only postings in country</span><input type="text" name="country" placeholder="e.g. France" value="${esc(c.country ?? "")}"></label>
        <label class="field"><span>Only postings matching</span><input type="text" name="search" placeholder="e.g. energy" value="${esc(c.search ?? "")}"></label>
        <label class="field"><span>Source</span><select name="ats">${Object.entries(ATS_LABEL).map(([k, l]) => `<option value="${k}" ${c.ats === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span>Category</span><input type="text" name="category" list="categories" value="${esc(c.category ?? "")}"></label>
        <datalist id="categories">${CATEGORIES.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
        <label class="check wide"><input type="checkbox" name="big" ${c.big ? "checked" : ""}>
          <span>Big company <span class="faint">— worth relocating for: postings in your relocation cities count too</span></span></label>
        <label class="check wide"><input type="checkbox" name="in_field" ${c.in_field ? "checked" : ""}>
          <span>Every role here is in my field <span class="faint">— skip the field keywords, keep the level, hidden words and locations</span></span></label>
        <label class="field wide"><span>Source settings (JSON)</span><textarea name="config" rows="4" spellcheck="false">${esc(JSON.stringify(c.config, null, 2))}</textarea></label>
        <label class="field wide"><span>Notes</span><textarea name="notes" rows="3">${esc(c.notes ?? "")}</textarea></label>
      </div>
      ${c.last_error ? `<div class="note err">Last check failed: ${esc(c.last_error)}</div>` : ""}
      <p class="faint small" style="margin:0">Country and keyword narrowing are applied by the job board itself, which keeps very large boards (thousands of postings) fast.</p>
    </form>
    <div class="drawer-foot">
      <button class="btn ghost danger" data-act="delete-company">Delete</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn primary" data-act="save-company">Save changes</button>
    </div>
  </aside>`;
}
async function saveCompany() {
  const fd = new FormData($("#company-form"));
  let config;
  try { config = JSON.parse(fd.get("config") || "{}"); } catch { return toast("Source settings must be valid JSON."); }
  const v = (k) => ((fd.get(k) ?? "").toString().trim() || null);
  const row = { name: v("name"), careers_url: v("careers_url"), country: v("country"), search: v("search"), ats: v("ats"), notes: v("notes"), config, in_field: fd.get("in_field") === "on", big: fd.get("big") === "on", category: v("category") };
  const { data, error } = await sb.from("companies").update(row).eq("id", S.drawer.id).select().single();
  if (error) return fail(error, "Couldn't save");
  S.companies = S.companies.map((c) => (c.id === data.id ? { ...c, ...data } : c));
  S.drawer = null;
  toast("Saved. Check it again to apply the change.");
  render();
}
async function deleteCompany() {
  const c = S.companies.find((x) => x.id === S.drawer.id);
  if (!confirm(`Stop watching ${c.name} and delete its stored postings? Your applications stay.`)) return;
  const { error } = await sb.from("companies").delete().eq("id", c.id);
  if (error) return fail(error, "Couldn't delete");
  S.companies = S.companies.filter((x) => x.id !== c.id);
  S.drawer = null;
  render();
}

// ───────────────────────────── events ─────────────────────────────
function bindView() {
  const main = $("#main");
  const qInbox = $("#inbox-q");
  if (qInbox) {
    let t;
    qInbox.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => { S.inboxQuery = qInbox.value.trim(); await loadInbox(); render(); $("#inbox-q").focus(); }, 250); });
  }
  const coQ = $("#co-q");
  if (coQ) coQ.addEventListener("input", () => {
    S.coQuery = coQ.value;
    const at = coQ.selectionStart;
    render();
    const again = $("#co-q");
    again.focus();
    again.setSelectionRange(at, at);
  });
  // A sector heading's box is half-ticked when only some of its companies are watched.
  document.querySelectorAll("[data-watch-sector]").forEach((b) => { b.indeterminate = b.dataset.some === "true"; });
  const qApps = $("#apps-q");
  if (qApps) qApps.addEventListener("input", () => {
    S.appsQuery = qApps.value;
    $("#rows").innerHTML = sheetRows().map(itemHtml).join("");
    const fb = $("#fbar");
    if (fb) fb.outerHTML = filterBar();
  });
  if (S.pendingLink) $("#link-input")?.focus();
  const linkForm = $("#link-form");
  if (linkForm) {
    // Enter saves for later; the second button logs it as already applied.
    linkForm.addEventListener("submit", (e) => { e.preventDefault(); addFromLink($("#link-input").value, e.submitter?.value === "applied" ? "applied" : "later"); });
  }
  $("#add-company")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    detect(f.name.value.trim(), f.url.value.trim());
  });
  $("#settings-form")?.addEventListener("submit", (e) => { e.preventDefault(); saveSettings(e.target); });
  bindLetters();

  // chip editors
  document.querySelectorAll("[data-chip-input]").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      const key = input.dataset.chipInput;
      if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
        e.preventDefault();
        const vals = input.value.split(",").map((v) => v.trim()).filter(Boolean);
        S.settings[key] = [...new Set([...S.settings[key], ...vals])];
        render();
        $(`[data-chip-input="${key}"]`).focus();
      } else if (e.key === "Backspace" && !input.value && S.settings[key].length) {
        S.settings[key] = S.settings[key].slice(0, -1);
        render();
        $(`[data-chip-input="${key}"]`).focus();
      }
    });
  });

  void main;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.watch) return setWatched([Number(t.dataset.watch)], t.checked);
  if (t.dataset.watchSector !== undefined) return setWatched(t.dataset.ids.split(",").map(Number), t.checked);
  if (t.dataset.coSectorOf) return updateCompanies([Number(t.dataset.coSectorOf)], { category: t.value || null }, `Moved to ${t.value || "No sector"}`);
  if (t.dataset.coFlag) return updateCompanies([Number(t.dataset.id)], { [t.dataset.coFlag]: t.checked }, null, true);
  const sel = e.target.closest("select[data-status-of]");
  if (sel) {
    sel.className = `status-pill tone-${STATUS[sel.value]?.tone}`;
    savePatch(Number(sel.dataset.statusOf), { status: sel.value });
  }
  if (e.target.id === "season-select") {
    if (e.target.value === "new") return startSeason();
    const n = Number(e.target.value);
    S.season = n === currentSeason() ? null : n;
    S.appsQuery = "";
    render();
  }
});

// Table editing: cells commit on blur or Enter; Escape puts the old value back.
document.addEventListener("focusin", (e) => {
  const ed = e.target.closest?.(".ed[contenteditable]");
  if (ed) ed.dataset.before = ed.textContent;
});
document.addEventListener("focusout", (e) => {
  const ed = e.target.closest?.(".ed[contenteditable]");
  if (ed && ed.textContent !== ed.dataset.before) commitCell(ed);
});
document.addEventListener("keydown", (e) => {
  const ed = e.target.closest?.(".ed[contenteditable]");
  if (!ed) return;
  if (e.key === "Enter" && !(e.shiftKey && ed.dataset.field === "description")) { e.preventDefault(); ed.blur(); }
  if (e.key === "Escape") { ed.textContent = ed.dataset.before ?? ""; ed.blur(); }
}, true);
document.addEventListener("paste", (e) => {
  // Keep pasted text plain in browsers without plaintext-only editing.
  const td = e.target.closest?.(".ed[contenteditable]");
  if (!td) return;
  e.preventDefault();
  document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});

document.addEventListener("click", async (e) => {
  const dateBtnEl = e.target.closest("button[data-date]");
  if (dateBtnEl) return editDate(dateBtnEl);
  if (e.target.closest("[data-edit-link]")) return editLink(e.target.closest("td"));
  if (e.target.closest("#fmenu-root, #imenu-root")) return;
  if (S.fmenu && !e.target.closest("[data-fmenu]")) return closeFmenu(); // a click outside just closes the menu, like Excel
  if (S.imenu && !e.target.closest("[data-imenu]")) return closeImenu();
  const imenuBtn = e.target.closest("[data-imenu]");
  if (imenuBtn) return S.imenu?.key === imenuBtn.dataset.imenu ? closeImenu() : openImenu(imenuBtn.dataset.imenu, imenuBtn);
  const coEl = e.target.closest("[data-co-sector], [data-co-show], [data-co-inbox]");
  if (coEl) {
    if (coEl.dataset.coShow) { S.coShow = coEl.dataset.coShow; return render(); }
    if (coEl.dataset.coSector !== undefined) {
      const x = coEl.dataset.coSector;
      S.coSectors = S.coSectors.includes(x) ? S.coSectors.filter((y) => y !== x) : [...S.coSectors, x];
      return render();
    }
    // A company's match count opens the inbox filtered to that company.
    e.preventDefault();
    S.inboxF = { companies: [coEl.dataset.coInbox] };
    localSet("inboxF", JSON.stringify(S.inboxF));
    S.inboxTab = "new";
    location.hash = "#inbox";
    return;
  }
  const el = e.target.closest("[data-act], [data-inbox-tab], [data-open], [data-filter], [data-fmenu], [data-fclear], [data-sort], [data-chip-remove], .post[data-i]");
  if (!el) return;
  if (el.dataset.fmenu) {
    const k = el.dataset.fmenu;
    return S.fmenu?.key === k ? closeFmenu() : openFmenu(k, el.closest("th") ?? el);
  }
  if (el.dataset.fclear) { setFilter(el.dataset.fclear, null); return render(); }
  if (el.dataset.filter !== undefined) {
    const label = el.dataset.filter ? STATUS[el.dataset.filter].label : null;
    setFilter("status", label && !onlyStatus(label) ? { in: [label] } : null);
    return render();
  }
  if (el.dataset.chipRemove) {
    const k = el.dataset.chipRemove;
    S.settings[k] = S.settings[k].filter((_, i) => i !== Number(el.dataset.i));
    return render();
  }
  if (el.dataset.inboxTab) { S.inboxTab = el.dataset.inboxTab; S.cursor = 0; await loadInbox(); return render(); }
  if (el.dataset.open) return openApp(Number(el.dataset.open));
  if (el.dataset.sort) {
    // Click a header: A→Z, then Z→A, then back to the log's own order.
    const k = el.dataset.sort;
    S.sort = S.sort.key !== k ? { key: k, dir: 1 } : S.sort.dir > 0 ? { key: k, dir: -1 } : { key: null, dir: 1 };
    const scroll = $("#log-scroll")?.scrollLeft ?? 0;
    render();
    if ($("#log-scroll")) $("#log-scroll").scrollLeft = scroll;
    return;
  }
  if (el.matches(".post[data-i]") && !el.dataset.act) {
    if (e.target.closest("a, button")) return;
    S.cursor = Number(el.dataset.i);
    document.querySelectorAll(".post").forEach((p) => p.classList.toggle("active", Number(p.dataset.i) === S.cursor));
    return;
  }
  const id = Number(el.dataset.id);
  switch (el.dataset.act) {
    case "track": return trackPosting(id);
    case "dismiss": return setPostingState(id, "dismissed");
    case "restore": return setPostingState(id, "new");
    case "dismiss-visible": {
      const ids = S.inbox.map((p) => p.id);
      if (!confirm(`Dismiss all ${ids.length} postings shown?`)) return;
      const { error } = await sb.from("postings").update({ state: "dismissed" }).in("id", ids);
      if (error) return fail(error, "Couldn't dismiss");
      await loadInbox(); await refreshCount(); return render();
    }
    case "run-all": return runAll();
    case "run-one": return runOne(id);
    case "toggle-company": {
      const c = S.companies.find((x) => x.id === id);
      const { error } = await sb.from("companies").update({ active: !c.active }).eq("id", id);
      if (error) return fail(error, "Couldn't update");
      c.active = !c.active;
      return render();
    }
    case "edit-company": S.drawer = { type: "company", id }; return render();
    case "save-company": return saveCompany();
    case "delete-company": return deleteCompany();
    case "save-detected": return saveDetected();
    case "clear-sort": S.sort = { key: null, dir: 1 }; return render();
    case "clear-filters": clearFilters(); S.appsQuery = ""; return render();
    case "toggle-add": S.coAdd = !(S.coAdd || S.detect); S.detect = null; return render();
    case "co-all-sectors": S.coSectors = []; return render();
    case "clear-inbox-filters": S.inboxF = {}; localSet("inboxF", "{}"); await loadInbox(); return render();
    case "paste": return pasteLink();
    case "save-app": return saveApp();
    case "upload-letter": return $("#letter-file").click();
    case "replace-letter": S.letterReplace = id; return $("#letter-file").click();
    case "open-letter": return openLetter(id, false);
    case "download-letter": return openLetter(id, true);
    case "delete-letter": return deleteLetter(id);
    case "delete-app": return deleteApp();
    case "add-note": return addNote();
    case "close": S.drawer = null; return render();
    case "export": return exportCsv();
    case "sign-out": await sb.auth.signOut(); return;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.fmenu) return closeFmenu();
  if (e.key === "Escape" && S.imenu) return closeImenu();
  if (e.key === "Escape" && S.drawer) { S.drawer = null; return render(); }
  if (S.view !== "inbox" || S.drawer || e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const p = S.inbox[S.cursor];
  const move = (d) => {
    S.cursor = Math.max(0, Math.min(S.inbox.length - 1, S.cursor + d));
    document.querySelectorAll(".post").forEach((el) => el.classList.toggle("active", Number(el.dataset.i) === S.cursor));
    document.querySelector(".post.active")?.scrollIntoView({ block: "nearest" });
  };
  if (e.key === "j") move(1);
  else if (e.key === "k") move(-1);
  else if (e.key === "t" && p && p.state !== "tracked") trackPosting(p.id);
  else if (e.key === "d" && p && p.state === "new") setPostingState(p.id, "dismissed");
  else if (e.key === "o" && p?.url) window.open(p.url, "_blank", "noopener");
});

async function route() {
  const v = location.hash.replace("#", "") || "applications";
  S.view = ["inbox", "applications", "companies", "letters", "settings"].includes(v) ? v : "applications";
  S.drawer = null;
  if (!S.user) return render();
  try {
    if (S.view === "inbox") await loadInbox();
    if (S.view === "companies") await loadMatchCounts();
  } catch (err) { fail(err, "Couldn't load"); }
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// Switching between phone and computer layouts (rotating a tablet, resizing a window).
mobileQuery.addEventListener("change", () => { if (S.user && S.view === "applications" && !S.drawer) render(); });

// A link shared to the installed app (Android share sheet) or opened as ?add=<link>: keep it ready in the add box.
(function takeSharedLink() {
  const q = new URLSearchParams(location.search);
  const shared = firstUrl([q.get("url"), q.get("text"), q.get("add"), q.get("title")].filter(Boolean).join(" "));
  try {
    if (shared) sessionStorage.setItem("jt:shared", shared);
    S.pendingLink = sessionStorage.getItem("jt:shared");
    sessionStorage.removeItem("jt:shared");
  } catch { S.pendingLink = shared; }
  if (shared) history.replaceState(null, "", location.pathname + "#applications");
})();

// ───────────────────────────── boot ─────────────────────────────
async function start(session) {
  S.user = session?.user ?? null;
  if (!S.user) return render();
  const { data: owner } = await sb.rpc("is_owner");
  if (!owner) {
    $("#app").innerHTML = authView("This account doesn't have access to this tracker.", true);
    bindAuth();
    await sb.auth.signOut();
    return;
  }
  try { await loadCore(); } catch (err) { return fail(err, "Couldn't load your data"); }
  route();
  if (S.pendingLink) toast("Link ready: choose Save for later or Already applied.");
}
let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  if (event === "INITIAL_SESSION" || (event === "SIGNED_IN" && !S.user) || event === "SIGNED_OUT") {
    booted = true;
    setTimeout(() => start(session), 0);
  }
});
setTimeout(async () => { if (!booted) { const { data } = await sb.auth.getSession(); start(data.session); } }, 1500);
