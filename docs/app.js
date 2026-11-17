import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

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
  inboxCompany: "",
  cursor: 0,
  appsQuery: "",
  sort: { key: null, dir: 1 },   // null = the log's own order (oldest row first, like the Excel)
  filter: null,                  // status shown in the log, null = all
  pendingLink: null,             // a link shared to the app, waiting for Save for later / Already applied
  season: null,                  // which round of applications the log shows; null = the current one
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
  const [c, a, s, n] = await Promise.all([
    sb.from("companies").select("*").order("name"),
    sb.from("applications").select("*").order("id", { ascending: true }),
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
        ${tab("applications", "Applications")}
        ${tab("inbox", "Inbox", S.newCount ? `<span class="count">${S.newCount > 99 ? "99+" : S.newCount}</span>` : "")}
        ${tab("companies", "Companies")}
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
  const views = { inbox: inboxView, applications: appsView, companies: companiesView, settings: settingsView };
  app.innerHTML = shell((views[S.view] ?? appsView)());
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
    season: currentSeason(), status: "saved", company: p.companies?.name ?? "", company_id: p.company_id, posting_id: p.id, role: p.title,
    location: p.location, url: p.url, date_posted: p.posted_at, contract: guessContract(p.title),
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
      for (const k of ["description", "contract", "location", "date_posted"]) if (!data[k] && x.row[k]) patch[k] = x.row[k];
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

// ───────────────────────────── applications log ─────────────────────────────
// The Excel's columns, with one Status per row in place of the three tick boxes.
// Computer: a full-width table. Phone: a card per row.
const COLS = [
  { key: "company", label: "Company", kind: "text", w: 140 },
  { key: "role", label: "Position", kind: "text", w: 0 },        // 0 = shares the remaining width
  { key: "contract", label: "Type", kind: "text", w: 88, title: "Position Length" },
  { key: "location", label: "Location", kind: "text", w: 104 },
  { key: "description", label: "Description", kind: "long", w: 0 },
  { key: "date_posted", label: "Posted", kind: "date", w: 76, title: "Date Posted" },
  { key: "url", label: "Link", kind: "link", w: 50 },
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

// Seasons are rounds of applications. The current one is a setting, so a new season can start empty.
const currentSeason = () => S.settings?.current_season ?? 2;
const shownSeason = () => S.season ?? currentSeason();
const seasonRows = (n = shownSeason()) => S.apps.filter((a) => (a.season ?? 2) === n);
const rowNumber = (a) => seasonRows(a.season ?? 2).indexOf(a) + 1;
function sheetRows() {
  const q = fold(S.appsQuery.trim());
  let list = seasonRows().filter((a) => (!S.filter || a.status === S.filter || (S.filter === "applied" && a.status === "no_response"))
    && (!q || [a.company, a.role, a.location, a.description, a.contract, a.notes].some((v) => fold(v).includes(q))));
  const { key, dir } = S.sort;
  if (!key) return [...list].reverse(); // newest first: what you just added is at the top
  const order = (a) => (key === "status" ? STATUSES.findIndex((x) => x.id === a.status) : a[key] ?? "");
  return [...list].sort((a, b) => {
    const va = order(a), vb = order(b);
    return dir * (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "fr", { numeric: true, sensitivity: "base" }));
  });
}

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
      return `<td class="c-${c.key}"><div class="ed" data-field="${c.key}" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></td>`;
    case "long":
      return `<td class="c-desc"><div class="ed clamp" data-field="${c.key}" contenteditable="plaintext-only" spellcheck="false">${esc(v)}</div></td>`;
    case "date":
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
  const meta = [a.contract, a.location].filter(Boolean).map(esc).join(" · ");
  const d = responseDays(a), w = waitingDays(a);
  const when = a.responded ? `${a.response_on ? `reply ${esc(shortDate(a.response_on))}` : "replied"}${d !== null ? ` · ${d} d` : ""}`
    : a.applied ? `applied ${a.applied_on ? esc(shortDate(a.applied_on)) : ""}${w !== null ? ` · ${w} d waiting` : ""}`
    : a.date_posted ? `posted ${esc(shortDate(a.date_posted))}` : "";
  return `<article class="card tone-${rowTone(a)}" data-row="${a.id}">
    <button type="button" class="card-main" data-open="${a.id}">
      <span class="card-top"><b class="co">${esc(a.company) || '<span class="faint">No company</span>'}</b><span class="n">#${n}</span></span>
      ${a.role ? `<span class="card-role">${esc(a.role)}</span>` : ""}
      ${meta ? `<span class="card-meta">${meta}</span>` : ""}
      ${a.description ? `<span class="card-desc">${esc(a.description)}</span>` : ""}
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
// Where the season stands: a bar of statuses that doubles as the filter.
function statusBar() {
  const A = seasonRows();
  if (!A.length) return "";
  const groups = STATUSES.filter((x) => !x.legacy).map((x) => ({ ...x, n: A.filter((a) => a.status === x.id || (x.id === "applied" && a.status === "no_response") || (x.id === "skipped" && a.status === "withdrawn")).length })).filter((g) => g.n);
  return `<div class="mix" role="group" aria-label="Filter by status">
    <div class="mix-bar">${groups.map((g) => `<span class="tone-${g.tone}" style="flex:${g.n}"></span>`).join("")}</div>
    <div class="mix-legend">${groups.map((g) => `<button data-filter="${g.id}" class="tone-${g.tone}" aria-pressed="${S.filter === g.id}"><i></i>${g.label}<b>${g.n}</b></button>`).join("")}
      ${S.filter ? `<button data-filter="" class="clear">Show all</button>` : ""}</div>
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
    return `<th class="h-${c.kind}" ${c.w ? `style="width:${c.w}px"` : ""} data-sort="${c.key}" title="${c.title ?? c.label}" aria-sort="${on ? (S.sort.dir > 0 ? "ascending" : "descending") : "none"}">${c.label}${on ? `<i class="arrow">${S.sort.dir > 0 ? "↑" : "↓"}</i>` : ""}</th>`;
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
    ${mobile
      ? `<div class="cards" id="rows">${list.map(itemHtml).join("")}</div>${list.length ? "" : empty}`
      : `<div class="log-scroll" id="log-scroll">
          <table class="log" id="log">
            <thead><tr><th class="gutter" aria-label="Row"></th>${head}</tr></thead>
            <tbody id="rows">${list.map(itemHtml).join("")}</tbody>
          </table>
          ${list.length ? "" : empty}
        </div>
        <p class="faint small log-foot">Click a cell to edit it. Dates fill themselves when the status moves on; click one to change it. The row number opens notes, contacts and history.${S.sort.key ? ` <button class="linklike" data-act="clear-sort">Back to newest first</button>` : ""}</p>`}
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
  if ((a[field] ?? "") === value) return;
  if (field === "company" && !value) { ed.textContent = a.company; return toast("A row needs a company name."); }
  await savePatch(id, { [field]: value || null }, true);
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
  S.filter = null;
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
    description: row.description ?? null, date_posted: row.date_posted ?? null, url,
    company_id: S.companies.find((c) => sameCompany(c.name, row.company))?.id ?? null,
  };
  const { data, error } = await sb.from("applications").insert(insert).select().single();
  done();
  if (error) return fail(error, "Couldn't add the row");
  S.apps.push(data);
  S.sort = { key: null, dir: 1 };
  S.season = null;
  S.filter = null;
  S.appsQuery = "";
  render();
  focusRow(data.id, note && !mobileQuery.matches ? "company" : null);
  if (note && mobileQuery.matches) openApp(data.id);
  toast(note ? `${note} The link is saved.`
    : mode === "applied" ? `Logged as applied: ${data.company}` : `Saved for later: ${data.company}`);
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
  S.filter = null;
  S.pendingLink = null;
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
  const cols = [["season", "Season"], ["company", "Company"], ["role", "Position"], ["contract", "Position Length"], ["location", "Location"],
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
        ${f("company", "Company", "text", "wide")}
        ${f("role", "Position", "text", "wide")}
        <label class="field wide"><span>Status</span><select name="status">${STATUSES.filter((x) => !x.legacy || x.id === a.status).map((x) => `<option value="${x.id}" ${x.id === a.status ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
        ${f("applied_on", "Application Date", "date")}
        ${f("response_on", "Response Date", "date")}
        <label class="field"><span>Position Length</span><input type="text" name="contract" list="contracts" value="${esc(a.contract ?? "")}"></label>
        ${f("location", "Location")}
        ${f("date_posted", "Date Posted", "date")}
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
  for (const k of ["company", "role", "status", "contract", "location", "description", "url", "date_posted", "applied_on", "response_on", "next_step", "contact", "documents", "notes"]) {
    const v = (fd.get(k) ?? "").toString().trim();
    row[k] = v === "" ? null : v;
  }
  if (!row.company) return toast("Add the company name first.");
  const id = S.drawer.id;
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
  if (qApps) qApps.addEventListener("input", () => {
    S.appsQuery = qApps.value;
    $("#rows").innerHTML = sheetRows().map(itemHtml).join("");
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
    S.filter = null;
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
  const el = e.target.closest("[data-act], [data-inbox-tab], [data-open], [data-filter], [data-sort], [data-chip-remove], .post[data-i]");
  if (!el) return;
  if (el.dataset.filter !== undefined) {
    S.filter = el.dataset.filter && S.filter !== el.dataset.filter ? el.dataset.filter : null;
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
    case "clear-filters": S.filter = null; S.appsQuery = ""; return render();
    case "paste": return pasteLink();
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
  const v = location.hash.replace("#", "") || "applications";
  S.view = ["inbox", "applications", "companies", "settings"].includes(v) ? v : "applications";
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
