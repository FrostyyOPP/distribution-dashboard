// Pulls the FutureLearn course list (title, code, status, start date) from the
// org admin panel.
//
// FutureLearn rebuilt this screen (seen 2026-09-14): the old
// /courses page, a single list of li.m-course-list__item cards, now redirects
// to /courses-search, which renders an EMPTY table until you search — so the
// old selector returned 0 rows and the write guard (correctly) refused to save.
// The full list now lives at /courses-all, a plain table paginated 20 per page.
// Category and wishlist count are no longer shown on this screen.
//
// Session-based (no partner API). Writes to dashboard.db via db.js's guarded
// writer. Run: npm run futurelearn:courses
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { writeFutureLearnCourses } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'futurelearn-auth.json');
const COURSES_URL = 'https://www.futurelearn.com/admin/organisations/starweaver/courses-all';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect FutureLearn" in the dashboard first.');
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
await minimizeWindow(ctx, page);

console.log('Opening the FutureLearn courses admin panel…');
await page.goto(COURSES_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);

if (/\/sign-in|\/login/i.test(page.url())) {
  console.error('❌ Session expired (redirected to sign-in). Reconnect FutureLearn.');
  await browser.close();
  process.exit(1);
}

const readPage = () => page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('table tbody tr')].map((tr) => {
    const td = [...tr.querySelectorAll('td')];
    if (td.length < 4) return null;
    // cell 0 packs the title, the run label and an "Edit Course" hint together
    const raw = clean(td[0].textContent);
    const title = raw.replace(/\s*Run\s*\d+.*$/i, '').trim();
    const runMatch = raw.match(/Run\s*(\d+)/i);
    const a = tr.querySelector('a[href*="/courses/"]');
    const slug = a ? (a.getAttribute('href').match(/\/courses\/([^/?#]+)/) || [])[1] : null;
    const dateText = clean(td[3].textContent);
    return {
      slug, title,
      code: clean(td[2].textContent) || null,
      category: null,               // no longer shown on this screen
      wishlistCount: null,          // ditto
      // The status cell holds TWO badges with no separator, so the raw text
      // reads "In progressPrivate" / "FinishedUnlisted". Split them: the run
      // state, and the visibility flag that decides whether it is public.
      status: (() => { const t = clean(td[1].textContent);
        const m = t.match(/^(In progress|Draft|Finished|Scheduled|Archived)/i);
        return m ? m[1] : (t || null); })(),
      visibility: (() => { const t = clean(td[1].textContent);
        const m = t.match(/(Private|Unlisted|Public)\s*$/i);
        return m ? m[1] : 'Public'; })(),
      startDate: dateText && dateText !== 'Not set' ? dateText : null,
      run: runMatch ? Number(runMatch[1]) : null,
    };
  }).filter((c) => c && c.title);
});

// how many pages? the pager exposes them as ?&page=N
const lastPage = await page.evaluate(() => {
  const ns = [...document.querySelectorAll('a[href*="page="]')]
    .map((a) => Number((a.getAttribute('href').match(/page=(\d+)/) || [])[1]))
    .filter(Boolean);
  return ns.length ? Math.max(...ns) : 1;
});

const seen = new Map();
for (let n = 1; n <= lastPage; n++) {
  // A page that renders slowly returns 0 rows and would silently cost 20
  // courses — the run still looks successful and stays inside the write
  // guard's 50% threshold. Retry an empty page before accepting it.
  let batch = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (n > 1 || attempt > 1) {
      await page.goto(`${COURSES_URL}?&page=${n}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200 * attempt);
    batch = await readPage();
    if (batch.length) break;
    if (attempt === 4) throw new Error(`page ${n} returned no rows after 4 attempts — aborting rather than saving a short list`);
  }
  // A course with several runs appears once per run; keep the latest-starting one.
  for (const c of batch) {
    const key = c.slug || c.title;
    const prev = seen.get(key);
    const ts = c.startDate ? Date.parse(c.startDate) : 0;
    if (!prev || ts > (prev.__ts || 0)) seen.set(key, { ...c, __ts: ts });
  }
  process.stdout.write(`\r  page ${n}/${lastPage} — ${seen.size} courses`);
}
console.log('');
const courses = [...seen.values()].map(({ __ts, run, ...c }) => c);

await browser.close();

const result = writeFutureLearnCourses(courses);
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${courses.length} courses found, looks like a partial/failed run. Kept existing data. Re-run after reconnecting.`);
  process.exit(1);
}
console.log(`✅ ${courses.length} FutureLearn courses → dashboard.db`);
