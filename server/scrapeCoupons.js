// Pulls ACTIVE coupons per course (not in the instructor API). Uses the connected
// session + a HEADED browser. Endpoint: /api-2.0/courses/{numId}/coupons-v2/?invalid=false
//
// AND THE ONES THAT RAN OUT. Udemy moves a coupon to ?invalid=true the moment its
// last redemption is taken, even though its dates still run — so asking for
// valid coupons alone makes a used-up coupon vanish, and with it any sign the
// course ever had one — a whole campaign that ran out between two scrapes was
// never seen at all. Those are fetched too and stored with
// status 'used_up'. Only USED UP ones: an expired coupon is simply over, and one
// somebody switched off (is_active false) was a decision, not an outcome.
// Writes to dashboard.db (courses table) via db.js's guarded writer — a run that
// covers far fewer courses than last time is refused rather than wiping the table.
// Run: npm run scrape:coupons   (a browser window opens — leave it)
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { udemyGet } from './udemyClient.js';
import { writeCoupons, writeCouponQuota } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect Udemy" in the dashboard first.');
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
async function apiGet(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (body.trim().startsWith('{') || body.trim().startsWith('[')) { try { return JSON.parse(body); } catch {} }
    await sleep(1500);
  }
  return null;
}

// Warm up Cloudflare.
await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(3000);

// numericId → slug from api-2.0 taught-courses.
const courses = [];
let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=published_title,is_published';
while (url) {
  const d = await apiGet(url);
  if (!d?.results) break;
  for (const c of d.results) if (c.id) courses.push({ numId: c.id, slug: c.published_title });
  url = d.next || null;
  await sleep(800);
}
console.log(`Checking coupons for ${courses.length} courses…`);

// slug → instructor id.
const slugToId = {};
let p2 = 1;
while (true) {
  const d = await udemyGet('/taught-courses/courses/', { page: p2, page_size: 100, 'fields[course]': '@default,published_title' });
  for (const c of d.results || []) slugToId[c.published_title] = c.id;
  if (!d.next) break;
  p2 += 1;
}

const shape = (x, status) => ({
  code: x.code,
  is_free: (x.discount_value ?? 0) === 0,
  discount_value: x.discount_value,
  max_uses: x.maximum_uses,
  used: x.number_of_uses,
  start: x.start_time,
  end: x.end_time,
  active: x.is_active,
  status,
});

// A coupon Udemy calls invalid that is nonetheless still inside its dates, still
// switched on, and at its cap. max_uses null means unlimited, which cannot run out.
const isUsedUp = (x, now) => x.maximum_uses != null && x.number_of_uses >= x.maximum_uses
  && x.is_active !== false && x.end_time && Date.parse(x.end_time) > now;

// Newest end date first, because the invalid list is every coupon the course
// ever had: sorted oldest-first, years of expired ones would push an in-date
// used-up coupon off the first page. Paging stops at the first expired one.
async function usedUpCoupons(numId) {
  const now = Date.now();
  const out = [];
  let url = `https://www.udemy.com/api-2.0/courses/${numId}/coupons-v2/?invalid=true&ordering=-end_time&page_size=50`;
  while (url) {
    const d = await apiGet(url);
    const page = d?.results || [];
    out.push(...page.filter((x) => isUsedUp(x, now)));
    const stillInDate = page.length && page.every((x) => x.end_time && Date.parse(x.end_time) > now);
    url = stillInDate ? d.next || null : null;
  }
  return out.map((x) => shape(x, 'used_up'));
}

const perCourse = {};
const quotaPerCourse = {};
let done = 0, withCoupons = 0, withUsedUp = 0, usedUpTotal = 0;
for (const c of courses) {
  const data = await apiGet(`https://www.udemy.com/api-2.0/courses/${c.numId}/coupons-v2/?invalid=false&ordering=end_time,-created&page_size=50`);
  const live = (data?.results || []).map((x) => shape(x, 'live'));
  const liveCodes = new Set(live.map((x) => x.code));
  // A code can only be one or the other; if Udemy ever lists it both ways, live wins.
  const usedUp = (await usedUpCoupons(c.numId)).filter((x) => !liveCodes.has(x.code));
  const list = [...live, ...usedUp];
  const meta = await apiGet(`https://www.udemy.com/api-2.0/courses/${c.numId}/coupons-v2/meta/`);
  const id = c.slug && slugToId[c.slug];
  if (id) {
    perCourse[id] = list;
    if (meta?.remaining_coupon_count != null) quotaPerCourse[id] = meta.remaining_coupon_count;
  }
  if (live.length) withCoupons++;
  if (usedUp.length) { withUsedUp++; usedUpTotal += usedUp.length; }
  done++;
  process.stdout.write(`\r  ${done}/${courses.length} · ${withCoupons} with active coupons · ${withUsedUp} with a used-up one`);
  await sleep(1000 + Math.floor(Math.random() * 800));
}
process.stdout.write('\n');
await browser.close();

const result = writeCoupons(perCourse);
writeCouponQuota(quotaPerCourse);
const totalCoupons = Object.values(perCourse).reduce((s, l) => s + l.filter((x) => x.status === 'live').length, 0);
if (result.guarded) {
  console.error(`⚠️ Refused to write — only ${Object.keys(perCourse).length} courses covered, looks like a partial/failed run. Kept existing data. Re-run after reconnecting.`);
  process.exit(1);
}
console.log(`✅ ${withCoupons} courses have active coupons (${totalCoupons} total) · ${usedUpTotal} used up on ${withUsedUp} courses · quota checked for ${Object.keys(quotaPerCourse).length} courses → dashboard.db`);
