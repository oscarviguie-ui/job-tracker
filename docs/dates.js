// Dates in job ads: when the ad went up, and when the job starts.
// Shared by the web app (docs/) and the extract edge function, which imports it through a symlink.
// Ads are mostly French or English and write dates every way imaginable ("12 nov. 2026", "Posted 2 weeks ago",
// "Date de début : début février", "Start: ASAP", "Stage de 6 mois à partir de janvier 2027").

export const fold = (t) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const iso = (y, m, d = 1) => {
  const t = new Date(Date.UTC(y, m, d));
  return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Month words, French and English, on folded (accent-free, lower-case) text.
const MONTH = "(janv(?:ier)?|jan(?:uary)?|fevr?(?:ier)?|feb(?:ruary)?|mars|march|mar|avr(?:il)?|apr(?:il)?|mai|may|juin|june?|juil(?:let)?|july?|aout|aug(?:ust)?|sept(?:embre|ember)?|sep|oct(?:obre|ober)?|nov(?:embre|ember)?|dec(?:embre|ember)?)\\.?";
export function monthIndex(w) {
  const s = fold(w).replace(/\./g, "");
  if (s.startsWith("juil") || s.startsWith("jul")) return 6;
  if (s.startsWith("juin") || s.startsWith("jun")) return 5;
  const k = s.slice(0, 3);
  return ({ jan: 0, fev: 1, feb: 1, mar: 2, avr: 3, apr: 3, mai: 4, may: 4, aou: 7, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 })[k] ?? -1;
}

// ─────────────────────────── when the ad went up ───────────────────────────

// A date written out in full: ISO, 12/11/2026, "12 nov. 2026", "November 12, 2026", "12 November 2026".
export function parseDate(v) {
  if (!v) return null;
  const s = fold(String(v)).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (m) return iso(+m[3], +m[2] - 1, +m[1]);
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`));
  if (m) return iso(+m[3], monthIndex(m[2]), +m[1]);
  m = s.match(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`));
  if (m) return iso(+m[3], monthIndex(m[1]), +m[2]);
  if (/^\d{4}-\d{2}-\d{2}t/.test(s) || /^\w{3}, \d{1,2} \w{3} \d{4}/.test(s) || /^\d{10,13}$/.test(s)) {
    const d = new Date(/^\d{10}$/.test(s) ? +s * 1000 : /^\d{13}$/.test(s) ? +s : String(v));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

// "Posted 3 days ago", "Reposted 2 weeks ago", "il y a 1 mois", "Publié aujourd'hui", "Posted 30+ Days Ago".
export function relativeDate(s, now = new Date()) {
  if (!s) return null;
  const t = fold(s), d = new Date(now);
  if (/today|aujourd|just now|a l'instant|\d+\s*(?:min|minute|hour|heure|hr|h)s?\b/.test(t)) return d.toISOString().slice(0, 10);
  if (/yesterday|hier/.test(t)) { d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
  const m = t.match(/(\d+|an?|une?)\+?\s*(day|jour|week|semaine|month|mois)/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? +m[1] : 1;
  if (/day|jour/.test(m[2])) d.setUTCDate(d.getUTCDate() - n);
  else if (/week|semaine/.test(m[2])) d.setUTCDate(d.getUTCDate() - 7 * n);
  else d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

// A posting date stated in the page text: "Publiée le 12/11/2026", "Date de publication : 3 novembre 2026",
// "Posted on November 3, 2026", "Posted 5 days ago".
export function postedFromText(text, now = new Date()) {
  const t = fold(text);
  const re = /(?:publie(?:e)?(?: le| depuis)?|mis(?:e)? en ligne(?: le)?|date de (?:publication|parution|mise en ligne)|posted(?: on| date)?|date posted|publication date|published(?: on)?|reposted)\s*:?\s*/g;
  for (const m of t.matchAll(re)) {
    const win = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const d = parseDate(win) ?? (/^(il y a|\d|an? |une? |today|yesterday|aujourd|hier)/.test(win) ? relativeDate(win.split(/\n/)[0], now) : null);
    if (d && d <= now.toISOString().slice(0, 10)) return d;
  }
  return null;
}

// ─────────────────────────── when the job starts ───────────────────────────

/** @typedef {{ text: string, from: string, to: string }} Start  text as shown ("Jan–Mar 2027"); from / to = the earliest
 *  and latest start it allows, YYYY-MM-DD (the same day for a single date) */

// Words that introduce a start date. Kept specific: "from" or "dès" on their own appear everywhere.
const START_LABEL = /(date de (?:debut|demarrage|prise de (?:poste|fonction)|commencement|depart)|debut (?:du stage|de stage|de (?:la )?mission|du contrat|de (?:l')?alternance|du poste|souhaite|envisage|d'activite)|demarrage(?: du stage| de la mission| souhaite| prevu)?|prise de (?:poste|fonction)|(?:poste|stage|mission|offre) a pourvoir|a pourvoir|disponibilite(?: souhaitee)?|start(?:ing)? date|date of (?:start|entry)|entry date|(?:expected |desired |anticipated )?start(?:ing)?(?: date)?(?: in| from| on)?|to start|commencing|beginning|available from|stage (?:de \S+ mois |de \S+ a \S+ mois |\(\S+ mois\) )?(?:a partir|des|debutant|commencant)|a partir d[eu']|a compter d[eu']|debut(?=\s*:)|debutera|commencera|(?:will |to )?starts? (?:in|on|from)|periode(?: du stage| de stage| de la mission)?(?! d'essai)(?=\s*:)|des le|des (?=(?:debut|mi|fin|janv|fev|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)))/g;
const FILLER = "(?:\\s|:|-|–|,|\\(|le|la|en|du|de|des|d'|a|au|on|in|from|of|the|by|around|vers|environ|idealement|ideally|ideal|souhaite[e]?|prevue?|envisagee?|si possible|possible|entre|between|partir|compter|pour|for|starting)*";
const QUAL = "(?:(debut|mi|fin|early|mid|late|end of|beginning of|courant|start of)\\s*-?\\s*)?";

function inferYear(month, ref) {
  return month < ref.getUTCMonth() ? ref.getUTCFullYear() + 1 : ref.getUTCFullYear();
}
const qualText = (q) =>
  !q ? "" : /debut|early|beginning|start/.test(q) ? "Early " : /mi|mid|courant/.test(q) ? "Mid " : "Late ";
const qualDay = (q) => (!q ? 1 : /debut|early|beginning|start/.test(q) ? 1 : /mi|mid|courant/.test(q) ? 15 : 25);
const fullYear = (y) => (!y ? null : y.length === 2 ? 2000 + +y : +y);

// Reads one date expression at the start of `w` (folded text just after a label).
function readStart(w, ref) {
  let m = w.match(new RegExp(`^${FILLER}(asap|as soon as possible|des que possible|immediate(?:ly)?|immediat(?:ement)?|de suite|right away|now)\\b`));
  if (m) return { text: "ASAP", from: ref.toISOString().slice(0, 10), len: m[0].length };
  // Ranges: "janvier à mars 2027", "Jan–Mar 2027", "between February and April", "janvier/février 2027".
  m = w.match(new RegExp(`^${FILLER}${QUAL}${MONTH}(?:\\s+(\\d{4}))?\\s*(?:-|–|—|a|au|à|to|ou|or|et|and|\\/|until|jusqu'(?:a|en))\\s*${QUAL}${MONTH}(?:\\s+(\\d{4}|\\d{2}\\b))?`));
  const sepWord = m && w.slice(0, m[0].length).match(/\b(ou|or)\b/);
  if (m) {
    // Follow a list of months to its end: "mai/juin/juillet" → May–Jul.
    let end = m[0].length, last = m[5], year = m[6];
    for (let more; (more = w.slice(end).match(new RegExp(`^\\s*(?:-|–|\\/|,|ou|or|et|and)\\s*${MONTH}(?:\\s+(\\d{4}))?`))) && monthIndex(more[1]) >= 0;) {
      last = more[1]; year = more[2] ?? year; end += more[0].length;
    }
    const a = monthIndex(m[2]), b = monthIndex(last);
    if (a >= 0 && b >= 0) {
      const yb = fullYear(year) ?? fullYear(m[3]) ?? inferYear(b, ref);
      const ya = fullYear(m[3]) ?? (a <= b ? yb : yb - 1);
      const from = iso(ya, a, qualDay(m[1]));
      const sep = sepWord ? " or " : "–";
      const text = ya === yb ? `${MON[a]}${sep}${MON[b]} ${yb}` : `${MON[a]} ${ya}${sep}${MON[b]} ${yb}`;
      return { text, from, to: iso(yb, b, 1), len: end };
    }
  }
  // Numeric: 01/02/2027, 1.2.27, 02/2027, 2027-02-01.
  m = w.match(new RegExp(`^${FILLER}(\\d{4})-(\\d{2})(?:-(\\d{2}))?\\b`));
  if (m) return day(+m[1], +m[2] - 1, m[3] ? +m[3] : null, m[0].length);
  m = w.match(new RegExp(`^${FILLER}(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4}|\\d{2})\\b`));
  if (m && +m[2] >= 1 && +m[2] <= 12) return day(fullYear(m[3]), +m[2] - 1, +m[1], m[0].length);
  m = w.match(new RegExp(`^${FILLER}(\\d{1,2})[/.](\\d{4})\\b`));
  if (m && +m[1] >= 1 && +m[1] <= 12) return day(+m[2], +m[1] - 1, null, m[0].length);
  // "3 février 2027", "February 3, 2027", "début février", "early March 2027", "janvier".
  m = w.match(new RegExp(`^${FILLER}(\\d{1,2})(?:er|st|nd|rd|th)?\\s+${MONTH}(?:\\s+(\\d{4}))?`));
  if (m) { const mo = monthIndex(m[2]); if (mo >= 0) return day(fullYear(m[3]) ?? inferYear(mo, ref), mo, +m[1], m[0].length); }
  m = w.match(new RegExp(`^${FILLER}${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`));
  if (m) { const mo = monthIndex(m[1]); if (mo >= 0) return day(+m[3], mo, +m[2], m[0].length); }
  m = w.match(new RegExp(`^${FILLER}${QUAL}${MONTH}(?:\\s*(\\d{4}|'?\\d{2}\\b))?`));
  if (m) {
    const mo = monthIndex(m[2]);
    // English "may"/"march" need a year to be read as a month ("start may vary").
    if (mo >= 0 && !(/^(may|march|mar)$/.test(m[2].replace(".", "")) && !m[3])) {
      const y = fullYear(m[3]?.replace("'", "")) ?? inferYear(mo, ref);
      return { text: `${qualText(m[1])}${MON[mo]} ${y}`, from: iso(y, mo, qualDay(m[1])), len: m[0].length };
    }
  }
  // Quarters and semesters: "Q1 2027", "S1 2027", "1er semestre 2027", "rentrée 2027", "summer 2027".
  m = w.match(new RegExp(`^${FILLER}(?:q([1-4])|t([1-4])|([1-4])(?:er|e|eme|st|nd|rd|th)? (?:trimestre|quarter))\\s*(\\d{4})`));
  if (m) { const q = +(m[1] ?? m[2] ?? m[3]) - 1; return { text: `Q${q + 1} ${m[4]}`, from: iso(+m[4], q * 3), to: iso(+m[4], q * 3 + 2), len: m[0].length }; }
  m = w.match(new RegExp(`^${FILLER}(?:[sh]([12])|([12])(?:er|e|eme|st|nd)? (?:semestre|semester|half))\\s*(\\d{4})`));
  if (m) { const h = +(m[1] ?? m[2]) - 1; return { text: `H${h + 1} ${m[3]}`, from: iso(+m[3], h * 6), to: iso(+m[3], h * 6 + 5), len: m[0].length }; }
  m = w.match(new RegExp(`^${FILLER}(rentree|autumn|fall|automne|spring|printemps|summer|ete|winter|hiver)\\s*(?:de\\s*)?(\\d{4})?`));
  if (m) {
    const s = m[1];
    const mo = /rentree|autumn|fall|automne/.test(s) ? 8 : /spring|printemps/.test(s) ? 2 : /summer|ete/.test(s) ? 5 : 0;
    const y = fullYear(m[2]) ?? inferYear(mo, ref);
    const name = /rentree/.test(s) ? "Sep" : /autumn|fall|automne/.test(s) ? "Autumn" : /spring|printemps/.test(s) ? "Spring" : /summer|ete/.test(s) ? "Summer" : "Winter";
    return { text: `${name} ${y}`, from: iso(y, mo), len: m[0].length };
  }
  return null;

  function day(y, mo, d, len) {
    const from = iso(y, mo, d ?? 1);
    if (!from) return null;
    return { text: d ? `${d} ${MON[mo]} ${y}` : `${MON[mo]} ${y}`, from, len };
  }
}

// A date, plus an alternative the ad offers right after it ("1 December 2026 or 1 February 2027").
function readWithAlternative(w, ref) {
  const a = readStart(w, ref);
  if (!a) return null;
  const rest = w.slice(a.len), or = rest.match(/^\s*,?\s*(?:or|ou)\s+/);
  const b = or ? readStart(rest.slice(or[0].length), ref) : null;
  const alt = b && b.from > a.from && b.text !== "ASAP";
  return { text: alt ? `${a.text} or ${b.text}` : a.text, from: a.from, to: alt ? b.to ?? b.from : a.to ?? a.from };
}

// The start date stated in an ad (title first, then labelled phrases in the text). `ref` is the posting date,
// used to place a month written without a year.
export function startFrom(title, text, ref) {
  const r = ref ? new Date(ref + "T00:00:00Z") : new Date();
  const refDate = isNaN(r.getTime()) ? new Date() : r;
  // Titles often carry it: "Stage – Analyste marché – Février 2027", "Internship (start Sept 2026)".
  if (title) {
    const t = fold(title);
    const m = t.match(new RegExp(`(?:^|[\\s(–—|-])${QUAL}${MONTH}\\s*(?:-|–|/|a|to)?\\s*(?:${MONTH}\\s*)?(\\d{4})(?=$|[\\s),–—|-])`));
    if (m) {
      const got = readWithAlternative(m[0].replace(/^[\s(–—|-]+/, ""), refDate);
      if (got) return got;
    }
    for (const l of t.matchAll(START_LABEL)) {
      const got = readWithAlternative(t.slice(l.index + l[0].length, l.index + l[0].length + 60), refDate);
      if (got) return got;
    }
  }
  if (!text) return null;
  const t = fold(text).replace(/[\u00a0\u202f]/g, " ");
  for (const l of t.matchAll(START_LABEL)) {
    // Up to one line break between the label and its value ("Date de début\nFévrier 2027").
    const after = t.slice(l.index + l[0].length, l.index + l[0].length + 80).replace(/^([^\n]*)\n/, "$1 ");
    const got = readWithAlternative(after, refDate);
    if (got) return got;
  }
  return null;
}
