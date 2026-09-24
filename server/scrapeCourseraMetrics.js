// Pulls per-course Coursera metrics (enrollments, completions, completion rate,
// star rating) from the partner analytics Looker dashboard. The dashboard's tile
// queries return their results as JSON via /querymanager/queries — we capture that
// and extract the "course_comparison" table (136 courses). Session + headed browser.
// Writes to dashboard.db via db.js's guarded writer. Run: npm run coursera:metrics
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { writeCourseraMetrics } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

// Split concatenated JSON objects (brace counting, string-aware).
function splitJson(text) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}
const P = 'eds_partner_dashboard_overview_course_comparison.';
const val = (row, key) => { const c = row[P + key]; return c && typeof c === 'object' ? c.value : c; };

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();

await parkWindow(ctx, page); // out of sight, but rendering — Looker skips tiles it thinks are hidden
const bodies = [];
page.on('response', async (res) => {
  if (!/querymanager\/queries/.test(res.url())) return;
  try { const t = await res.text(); if (t.length > 200) bodies.push(t); } catch {}
});

// Find the full per-course table among captured querymanager responses: a
// query whose rows have enrollments + rating + launch date.
function findTable() {
  const captured = bodies.join('\n');
  let best = null;
  for (const chunk of splitJson(captured)) {
    let o; try { o = JSON.parse(chunk); } catch { continue; }
    const rows = o?.data?.data;
    if (!Array.isArray(rows) || !rows.length) continue;
    const cols = Object.keys(rows[0]);
    if (cols.includes(P + 'enrollments_count') && cols.includes(P + 'avg_star_rating') && cols.includes(P + 'course_launch_date_date')) {
      if (!best || rows.length > best.length) best = rows;
    }
  }
  return best;
}

console.log('Opening the partner analytics dashboard…');
// 'networkidle' can hang indefinitely on this page (observed a full 60s
// timeout with no load event at all) — use 'domcontentloaded' and poll for
// the actual data we need instead of a single fixed wait-then-check, which
// proved unreliable (the course-comparison tile is lazy and Looker's own
// render time varies — this is the same class of bug fixed for CIN's
// enrollment scrape, whose fixed sleep had an 11% hit rate before polling).
await page.goto('https://www.coursera.org/admin/starweaver/analytics/monitor', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);

let best = null;
const deadline = Date.now() + 90000;
let scrollRound = 0;
while (Date.now() < deadline) {
  best = findTable();
  if (best) break;
  // Scroll EVERY frame, including the outer Coursera page — not just the
  // Looker iframe. The course-comparison tile is lazy and only renders once
  // the host page has been scrolled down to it; restricting this to frames
  // matching /looker/ left the outer page at the top, so the tile never
  // rendered and the query never fired. The run then failed with "could not
  // find the per-course table" even though the session was perfectly valid.
  for (const f of page.frames()) {
    await f.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
  }
  scrollRound++;
  await sleep(2000);
}
console.log(`(found after ${scrollRound} scroll round(s))`);
await browser.close();

if (!bodies.length) {
  // Do NOT jump to "reconnect". For thirteen nights this said so while the
  // session was fine — the other Coursera steps, on the same session, all ran.
  console.error('❌ No dashboard data captured.');
  console.error('   If the other Coursera steps in this run succeeded, the session is fine and the page');
  console.error('   did not render its tiles (a minimized window does this). Only if every Coursera step');
  console.error('   failed is reconnecting likely to help.');
  process.exit(1);
}
if (!best) {
  // Diagnostic: say WHAT was captured, so a schema change is distinguishable
  // from a page that never rendered the tile.
  const seen = {};
  for (const chunk of splitJson(bodies.join('\n'))) {
    let o; try { o = JSON.parse(chunk); } catch { continue; }
    const rows = o?.data?.data;
    if (!Array.isArray(rows) || !rows.length) continue;
    const pre = [...new Set(Object.keys(rows[0]).map((c) => c.split('.')[0]))].join(',');
    seen[pre] = Math.max(seen[pre] || 0, rows.length);
  }
  console.error('❌ Could not find the per-course table in the dashboard data after 90s of polling.');
  console.error(`   captured ${bodies.length} response body(ies), ${Object.keys(seen).length} row-bearing results:`);
  for (const [k, v] of Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.error(`     ${String(v).padStart(5)}  ${k.slice(0, 100)}`);
  }
  process.exit(1);
}

const courses = best.map((r) => ({
  name: (val(r, 'course_name') || '').trim(),
  domain: val(r, 'course_primary_domain'),
  inSpecialization: val(r, 'is_course_in_specialization') === 'Yes',
  launchDate: val(r, 'course_launch_date_date'),
  enrollments: val(r, 'enrollments_count'),
  paidEnrollments: val(r, 'paid_enrollments_count'),
  completions: val(r, 'completions_count'),
  completionRate: val(r, 'paid_completition_rate') ?? val(r, 'completition_rate'),
  rating: val(r, 'avg_star_rating'),
})).filter((c) => c.name);

const result = writeCourseraMetrics(courses);
const totalEnroll = courses.reduce((s, c) => s + (c.enrollments || 0), 0);
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${courses.length} courses parsed, looks like a partial/failed run. Kept existing data. Re-run after reconnecting.`);
  process.exit(1);
}
console.log(`✅ ${courses.length} courses with metrics · ${totalEnroll.toLocaleString()} total enrollments → dashboard.db`);
