// Per-course Coursera figures from each course's OWN analytics page, Analytics › Summary
// (https://www.coursera.org/teach/<slug>/course/analytics/summary — Looker dashboard 447,
// "Course Summary", all time, live course version). This is the source for every Coursera
// course on the dashboard (Starweaver, CIN, Dummies) and for the IBM monthly report, at the
// user's request (2026-11-17: "not from the learner side … from the link I shared, for
// each course"). From the page it keeps:
//   Unique Visitors, Enrolled in Course, Started Course, Completed Course,
//   completion rate = Completed ÷ Enrolled, star ratings (count, sum → average),
//   written reviews, enrollments by category (paid / Coursera Plus / enterprise / …),
//   and the "Top Line Metrics Trends Over Time" table (the same four figures by month).
// The page's tile queries come back as NDJSON from /querymanager/queries; that is read,
// not the drawn page.
//
// TRAP: the course is chosen when the page logs in to Coursera's Looker, and the first
// analytics page of a session can show the course Looker was last on. The Summary data
// does not name its course, so each reading is checked against the course's own item list
// (onDemandCourseMaterials.v2): the module names the page shows must be the course's
// modules (or, before any learner finishes an item, its item names). A page showing another course is reloaded
// (twice at most) and otherwise not saved. A warm-up page is opened first, too.
//
// Writes coursera_course_summary (one row per slug) and coursera_course_summary_monthly,
// then lays the figures over the three Coursera tables (applyCourseSummary in db.js).
//   node scrapeCourseraSummary.js               every course not read in the last 20 h
//   node scrapeCourseraSummary.js --max=200     at most 200 of them, stalest first
//   node scrapeCourseraSummary.js --force       every course
//   node scrapeCourseraSummary.js --slugs=a,b [--dry]   some courses; --dry prints, saves nothing
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { db, writeCourseSummary, applyCourseSummary, logScrapeRun } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FORCE = process.argv.includes('--force'), DRY = process.argv.includes('--dry');
const ONLY = process.argv.find((a) => a.startsWith('--slugs='))?.slice(8).split(',').filter(Boolean);
const DUMP = process.argv.find((a) => a.startsWith('--dump='))?.slice(7); const dumped = {};   // debugging: raw tiles per course
const MAX = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6)) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

// Every course we report on, once per slug (a renamed Starweaver course has a row per title;
// three IBM courses are also in the Starweaver list). IBM = the courses on the IBM list.
const rows = [
  ...db.prepare("SELECT 'starweaver' AS catalog, slug, course_name AS name FROM coursera_course_status WHERE status = 'launched'").all(),
  ...db.prepare("SELECT 'cin' AS catalog, slug, course_name AS name FROM coursera_cin_metrics WHERE status = 'launched'").all(),
  ...db.prepare("SELECT 'dummies' AS catalog, slug, name FROM coursera_dummies_courses WHERE status = 'live'").all(),
];
try {
  rows.push(...db.prepare(`SELECT 'ibm' AS catalog, slug, name FROM ibm_coursera_monthly
    WHERE kind = 'course' AND in_list = 1 AND month = (SELECT MAX(month) FROM ibm_coursera_monthly)`).all());
} catch { /* no IBM table on this machine */ }
const bySlug = new Map();
for (const r of rows.filter((r) => r.slug)) {
  const e = bySlug.get(r.slug) || { slug: r.slug, name: r.name, catalogs: [] };
  if (!e.catalogs.includes(r.catalog)) e.catalogs.push(r.catalog);
  bySlug.set(r.slug, e);
}
const courses = [...bySlug.values()].filter((c) => !ONLY || ONLY.includes(c.slug));
const last = new Map(db.prepare('SELECT slug, captured_at FROM coursera_course_summary').all().map((r) => [r.slug, r.captured_at]));
const since = new Date(Date.now() - 20 * 36e5).toISOString();
// IBM courses first (15 of them, ~6 min), so the dashboard's IBM tab is fresh early in the
// morning even though the whole step takes hours; then the stalest of the rest.
const isIbm = (c) => (c.catalogs.includes('ibm') ? 0 : 1);
const todo = courses.filter((c) => FORCE || ONLY || !(last.get(c.slug) > since))
  .sort((a, b) => isIbm(a) - isIbm(b) || (last.get(a.slug) || '').localeCompare(last.get(b.slug) || '')).slice(0, MAX);
console.log(`${courses.length} courses · reading ${todo.length} now`);
if (!todo.length) { if (!DRY) applyCourseSummary(); process.exit(0); }

// ---- the page's tiles, by their field names ----
const F = 'eds_course_dashboard_overview.';
const v = (cell) => {                          // {value} or, pivoted, {Total: {value}}
  if (cell == null || typeof cell !== 'object') return cell ?? null;
  if ('value' in cell) return cell.value;
  const first = Object.values(cell)[0];
  return first && typeof first === 'object' ? first.value ?? null : null;
};
function parse(text, sink) {
  for (const line of text.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const d = o?.data; if (!d?.fields) continue;
    const names = ['dimensions', 'measures', 'table_calculations'].flatMap((k) => (d.fields[k] || []).map((x) => x.name));
    if (!names.length) continue;
    sink[names.join('|')] = d.data || [];
    // every module / item name any tile shows — for the which-course check (several tiles
    // share one field list, e.g. Top 10 / Bottom 10 / All items, so they are pooled here)
    for (const r of d.data || []) for (const n of names) {
      if (/\.module_name$/.test(n) && v(r[n])) (sink.__modules ||= new Set()).add(v(r[n]));
      if (/\.item_name$/.test(n) && v(r[n])) (sink.__items ||= new Set()).add(v(r[n]));
    }
  }
}
// A tile by its exact field list's start: several tiles share fields (the monthly table
// also has enrollments/starters/completions), so "contains these fields" picks wrong ones.
const tile = (q, start) => { const k = Object.keys(q).find((k) => k === start || k.startsWith(start + '|')); return k ? q[k] : undefined; };
const one = (q, start) => { const t = tile(q, start); return t ? t[0] || {} : undefined; };

function read(q) {
  const tot = one(q, `${F}enrollments_count|${F}completions_count|${F}branches_count|${F}visitors_count`);   // Enrolled + Completed tiles
  const st = one(q, `${F}starters_count`);                                                                     // Started Course
  const rev = one(q, `${F}star_ratings_count|${F}course_reviews_count`);                                      // Ratings / Reviews
  const monthly = tile(q, `${F}cal_dt_month|${F}enrollments_count|${F}visitors_count|${F}starters_count|${F}completions_count`);   // Top Line Metrics Trends
  if (!tot || !st || !rev || !monthly) return null;                  // not all there yet
  const rs = one(q, `${F}star_ratings_sum|${F}star_ratings_count`) || {};
  const cat = one(q, `${F}enrollments_count|${F}enterprise_enrollments_count`) || {};                          // Category Enrollments (all time)
  const n = (x) => (x == null ? 0 : Number(x));
  const enrollments = n(v(tot[F + 'enrollments_count'])), completions = n(v(tot[F + 'completions_count']));
  const ratings = n(v(rev[F + 'star_ratings_count'])), ratingSum = v(rs[F + 'star_ratings_sum']);
  return {
    visitors: n(v(tot[F + 'visitors_count'])), enrollments, starters: n(v(st[F + 'starters_count'])), completions,
    completionRate: enrollments ? completions / enrollments : null,
    ratings, ratingSum: ratingSum == null ? null : Number(ratingSum), rating: ratings && ratingSum != null ? Number(ratingSum) / ratings : null,
    reviews: n(v(rev[F + 'course_reviews_count'])),
    categories: Object.fromEntries(Object.entries(cat).filter(([k]) => k.startsWith(F) && k !== F + 'enrollments_count').map(([k, x]) => [k.slice(F.length).replace(/_count$/, ''), n(v(x))])),
    monthly: monthly.map((r) => ({ month: String(v(r[F + 'cal_dt_month']) || '').slice(0, 7), visitors: n(v(r[F + 'visitors_count'])),
      enrollments: n(v(r[F + 'enrollments_count'])), starters: n(v(r[F + 'starters_count'])), completions: n(v(r[F + 'completions_count'])) }))
      .filter((m) => /^\d{4}-\d{2}$/.test(m.month)).sort((a, b) => a.month.localeCompare(b.month)),
    modules: [...(q.__modules || [])], items: [...(q.__items || [])],
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function outline(page, slug) {             // the course's own module + item names, from inside the page
  return page.evaluate(async (slug) => {
    try {
      const r = await fetch(`/api/onDemandCourseMaterials.v2/?q=slug&slug=${encodeURIComponent(slug)}&includes=modules,items&fields=onDemandCourseMaterialModules.v1(name),onDemandCourseMaterialItems.v2(name)`);
      const L = (await r.json()).linked || {};
      return { modules: (L['onDemandCourseMaterialModules.v1'] || []).map((x) => x.name), items: (L['onDemandCourseMaterialItems.v2'] || []).map((x) => x.name) };
    } catch { return null; }
  }, slug).catch(() => null);
}
// The page is this course if most of the module names it shows are the course's modules
// (module names were the same on both sides in every course checked); with no module names
// on the page (no completions yet), its item names are compared instead.
function sameCourse(res, own) {
  const share = (shown, mine) => { const m = new Set(mine.map(norm)); return shown.filter((n) => m.has(norm(n))).length; };
  let modules = null;
  if (res.modules.length && own.modules.length) {
    const hit = share(res.modules, own.modules);
    modules = [hit * 2 >= res.modules.length, `${hit}/${res.modules.length} modules match`];
    if (modules[0]) return modules;
    // a restructured course: all-time analytics still lists its old module names, so let the item names decide
  }
  if (res.items.length && own.items.length) {
    const hit = share(res.items, own.items);
    return [hit * 2 >= res.items.length, `${hit}/${res.items.length} items match${modules ? ` (modules ${modules[1].split(' ')[0]})` : ''}`];
  }
  if (modules) return modules;
  return [true, 'not checked (no names on the page yet)'];
}

// A page given up on (stalled / retried) can still reject a pending Playwright call after it is
// closed. That must not crash a run whose readings are already saved — log it and carry on.
process.on('unhandledRejection', (e) => console.error(`      · (late error from a closed page ignored: ${String(e?.message || e).split('\n')[0].slice(0, 120)})`));
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 9000 } });   // tall: Looker only queries tiles on screen, so every tile is "on screen" at once — no scrolling (≈3× faster)
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const warm = await ctx.newPage();
await parkWindow(ctx, warm);   // out of sight but rendering — Looker skips tiles it thinks are hidden
await warm.goto(`https://www.coursera.org/teach/${todo[0].slug}/course/analytics/summary`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(15000);

async function visit(c) {
  const q = {}, pending = [];
  let cutoff = 0, cleared = false;               // replies to queries sent before the version filter was cleared are ignored
  const page = await ctx.newPage();              // a page per course: a late reply can't land on the next one
  page.on('response', (r) => {
    if (!/querymanager\/queries/.test(r.url()) || r.request().timing().startTime < cutoff) return;
    pending.push(r.text().then((t) => parse(t, q)).catch(() => {}));
  });
  await page.goto(`https://www.coursera.org/teach/${c.slug}/course/analytics/summary`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  let res = null, state = 'timeout';
  const tA = Date.now();
  for (let t = 0; t < 90; t++) {
    await sleep(1000); await Promise.race([Promise.all(pending), sleep(5000)]);   // a reply whose body never finishes must not hang the run
    if (/\/course\/overview/.test(page.url())) { state = 'no access'; break; }
    if (t >= 10 && !page.frames().some((f) => /looker/.test(f.url()))) {
      const txt = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/Course Settings/.test(txt) && !/\bSummary\b/.test(txt)) { state = 'no access'; break; }
    }
    // ALL COURSE VERSIONS. Coursera opens the Summary filtered to "Course Version contains Live", which
    // drops every learner of a course's earlier versions (Personal Productivity: 6,326 enrolled live vs
    // 37,275 in all). The page itself says to clear that filter for all versions, so the Looker frame
    // is reloaded with it cleared and only the replies after that are kept.
    if (!cleared) {
      const f = page.frames().find((x) => /looker.*\/dashboards\/447/.test(x.url()));
      // the frame opens at ?Course+Slug=… and only then redirects to ?Date=&Course+Version=%25Live%25
      if (f && /Course\+Version=(&|$)/.test(f.url())) cleared = true;          // already all versions
      else if (!f || !/Course\+Version=/.test(f.url())) { if (t >= 20) cleared = true; }   // no filter showed up at all
      else {
        cutoff = Date.now(); cleared = true; t = 0;
        for (const k of Object.keys(q)) delete q[k];
        await f.goto(f.url().replace(/Course\+Version=[^&]*/, 'Course+Version='), { timeout: 30000 }).catch(() => {});
        continue;
      }
    }
    if (t % 8 === 7) { await page.mouse.move(700, 600).catch(() => {}); await page.mouse.wheel(0, 2000).catch(() => {}); }   // in case a tile still waits
    res = cleared ? read(q) : null;
    if (res && (res.modules.length || res.items.length || !res.completions || t >= 25)) { state = 'ok'; break; }   // the name tiles can lag
    const tiles = Object.keys(q).filter((k) => !k.startsWith('__')).length;
    // The first page opened for a course switches Looker over to it and then stalls after one tile;
    // a second page then loads every tile in ~4 s. So give up on a stalled page early and open a fresh one.
    if (!res && (t >= 25 || (t >= 3 && tiles === 1) || (cleared && cutoff && t >= 6 && tiles < 10))) break;   // (t restarts at 0 once the filter is cleared)
  }
  console.error(`      · attempt: ${state} after ${Math.round((Date.now() - tA) / 1000)}s, ${Object.keys(q).filter((k) => !k.startsWith('__')).length} tiles`);
  if (state === 'ok') {
    const own = await outline(page, c.slug);
    if (own) { const [same, how] = sameCourse(res, own); res.checked = how; if (!same) state = 'another course'; }
    else res.checked = 'not checked (no course outline)';
  }
  if (DUMP) { dumped[c.slug] = { state, q, own: await outline(page, c.slug) }; writeFileSync(DUMP, JSON.stringify(dumped, (k, x) => (x instanceof Set ? [...x] : x))); }
  await page.close();
  return { state, res };
}

let ok = 0, locked = 0, failed = 0;
for (const [k, c] of todo.entries()) {
  const tag = `${String(k + 1).padStart(3)}/${todo.length} · ${c.catalogs.join('+')} · ${c.slug}`;
  const t0 = Date.now();
  let r = await visit(c);
  for (let tries = 0; (r.state === 'another course' || r.state === 'timeout') && tries < 3; tries++) r = await visit(c);
  if (r.state === 'no access') { locked++; console.log(`  ${tag}: no Analytics access for this account`); continue; }
  if (r.state !== 'ok') { failed++; console.log(`  ${tag}: ❌ ${r.state === 'another course' ? 'page kept showing another course' : 'page did not load its figures'} — not saved`); continue; }
  const x = r.res; ok++;
  console.log(`  ${tag}: enrolled ${x.enrollments} · started ${x.starters} · completed ${x.completions} (${x.completionRate == null ? '—' : (x.completionRate * 100).toFixed(1) + '%'}) · ${x.ratings} ratings${x.rating ? ' ' + x.rating.toFixed(2) + '★' : ''} · ${x.reviews} reviews · ${x.checked} · ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!DRY) writeCourseSummary({ slug: c.slug, name: c.name, catalogs: c.catalogs, ...x });
}
await browser.close();
if (!DRY) applyCourseSummary();
const okRun = failed <= Math.max(3, 0.2 * todo.length);
if (!DRY) logScrapeRun({ job: 'coursera_course_summary', ok: okRun, rows: ok + locked, startedAt, error: okRun ? null : `${failed} course page(s) failed` });
console.log(`${okRun ? '✅' : '❌'} Course Summary pages: ${ok} read · ${locked} without analytics access · ${failed} failed`);
process.exit(okRun ? 0 : 1);
