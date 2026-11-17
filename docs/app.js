import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────────── vocabulary ─────────────────────────────
const STATUSES = [
  { id: "saved", label: "To apply", open: true },
  { id: "applied", label: "Applied", open: true },
  { id: "interview", label: "Interviewing", open: true },
  { id: "offer", label: "Offer", open: true },
  { id: "accepted", label: "Accepted", open: false },
  { id: "rejected", label: "Rejected", open: false },
  { id: "no_response", label: "No response", open: false },
  { id: "withdrawn", label: "Withdrawn", open: false },
  { id: "skipped", label: "Not pursued", open: false },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
const LIGHT_STATUSES = new Set(["saved", "interview", "no_response", "withdrawn", "skipped"]);
const CONTRACTS = ["Stage", "CDI", "CDD", "VIE", "Graduate", "Alternance", "Freelance"];
const ATS_LABEL = {
  workday: "Workday", smartrecruiters: "SmartRecruiters", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby",
  recruitee: "Recruitee", teamtailor: "Teamtailor", personio: "Personio", oracle: "Oracle", successfactors: "SuccessFactors",
  pinpoint: "Pinpoint", links: "Careers page", unknown: "Check by hand",
};

// ───────────────────────────── state ─────────────────────────────
const S = {
  user: null,
  view: "inbox",
  companies: [],
  apps: [],
  settings: null,
  inbox: [],             // postings for the current inbox tab
  inboxTab: "new",       // new | all | dismissed
  inboxQuery: "",
  inboxCompany: "",
  cursor: 0,
  appsQuery: "",
  appsStatus: null,      // status filter from the mix bar
  appsView: localGet("appsView", "table"),
  sort: { key: "updated_at", dir: -1 },
  drawer: null,          // { type: 'app'|'company', id|null }
  detect: null,          // detection preview in Companies
  newCount: 0,
};

function localGet(k, d) { try { return localStorage.getItem("jt:" + k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem("jt:" + k, v); } catch { /* private mode */ } }

// ───────────────────────────── helpers ─────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? "") ? esc(u) : "");
const today = () => new Date().toISOString().slice(0, 10);
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
const statusSelect = (value, attrs = "") =>
  `<select class="status-select" style="--c: var(--s-${value})" ${attrs} aria-label="Status">${STATUSES.map(
    (s) => `<option value="${s.id}" ${s.id === value ? "selected" : ""}>${s.label}</option>`,
  ).join("")}</select>`;

// ───────────────────────────── data ─────────────────────────────
async function loadCore() {
  const [c, a, s, n] = await Promise.all([
    sb.from("companies").select("*").order("name"),
    sb.from("applications").select("*").order("updated_at", { ascending: false }),
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("postings").select("id", { count: "exact", head: true }).eq("state", "new").eq("matched", true).eq("is_open", true),
  ]);
  for (const r of [c, a, s, n]) if (r.error) throw r.error;
  S.companies = c.data;
  S.apps = a.data;
  S.settings = s.data;
  S.newCount = n.count ?? 0;
}
async function loadInbox() {
  let q = sb.from("postings").select("*, companies(name)").order("first_seen", { ascending: false }).order("score", { ascending: false }).limit(400);
  if (S.inboxTab === "new") q = q.eq("state", "new").eq("matched", true).eq("is_open", true);
  if (S.inboxTab === "all") q = q.eq("is_open", true);
  if (S.inboxTab === "dismissed") q = q.eq("state", "dismissed");
  if (S.inboxCompany) q = q.eq("company_id", S.inboxCompany);
  if (S.inboxQuery) q = q.ilike("title", `%${S.inboxQuery}%`);
  const { data, error } = await q;
  if (error) throw error;
  S.inbox = data;
  S.cursor = Math.min(S.cursor, Math.max(0, data.length - 1));
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
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
};

function shell(content) {
  const tab = (id, label, extra = "") =>
    `<a href="#${id}" ${S.view === id ? 'aria-current="page"' : ""}>${ICONS[id]}<span>${label}</span>${extra}</a>`;
  return `<div class="shell">
    <header class="topbar"><div class="topbar-inner">
      <div class="brand">${LOGO}<span>Job Tracker</span></div>
      <nav class="nav" aria-label="Sections">
        ${tab("inbox", "Inbox", S.newCount ? `<span class="count">${S.newCount > 99 ? "99+" : S.newCount}</span>` : "")}
        ${tab("applications", "Applications")}
        ${tab("companies", "Companies")}
        ${tab("settings", "Settings")}
      </nav>
      <div class="spacer"></div>
    </div></header>
    <main id="main">${content}</main>
  </div>${S.drawer ? drawerHtml() : ""}`;
}

async function render() {
  const app = $("#app");
  if (!S.user) { app.innerHTML = authView(); bindAuth(); return; }
  const views = { inbox: inboxView, applications: appsView, companies: companiesView, settings: settingsView };
  app.innerHTML = shell((views[S.view] ?? inboxView)());
  bindView();
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
  const rows = S.inbox;
  const companyOpts = S.companies.map((c) => `<option value="${c.id}" ${String(c.id) === String(S.inboxCompany) ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  let body;
  if (!rows.length) {
    const active = S.companies.filter((c) => c.active && c.ats !== "unknown").length;
    body = `<div class="feed"><div class="empty">${
      S.inboxTab === "new"
        ? active
          ? `<h2>You're up to date</h2><p>New postings that match your filters land here after each morning check. Last check: ${esc(relTime(lastRun()))}.</p><button class="btn" data-act="run-all">Check all companies now</button>`
          : `<h2>No companies to watch yet</h2><p>Add the careers pages you care about and they'll be checked every morning.</p><a class="btn primary" href="#companies">Add companies</a>`
        : `<h2>Nothing here</h2><p>Try another company or clear the search.</p>`
    }</div></div>`;
  } else {
    let lastDay = "";
    body = `<div class="feed" id="feed">${rows.map((p, i) => {
      const dayKey = (p.first_seen ?? "").slice(0, 10);
      const head = S.inboxTab === "new" && dayKey !== lastDay ? `<div class="day-head">Found ${esc(dayLabel(dayKey))}</div>` : "";
      lastDay = dayKey;
      return head + postingRow(p, i);
    }).join("")}</div>`;
  }
  return `
    <div class="page-head">
      <div class="grow">
        <h1>${S.inboxTab === "new" ? `${S.newCount} new ${S.newCount === 1 ? "posting" : "postings"}` : "Postings"}</h1>
        <p class="sub">Matched against your keywords and locations. Track the ones worth applying to; dismiss the rest.</p>
      </div>
      ${S.inboxTab === "new" && rows.length ? `<button class="btn" data-act="dismiss-visible">Dismiss all ${rows.length}</button>` : ""}
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Which postings">${tabs.map(([id, l]) => `<button data-inbox-tab="${id}" aria-pressed="${S.inboxTab === id}">${l}</button>`).join("")}</div>
      <input class="search" type="search" id="inbox-q" placeholder="Search titles" value="${esc(S.inboxQuery)}">
      <select id="inbox-co" style="width:auto"><option value="">All companies</option>${companyOpts}</select>
      <span class="faint small hide-m">Keys: j / k to move, t to track, d to dismiss, o to open</span>
    </div>
    ${body}`;
}
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
function postingRow(p, i) {
  const tracked = p.state === "tracked";
  return `<div class="post ${i === S.cursor ? "active" : ""}" data-i="${i}" data-posting="${p.id}">
    <div>
      <a class="post-title" href="${safeUrl(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="post-meta">
        <span class="company">${esc(p.companies?.name)}</span>
        ${p.location ? `<span>${esc(p.location)}</span>` : ""}
        ${p.posted_at ? `<span>Posted ${esc(fmtDate(p.posted_at))}</span>` : ""}
        ${!p.baseline && S.inboxTab === "new" ? `<span class="tag new">New listing</span>` : ""}
        ${!p.is_open ? `<span class="tag closed">Closed</span>` : ""}
        ${!p.matched && S.inboxTab !== "new" ? `<span class="tag">Outside your filters</span>` : ""}
      </div>
    </div>
    <div class="post-actions">
      ${tracked ? `<span class="tag">Tracked</span>` : `<button class="btn sm primary" data-act="track" data-id="${p.id}">Track <kbd>t</kbd></button>`}
      ${p.state === "new" ? `<button class="btn sm" data-act="dismiss" data-id="${p.id}">Dismiss <kbd>d</kbd></button>` : ""}
      ${p.state === "dismissed" ? `<button class="btn sm" data-act="restore" data-id="${p.id}">Restore</button>` : ""}
    </div>
  </div>`;
}
async function trackPosting(id) {
  const p = S.inbox.find((x) => x.id === id);
  if (!p) return;
  const { data, error } = await sb.from("applications").insert({
    company: p.companies?.name ?? "", company_id: p.company_id, posting_id: p.id, role: p.title,
    location: p.location, url: p.url, date_posted: p.posted_at, status: "saved",
    contract: guessContract(p.title),
  }).select().single();
  if (error) return fail(error, "Couldn't track it");
  await sb.from("postings").update({ state: "tracked", application_id: data.id }).eq("id", id);
  S.apps.unshift(data);
  removeFromInbox(id, "tracked");
  toast(`Tracked: ${p.title}`);
}
function guessContract(t = "") {
  const s = t.toLowerCase();
  if (/\bv\.?i\.?e\b/.test(s)) return "VIE";
  if (/stag|intern/.test(s)) return "Stage";
  if (/altern|apprenti/.test(s)) return "Alternance";
  if (/graduate|jeune dipl/.test(s)) return "Graduate";
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

// ───────────────────────────── applications ─────────────────────────────
function appsFiltered() {
  const q = S.appsQuery.toLowerCase();
  let list = S.apps.filter((a) => (!S.appsStatus || a.status === S.appsStatus)
    && (!q || [a.company, a.role, a.location, a.notes, a.contract].some((v) => (v ?? "").toLowerCase().includes(q))));
  const { key, dir } = S.sort;
  list = [...list].sort((a, b) => {
    const va = a[key] ?? "", vb = b[key] ?? "";
    if (key === "status") return dir * (STATUSES.findIndex((s) => s.id === va) - STATUSES.findIndex((s) => s.id === vb));
    return dir * String(va).localeCompare(String(vb), "fr", { numeric: true });
  });
  return list;
}
function followUpDue(a) {
  if (a.follow_up_on && a.follow_up_on <= today() && STATUS[a.status]?.open) return "Follow up today";
  if (a.status === "applied" && a.applied_on && daysBetween(a.applied_on) >= (S.settings?.follow_up_days ?? 14)) {
    return `No reply in ${daysBetween(a.applied_on)} days`;
  }
  return "";
}
function metrics() {
  const A = S.apps;
  const submitted = A.filter((a) => !["saved", "skipped"].includes(a.status));
  const responded = submitted.filter((a) => ["interview", "offer", "accepted", "rejected"].includes(a.status));
  const positive = submitted.filter((a) => ["interview", "offer", "accepted"].includes(a.status));
  const waits = submitted.filter((a) => a.applied_on && a.response_on).map((a) => daysBetween(a.applied_on, a.response_on)).sort((x, y) => x - y);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "–");
  const due = A.filter(followUpDue).length;
  return [
    [submitted.length, "applications sent"],
    [pct(responded.length, submitted.length), `got a reply (${responded.length})`],
    [pct(positive.length, submitted.length), `led to interviews (${positive.length})`],
    [median === null ? "–" : `${median} d`, "median wait for a reply"],
    [due, due === 1 ? "follow-up due" : "follow-ups due"],
  ];
}
function mixBar() {
  const counts = STATUSES.map((s) => ({ ...s, n: S.apps.filter((a) => a.status === s.id).length })).filter((s) => s.n);
  if (!counts.length) return "";
  return `<div class="mix ${S.appsStatus ? "filtered" : ""}">
    <div class="mix-bar" role="group" aria-label="Applications by status">
      ${counts.map((s) => `<button class="mix-seg" style="--n:${s.n}; --c: var(--s-${s.id})" ${LIGHT_STATUSES.has(s.id) ? "data-light" : ""}
        data-status="${s.id}" aria-pressed="${S.appsStatus === s.id}" title="${s.label}: ${s.n}"><span>${s.n}</span></button>`).join("")}
    </div>
    <div class="mix-legend">
      ${counts.map((s) => `<button data-status="${s.id}" aria-pressed="${S.appsStatus === s.id}"><span class="pill" style="--c: var(--s-${s.id})">${s.label}</span><b>${s.n}</b></button>`).join("")}
      ${S.appsStatus ? `<button data-status="">Show all</button>` : ""}
    </div>
  </div>`;
}
function appsView() {
  const list = appsFiltered();
  const th = (key, label, cls = "") => {
    const on = S.sort.key === key;
    return `<th class="sortable ${cls}" data-sort="${key}">${label}${on ? `<span class="arrow">${S.sort.dir > 0 ? "↑" : "↓"}</span>` : ""}</th>`;
  };
  let body;
  if (!S.apps.length) {
    body = `<div class="table-wrap"><div class="empty"><h2>No applications yet</h2><p>Track a posting from the Inbox or add one by hand.</p><button class="btn primary" data-act="new-app">Add application</button></div></div>`;
  } else if (S.appsView === "board") {
    body = boardHtml(list);
  } else {
    body = `<div class="table-wrap"><table class="stack">
      <thead><tr>${th("company", "Company")}${th("role", "Role")}${th("contract", "Type", "hide-m")}${th("location", "Location", "hide-m")}${th("status", "Status")}${th("applied_on", "Applied", "num")}<th class="hide-m">Follow-up</th></tr></thead>
      <tbody>${list.map((a) => {
        const due = followUpDue(a);
        return `<tr class="clickable" data-app="${a.id}">
          <td class="co">${esc(a.company)}</td>
          <td class="role"><span class="t">${esc(a.role) || '<span class="faint">No role</span>'}</span></td>
          <td class="hide-m">${esc(a.contract)}</td>
          <td class="hide-m muted">${esc(a.location)}</td>
          <td class="status-cell">${statusSelect(a.status, `data-status-of="${a.id}"`)}</td>
          <td class="num">${a.applied_on ? esc(fmtDate(a.applied_on)) : ""}</td>
          <td class="flag-cell">${due ? `<span class="flag">${esc(due)}</span>` : ""}</td>
        </tr>`;
      }).join("")}</tbody></table>
      ${list.length ? "" : `<div class="empty">No applications match.</div>`}
    </div>`;
  }
  return `
    <div class="page-head">
      <div class="grow"><h1>Applications</h1><p class="sub">${S.apps.length} tracked. Click a status to filter; click a row to see the full record.</p></div>
      <button class="btn primary" data-act="new-app">Add application</button>
    </div>
    ${mixBar()}
    <div class="stats">${metrics().map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>
    <div class="toolbar">
      <input class="search" type="search" id="apps-q" placeholder="Search company, role, notes" value="${esc(S.appsQuery)}">
      <div class="seg" role="group" aria-label="Layout">
        <button data-apps-view="table" aria-pressed="${S.appsView === "table"}">Table</button>
        <button data-apps-view="board" aria-pressed="${S.appsView === "board"}">Board</button>
      </div>
    </div>
    ${body}`;
}
function boardHtml(list) {
  const cols = S.appsStatus ? [STATUS[S.appsStatus]] : STATUSES.filter((s) => s.open || list.some((a) => a.status === s.id && s.id === "accepted"));
  return `<div class="board">${cols.map((s) => {
    const items = list.filter((a) => a.status === s.id);
    return `<div class="col" data-col="${s.id}">
      <div class="col-head"><span class="pill" style="--c: var(--s-${s.id})">${s.label}</span><span class="faint small">${items.length}</span></div>
      ${items.map((a) => `<div class="card" draggable="true" data-app="${a.id}">
        <div class="co">${esc(a.company)}</div><div class="r">${esc(a.role)}</div>
        <div class="meta"><span>${esc(a.contract ?? "")}</span><span>${followUpDue(a) ? `<span class="flag">Follow up</span>` : a.applied_on ? esc(fmtDate(a.applied_on)) : ""}</span></div>
      </div>`).join("")}
    </div>`;
  }).join("")}</div>`;
}
async function setStatus(id, status) {
  const { data, error } = await sb.from("applications").update({ status }).eq("id", id).select().single();
  if (error) return fail(error, "Couldn't change the status");
  S.apps = S.apps.map((a) => (a.id === id ? data : a));
  toast(`${data.company}: ${STATUS[status].label}`);
  render();
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
function companiesView() {
  const d = S.detect;
  const watched = S.companies.filter((c) => c.active && c.ats !== "unknown").length;
  return `
    <div class="page-head">
      <div class="grow"><h1>Companies</h1><p class="sub">${watched} of ${S.companies.length} careers pages are checked every morning at 06:30. Paste a careers page or any job link from a company to add it.</p></div>
      <button class="btn" data-act="run-all">Check all now</button>
    </div>
    <form class="panel panel-pad" id="add-company" style="margin-bottom:22px">
      <div class="add-company">
        <label class="field"><span>Company</span><input type="text" name="name" placeholder="e.g. Engie" required value="${esc(d?.name ?? "")}"></label>
        <label class="field"><span>Careers page or a job link</span><input type="url" name="url" placeholder="https://…" required value="${esc(d?.url ?? "")}"></label>
        <button class="btn" type="submit" ${d?.loading ? "disabled" : ""}>${d?.loading ? "Checking…" : "Check"}</button>
      </div>
      ${d && !d.loading ? detectResult(d) : ""}
    </form>
    <div class="table-wrap"><table class="stack">
      <thead><tr><th>Company</th><th class="hide-m">Source</th><th>Status</th><th class="num hide-m">Matches</th><th class="hide-m">Last checked</th><th></th></tr></thead>
      <tbody>${S.companies.map((c) => `<tr>
        <td class="co">${c.careers_url ? `<a href="${safeUrl(c.careers_url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}</td>
        <td class="hide-m"><span class="src">${esc(ATS_LABEL[c.ats] ?? c.ats)}</span>${c.country ? `<span class="faint small"> in ${esc(c.country)}</span>` : ""}${c.search ? `<span class="faint small"> for “${esc(c.search)}”</span>` : ""}</td>
        <td class="status-cell">${companyHealth(c)}</td>
        <td class="num hide-m">${c.matched_open ?? ""}</td>
        <td class="hide-m muted small">${esc(relTime(c.last_run_at))}</td>
        <td class="row-actions-cell"><div class="row-actions">
          ${c.ats !== "unknown" && c.active ? `<button class="btn sm ghost" data-act="run-one" data-id="${c.id}">Check now</button>` : ""}
          <button class="btn sm ghost" data-act="toggle-company" data-id="${c.id}">${c.active ? "Pause" : "Resume"}</button>
          <button class="btn sm ghost" data-act="edit-company" data-id="${c.id}">Edit</button>
        </div></td>
      </tr>`).join("")}</tbody>
    </table>${S.companies.length ? "" : `<div class="empty">No companies yet.</div>`}</div>`;
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
  toast(`Added ${data.name}`);
  render();
  if (data.ats !== "unknown") runOne(data.id);
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
      <p class="sub">A posting reaches your inbox when its title names your field and your level, avoids the hidden words, and is in one of your locations. Matching ignores case and accents. A keyword matches the start of a word (“analyst” also matches “analystes”); put it in double quotes to match the whole word only: <code>"market"</code> skips “marketing”.</p></div></div>
    <form id="settings-form" class="settings-grid">
      <section><h2>Field: titles mentioning any of</h2>${chipEditor("include_keywords", s.include_keywords, "Add a keyword and press Enter")}
        <p class="faint small" style="margin:0">Skipped for companies marked “every role here is in my field”. Leave empty to accept any field.</p></section>
      <section><h2>Level: and any of</h2>${chipEditor("role_keywords", s.role_keywords ?? [], "Add a keyword and press Enter")}
        <p class="faint small" style="margin:0">Leave empty to accept any level.</p></section>
      <section><h2>Hide titles containing</h2>${chipEditor("exclude_keywords", s.exclude_keywords, "Add a keyword and press Enter")}</section>
      <section><h2>Locations</h2>${chipEditor("locations", s.locations, "Add a city, region or country")}
        <p class="faint small" style="margin:0">Postings without a location are always kept.</p></section>
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
    exclude_keywords: S.settings.exclude_keywords, locations: S.settings.locations,
    follow_up_days: Number(form.follow_up_days.value) || 14, updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("settings").update(patch).eq("id", 1);
  if (error) return fail(error, "Couldn't save");
  const { data: n, error: e2 } = await sb.rpc("rematch_postings", { p_company_id: null });
  if (e2) return fail(e2, "Saved, but re-checking failed");
  await refreshCount();
  toast(`Filters saved. ${n} postings re-checked, ${S.newCount} in your inbox.`);
  render();
}
function exportCsv() {
  const cols = ["company", "role", "contract", "location", "status", "date_posted", "applied_on", "response_on", "follow_up_on", "next_step", "contact", "documents", "url", "notes"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...S.apps.map((a) => cols.map((c) => cell(a[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `applications-${today()}.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

// ───────────────────────────── drawer ─────────────────────────────
let drawerEvents = [];
function drawerHtml() {
  const d = S.drawer;
  if (d.type === "company") return companyDrawer(S.companies.find((c) => c.id === d.id));
  const a = d.id ? S.apps.find((x) => x.id === d.id) : { status: "saved", priority: 2 };
  const f = (name, label, type = "text", cls = "") =>
    `<label class="field ${cls}"><span>${label}</span><input type="${type}" name="${name}" value="${esc(a[name] ?? "")}"></label>`;
  return `<div class="scrim" data-act="close"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Application">
    <div class="drawer-head"><h2>${d.id ? esc(a.company) : "New application"}</h2>
      ${a.url ? `<a class="btn sm" href="${safeUrl(a.url)}" target="_blank" rel="noopener">Open posting</a>` : ""}
      <button class="btn sm ghost" data-act="close" aria-label="Close">Close</button></div>
    <form class="drawer-body" id="app-form">
      <div class="fields">
        ${f("company", "Company")}
        ${f("role", "Role")}
        <label class="field"><span>Status</span>${statusSelect(a.status, 'name="status"')}</label>
        <label class="field"><span>Type</span><select name="contract"><option value=""></option>${CONTRACTS.map((c) => `<option ${a.contract === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        ${f("location", "Location")}
        <label class="field"><span>Priority</span><select name="priority">${[[1, "High"], [2, "Normal"], [3, "Low"]].map(([v, l]) => `<option value="${v}" ${a.priority === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        ${f("url", "Posting link", "url", "wide")}
        ${f("date_posted", "Posted", "date")}
        ${f("applied_on", "Applied", "date")}
        ${f("response_on", "Reply received", "date")}
        ${f("follow_up_on", "Follow up on", "date")}
        ${f("next_step", "Next step", "text", "wide")}
        ${f("contact", "Contacts", "text", "wide")}
        ${f("documents", "CV and cover letter sent", "text", "wide")}
        <label class="field wide"><span>Notes</span><textarea name="notes" rows="4">${esc(a.notes ?? "")}</textarea></label>
      </div>
      ${d.id ? `<section><h2 style="margin-bottom:10px">History</h2>
        <ul class="timeline" id="timeline">${timelineHtml()}</ul>
        <div class="toolbar" style="margin:12px 0 0"><input type="text" id="note-input" placeholder="Add a note to the history" style="flex:1"><button class="btn sm" type="button" data-act="add-note">Add</button></div>
      </section>` : ""}
    </form>
    <div class="drawer-foot">
      ${d.id ? `<button class="btn ghost danger" data-act="delete-app">Delete</button>` : ""}
      <div class="spacer"></div>
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn primary" data-act="save-app">${d.id ? "Save changes" : "Add application"}</button>
    </div>
  </aside>`;
}
function timelineHtml() {
  if (!drawerEvents.length) return `<li><time></time><span class="faint">Loading…</span></li>`;
  return drawerEvents.map((e) => {
    const what = e.kind === "created" ? `Added as ${STATUS[e.to_status]?.label ?? e.to_status}`
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
  for (const k of ["company", "role", "status", "contract", "location", "url", "date_posted", "applied_on", "response_on", "follow_up_on", "next_step", "contact", "documents", "notes"]) {
    const v = (fd.get(k) ?? "").toString().trim();
    row[k] = v === "" ? null : v;
  }
  row.priority = Number(fd.get("priority") || 2);
  if (!row.company) return toast("Add the company name first.");
  const id = S.drawer.id;
  const q = id ? sb.from("applications").update(row).eq("id", id) : sb.from("applications").insert(row);
  const { data, error } = await q.select().single();
  if (error) return fail(error, "Couldn't save");
  S.apps = id ? S.apps.map((a) => (a.id === id ? data : a)) : [data, ...S.apps];
  S.drawer = null;
  toast(id ? "Saved" : `Added ${data.company}`);
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
  if (!confirm(`Delete the ${a.company} application and its history? This can't be undone.`)) return;
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
  const row = { name: v("name"), careers_url: v("careers_url"), country: v("country"), search: v("search"), ats: v("ats"), notes: v("notes"), config, in_field: fd.get("in_field") === "on" };
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
  $("#inbox-co")?.addEventListener("change", async (e) => { S.inboxCompany = e.target.value; await loadInbox(); render(); });
  const qApps = $("#apps-q");
  if (qApps) qApps.addEventListener("input", () => { S.appsQuery = qApps.value; const pos = qApps.selectionStart; render(); const el = $("#apps-q"); el.focus(); el.setSelectionRange(pos, pos); });
  $("#add-company")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    detect(f.name.value.trim(), f.url.value.trim());
  });
  $("#settings-form")?.addEventListener("submit", (e) => { e.preventDefault(); saveSettings(e.target); });

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

  // board drag and drop
  document.querySelectorAll(".card[draggable]").forEach((card) => {
    card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", card.dataset.app));
  });
  document.querySelectorAll(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
    col.addEventListener("dragleave", () => col.classList.remove("drop"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop");
      const id = Number(e.dataTransfer.getData("text/plain"));
      if (id && S.apps.find((a) => a.id === id)?.status !== col.dataset.col) setStatus(id, col.dataset.col);
    });
  });
  void main;
}

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-status-of]");
  if (sel) { e.stopPropagation(); setStatus(Number(sel.dataset.statusOf), sel.value); }
  if (e.target.matches('.drawer select[name="status"]')) e.target.style.setProperty("--c", `var(--s-${e.target.value})`);
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act], [data-inbox-tab], [data-apps-view], [data-status], [data-sort], [data-chip-remove], tr[data-app], .card[data-app], .post[data-i]");
  if (!el) return;
  if (el.matches("[data-status-of], select")) return;
  if (el.dataset.chipRemove) {
    const k = el.dataset.chipRemove;
    S.settings[k] = S.settings[k].filter((_, i) => i !== Number(el.dataset.i));
    return render();
  }
  if (el.dataset.inboxTab) { S.inboxTab = el.dataset.inboxTab; S.cursor = 0; await loadInbox(); return render(); }
  if (el.dataset.appsView) { S.appsView = el.dataset.appsView; localSet("appsView", S.appsView); return render(); }
  if (el.dataset.status !== undefined && !el.dataset.act) { S.appsStatus = el.dataset.status && S.appsStatus !== el.dataset.status ? el.dataset.status : null; return render(); }
  if (el.dataset.sort) {
    const k = el.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : k === "company" || k === "role" ? 1 : -1 };
    return render();
  }
  if (el.matches("tr[data-app], .card[data-app]") && !e.target.closest("a, button, select")) return openApp(Number(el.dataset.app));
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
    case "new-app": return openApp(null);
    case "save-app": return saveApp();
    case "delete-app": return deleteApp();
    case "add-note": return addNote();
    case "close": S.drawer = null; return render();
    case "export": return exportCsv();
    case "sign-out": await sb.auth.signOut(); return;
  }
});

document.addEventListener("keydown", (e) => {
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
  const v = location.hash.replace("#", "") || "inbox";
  S.view = ["inbox", "applications", "companies", "settings"].includes(v) ? v : "inbox";
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
}
let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  if (event === "INITIAL_SESSION" || (event === "SIGNED_IN" && !S.user) || event === "SIGNED_OUT") {
    booted = true;
    setTimeout(() => start(session), 0);
  }
});
setTimeout(async () => { if (!booted) { const { data } = await sb.auth.getSession(); start(data.session); } }, 1500);
