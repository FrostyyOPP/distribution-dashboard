// FutureLearn learners per course, from the ADMIN side (Course Creator › Stats).
// Run: npm run futurelearn:enrollment     [--force] [--max=N] [--slugs=a,b]
//
// Source: every run's Stats dashboard › Course Measures,
//   /admin/courses/<slug>/<run>/stats-dashboard/overview
// which gives Joiners, Leavers, Learners, Active / Returning / Social learners,
// learners with ≥50% and ≥90% step completion, the Run Retention Index, products
// (or upgrades) sold and gross revenue in GBP. Each run is stored in
// futurelearn_run_stats; a course's enrollment on the dashboard = the sum of its
// runs' Joiners (the public "N enrolled on this course" is the same count across
// runs, but lags and isn't the partner's own figure).
//
// Changed 2026-11-18 (user asked for admin-side data wherever it exists). It used
// to read the public course pages. Uses the connected FutureLearn session
// (futurelearn-auth.json) in a headed browser — Cloudflare checks admin pages too.
//
// Caching: a run read in the last 20 h is skipped, and so is a finished run whose
// stats stopped updating (accurate-up-to date > 21 days old) if read in the last
// 30 days. --force reads everything.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { db, readFutureLearnCourses, writeFutureLearnEnrollment, writeFutureLearnRunStats, readFutureLearnRunStats } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'futurelearn-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const BASE = 'https://www.futurelearn.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const FORCE = process.argv.includes('--force');
const MAX = Number(arg('max')) || 0;
const ONLY = arg('slugs')?.split(',').filter(Boolean);

if (!existsSync(AUTH_FILE)) { console.error('❌ FutureLearn not connected.'); process.exit(1); }

const HOUR = 36e5, DAY = 24 * HOUR;
const cached = new Map(readFutureLearnRunStats().map((r) => [`${r.slug}#${r.run}`, r]));
const fresh = (r) => {
  if (!r || FORCE) return false;
  const age = Date.now() - Date.parse(r.captured_at);
  if (age < 20 * HOUR) return true;
  const frozen = r.accurate_to && Date.now() - Date.parse(r.accurate_to) > 21 * DAY;
  return frozen && age < 30 * DAY;
};

let courses = readFutureLearnCourses().courses.map((c) => c.slug);
if (ONLY) courses = courses.filter((s) => ONLY.includes(s));
const hasStats = new Set([...cached.values()].map((r) => r.slug));
courses.sort((a, b) => hasStats.has(a) - hasStats.has(b));     // never-read courses first
if (MAX) courses = courses.slice(0, MAX);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

let challenged = 0;
async function open(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 14; i++) {
      await sleep(2000);
      const t = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/sign in|log in/i.test(page.url())) throw new Error('signed out — reconnect FutureLearn');
      if (t && !/security verification|Just a moment/i.test(t)) { challenged = 0; return t; }
    }
    if (++challenged >= 4) { console.log('  ⏸ Cloudflare keeps checking — cooling down 90 s'); await sleep(90000); challenged = 0; }
  }
  return null;
}

const num = (t, label) => { const m = t.match(new RegExp(label + '\\s+£?([\\d,.]+)')); return m ? Number(m[1].replace(/,/g, '')) : null; };
function parseStats(t) {
  if (!/Joiners\s+\d/.test(t)) return null;                   // run not started / no stats yet
  const acc = t.match(/Accurate up to midnight on (\d{1,2} \w+ \d{4})/);
  const label = t.match(/ - (\d{1,2} \w{3} \d{4})\s*Stats dashboard/);
  const revenue = [...t.matchAll(/Gross [^\n£]*revenue in GBP\s+£([\d,.]+)/g)].reduce((s, m) => s + Number(m[1].replace(/,/g, '')), 0);
  return {
    run_label: label?.[1] ?? null,
    accurate_to: acc ? new Date(acc[1] + ' UTC').toISOString().slice(0, 10) : null,
    joiners: num(t, 'Joiners'), leavers: num(t, 'Leavers'), learners: num(t, '\\nLearners'),
    active_learners: num(t, 'Active Learners'), returning_learners: num(t, 'Returning Learners'),
    social_learners: num(t, 'Social Learners'),
    completed_50: num(t, 'Learners with ≥50% step completion'), completed_90: num(t, 'Learners with ≥90% step completion'),
    retention_index: num(t, 'Run Retention Index'),
    sold: num(t, 'Products Sold') ?? num(t, 'Upgrades Sold'), revenue_gbp: revenue,
    unlimited_learners: num(t, 'Unlimited Learners'),
  };
}

let read = 0, skipped = 0, noStats = 0, failedCourses = 0;
const generating = [];   // FutureLearn builds a finished run's stats on first request ("Generating stats") — come back later
async function readRun(slug, run) {
  const s = await open(`/admin/courses/${slug}/${run}/stats-dashboard/overview`);
  if (s == null) return '❌ did not load';
  const st = parseStats(s);
  if (!st) {
    if (/Generating stats/i.test(s)) { generating.push([slug, run]); return 'stats being generated'; }
    noStats++; return 'no stats yet';
  }
  writeFutureLearnRunStats({ slug, run, ...st });
  read++;
  await sleep(1500 + Math.random() * 1500);
  return `${st.joiners} joiners, ${st.completed_90 ?? 0} ≥90%`;
}
try {
  for (const [i, slug] of courses.entries()) {
    const t = await open(`/admin/courses/${slug}`);
    const runs = t ? await page.evaluate((slug) => [...new Set([...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href').match(new RegExp(`^/admin/courses/${slug}/(\\d+)$`))?.[1]).filter(Boolean))].map(Number), slug) : [];
    if (!runs.length) { failedCourses++; console.log(`  ${i + 1}/${courses.length} · ${slug}: ❌ course page did not load its runs — kept as it was`); continue; }
    const parts = [];
    for (const run of runs.sort((a, b) => a - b)) {
      const key = `${slug}#${run}`;
      if (fresh(cached.get(key))) { skipped++; parts.push(`run ${run}: ${cached.get(key).joiners ?? '—'} (cached)`); continue; }
      parts.push(`run ${run}: ${await readRun(slug, run)}`);
    }
    console.log(`  ${i + 1}/${courses.length} · ${slug}: ${parts.join(' · ')}`);
  }
  for (let round = 1; generating.length && round <= 4; round++) {
    const again = generating.splice(0);
    console.log(`  ⏳ ${again.length} run(s) had their stats being generated — trying again in 60 s (round ${round}/4)`);
    await sleep(60000);
    for (const [slug, run] of again) console.log(`  ${slug} run ${run}: ${await readRun(slug, run)}`);
  }
  if (generating.length) console.log(`  ⚠️ ${generating.length} run(s) still generating — the next run picks them up`);
} catch (e) {
  console.error('❌', e.message);
} finally {
  await browser.close();
}

// Course enrollment = sum of its runs' Joiners (only for courses with at least one run read).
const perSlug = Object.fromEntries(db.prepare(
  'SELECT slug, SUM(joiners) AS n FROM futurelearn_run_stats WHERE joiners IS NOT NULL GROUP BY slug').all().map((r) => [r.slug, r.n]));
if (Object.keys(perSlug).length) writeFutureLearnEnrollment(perSlug);
const total = Object.values(perSlug).reduce((s, n) => s + n, 0);
console.log(`✅ FutureLearn admin stats: ${read} runs read · ${skipped} cached · ${noStats} without stats yet · ${failedCourses} courses failed · ` +
  `${Object.keys(perSlug).length} courses, ${total.toLocaleString()} joiners in all`);
if (failedCourses > courses.length / 2) process.exit(1);
