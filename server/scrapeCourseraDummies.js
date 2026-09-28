// COURSES FOR DUMMIES — the third Coursera partner console this login can open,
// beside Starweaver (/admin/starweaver) and CIN (/admin/coursera). New in
// September 2026: its first courses were created on 2026-09-14.
// Run: node scrapeCourseraDummies.js
//
// Two sources, joined by course:
//   1. The console's own Courses table (/admin/courses-for-dummies/home/courses)
//      lists EVERY course with its enrollments, completion rate and session
//      status — including ones not launched yet ("New", "Pending"). That is the
//      course list.
//   2. The Institution Overview Looker dashboard — the same dashboard, #428,
//      that Starweaver's Coursera metrics come from — whose course_comparison
//      table adds completions, the paid completion rate and the star rating
//      for LAUNCHED courses. Before a course launches it is simply not there.
//
// The window is parked rather than minimized: Looker only queries the tiles it
// thinks are on screen (see browserWindow.js). Writes one table,
// coursera_dummies_courses, through the guarded writer.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { writeCourseraDummiesCourses } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const PARTNER = 'courses-for-dummies';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await parkWindow(ctx, page);

// The console redirects itself after load; a read caught mid-redirect throws.
// That means "not ready yet", not failure (the same fix as the CIN scraper).
const navigated = (e) => /Execution context was destroyed|because of a navigation/i.test(String(e?.message || e));
const safe = (fn, fallback) => fn().catch((e) => { if (navigated(e)) return fallback; throw e; });

// ── 1. the console's Courses table ────────────────────────────────────────
console.log('Opening the Courses for Dummies partner console…');
await page.goto(`https://www.coursera.org/admin/${PARTNER}/home/courses`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(4000);
if (!/\/admin\/courses-for-dummies\//.test(page.url())) {
  console.error(`❌ The Dummies console did not open (landed on ${page.url().slice(0, 80)}). Is the Coursera login still valid?`);
  await browser.close();
  process.exit(1);
}

const readRows = () => safe(() => page.evaluate(() => [...document.querySelectorAll('tr[role="row"], tr')]
  .map((tr) => {
    const a = tr.querySelector('a[href^="/teach/"][href$="/course"]');
    if (!a) return null;
    const cells = [...tr.querySelectorAll('td,[role="cell"]')].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
    return { name: a.textContent.trim(), slug: a.getAttribute('href').split('/')[2], cells };
  })
  .filter(Boolean)), []);

// A NEW PAGE'S TITLES ARRIVE BEFORE ITS STATUS COLUMN. Read the moment the
// titles changed, pages 2 and 3 came back with no status on 17 of 27 courses.
// So wait for the rows to change AND for their status cells to fill — or for
// the text to stop changing, since one course genuinely has no status at all.
async function waitForRows(prevFirst, timeoutMs = 15000) {
  const start = Date.now();
  let last = '', steady = 0;
  while (Date.now() - start < timeoutMs) {
    const rows = await readRows();
    if (rows.length && rows[0].slug !== prevFirst) {
      const filled = rows.filter((r) => /Warning:|Created on|Starts on|Started on/.test(r.cells.join(' '))).length;
      const sig = JSON.stringify(rows.map((r) => r.cells));
      steady = sig === last ? steady + 1 : 0;
      last = sig;
      if (filled === rows.length || steady >= 4) return rows;
    }
    await sleep(400);
  }
  return readRows();
}

const seen = new Map();
let prevFirst = null;
for (let p = 1; p <= 30; p++) {
  const rows = await waitForRows(prevFirst);
  if (!rows.length) break;
  rows.forEach((r) => seen.set(r.slug, r));
  prevFirst = rows[0].slug;
  process.stdout.write(`\r  page ${p} — ${seen.size} courses`);
  const next = await safe(() => page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Go to next page"], a[aria-label="Go to next page"]');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return true; }
    return false;
  }), true);
  if (!next) break;
}
process.stdout.write('\n');

// "Inclusive Leadership For Dummies 0 enrollments" · "N/A" · "Version 1 Created on
// Sep 14, 2026 Warning: New New". The status is the word the console repeats at
// the end; the date says what kind of date it is.
const parseRow = ({ name, slug, cells }) => {
  const all = cells.join(' | ');
  const enrol = all.match(/([\d,]+)\s+enrollments?/i);
  const rate = (cells[1] || '').match(/([\d.]+)\s*%/);
  const when = all.match(/(Created on|Starts on|Started on|Launched on|Ended on|Ends on)\s+([A-Z][a-z]{2,8} \d{1,2}, \d{4})/);
  const status = (all.match(/Warning:\s*([A-Za-z-]+)/) || all.match(/\b(New|Pending|Launched|Active|Ongoing|Ended|Archived|Draft|Preenroll)\b(?!.*\b(New|Pending|Launched|Active|Ongoing|Ended|Archived|Draft|Preenroll)\b)/i) || [])[1] || null;
  return {
    name, slug,
    enrollments: enrol ? Number(enrol[1].replace(/,/g, '')) : null,
    completionRate: rate ? Number(rate[1]) / 100 : null,
    // A row with no version and no date has no session scheduled at all. Left
    // blank it read as "status unknown", which one count took as live.
    status: status ? status.toLowerCase() : (!when && !/Version/.test(all) ? 'unscheduled' : null),
    dateKind: when ? when[1] : null,
    date: when ? when[2] : null,
  };
};
const courses = [...seen.values()].map(parseRow);
console.log(`console: ${courses.length} courses · status ${JSON.stringify(courses.reduce((a, c) => ((a[c.status || '?'] = (a[c.status || '?'] || 0) + 1), a), {}))}`);

// ── 2. the Looker dashboard, for launched courses ─────────────────────────
const bodies = [];
page.on('response', async (res) => {
  if (!/querymanager\/queries/.test(res.url())) return;
  try { const t = await res.text(); if (t.length > 200) bodies.push(t); } catch {}
});
console.log('Opening the Dummies analytics dashboard…');
await page.goto(`https://www.coursera.org/admin/${PARTNER}/analytics/monitor`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);

const P = 'eds_partner_dashboard_overview_course_comparison.';
const val = (row, key) => { const c = row[P + key]; return c && typeof c === 'object' ? c.value : c; };
// The query results arrive as JSON objects one after another in one response.
function* objects(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { yield text.slice(start, i + 1); start = -1; } }
  }
}
const findTable = () => {
  let best = null, sawLastRefresh = false;
  for (const chunk of objects(bodies.join('\n'))) {
    let o; try { o = JSON.parse(chunk); } catch { continue; }
    const rows = o?.data?.data;
    if (!Array.isArray(rows)) continue;
    if (rows[0] && Object.keys(rows[0]).some((k) => k.startsWith('last_refresh_time'))) sawLastRefresh = true;
    if (rows.length && Object.keys(rows[0]).includes(P + 'enrollments_count')) best = rows;
    // A dashboard with no launched courses answers course_comparison with no rows.
    if (!rows.length && JSON.stringify(o).includes('course_comparison')) best = best || [];
  }
  return { best, sawLastRefresh };
};
let looker = null;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const { best } = findTable();
  if (best) { looker = best; break; }
  for (const f of page.frames()) await f.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
  await sleep(2000);
}
await browser.close();

const byName = new Map();
for (const r of looker || []) {
  const name = String(val(r, 'course_name') || '').trim();
  if (name) byName.set(name.toLowerCase(), {
    domain: val(r, 'course_primary_domain') || null,
    launchDate: val(r, 'course_launch_date_date') || null,
    enrollments: val(r, 'enrollments_count') ?? null,
    completions: val(r, 'completions_count') ?? null,
    completionRate: val(r, 'paid_completition_rate') ?? val(r, 'completition_rate') ?? null,
    rating: val(r, 'avg_star_rating') ?? null,
  });
}
console.log(looker ? `analytics: ${byName.size} launched course(s) with metrics` : 'analytics: the course table did not load — console figures only this run');

// Looker's figures win where it has them (it counts completions and ratings the
// console table does not show); the console supplies every course's status.
const out = courses.map((c) => {
  const m = byName.get(c.name.toLowerCase()) || {};
  return {
    slug: c.slug, name: c.name, status: c.status, dateKind: c.dateKind, date: c.date,
    domain: m.domain ?? null, launchDate: m.launchDate ?? null,
    enrollments: m.enrollments ?? c.enrollments, completions: m.completions ?? null,
    completionRate: m.completionRate ?? c.completionRate, rating: m.rating ?? null,
  };
});

if (!out.length) { console.error('❌ No courses read from the Dummies console. Nothing written.'); process.exit(1); }
const res = writeCourseraDummiesCourses(out);
if (res.guarded) { console.error(`⚠️ Refused to write — ${out.length} courses is far fewer than last time. Kept existing data.`); process.exit(1); }
const tot = out.reduce((a, c) => a + (c.enrollments || 0), 0);
console.log(`✅ ${out.length} Courses for Dummies courses · ${tot.toLocaleString()} enrollments · ${out.filter((c) => c.rating).length} rated → dashboard.db`);
