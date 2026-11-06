// LinkedIn Learning royalty statements, month by month.
//
//   /learning/instructor-portal/payments/statements?instructorUrn=<urn>
//
// The page reports ONE period at a time, chosen by two dropdown buttons —
// a month ("August ▾") and a year ("2026 ▾"). This walks every year/month the
// pickers offer and upserts each period into linkedin_revenue.
//
// RECONCILIATION. Two figures on the page prove a period was read whole:
//   "Total courses"                -> number of rows expected
//   "Payment for selected period"  -> grand total, must equal the summed rows
// A period that does not reconcile is reported and skipped rather than stored,
// because a half-read month looks exactly like a bad month in the dashboard.
//
// EARNINGS TO DATE IS CUMULATIVE. It is a lifetime running total per course,
// not a per-period value; summing it across periods multiplies the real figure.
// It is stored as-is and the reader takes the latest value per course.
//
// BE GENTLE. LinkedIn throttles automation hard and silently: it stops
// responding rather than returning 429, and on 2026-09-15 five rapid loads of
// this page took the whole site out for over a day. One page load per period,
// a real pause between them, and every period's HTML is snapshotted so the
// parser can be reworked offline without ever reloading the site.
//
// Run: node scrapeLinkedInRevenue.js [--dry-run] [--year=2026] [--month=August]
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { saveSnapshot } from './snapshotStore.js';
import { writeLinkedInRevenue, logScrapeRun } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'linkedin-auth.json');
const URN = process.env.LINKEDIN_INSTRUCTOR_URN || 'urn:li:learningApiInstructor:20309001';
const URL = `https://www.linkedin.com/learning/instructor-portal/payments/statements?instructorUrn=${encodeURIComponent(URN)}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry-run');
const ONLY_YEAR = arg('year');
const ONLY_MONTH = arg('month');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect LinkedIn" in the dashboard first.');
  process.exit(1);
}

const money = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const intOf = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

console.log('Opening the LinkedIn payments statements page…');
const resp = await page.goto(URL, { waitUntil: 'commit', timeout: 90000 }).catch(() => null);
if (!resp) {
  console.error('❌ The page did not load. LinkedIn throttles automation by going silent rather than');
  console.error('   returning an error — wait a few hours before retrying, and do not loop on this.');
  await browser.close();
  process.exit(1);
}
await page.waitForSelector('table tbody tr', { timeout: 60000 }).catch(() => {});
await sleep(4000);

const shell = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
if (/page doesn.?t exist|Page not found/i.test(shell) || /\/login|authwall/.test(page.url())) {
  console.error('❌ Not signed in — LinkedIn serves a missing-page shell when the session is dead.');
  await browser.close();
  process.exit(1);
}

// The two pickers are buttons, not selects. Find them by their current label.
const pickerByValue = (value) => page.locator('button').filter({ hasText: new RegExp(`^${value}$`) }).first();

async function openAndList(current) {
  const btn = pickerByValue(current);
  if (!(await btn.count())) return { btn: null, options: [] };
  await btn.click().catch(() => {});
  await sleep(700);
  const options = await page.locator('[role="option"], [role="menuitem"], li button, li [role="option"]')
    .evaluateAll((els) => [...new Set(els.map((e) => (e.innerText || '').trim()).filter(Boolean))]);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);
  return { btn, options };
}

// What period is showing, and what does each picker offer?
const currentMonth = await page.evaluate((months) => {
  const t = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
  return t.find((x) => months.includes(x)) || null;
}, MONTHS);
const currentYear = await page.evaluate(() => {
  const t = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
  return t.find((x) => /^20\d\d$/.test(x)) || null;
});
console.log(`  currently showing: ${currentMonth} ${currentYear}`);

const yearOpts = (await openAndList(currentYear)).options.filter((o) => /^20\d\d$/.test(o));
const monthOpts = (await openAndList(currentMonth)).options.filter((o) => MONTHS.includes(o));
const years = (ONLY_YEAR ? [ONLY_YEAR] : (yearOpts.length ? yearOpts : [currentYear])).filter(Boolean);
const monthsFor = ONLY_MONTH ? [ONLY_MONTH] : (monthOpts.length ? monthOpts : [currentMonth]).filter(Boolean);
console.log(`  years offered : ${years.join(', ')}`);
console.log(`  months offered: ${monthsFor.join(', ')}`);

async function choose(currentLabel, want) {
  if (currentLabel === want) return true;
  const btn = pickerByValue(currentLabel);
  if (!(await btn.count())) return false;
  await btn.click().catch(() => {});
  await sleep(700);
  const opt = page.locator('[role="option"], [role="menuitem"], li button').filter({ hasText: new RegExp(`^${want}$`) }).first();
  if (!(await opt.count())) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await opt.click().catch(() => {});
  // wait for the table to redraw rather than trusting a fixed pause
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20000 }).catch(() => {});
  await sleep(2500);
  return true;
}

function parsePeriod() {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const txt = document.body.innerText;
    const grand = (txt.match(/Grand total payment/i) && txt.match(/\$[\d,]+\.\d\d/)) ? txt.match(/\$[\d,]+\.\d\d/)[0] : null;
    const totalCourses = (txt.match(/([\d,]+)\s*\n?\s*Courses/i) || [])[1] || null;
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const td = [...tr.querySelectorAll('td')].map((x) => clean(x.innerText));
      if (td.length < 6) return null;
      return td;
    }).filter(Boolean);
    const headers = [...document.querySelectorAll('table thead th')].map((x) => clean(x.innerText));
    return { rows, headers, grand, totalCourses };
  });
}

const all = [];
let sawTrouble = false;
for (const year of years) {
  for (const month of monthsFor) {
    const okY = await choose(await page.evaluate(() => {
      const t = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
      return t.find((x) => /^20\d\d$/.test(x)) || '';
    }), year);
    const okM = await choose(await page.evaluate((ms) => {
      const t = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
      return t.find((x) => ms.includes(x)) || '';
    }, MONTHS), month);
    if (!okY || !okM) { console.log(`  ${month} ${year}: could not select — skipped`); continue; }

    const { rows, headers, grand, totalCourses } = await parsePeriod();
    const period = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}`;
    const html = await page.content();
    saveSnapshot('linkedin', `statements-${period}`, html, { url: URL, period });

    // Column order comes from the header row, so a reordered table cannot
    // silently shift every value one column across.
    const idx = (re) => headers.findIndex((h) => re.test(h));
    const cName = 0;
    const cPay = idx(/payment for selected/i), cEarn = idx(/earnings for selected/i);
    const cAdv = idx(/remaining advance/i), cRoy = idx(/royalty earnings/i);
    const cToDate = idx(/earnings to date/i), cPrev = idx(/previous period/i);
    const cAlaE = idx(/a la carte earnings/i), cAlaU = idx(/a la carte units/i);
    const cGrant = idx(/grants/i), cAdvT = idx(/total advances/i);
    const cPct = idx(/royalty %/i), cRel = idx(/release date/i);
    const cLang = idx(/languages/i), cId = idx(/course id/i);

    const parsed = rows.map((td) => ({
      courseId: cId >= 0 ? td[cId] : null,
      courseName: td[cName],
      period,
      payment: money(td[cPay]), earnings: money(td[cEarn]),
      royaltyEarnings: money(td[cRoy]), earningsPrevPeriod: money(td[cPrev]),
      earningsToDate: money(td[cToDate]), alacarteEarnings: money(td[cAlaE]),
      alacarteUnits: intOf(td[cAlaU]), grants: money(td[cGrant]),
      advanceRemaining: money(td[cAdv]), advancesTotal: money(td[cAdvT]),
      royaltyPct: money(td[cPct]), releaseDate: cRel >= 0 ? td[cRel] : null,
      languages: cLang >= 0 ? td[cLang] : null,
    })).filter((r) => r.courseId && r.courseName);

    const sum = parsed.reduce((a, r) => a + (r.payment || 0), 0);
    const grandN = money(grand);
    const expect = intOf(totalCourses);
    const problems = [];
    if (expect != null && expect !== parsed.length) problems.push(`page says ${expect} courses, parsed ${parsed.length}`);
    if (grandN != null && Math.abs(grandN - sum) > 0.05) problems.push(`grand total ${grandN} vs summed rows ${sum.toFixed(2)}`);

    if (problems.length) {
      sawTrouble = true;
      console.log(`  ⚠️  ${period}: ${problems.join(' · ')} — skipped`);
    } else {
      all.push(...parsed);
      console.log(`  ✅ ${period}: ${parsed.length} courses · $${sum.toFixed(2)}`);
    }
    await sleep(3500);   // deliberate: this site punishes speed
  }
}
await browser.close();

if (!all.length) {
  console.error('❌ nothing reconciled — nothing written');
  logScrapeRun({ job: 'linkedin_revenue', ok: false, rows: 0, error: 'no periods reconciled' });
  process.exit(1);
}
if (DRY) {
  console.log(`\n[DRY RUN] ${all.length} course-period rows across ${new Set(all.map((r) => r.period)).size} period(s) — not written`);
  process.exit(0);
}
const res = writeLinkedInRevenue(all);
logScrapeRun({ job: 'linkedin_revenue', ok: !sawTrouble, rows: res.written, error: sawTrouble ? 'some periods failed reconciliation' : null });
console.log(`\n✅ ${res.written} course-period rows → linkedin_revenue`);
