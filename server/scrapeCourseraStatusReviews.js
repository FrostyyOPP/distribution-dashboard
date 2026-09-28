// Adds two things scrapeCourseraMetrics.js's Looker-dashboard technique can't
// provide for Starweaver: course status (Launched/Draft) and real learner
// review text. Both exist per-course via lightweight JSON APIs, but need a
// slug — which coursera_metrics doesn't have (it's keyed by course_name from
// the Looker table). So this script first pages through the admin Courses
// table directly (same reliable technique as scrapeCourseraCinCourses.js) to
// get every course's slug, then for each one calls:
//   - onDemandCourses.v1 (courseStatus, id)
//   - feedback.v1 (a page of real review text + per-review star rating)
// Writes slug+status to coursera_course_status (merge, never wipes) and
// reviews to coursera_reviews (guarded snapshot). Session + headed browser.
// Run: npm run coursera:status-reviews
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { writeCourseraCourseStatus, writeCourseraReviews } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

console.log('Opening the Starweaver partner console…');
await page.goto('https://www.coursera.org/admin/starweaver/home/courses', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

async function extractRows() {
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href^="/teach/"][href$="/course"]'))
    .map((a) => ({ name: a.textContent.trim(), slug: a.getAttribute('href').split('/')[2] }))
    .filter((r) => r.name && r.slug));
}
async function waitForRows(prevFirstSlug, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await extractRows();
    if (rows.length && rows[0].slug !== prevFirstSlug) return rows;
    await sleep(400);
  }
  return extractRows();
}

const seen = new Map();
let pageNum = 1;
let prevFirstSlug = null;
for (; pageNum <= 100; pageNum++) {
  const rows = await waitForRows(prevFirstSlug);
  if (!rows.length) break;
  for (const r of rows) seen.set(r.slug, r);
  prevFirstSlug = rows[0].slug;
  process.stdout.write(`\rPage ${pageNum} — ${seen.size} unique courses so far`.padEnd(50));
  const nextClicked = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Go to next page"], a[aria-label="Go to next page"]');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return true; }
    return false;
  });
  if (!nextClicked) break;
}
process.stdout.write('\n');
const courseList = [...seen.values()];
console.log(`Found ${courseList.length} Starweaver courses. Fetching status + reviews…`);

async function fetchStatusAndReviews(slug) {
  return page.evaluate(async (slug) => {
    try {
      const r1 = await fetch(`https://www.coursera.org/api/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=courseStatus,id`, { credentials: 'include', headers: { Accept: 'application/json' } });
      const j1 = await r1.json();
      const el = j1.elements?.[0];
      const status = el?.courseStatus || null;
      let reviews = [];
      if (el?.id) {
        const r2 = await fetch(`https://www.coursera.org/api/feedback.v1/?q=course&courseId=${el.id}&feedbackSystem=STAR&ratingValues=1,2,3,4,5&categories=generic&start=0&limit=10`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const j2 = await r2.json();
        reviews = (j2.elements || []).map((e) => {
          const raw = e.comments?.generic?.definition?.value || '';
          const text = raw.replace(/<[^>]+>/g, '').trim(); // strip CML/HTML tags (e.g. <co-content><text>...)
          return {
            rating: e.rating?.value ?? null,
            reviewText: text || null,
            reviewerName: null, // Coursera returns an opaque userId here, not a display name
            reviewDate: e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 10) : null,
          };
        }).filter((r) => r.reviewText); // skip star-only "reviews" with no written comment
      }
      return { status, reviews };
    } catch {
      return { status: null, reviews: [] };
    }
  }, slug);
}

const statusRows = [];
const allReviews = [];
for (let i = 0; i < courseList.length; i++) {
  const c = courseList[i];
  // A cheap navigation keeps us same-origin for the fetch() calls without a
  // full per-course page load (unlike CIN's enrollment scrape, nothing here
  // needs the rendered page itself, just the API responses).
  if (i === 0) await page.goto(`https://www.coursera.org/teach/${c.slug}/course/overview`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const { status, reviews } = await fetchStatusAndReviews(c.slug);
  statusRows.push({ courseName: c.name, slug: c.slug, status });
  for (const rv of reviews) allReviews.push({ slug: c.slug, courseName: c.name, ...rv });
  process.stdout.write(`\r  ${i + 1}/${courseList.length} — ${c.name.slice(0, 40)}`.padEnd(70));
  await sleep(250);
}
process.stdout.write('\n');
await browser.close();

// NO COURSES FOUND IS A FAILURE. On 2026-09-28 the course list came back
// empty and this ended "✅ 0/0 with status · 0 reviews", exit 0 — the nightly
// job counted it a success. Nothing was lost (the writers are guarded), but a
// run that read nothing must say so, so the retry and the sidebar can see it.
if (!statusRows.length) {
  console.error('❌ No Coursera courses were found to check. Nothing written.');
  process.exit(1);
}
writeCourseraCourseStatus(statusRows);
const reviewResult = writeCourseraReviews(allReviews);
const withStatus = statusRows.filter((r) => r.status).length;
console.log(`✅ ${withStatus}/${statusRows.length} with status · ${allReviews.length} reviews across ${new Set(allReviews.map((r) => r.slug)).size} courses → dashboard.db`);
if (reviewResult.guarded) console.log('   (reviews table write was guarded — check scrape_runs if this is unexpected)');
