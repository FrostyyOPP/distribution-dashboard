// Pulls per-course enrollment, domain, and rating for the Coursera CIN
// partner account:
//  - Enrollment + launch date: from the course's own /teach/{slug}/course/overview
//    page (the "Current Enrollments" figure) — CIN's account doesn't have
//    org-wide Analytics-tab access (unlike Starweaver — confirmed by
//    /admin/coursera/analytics/monitor redirecting to an unrelated learner
//    page), so the fast org-wide Looker-dashboard technique
//    scrapeCourseraMetrics.js uses isn't available here.
//  - Domain + rating: DO exist per-course even without org-wide access, via
//    two lightweight JSON APIs called from within the loaded page (same
//    session, no extra navigation): onDemandCourses.v1 (domainTypes, id) and
//    courseFeedbackCounts.v1 (star-rating counts, keyed by that id).
// Run scrapeCourseraCinCourses.js first so there's a course list to iterate.
// Writes to dashboard.db via db.js's guarded writer. Run: npm run coursera-cin:metrics
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { readCourseraCinCourses, writeCourseraCinMetrics, writeCourseraCinReviews } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

const { courses: courseList } = readCourseraCinCourses();
if (!courseList.length) {
  console.error('❌ No Coursera CIN courses found. Run `npm run coursera-cin:courses` first.');
  process.exit(1);
}

// Coursera's standard top-level domain taxonomy (domainId -> display name),
// matching the naming convention already used for Starweaver's coursera_metrics.
const DOMAIN_NAMES = {
  'business': 'Business',
  'computer-science': 'Computer Science',
  'data-science': 'Data Science',
  'information-technology': 'Information Technology',
  'physical-science-and-engineering': 'Physical Science & Engineering',
  'life-sciences': 'Life Sciences',
  'math-and-logic': 'Math and Logic',
  'personal-development': 'Personal Development',
  'social-sciences': 'Social Sciences',
  'arts-and-humanities': 'Arts and Humanities',
  'language-learning': 'Language Learning',
  'health': 'Health',
};

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

// "December 13, 2024 - present" / "December 13, 2024 - March 1, 2025"
function parseLaunchLine(line) {
  const m = line.match(/^([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*/);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function parseText(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  let enrollments = null, launchDate = null;
  for (let i = 0; i < lines.length; i++) {
    if (!launchDate) { const d = parseLaunchLine(lines[i]); if (d) launchDate = d; }
    if (lines[i] === 'Current Enrollments' && lines[i + 1] && /^[\d,]+$/.test(lines[i + 1])) {
      enrollments = Number(lines[i + 1].replace(/,/g, ''));
    }
  }
  return { enrollments, launchDate };
}

// Poll instead of a fixed sleep — the enrollment count renders async, and a
// fixed wait proved unreliable across hundreds of sequential navigations in
// one long-running browser session (11% hit rate before this fix).
//
// A 0 is not an answer yet. The overview shows "Current Enrollments 0" while the
// real count loads, and taking the first number read stored 0 for courses with
// thousands of learners (Microsoft Excel VBA and Macros: 28,553 → 0 on
// 2026-10-01, alongside ratings that prove it has learners). So a 0 is only
// kept if it is still 0 when the wait runs out — true for unused courses.
async function scrapeEnrollment(slug, timeoutMs = 8000) {
  await page.goto(`https://www.coursera.org/teach/${slug}/course/overview`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const start = Date.now();
  let result = { enrollments: null, launchDate: null };
  while (Date.now() - start < timeoutMs) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const r = parseText(text);
    if (r.enrollments != null || r.launchDate) result = r;
    if (result.enrollments) return result;
    await sleep(500);
  }
  return result;
}

async function fetchDomainRatingStatusReviews(slug) {
  return page.evaluate(async ({ slug, domainNames }) => {
    try {
      const r1 = await fetch(`https://www.coursera.org/api/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=domainTypes,courseStatus,id`, { credentials: 'include', headers: { Accept: 'application/json' } });
      const j1 = await r1.json();
      const el = j1.elements?.[0];
      const domainId = el?.domainTypes?.[0]?.domainId;
      const domain = domainId ? (domainNames[domainId] || domainId) : null;
      const status = el?.courseStatus || null;
      let rating = null, reviews = [];
      if (el?.id) {
        const r2 = await fetch(`https://www.coursera.org/api/courseFeedbackCounts.v1/?q=course&courseId=${el.id}&feedbackSystem=STAR&ratingValues=1,2,3,4,5&countBy=ratingValue`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const j2 = await r2.json();
        const counts = j2.elements?.[0]?.counts || {};
        let sum = 0, n = 0;
        for (const [star, count] of Object.entries(counts)) { sum += Number(star) * count; n += count; }
        rating = n ? sum / n : null;

        const r3 = await fetch(`https://www.coursera.org/api/feedback.v1/?q=course&courseId=${el.id}&feedbackSystem=STAR&ratingValues=1,2,3,4,5&categories=generic&start=0&limit=10`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const j3 = await r3.json();
        reviews = (j3.elements || []).map((e) => {
          const raw = e.comments?.generic?.definition?.value || '';
          const text = raw.replace(/<[^>]+>/g, '').trim();
          return {
            rating: e.rating?.value ?? null,
            reviewText: text || null,
            reviewDate: e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 10) : null,
          };
        }).filter((r) => r.reviewText);
      }
      return { domain, rating, status, reviews };
    } catch {
      return { domain: null, rating: null, status: null, reviews: [] };
    }
  }, { slug, domainNames: DOMAIN_NAMES });
}

// Check the login on ONE page before visiting 325. With an expired session every
// page times out instead, and on 2026-10-13 that took 6.4 hours to fail — holding
// up every step after it in the nightly run.
await page.goto(`https://www.coursera.org/teach/${courseList[0].slug}/course/overview`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await sleep(6000);
const signedIn = await page.evaluate(async () => (await fetch('/api/programMemberships.v2?q=byUser&userId=130949192', { credentials: 'include' })).status !== 403).catch(() => false);
if (!/\/teach\//.test(page.url()) || !signedIn) {
  console.error(`❌ Coursera login has expired (landed on ${page.url().slice(0, 60)}). Reconnect Coursera in the dashboard, then re-run. Nothing written.`);
  await browser.close();
  process.exit(1);
}

console.log(`Visiting ${courseList.length} Coursera CIN course pages…`);
const results = [];
const allReviews = [];
for (let i = 0; i < courseList.length; i++) {
  const c = courseList[i];
  const { enrollments, launchDate } = await scrapeEnrollment(c.slug);
  const { domain, rating, status, reviews } = await fetchDomainRatingStatusReviews(c.slug);
  results.push({
    name: c.name, slug: c.slug, domain, inSpecialization: false, launchDate,
    enrollments, paidEnrollments: null, completions: null, completionRate: null, rating, status,
  });
  for (const rv of reviews) allReviews.push({ slug: c.slug, courseName: c.name, ...rv });
  process.stdout.write(`\r  ${i + 1}/${courseList.length} — ${c.name.slice(0, 40)}`.padEnd(70));
  await sleep(300);
}
process.stdout.write('\n');

// Second pass for every course that came back blank or 0, with a longer wait.
// Over 325 sequential pages a few always load slowly; one retry recovers them
// instead of storing a gap for a month.
const retry = results.filter((r) => !r.enrollments);
if (retry.length) {
  let fixed = 0;
  for (const r of retry) {
    const again = await scrapeEnrollment(r.slug, 20000);
    if (again.enrollments != null && (r.enrollments == null || again.enrollments > r.enrollments)) { r.enrollments = again.enrollments; fixed++; }
    if (!r.launchDate && again.launchDate) r.launchDate = again.launchDate;
    await sleep(300);
  }
  console.log(`  retried ${retry.length} course(s) with no enrollment figure — ${fixed} recovered, ${retry.length - fixed} still blank or 0`);
}
await browser.close();

const withEnroll = results.filter((r) => r.enrollments != null);
const withRating = results.filter((r) => r.rating != null);
const totalEnroll = withEnroll.reduce((s, c) => s + (c.enrollments || 0), 0);

// writeCourseraCinMetrics's guard only blocks on row-count drops — every course
// still gets a row here even when its fields are all null (expired session,
// Cloudflare block, etc.), so row count alone can't catch a bad run. Check
// content coverage ourselves before writing, so a session-expiry doesn't
// silently overwrite good data with nulls (this bit the dashboard for real on
// 2026-07-27 — the write went through with 0/325 enrollment parsed).
if (withEnroll.length < results.length * 0.5) {
  console.error(`⚠️ Refused to write — only ${withEnroll.length}/${results.length} courses had enrollment parsed, looks like a partial/failed run (expired Coursera session?). Kept existing data. Reconnect Coursera and re-run.`);
  process.exit(1);
}

const result = writeCourseraCinMetrics(results);
writeCourseraCinReviews(allReviews);
if (result.guarded) {
  console.error(`⚠️ Refused to write — row count dropped too far vs existing data. Kept existing data. Re-run after reconnecting.`);
  process.exit(1);
}
console.log(`✅ ${withEnroll.length}/${results.length} with enrollment · ${withRating.length}/${results.length} with a rating · ${allReviews.length} reviews · ${totalEnroll.toLocaleString()} total enrollments → dashboard.db`);
