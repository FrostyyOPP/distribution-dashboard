// Go1 only exposes a MONTHLY snapshot per request — no lifetime/all-time
// endpoint exists. This scrapes EVERY month back to when Go1 data starts
// (confirmed live: March 2025 and earlier are empty, April 2025 is the first
// real month) and sums per course, to give a genuine full-history total
// instead of just "this month". KEY SIMPLIFICATION over scrapeGo1Courses.js:
// no iframe-hunting needed — the Learning Content table's frame URL
// (…/content-studio/learning-content?to_date=YYYY-MM-DD) can be navigated to
// DIRECTLY as a normal page, sidestepping the same-origin-iframe gotcha
// entirely. Session-based (no partner API). Writes to dashboard.db via
// db.js's guarded writer. Run: npm run go1:history (takes a few minutes —
// ~15 months, several page-loads each)
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { writeGo1History } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'go1-auth.json');
const BASE_URL = 'https://starweaver.mygo1.com/r/app/content-studio/learning-content';
const INSIGHTS_URL = 'https://starweaver.mygo1.com/r/app/content-studio/insights';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FIRST_MONTH = { year: 2025, month: 4 }; // April 2025 — confirmed live as the first month with any data
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect Go1" in the dashboard first.');
  process.exit(1);
}

function parseTable(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => !/^Showing \d+ of \d+$/.test(l));
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const nums = lines.slice(i + 1, i + 5);
    if (nums.length === 4 && nums.every((n) => /^[\d,]+$/.test(n)) && !/^[\d,]+$/.test(lines[i])) {
      rows.push({
        name: lines[i],
        enrolments: Number(nums[0].replace(/,/g, '')),
        completions: Number(nums[1].replace(/,/g, '')),
        totalMinutes: Number(nums[2].replace(/,/g, '')),
        avgSessionMinutes: Number(nums[3].replace(/,/g, '')),
      });
      i += 4;
    }
  }
  return rows;
}

function lastDayOfMonth(year, month) {
  // month is 1-indexed; day 0 of the next month = last day of this month.
  const d = new Date(year, month, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();

console.log('Warming the Go1 session…');
// A DEAD SESSION LANDS ON THE LOGIN PAGE. Checked up front, because otherwise
// every retry below re-opens the login page and the run ends minutes later
// blaming "session, or Go1 changed something" — it could say which at once.
{
  await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(4000);
  if (/\/login\b/.test(page.url())) {
    console.error('❌ Go1 session expired — the saved login lands on the Go1 sign-in page.');
    console.error('   Reconnect Go1 from the dashboard (Settings → Connect Go1), then re-run. Nothing written.');
    await browser.close();
    process.exit(1);
  }
}
await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await sleep(3000);

// Find the latest complete month by reading Go1's own default subtitle.
let contentFrame = null;
for (let i = 0; i < 10 && !contentFrame; i++) {
  await sleep(1000);
  contentFrame = page.frames().find((f) => f.url().includes('learning-content')) || null;
}
let endYear, endMonth;
if (contentFrame) {
  const text = await contentFrame.evaluate(() => document.body.innerText).catch(() => '');
  const m = text.match(/^([A-Za-z]+) (\d{4}) Consumption data$/m);
  if (m) {
    endYear = Number(m[2]);
    endMonth = new Date(`${m[1]} 1, ${m[2]}`).getMonth() + 1;
  }
}
if (!endYear) {
  console.error('❌ Could not determine the latest complete month from the Insights page. Session may need reconnecting.');
  await browser.close();
  process.exit(1);
}
console.log(`Latest complete month: ${endYear}-${String(endMonth).padStart(2, '0')}. Scanning back to ${FIRST_MONTH.year}-${String(FIRST_MONTH.month).padStart(2, '0')}…`);

// Build the list of month-end dates to scrape, oldest first.
const months = [];
for (let y = FIRST_MONTH.year, m = FIRST_MONTH.month; y < endYear || (y === endYear && m <= endMonth); m++) {
  if (m > 12) { m = 1; y++; }
  months.push({ y, m, dateStr: lastDayOfMonth(y, m), label: `${y}-${String(m).padStart(2, '0')}` });
}

const allRows = [];
for (const { dateStr, label } of months) {
  await page.goto(`${BASE_URL}?to_date=${dateStr}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(3000);
  let text = await page.evaluate(() => document.body.innerText).catch(() => '');
  let rows = parseTable(text);
  const totalMatch = text.match(/Showing \d+ of (\d+)/);
  const total = totalMatch ? Number(totalMatch[1]) : rows.length;

  let pageNum = 2;
  while (rows.length < total && pageNum <= 20) {
    const seenBeforeClick = new Set(rows.map((r) => r.name)).size;
    let advanced = false;
    for (let attempt = 1; attempt <= 3 && !advanced; attempt++) {
      const clicked = await page.evaluate((p) => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === String(p));
        if (btn) { btn.click(); return true; }
        return false;
      }, pageNum).catch(() => false);
      if (!clicked) break;
      await sleep(2200);
      text = await page.evaluate(() => document.body.innerText).catch(() => '');
      const pageRows = parseTable(text);
      const merged = new Set([...rows.map((r) => r.name), ...pageRows.map((r) => r.name)]).size;
      if (merged > seenBeforeClick) { rows.push(...pageRows); advanced = true; }
      // else: click didn't register or page hadn't finished re-rendering — retry.
    }
    if (!advanced) break; // genuinely out of pages, or this page is unreachable — stop rather than loop forever
    pageNum++;
  }
  // De-dupe by name in case a page re-render doubled up any rows.
  const byName = new Map();
  for (const r of rows) byName.set(r.name, r);
  const monthRows = [...byName.values()];

  for (const r of monthRows) allRows.push({ courseName: r.name, month: label, enrolments: r.enrolments, completions: r.completions, totalMinutes: r.totalMinutes, avgSessionMinutes: r.avgSessionMinutes });
  console.log(`  ${label}: ${monthRows.length} course rows (expected ~${total})`);
}

await browser.close();

const result = writeGo1History(allRows);
const distinctMonths = new Set(allRows.map((r) => r.month)).size;
const distinctCourses = new Set(allRows.map((r) => r.courseName)).size;
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${allRows.length} rows across ${distinctMonths} months, looks like a partial run. Kept existing data.`);
  process.exit(1);
}
console.log(`✅ ${allRows.length} course-month rows · ${distinctMonths} months · ${distinctCourses} distinct courses → dashboard.db`);
