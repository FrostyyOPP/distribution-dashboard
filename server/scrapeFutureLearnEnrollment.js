// Scrapes public FutureLearn course pages for the "N enrolled on this course"
// text (not exposed anywhere in the admin panel). No session needed — same
// public-page pattern as Udemy's scrapeEnrollment.js. Merge-only write (never
// deletes existing enrollment numbers). Run: npm run futurelearn:enrollment
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { readFutureLearnCourses, writeFutureLearnEnrollment } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX = Number(process.env.MAX) || 0;
const { courses } = readFutureLearnCourses();
const alreadyHave = courses.length - courses.filter((c) => FORCE || c.enrollment == null).length;
let todo = courses.filter((c) => FORCE || c.enrollment == null);
if (MAX > 0) todo = todo.slice(0, MAX);
console.log(`${courses.length} courses; ${alreadyHave} already have enrollment, ${todo.length} to scrape now.`);

const browser = await chromium.launch({ headless: true });
const perSlug = {};
let found = 0, blocked = 0;

for (let i = 0; i < todo.length; i++) {
  const c = todo[i];
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();
  await minimizeWindow(ctx, page);
  try {
    const res = await page.goto(`https://www.futurelearn.com/courses/${c.slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    if (res && res.status() === 403) blocked++;
    // READ THE NUMBER FROM THE PAGE'S OWN DATA, not its visible text. The page
    // embeds `enrolmentCount` in the HTML it is served with, while "N enrolled
    // on this course" is rendered later — read straight after load it was not
    // there yet — and small courses never show that line at all. Reading the
    // text found 3 of 174 on 2026-09-24; the data carries it for every course.
    const html = await page.content().catch(() => '');
    let m = html.match(/"enrolmentCount"\s*:\s*"?(\d[\d,]*)/);
    if (!m) {
      await sleep(2500);
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      m = text.match(/([\d,]+)\s+enrolled on this course/i);
    }
    if (m) { perSlug[c.slug] = Number(m[1].replace(/,/g, '')); found++; }
  } catch {}
  await ctx.close();
  process.stdout.write(`\r  ${i + 1}/${todo.length} · ${found} found`);
  await sleep(500 + Math.floor(Math.random() * 500));
}
process.stdout.write('\n');
await browser.close();

// A RUN THAT READS ALMOST NOTHING IS A FAILURE, and says so rather than ending
// on a ✅ over "3/174". If most pages were refused outright (403), FutureLearn is
// blocking the request — getting around that is deliberately not attempted.
writeFutureLearnEnrollment(perSlug);
if (todo.length && blocked >= todo.length * 0.5) {
  console.error(`❌ FutureLearn refused ${blocked} of ${todo.length} public course pages (HTTP 403). Previous values kept.`);
  process.exit(1);
}
if (todo.length >= 10 && found < todo.length * 0.5) {
  console.error(`❌ Read enrollment for only ${found} of ${todo.length} courses — the page layout has probably changed. Previous values kept.`);
  process.exit(1);
}
console.log(`✅ Got enrollment for ${found}/${todo.length} courses → dashboard.db`);
