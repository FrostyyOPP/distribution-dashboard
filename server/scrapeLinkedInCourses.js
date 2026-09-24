// Pulls the LinkedIn Learning instructor portal's all-courses table.
//
// Starweaver publishes as "Starweaver Group, Inc. Licensor".
//   https://www.linkedin.com/learning/instructor-portal/analytics
//
// The table exposes title, language, learners, shares, likes and a last-updated
// date — and nothing else. Watch time, completion rate and demographics live on
// each course's own Analytics page (one page per course), so they are out of
// scope here.
//
// KEY GOTCHAS
//  - The table paginates 10 rows at a time behind a "Next" button, with no
//    page-size control. The only way through is to keep clicking.
//  - An UNAUTHENTICATED hit does not redirect to a login page. It silently
//    serves a "This page doesn't exist" shell, which reads like a dead URL
//    rather than an expired session. That case is detected explicitly below.
//  - The page header carries portfolio totals for shares and likes. Summing the
//    scraped rows and comparing against those two numbers proves no page was
//    skipped during pagination — pagination scrapes fail silently otherwise.
//
// Session-based. Writes via db.js's guarded writer.
// Run: node scrapeLinkedInCourses.js [--dry-run]
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { writeLinkedInCourses } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'linkedin-auth.json');
const URL = 'https://www.linkedin.com/learning/instructor-portal/analytics';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry-run');

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect LinkedIn" in the dashboard first.');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
// Parked, not minimized: in a minimized window LinkedIn's page never answers a
// read at all — the sign-in check below hung for minutes instead of firing.
await parkWindow(ctx, page);

console.log('Opening the LinkedIn Learning instructor portal…');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

// Not-signed-in looks like a missing page, not a login redirect. Read ONCE at
// six seconds it could be judged before LinkedIn had rendered either answer,
// and a dead session then ran on to write nothing. Wait for one of the two:
// the analytics portal, or the logged-out shell.
const signedOut = (text, url) => /page doesn.?t exist|Page not found|Join now\s+Sign in/i.test(text)
  || /\/login|\/uas\/login|authwall/.test(url);
let shell = '';
for (let i = 0; i < 20; i++) {
  await sleep(1500);
  shell = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
  if (signedOut(shell, page.url()) || /Active courses|Total shares/i.test(shell)) break;
}
if (signedOut(shell, page.url())) {
  console.error('❌ Not signed in. LinkedIn serves a "page doesn\'t exist" shell when the session is dead —');
  console.error('   it is not a broken URL. Reconnect LinkedIn from the dashboard and re-run.');
  await browser.close();
  process.exit(1);
}

// Portfolio totals, used to prove pagination did not drop rows. They sit in
// their own summary buttons reading "55 Active courses", "2,544 Total shares",
// "1,923 Total likes", "1,790 Followers" — matching on those exact labels,
// because a loose search over the page text pairs the wrong number with the
// wrong word (it read Followers as likes).
const header = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('button, div, span')]
    .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 40);
  const grab = (re) => {
    for (const t of labels) {
      const m = t.match(re);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };
  return {
    courses: grab(/^([\d,]+)\s+Active courses$/i),
    shares: grab(/^([\d,]+)\s+Total shares$/i),
    likes: grab(/^([\d,]+)\s+Total likes$/i),
  };
});
if (header.courses) console.log(`  portal reports ${header.courses} active courses`);

const seen = new Map();
let pageNo = 0;
for (;;) {
  pageNo++;
  await page.waitForSelector('table tbody tr, [role="row"]', { timeout: 20000 }).catch(() => {});
  await sleep(900);

  const batch = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const num = (s) => { const m = clean(s).match(/[\d,]+/); return m ? Number(m[0].replace(/,/g, '')) : null; };
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map((tr) => {
      const td = [...tr.querySelectorAll('td')].map((x) => clean(x.innerText));
      if (td.length < 4) return null;
      // Every cell repeats its visible value followed by a screen-reader label:
      //   "EN EN LANGUAGE COURSE" · "6,452 6,452 course learners"
      //   "March 12, 2026 Updated on March 12, 2026"
      // num() already takes the first number, so only the text cells need trimming.
      const lang = (td[1] || '').split(/\s+/)[0] || null;
      const dateM = (td[5] || '').match(/^([A-Za-z]+ \d{1,2}, \d{4})/);
      return {
        title: td[0], language: lang,
        learners: num(td[2]), shares: num(td[3]), likes: num(td[4]),
        lastUpdated: dateM ? dateM[1] : (td[5] || null),
      };
    }).filter((r) => r && r.title);
  });

  const before = seen.size;
  for (const r of batch) if (!seen.has(r.title)) seen.set(r.title, r);
  process.stdout.write(`\r  page ${pageNo} — ${seen.size} courses`);

  // A page that adds nothing means the Next button is inert or we have looped.
  if (seen.size === before && pageNo > 1) break;

  // Match the button whose label is EXACTLY "Next". An aria-label contains-match
  // also hits the per-row Share buttons — one course is called "Next-Generation
  // Network Automation" — and clicking that opens a share dialog while the table
  // never advances, which looks like pagination quietly ending.
  // Only :has-text matches this button: its textContent is whitespace (the
  // label is rendered inside), so an anchored /^Next$/ regex finds nothing.
  // The aria-label branch this used to carry is what broke it — it matched the
  // per-row Share button for the course "Next-Generation Network Automation".
  const next = page.locator('button:has-text("Next")').first();
  const usable = (await next.count()) && await next.isEnabled().catch(() => false);
  if (!usable) break;
  const firstBefore = batch[0] ? batch[0].title : '';
  await next.click().catch(() => {});
  // Wait for the table to actually turn over rather than trusting a fixed pause.
  await page.waitForFunction(
    (prev) => {
      const r = document.querySelector('table tbody tr td');
      return r && r.innerText.replace(/\s+/g, ' ').trim() !== prev;
    },
    firstBefore, { timeout: 15000 },
  ).catch(() => {});
  await sleep(700);
  if (pageNo > 40) { console.log('\n⚠️  stopped after 40 pages — pagination may be looping'); break; }
}
console.log('');
await browser.close();

const courses = [...seen.values()];
// Nothing scraped is never a result to save. It means the portal never showed
// its table — almost always a session that died between the check above and here.
if (!courses.length) {
  console.error('❌ No courses found on the portal. Nothing written — reconnect LinkedIn from the dashboard and re-run.');
  await browser.close().catch(() => {});
  process.exit(1);
}
const sum = (k) => courses.reduce((a, c) => a + (c[k] || 0), 0);
console.log(`scraped ${courses.length} courses · learners ${sum('learners')} · shares ${sum('shares')} · likes ${sum('likes')}`);

// The header totals are the check that pagination collected everything.
let mismatch = false;
for (const k of ['shares', 'likes']) {
  if (header[k] != null && header[k] !== sum(k)) {
    console.error(`⚠️  ${k}: header says ${header[k]}, scraped rows total ${sum(k)} — a page was probably missed`);
    mismatch = true;
  }
}
if (header.courses != null && header.courses !== courses.length) {
  console.error(`⚠️  the portal reports ${header.courses} active courses but ${courses.length} were scraped`);
  mismatch = true;
}
if (header.shares == null && header.likes == null) console.log('   (header totals not found — could not cross-check pagination)');
else if (!mismatch) console.log('   header totals match the scraped rows — no pages dropped');

if (DRY) {
  console.log('[DRY RUN] not written');
  courses.slice(0, 5).forEach((c) => console.log(`   ${String(c.learners).padStart(7)}  ${c.title.slice(0, 60)}`));
  process.exit(0);
}
if (mismatch) { console.error('❌ refusing to write a run that does not reconcile against the header totals'); process.exit(1); }

const res = writeLinkedInCourses(courses);
if (res && res.error) { console.error('❌', res.error); process.exit(1); }
if (res && res.guarded) { console.error('❌ The write guard refused this run as too small against the existing table. Nothing written.'); process.exit(1); }
console.log(`✅ ${courses.length} LinkedIn Learning courses → dashboard.db`);
