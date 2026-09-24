// Save this month's rating / enrollment for every Starweaver Coursera course.
//
// Why it exists: coursera_metrics is REPLACED on every scrape, so last month's
// rating is gone the moment the daily job runs. This appends a dated row per
// course into coursera_rating_history, which is what makes month-over-month
// comparison possible at all.
//
// Upserts on (catalog, course_name, month), so running it repeatedly within a
// month just refreshes that month's row — never duplicates.
//
//   node snapshotCourseraRatings.js              this month
//   node snapshotCourseraRatings.js --closing    the month that just ended
//                                                (what the 1st-of-month job uses)
//   node snapshotCourseraRatings.js 2026-08      an explicit month
//   node snapshotCourseraRatings.js --with-cin   include the CIN catalogue too
import { snapshotCourseraRatings } from './db.js';

const args = process.argv.slice(2);
const explicit = args.find((a) => /^\d{4}-\d{2}$/.test(a));
let month = explicit;

// Run on the 1st, the useful label is the month that just CLOSED — the numbers
// captured then are that month's final state, not the new month's.
if (!month && args.includes('--closing')) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  month = d.toISOString().slice(0, 7);
}

const catalogs = args.includes('--with-cin') ? ['starweaver', 'cin'] : ['starweaver'];
const r = snapshotCourseraRatings({ month, catalogs });
console.log(`✅ ${new Date().toISOString()}  snapshot ${r.month} [${catalogs.join(', ')}]: ${r.written} course rows -> coursera_rating_history`);
