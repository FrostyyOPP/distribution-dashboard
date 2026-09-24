// Refreshes all dashboard data by running the scrapers in sequence.
// Session-based scrapers open a browser window briefly (needed to pass Cloudflare).
// Resilient: one failing step doesn't stop the rest. Writes last-update.json.
// Run: npm run update
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Datasets that change day to day. Each entry is [label, script file, platform].
// Enrollment is slow (~15 min, public pages) — run it manually/weekly instead.
const STEPS = [
  ['Udemy revenue', 'scrapeRevenue.js', 'udemy'],
  ['Udemy coupons', 'scrapeCoupons.js', 'udemy'],
  ['Udemy captions', 'scrapeCaptions.js', 'udemy'],
  ['Coursera metrics', 'scrapeCourseraMetrics.js', 'coursera'],
  // Looker's course_comparison tile under-reports: on 2026-08-05 it returned
  // 5,453 enrollments for a course whose real total was 36,401, and the same
  // failure recurred in September. Enrollment is monotonic, so a fall is always
  // wrong. These two steps read the admin Courses table — which was verified
  // against the affected courses — and repair coursera_metrics straight after
  // the Looker scrape writes it. Without them the dashboard has run ~20% low.
  ['Coursera enrollment (authoritative)', 'scrapeCourseraEnrollment.js', 'coursera'],
  ['Coursera enrollment fix', 'fixCourseraEnrollment.js', 'coursera'],
  ['Coursera overview', 'scrapeCourseraOverview.js', 'coursera'],
  ['Coursera status + reviews', 'scrapeCourseraStatusReviews.js', 'coursera'],
  // The other three platforms, each skipped on its own if its session is
  // missing. Until 2026-09-24 none of them ran on a schedule at all: Go1 was 72
  // days old, FutureLearn 10 and LinkedIn 9, with nothing on screen saying so.
  // Placed before the CIN metrics step, which is slow and deliberately last.
  ['FutureLearn courses', 'scrapeFutureLearnCourses.js', 'futurelearn'],
  // --force: without it the scraper only visits courses that have no number
  // yet, so a course's enrollment, once read, would never be refreshed.
  ['FutureLearn enrollment', 'scrapeFutureLearnEnrollment.js', 'futurelearn', ['--force']],
  ['LinkedIn courses', 'scrapeLinkedInCourses.js', 'linkedin'],
  ['Go1 courses (latest month)', 'scrapeGo1Courses.js', 'go1'],
  ['Go1 history (every month)', 'scrapeGo1History.js', 'go1'],
  ['Coursera CIN courses', 'scrapeCourseraCinCourses.js', 'coursera'],
  // Slowest step by far (~30-50 min: visits all ~467 CIN course pages
  // individually — this account has no org-wide analytics dashboard access,
  // unlike Starweaver, so there's no fast batch source for its enrollment
  // data). Deliberately last so every faster step still completes even if
  // this one runs long or gets interrupted.
  ['Coursera CIN metrics', 'scrapeCourseraCinMetrics.js', 'coursera'],
];

// Udemy scraping is switched OFF (2026-08-13, at the user's request). The daily
// 7am launchd job still runs, so this is the switch that keeps the three Udemy
// steps from firing; the Coursera steps are unaffected.
// To turn it back on: set this to false, or run with UDEMY_SCRAPING=on.
const UDEMY_DISABLED = process.env.UDEMY_SCRAPING !== 'on';

// Skip session-based steps if the session file is missing (avoids noisy failures).
const needsUdemy = !UDEMY_DISABLED && existsSync(join(__dirname, 'udemy-auth.json'));
const needsCoursera = existsSync(join(__dirname, 'coursera-auth.json'));
// One saved session per platform; a platform without one is skipped, not failed.
const SESSION = { futurelearn: 'futurelearn-auth.json', linkedin: 'linkedin-auth.json', go1: 'go1-auth.json' };
const connected = (platform) => existsSync(join(__dirname, SESSION[platform]));
if (UDEMY_DISABLED) console.log('⏸  Udemy scraping is disabled — skipping all Udemy steps.\n');

// Spawn with the SAME node binary that's running us — works under launchd/cron
// where npm/nvm aren't on PATH.
function run(file, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(__dirname, file), ...args], { cwd: __dirname, stdio: 'inherit' });
    p.on('close', (code) => resolve(code));
    p.on('error', () => resolve(1));
  });
}

console.log(`\n=== Dashboard update · ${new Date().toISOString()} ===`);
const results = [];
for (const [name, file, platform, args] of STEPS) {
  if (platform === 'coursera' && !needsCoursera) { results.push({ name, skipped: 'not connected' }); continue; }
  if (SESSION[platform] && !connected(platform)) { results.push({ name, skipped: 'not connected' }); continue; }
  if (platform === 'udemy' && !needsUdemy) {
    results.push({ name, skipped: UDEMY_DISABLED ? 'udemy scraping disabled' : 'not connected' });
    continue;
  }
  console.log(`\n▶ ${name}…`);
  const t = Date.now();
  const code = await run(file, args);
  results.push({ name, ok: code === 0, secs: Math.round((Date.now() - t) / 1000) });
}

// Ratings and enrollment are REPLACED by the scrapes above, so yesterday's
// values are gone once they run. Snapshot them into coursera_rating_history
// afterwards — that append-only table is the only thing that makes
// month-over-month comparison possible. Upserts per month, so daily is fine.
try {
  const { snapshotCourseraRatings } = await import('./db.js');
  const snap = snapshotCourseraRatings({ catalogs: ['starweaver'] });
  console.log(`\n📸 Starweaver rating snapshot ${snap.month}: ${snap.written} course rows`);
  results.push({ name: 'Coursera rating snapshot', ok: true, secs: 0 });
} catch (e) {
  console.log(`\n⚠️  rating snapshot failed: ${e.message}`);
  results.push({ name: 'Coursera rating snapshot', ok: false, secs: 0 });
}

writeFileSync(join(__dirname, 'last-update.json'), JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));

console.log('\n=== Summary ===');
for (const r of results) {
  if (r.skipped) console.log(`  ⏭  ${r.name} — ${r.skipped}`);
  else console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} (${r.secs}s)`);
}
const failed = results.filter((r) => r.ok === false);
if (failed.length) {
  // Not "your session expired" by default: on 2026-09-24 neither failure was a
  // session — one was a page that never rendered, the other a redirect race.
  // If other steps on the same platform succeeded, the session is fine.
  console.log(`\n⚠️  ${failed.length} step(s) failed. If other steps on the same platform ran, the session is fine and`);
  console.log('   the page itself changed or failed to load — read that step\'s output above. If EVERY step on a');
  console.log('   platform failed, its session has probably expired: reconnect it from the dashboard.');
}
