// Pulls Go1's Content Studio per-course learning data (enrolments, completions,
// total minutes, avg session duration) for the most recent complete month.
// KEY GOTCHA: the Insights page embeds this table in a same-origin IFRAME
// (frame URL contains "learning-content") — the outer page's document.body
// is just nav chrome, so reading it directly always looks empty. Read the
// iframe's own text instead. Table is paginated (~20 rows/page); click through
// the page-number buttons inside the frame to get everything.
// Session-based (no partner API). Writes to dashboard.db via db.js's guarded
// writer. Run: npm run go1:courses
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { writeGo1Courses } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'go1-auth.json');
const INSIGHTS_URL = 'https://starweaver.mygo1.com/r/app/content-studio/insights';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
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

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();

console.log('Opening the Go1 Content Studio Insights page…');
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
let contentFrame = null;
for (let attempt = 1; attempt <= 8 && !contentFrame; attempt++) {
  await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  // Poll for the iframe via Playwright's own frame list (in-page window.frames
  // checks are unreliable here — cross-frame property access gets flaky).
  for (let i = 0; i < 10 && !contentFrame; i++) {
    await sleep(1000);
    contentFrame = page.frames().find((f) => f.url().includes('learning-content')) || null;
  }
  if (contentFrame) {
    await sleep(2500); // give the frame's own data fetch a moment to populate rows, not just the header
  } else {
    console.log(`  attempt ${attempt}/8 — page didn't render in time, retrying…`);
  }
}

if (!contentFrame) {
  console.error('❌ Insights page never rendered the Learning Content iframe after 8 attempts. Session may need reconnecting, or Go1 changed something.');
  await browser.close();
  process.exit(1);
}

// Month label lives in the frame's own subtitle line, e.g. "June 2026 Consumption data".
const firstPageText = await contentFrame.evaluate(() => document.body.innerText);
const monthMatch = firstPageText.match(/^([A-Za-z]+ \d{4}) Consumption data$/m);
const month = monthMatch ? monthMatch[1] : null;

let allRows = [...parseTable(firstPageText)];
const totalMatch = firstPageText.match(/Showing \d+ of (\d+)/);
const total = totalMatch ? Number(totalMatch[1]) : allRows.length;
console.log(`Page 1: ${allRows.length} rows (total expected: ${total})`);

let pageNum = 2;
while (allRows.length < total) {
  const clicked = await contentFrame.evaluate((p) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === String(p));
    if (btn) { btn.click(); return true; }
    return false;
  }, pageNum).catch(() => false);
  if (!clicked) break;
  await sleep(2000);
  const text = await contentFrame.evaluate(() => document.body.innerText);
  const rows = parseTable(text);
  console.log(`Page ${pageNum}: ${rows.length} rows`);
  allRows.push(...rows);
  pageNum++;
  if (pageNum > 20) break; // safety stop
}

await browser.close();

// De-dupe by name in case a page re-render doubled up any rows.
const byName = new Map();
for (const r of allRows) byName.set(r.name, r);
const courses = [...byName.values()];

const result = writeGo1Courses(courses, month);
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${courses.length} courses parsed (expected ${total}), looks like a partial run. Kept existing data.`);
  process.exit(1);
}
console.log(`✅ ${courses.length} Go1 courses (${month || 'unknown month'}) → dashboard.db`);
