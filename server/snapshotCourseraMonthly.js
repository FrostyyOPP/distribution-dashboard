// MONTHLY COURSERA SNAPSHOT — run on the 4th of every month by launchd
// (com.starweaver.dashboard-monthly-snapshot). Saves, for the month that just
// closed:
//
//   1. coursera_rating_history — rating, enrollments, paid enrollments,
//      completions and completion rate per course, for Starweaver, CIN and
//      Courses for Dummies. This month's rows REPLACE that month's daily rows.
//   2. coursera_monthly_archive — a complete gzipped copy of every coursera_*
//      table, dated by the day it was taken and never overwritten.
//
// The 4th, not the 1st: the first snapshot was taken on 2026-09-04, and it is
// the day each month's figures are recorded from.
//
//   node snapshotCourseraMonthly.js              the month that just closed
//   node snapshotCourseraMonthly.js 2026-09      label it as an explicit month
//   node snapshotCourseraMonthly.js --no-wait    do not wait for the nightly job
import { execFileSync } from 'node:child_process';
import { snapshotCourseraRatings, archiveCourseraTables } from './db.js';

const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const month = args.find((a) => /^\d{4}-\d{2}$/.test(a)) || local(prev).slice(0, 7);
const today = local(now);

// The nightly update replaces these tables while it runs. Copying them mid-run
// would archive a half-updated month, so wait for it (up to 4 hours).
const updateRunning = () => { try { return execFileSync('pgrep', ['-f', 'update-all.js']).toString().trim().length > 0; } catch { return false; } };
if (!args.includes('--no-wait')) {
  const until = Date.now() + 4 * 3600e3;
  if (updateRunning()) console.log(`${new Date().toISOString()}  nightly update still running — waiting for it to finish`);
  while (updateRunning() && Date.now() < until) await sleep(60e3);
  if (updateRunning()) console.log('  still running after 4 hours — snapshotting anyway');
}

const r = snapshotCourseraRatings({ month, catalogs: ['starweaver', 'cin', 'dummies'], replaceMonth: true });
const a = archiveCourseraTables({ month, date: today });
const empty = a.tables.filter((t) => !t.rows).map((t) => t.table);
const kb = (a.tables.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0);
console.log(`✅ ${new Date().toISOString()}  ${month} closed on ${today}: ${r.written} course rows -> coursera_rating_history · ${a.tables.length} tables (${a.tables.reduce((s, t) => s + t.rows, 0)} rows, ${kb} KB) -> coursera_monthly_archive`);
for (const t of a.tables) console.log(`     ${t.table.padEnd(34)} ${String(t.rows).padStart(6)} rows · data as of ${t.newest || '—'}`);
if (empty.length) console.log(`  ⚠️  empty when copied: ${empty.join(', ')}`);
// The tables every month needs. If one of these is empty the scrape failed,
// and the run should show as failed in the log rather than quietly succeed.
const core = ['coursera_metrics', 'coursera_cin_metrics'];
process.exit(core.some((t) => empty.includes(t)) ? 1 : 0);
