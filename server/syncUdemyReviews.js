// UDEMY RATINGS HISTORY. Pulls every review of every course from the instructor
// API (stars + date) into udemy_reviews, and records today's rating, review
// count, students and UFB status per course into udemy_course_daily.
//
// Why: Udemy ratings were only ever read live, so a course's rating last month
// was lost and a falling rating could not be spotted. The reviews rebuild the
// trend back to the first review; the daily rows keep Udemy's own displayed
// (weighted) rating from today on. Both tables are append-only.
//
// Uses the API key in .env, not a browser login — an expired Udemy session does
// not stop it. A full pull is ~60,000 reviews in about three minutes.
//   node syncUdemyReviews.js
import { udemyGet } from './udemyClient.js';
import { writeUdemyReviews, snapshotUdemyCourses, logScrapeRun, db } from './db.js';

const startedAt = new Date().toISOString();
// The day in IST, so a run just after midnight UTC is filed under the right date.
const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, query) {
  for (let attempt = 1; ; attempt++) {
    try { return await udemyGet(path, query); }
    catch (e) {
      if (attempt >= 5 || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await sleep(5000 * attempt);
    }
  }
}

async function allPages(path, query) {
  const out = [];
  for (let page = 1; ; page++) {
    const d = await get(path, { ...query, page, page_size: 100 });
    out.push(...(d.results || []));
    if (!d.next) return out;
  }
}

try {
  const courses = await allPages('/taught-courses/courses/', {
    'fields[course]': 'title,url,is_published,rating,num_reviews,published_time',
  });
  if (!courses.length) throw new Error('the API returned no courses — nothing written');

  // Four courses at a time: fast, and well inside the API's rate limit.
  const reviews = [];
  const queue = courses.filter((c) => c.num_reviews > 0);
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let c; (c = queue.shift()); ) {
      const rows = await allPages('/taught-courses/reviews/', { course: c.id });
      for (const r of rows) {
        reviews.push({ id: r.id, courseId: c.id, rating: r.rating, content: r.content, created: r.created, userModified: r.user_modified });
      }
      if (++done % 25 === 0) process.stdout.write(`  ${done} courses · ${reviews.length} reviews\n`);
    }
  }));

  // Guard: a pull that comes back far short of what Udemy says exists is not
  // trusted (same rule as guardedReplaceAll). Nothing is deleted either way.
  const expected = courses.reduce((n, c) => n + (c.num_reviews || 0), 0);
  if (reviews.length < expected * 0.9) {
    throw new Error(`only ${reviews.length} of ${expected} reviews came back — not saved`);
  }

  const w = writeUdemyReviews(reviews);
  const snap = snapshotUdemyCourses(courses, today);
  const total = db.prepare('SELECT COUNT(*) AS n FROM udemy_reviews').get().n;
  const days = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM udemy_course_daily').get().n;
  logScrapeRun({ job: 'udemy-reviews', ok: true, rows: reviews.length, startedAt });
  console.log(`✅ ${reviews.length.toLocaleString()} reviews across ${courses.length} courses (${w.added} new) · ${total.toLocaleString()} stored`);
  console.log(`✅ Ratings snapshot for ${snap.date}: ${snap.written} courses · ${days} day(s) of history → dashboard.db`);
} catch (e) {
  logScrapeRun({ job: 'udemy-reviews', ok: false, error: e.message, startedAt });
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
