// RETIRED 2026-11-17 — no longer in the daily update. The dashboard's Coursera figures now
// come from each course's Analytics › Summary page (scrapeCourseraSummary.js); this
// Progress Funnel reading counts only eligible learners who enrolled in the last year.
// Kept for one-off checks; running it no longer changes the dashboard's figures.
//
// Per-course Coursera completion rate, read from each course's OWN analytics page
// (Analytics › Progress Funnel › "Course Level Metrics": Completion Rate
// (Completed/Enrollment)) rather than the partner-wide Looker table that
// scrapeCourseraMetrics.js uses — the two disagree (e.g. Stakeholder Management:
// 57.7% on its own page vs 70.9% "paid completion" partner-side), and the course
// page is the figure the team quotes. Covers every launched course in all three
// catalogues (Starweaver, CIN, Dummies).
//
// One page per course (~10 s each, ~580 courses), so each course is re-read weekly:
// a course read in the last 6 days is skipped, the stalest go first, and the daily
// run reads at most --max of them (update-all passes 90, ~15 min) so the work is
// spread over the week. An interrupted run simply resumes. Results go to
// coursera_course_completion and are applied over the partner-side completion_rate
// in coursera_metrics / coursera_cin_metrics / coursera_dummies_courses (and are
// re-applied whenever those tables are rewritten — see applyCourseLevelCompletion).
//   node scrapeCourseraCompletion.js            every course not read in 6 days
//   node scrapeCourseraCompletion.js --max=90   at most 90 of them, stalest first
//   node scrapeCourseraCompletion.js --force    re-read every course
//   node scrapeCourseraCompletion.js --slugs=a,b --dry   read some, print, don't save
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { db, writeCourseLevelCompletion, applyCourseSummary, logScrapeRun } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FORCE = process.argv.includes('--force'), DRY = process.argv.includes('--dry');
const ONLY = process.argv.find((a) => a.startsWith('--slugs='))?.slice(8).split(',').filter(Boolean);
const MAX = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6)) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();

if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

// A renamed course has a row per title in coursera_course_status (both 'launched'), so the
// rows are merged per catalogue+slug, keeping every title it has had (see readFunnel).
const rows = [
  ...db.prepare("SELECT 'starweaver' AS catalog, slug, course_name AS name FROM coursera_course_status WHERE status = 'launched'").all(),
  ...db.prepare("SELECT 'cin' AS catalog, slug, course_name AS name FROM coursera_cin_metrics WHERE status = 'launched'").all(),
  ...db.prepare("SELECT 'dummies' AS catalog, slug, name FROM coursera_dummies_courses WHERE status = 'live'").all(),
].filter((c) => c.slug);
const merged = new Map();
for (const c of rows) {
  const e = merged.get(`${c.catalog}/${c.slug}`) || { ...c, names: [] };
  if (c.name && !e.names.includes(c.name)) e.names.push(c.name);
  merged.set(`${c.catalog}/${c.slug}`, e);
}
const courses = [...merged.values()].filter((c) => !ONLY || ONLY.includes(c.slug));
// Every course title we know, with its slug — to recognise another course's page. The IBM
// courses are in it because the IBM monthly report opens their funnel pages too.
let ibmNames = [];
try { ibmNames = db.prepare("SELECT DISTINCT slug, name FROM ibm_coursera_monthly WHERE kind = 'course'").all(); } catch {}
const known = [...rows, ...ibmNames].filter((c) => c.name);
const last = new Map(db.prepare("SELECT catalog || '/' || slug AS k, captured_at FROM coursera_course_completion").all().map((r) => [r.k, r.captured_at]));
// Dummies courses are new and their numbers move daily, and there are only ~20, so
// they are re-read on every daily run (older than 20 h) and don't count against --max.
const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString();
const dayAgo = new Date(Date.now() - 20 * 36e5).toISOString();
const stale = courses.filter((c) => FORCE || ONLY || !(last.get(`${c.catalog}/${c.slug}`) > (c.catalog === 'dummies' ? dayAgo : weekAgo)))
  .sort((a, b) => (last.get(`${a.catalog}/${a.slug}`) || '').localeCompare(last.get(`${b.catalog}/${b.slug}`) || ''));
const todo = [...stale.filter((c) => c.catalog === 'dummies'), ...stale.filter((c) => c.catalog !== 'dummies').slice(0, MAX)];
console.log(`${courses.length} launched courses · ${stale.length} due (6 days; Dummies daily) · reading ${todo.length} now`);
if (!todo.length) { applyCourseSummary(); process.exit(0); }

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await parkWindow(ctx, page); // out of sight but rendering — Looker skips tiles it thinks are hidden

const HEAD = 'Completion Rate (Completed/Enrollment)';
const num = (s) => (s == null ? null : Number(String(s).replace(/[,%]/g, '')));
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// Our stored name and the one on the tile can differ slightly (punctuation, a subtitle
// added later), so "same course" = equal, one contains the other, or 80% of the words shared.
function sameCourse(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y || x === y || x.includes(y) || y.includes(x)) return true;
  const wx = new Set(x.split(' ')), wy = new Set(y.split(' '));
  return [...wx].filter((w) => wy.has(w)).length / Math.max(wx.size, wy.size) >= 0.8;
}

// The "Course Level Metrics" tile, as rendered text: its header row, then
// "1", course name, enrollment, first-half completed, completed, rate%.
// TRAP (found 2026-11-17): the first funnel page a browser opens can show the course
// Coursera's Looker embed was last on — another course's numbers — and stay there until
// reloaded. So the course name on the tile must match the course we asked for; if not,
// { wrong: <name shown> } comes back and the caller reloads.
async function readFunnel(c) {   // → { enrolled, firstHalf, completed, rate, shown } | { empty } | { wrong, ... } | null
  for (let t = 0; t < 60; t++) {
    for (const f of page.frames()) {
      if (!/looker/.test(f.url())) continue;
      const text = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
      // (the dashboard's intro text also says "Course Level Metrics", so anchor on the column header)
      const h = text.indexOf(HEAD);
      if (h < 0) continue;
      const lines = text.slice(h + HEAD.length).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
      if (/no results/i.test(lines.slice(0, 3).join(' '))) return { empty: true };
      const pct = lines.findIndex((l) => /^\d+(\.\d+)?%$/.test(l));
      if (pct >= 3) {
        const [enrolled, firstHalf, completed] = lines.slice(pct - 3, pct).map(num);
        const shown = pct >= 4 ? lines[pct - 4] : null;
        const res = { enrolled, firstHalf, completed, rate: num(lines[pct]) / 100, shown };
        return !shown || c.names.some((n) => sameCourse(shown, n)) ? res : { ...res, wrong: shown };
      }
    }
    await sleep(1000);
  }
  return null;
}

// Some CIN courses give this account no Analytics tab at all: the funnel link
// redirects to the course overview. Nothing to read there — note it and move on.
// Others stay on the funnel URL but show only Overview and Course Settings in the
// course menu, with "Loading the dashboard" forever (e.g. openai-chatgpt-enterprise-
// solutions-unleashed-1). No Progress Funnel link in the menu means no access too.
async function noAnalytics() {
  for (let t = 0; t < 12; t++) {
    if (/\/course\/overview/.test(page.url())) return true;
    if (page.frames().some((f) => /looker/.test(f.url()))) return false;
    if (t >= 7) {
      const txt = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/Course Settings/.test(txt) && !/Progress Funnel/.test(txt)) return true;
    }
    await sleep(1000);
  }
  return /\/course\/overview/.test(page.url());
}

let ok = 0, empty = 0, failed = 0, locked = 0;
for (const [k, c] of todo.entries()) {
  await page.goto(`https://www.coursera.org/teach/${c.slug}/course/analytics/course-progress-funnel`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  if (await noAnalytics()) {
    locked++; console.log(`  ${String(k + 1).padStart(3)}/${todo.length} · ${c.catalog} · ${c.slug}: no Analytics tab for this account`);
    if (!DRY) writeCourseLevelCompletion({ catalog: c.catalog, slug: c.slug, name: c.name });   // re-checked weekly like the rest
    continue;
  }
  let r = await readFunnel(c);
  if (!r) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); r = await readFunnel(c); }
  for (let tries = 0; r?.wrong && tries < 2; tries++) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); r = await readFunnel(c); }
  const tag = `${String(k + 1).padStart(3)}/${todo.length} · ${c.catalog} · ${c.slug}`;
  if (!r) { failed++; console.log(`  ${tag}: ❌ page did not show the Course Level Metrics`); continue; }
  if (r.wrong) {
    // Still a title we don't have for this course after reloading. If it is another course's
    // title, the page is stuck on that course: don't save. If it is no course we know, the
    // course was renamed on Coursera (and the reload ruled out the stale first page): keep it.
    const other = known.find((o) => o.slug !== c.slug && sameCourse(r.wrong, o.name));
    if (other) { failed++; console.log(`  ${tag}: ❌ page kept showing another course ("${r.wrong}") — not saved`); continue; }
    console.log(`  ${tag}: (now called "${r.wrong}" on Coursera)`);
  }
  if (r.empty) { empty++; console.log(`  ${tag}: no learners in the funnel yet`); }
  else { ok++; console.log(`  ${tag}: ${(r.rate * 100).toFixed(2)}% (${r.completed}/${r.enrolled})`); }
  if (!DRY) writeCourseLevelCompletion({ catalog: c.catalog, slug: c.slug, ...(r.empty ? {} : r), name: r.shown || c.name });   // the title Coursera shows now
}
await browser.close();

if (!DRY) applyCourseSummary();
// A run fails when many pages fail (a dead session), not when one stubborn page does.
const okRun = failed <= Math.max(3, 0.2 * todo.length);
if (!DRY) logScrapeRun({ job: 'coursera_course_completion', ok: okRun, rows: ok + empty + locked, startedAt, error: okRun ? null : `${failed} course page(s) failed` });
console.log(`${okRun ? '✅' : '❌'} Completion rate from each course's analytics page: ${ok} read · ${empty} with no learners yet · ${locked} without analytics access · ${failed} failed`);
process.exit(okRun ? 0 : 1);
