// CAN UDEMY GIVE US REVENUE PER COURSE PER PERIOD?
//
// Every other platform reports revenue per course per quarter. Udemy gives us
// two halves that do not join:
//
//   share-holders/v2.0/{id}/total/                  account total BY MONTH,
//                                                   no course dimension
//   share-holders/v1.0/{id}/total/?aggregate=course per course LIFETIME,
//                                                   no date dimension
//
// So the map can say what each Udemy course earned in total, or what the
// account earned in a quarter, but never what a course earned in a quarter.
// Apportioning one by the other would credit a course launched in 2025 with
// revenue from 2014 — 55% of Udemy's money was earned before the map's window
// even opens ($324,610.60 of $592,714.29), so the misdating would be large.
//
// This asks the API whether it will answer the question directly. It only
// READS, and writes nothing to the database.
//
//   npm run auth:udemy      first, if the session has lapsed
//   node probeUdemyRevenuePeriods.js
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('Not connected. Run:  npm run auth:udemy');
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

let shId = null;
page.on('response', (res) => {
  const m = res.url().match(/\/api-2\.0\/share-holders\/(?:v[\d.]+\/)?(\d+)\//);
  if (m && !shId) shId = m[1];
});

// Warm up on a normal instructor page first, or Cloudflare serves a challenge
// and the share-holders call never fires. Non-deterministic, so retry.
for (let attempt = 1; attempt <= 3 && !shId; attempt++) {
  if (attempt > 1) console.log(`retrying (${attempt}/3)…`);
  await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(3000);
  await page.goto('https://www.udemy.com/instructor/performance/revenue/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(6000);
  if (!shId) await sleep(4000);
}

if (!shId) {
  // Tell the two failures apart: a lapsed session lands on the login page, a
  // Cloudflare challenge does not. They need different fixes.
  const url = page.url();
  const title = await page.title().catch(() => '');
  console.error('\nCould not reach the revenue account id.');
  console.error(/passwordless-auth|\/join\/|login/i.test(url + title)
    ? '  The session has lapsed — Udemy redirected to the login page.\n  Fix:  npm run auth:udemy   then run this again.'
    : `  Landed on ${url}\n  Title: ${title}\n  Looks like a Cloudflare challenge rather than a login. Just run it again.`);
  await browser.close();
  process.exit(1);
}
console.log('revenue account id:', shId, '\n');

async function get(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
      try { return JSON.parse(body); } catch {}
    }
    await sleep(1500);
  }
  return null;
}

const B = 'https://www.udemy.com/api-2.0/share-holders';
// The two known-good calls are included as controls. If they fail too, the
// session or Cloudflare is the problem, not the parameter being tested.
const PROBES = [
  ['CONTROL  per-course lifetime',   `${B}/v1.0/${shId}/total/?aggregate=course`],
  ['CONTROL  account by month',      `${B}/v2.0/${shId}/total/`],
  ['v2 + aggregate=course',          `${B}/v2.0/${shId}/total/?aggregate=course`],
  ['v1 course + from_date/to_date',  `${B}/v1.0/${shId}/total/?aggregate=course&from_date=2026-01-01&to_date=2026-03-31`],
  ['v1 course + start/end_date',     `${B}/v1.0/${shId}/total/?aggregate=course&start_date=2026-01-01&end_date=2026-03-31`],
  ['v2 course + from_date/to_date',  `${B}/v2.0/${shId}/total/?aggregate=course&from_date=2026-01-01&to_date=2026-03-31`],
  ['v1 aggregate=course,month',      `${B}/v1.0/${shId}/total/?aggregate=course,month`],
  ['v1 aggregate=month,course',      `${B}/v1.0/${shId}/total/?aggregate=month,course`],
  ['v2 detail',                      `${B}/v2.0/${shId}/detail/`],
  ['v1 detail + aggregate=course',   `${B}/v1.0/${shId}/detail/?aggregate=course`],
];

const results = [];
for (const [label, url] of PROBES) {
  const j = await get(url);
  const items = j?.items || [];
  const first = items[0] || null;
  // A per-course-per-period answer looks like MANY items whose identifier
  // names a course, under a call that was given a date range. A call that
  // ignores the dates returns the same count and the same total as the
  // lifetime control — that is the tell.
  const row = {
    label,
    ok: !!j,
    items: items.length,
    total: j?.amount?.amount ?? null,
    idSample: first ? String(first.identifier).slice(0, 40) : null,
    keys: first ? Object.keys(first).join(',') : null,
  };
  results.push(row);
  console.log(label);
  console.log(j
    ? `   items=${row.items}  total=${row.total}  id0=${row.idSample}  keys=[${row.keys}]`
    : '   no JSON (404, error, or challenge)');
  await sleep(1500);
}
await browser.close();

const lifetimeControl = results[0];
const monthlyControl = results[1];
console.log('\n─────────────────────────────────────────────');
// A dated call "worked" only if it differs from BOTH controls. Matching the
// lifetime control means the dates were ignored; matching the monthly control
// means the `course` half of the aggregate was ignored and we got the account
// series back. An earlier version of this check compared against the lifetime
// control alone and so reported `aggregate=course,month` as a success when it
// had simply returned the month series.
const same = (a, b) => a.items === b.items && a.total === b.total;
const worked = results.slice(2).filter((r) => r.ok && r.items
  && !same(r, lifetimeControl) && !same(r, monthlyControl));

if (worked.length) {
  console.log('share-holders CAN answer per course per period:\n');
  worked.forEach((r) => console.log(`   ${r.label}  items=${r.items} total=${r.total}`));
} else {
  console.log('share-holders CANNOT answer per course per period. Every dated');
  console.log('call came back as one of the two controls unchanged.');
  console.log('\nUse the monthly STATEMENTS instead — they are itemised per course:');
  console.log('   /api-2.0/statements/{id}/overview/            start_time dates the month');
  console.log('   /api-2.0/statements/{id}/ufb-with-aggregate/  Udemy Business, per course,');
  console.log('                                                 carries course_id');
  console.log('   /api-2.0/statements/{id}/sales/               marketplace, per transaction,');
  console.log('                                                 aggregate by course_name');
  console.log('   ...?statement_id=N links on /instructor/performance/revenue/ list the ids');
  console.log('   (a rolling 12 months only — Oct 2025 to Sep 2026 at the time of writing)');
  console.log('\nNote revenues-by-course/ looks right but is a top-6 + "Others" widget.');
}
