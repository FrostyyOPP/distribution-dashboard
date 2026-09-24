// Pulls the real course list for the Coursera CIN partner account (org slug
// "coursera") by paging through the admin Courses table directly (10 rows/page,
// "Go to next page" button) and reading each row's name + slug from its
// /teach/{slug}/course link. This partner's course-permission API responses
// (the technique scrapeCourseraCourses.js uses for Starweaver) resolve to far
// more entries than the admin table actually lists — specializations, drafts,
// and stale entries mixed in — so for CIN we read the authoritative table
// instead of inferring from permission side-channels. Session + headed browser.
// Writes to dashboard.db via db.js's guarded writer. Run: npm run coursera-cin:courses
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { writeCourseraCinCourses } from './db.js';
import { EXCLUDED_CIN_SLUGS } from './courseraCinExclusions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Coursera not connected. Use Connect Coursera in the dashboard first.');
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

await minimizeWindow(ctx, page); // keep the automation window out of the user's way

console.log('Opening the Coursera CIN partner console…');
await page.goto('https://www.coursera.org/admin/coursera/home/courses', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

// THE CONSOLE NAVIGATES ON ITS OWN AFTER LOAD. goto() resolves at
// DOMContentLoaded, then the admin app redirects, and an evaluate() caught
// mid-redirect throws "Execution context was destroyed". Uncaught, that killed
// the whole step on three of five nights (2026-09-20 → 24). A navigation is not
// a failure — it means "not ready yet", which is exactly what the polling loop
// below already waits out. Any other error still throws.
const navigated = (e) => /Execution context was destroyed|because of a navigation|navigat/i.test(String(e?.message || e));

async function extractRows() {
  try {
    return await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="/teach/"][href$="/course"]'))
      .map((a) => ({ name: a.textContent.trim(), slug: a.getAttribute('href').split('/')[2] }))
      .filter((r) => r.name && r.slug));
  } catch (e) {
    if (navigated(e)) return [];
    throw e;
  }
}

// Poll until the table actually has rows (or a real timeout) instead of a
// fixed sleep — first load and each page transition take variable time.
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
const maxPages = 100; // safety backstop
let prevFirstSlug = null;
for (; pageNum <= maxPages; pageNum++) {
  const rows = await waitForRows(prevFirstSlug);
  if (!rows.length) break;
  for (const r of rows) seen.set(r.slug, r);
  prevFirstSlug = rows[0].slug;
  process.stdout.write(`\rPage ${pageNum} — ${seen.size} unique courses so far`.padEnd(50));

  // If the click itself navigates, the evaluate dies AFTER the click landed —
  // so a navigation here means it worked. Reading it as "no next page" would
  // stop at a partial list, and one over half-size would pass the write guard.
  const nextClicked = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Go to next page"], a[aria-label="Go to next page"]');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') { btn.click(); return true; }
    return false;
  }).catch((e) => { if (navigated(e)) return true; throw e; });
  if (!nextClicked) break;
}
process.stdout.write('\n');
await browser.close();

const allFound = [...seen.values()];
const courses = allFound.filter((r) => !EXCLUDED_CIN_SLUGS.has(r.slug)).map((r) => ({ id: r.slug, name: r.name, slug: r.slug }));
const excludedCount = allFound.length - courses.length;
const result = writeCourseraCinCourses(courses);
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${courses.length} courses found, looks like a partial/failed run. Kept existing data. Re-run after reconnecting.`);
  process.exit(1);
}
console.log(`✅ ${courses.length} Coursera CIN courses (across ${pageNum} pages, ${excludedCount} excluded) → dashboard.db`);
