// Udemy students per course, from the INSTRUCTOR side (not the public course pages).
// Run: npm run scrape:enrollment
//
// Source: the instructor's own course list, api-2.0/users/me/taught-courses
// (field num_subscribers), read with the connected Udemy session in a HEADED
// browser (Cloudflare blocks headless on api-2.0). It covers every course we
// teach, published or not, and its sum equals "Total students" on Instructor ›
// Performance › Overview (api-2.0/instructor-performance/enrollment-metrics),
// which is checked before anything is saved.
//
// Why not the public pages any more (changed 2026-11-18, user asked for admin-side
// data wherever it exists): public pages lag the instructor figures, and 46 of
// 200 courses (≈78k students) have no public page to read at all.
//
// The instructor API (API key) has no student count, so it is only used to map
// api-2.0's numeric course ids onto the ids the dashboard keys on, by slug.
// Writes enrollment (merge upsert — never deletes a course's last known count).
// --force is accepted for update-all compatibility; every run reads every course.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { udemyGet } from './udemyClient.js';
import { writeEnrollment, readEnrollment } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Not connected. Use "Connect Udemy" in the dashboard first.');
  process.exit(1);
}

// The dashboard's course ids (instructor API), by slug.
const apiCourses = [];
for (let p = 1; ; p++) {
  const d = await udemyGet('/taught-courses/courses/', { page: p, page_size: 100, 'fields[course]': '@default,published_title' });
  apiCourses.push(...(d.results || []));
  if (!d.next) break;
}
const idBySlug = new Map(apiCourses.filter((c) => c.published_title).map((c) => [c.published_title, c.id]));
const idByTitle = new Map(apiCourses.map((c) => [c.title, c.id]));

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

async function apiGet(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    const body = (await page.evaluate(() => document.body.innerText).catch(() => '')).trim();
    if (body.startsWith('{') || body.startsWith('[')) { try { return JSON.parse(body); } catch {} }
    await sleep(1500);
  }
  return null;
}

let mine = [], total = null;
for (let attempt = 1; attempt <= 3 && !mine.length; attempt++) {
  if (attempt > 1) console.log(`Retrying (attempt ${attempt}/3)…`);
  await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});   // warms up Cloudflare
  await sleep(4000);
  const got = [];
  let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=title,published_title,num_subscribers';
  while (url) {
    const d = await apiGet(url);
    if (!d || !Array.isArray(d.results)) { got.length = 0; break; }
    got.push(...d.results); url = d.next;
  }
  mine = got;
}
const em = mine.length ? await apiGet('https://www.udemy.com/api-2.0/instructor-performance/enrollment-metrics/?fields[user]=total&data_scope=all&date_filter=all') : null;
total = em?.results?.[0]?.total ?? null;
await browser.close();

if (!mine.length) { console.error('❌ Could not read the instructor course list — session expired? Reconnect Udemy. Nothing saved.'); process.exit(1); }

const counts = {}, unmatched = [];
for (const c of mine) {
  const id = idBySlug.get(c.published_title) ?? idByTitle.get(c.title);
  if (id == null || c.num_subscribers == null) { unmatched.push(c.title); continue; }
  counts[id] = c.num_subscribers;
}
const sum = Object.values(counts).reduce((s, n) => s + n, 0);
const sumAll = mine.reduce((s, c) => s + (c.num_subscribers || 0), 0);

// Guards: the list must be (nearly) complete and agree with the instructor's own total.
if (Object.keys(counts).length < 0.9 * apiCourses.length) {
  console.error(`❌ Only ${Object.keys(counts).length}/${apiCourses.length} courses matched — not saved.`); process.exit(1);
}
if (total != null && Math.abs(sumAll - total) > Math.max(50, 0.005 * total)) {
  console.error(`❌ Course figures add up to ${sumAll.toLocaleString()} but Udemy's total is ${total.toLocaleString()} — not saved.`); process.exit(1);
}

const before = readEnrollment().counts;
const lower = Object.entries(counts).filter(([id, n]) => before[id] != null && n < before[id]);
writeEnrollment(counts);
console.log(`✅ Udemy students (instructor side): ${Object.keys(counts).length}/${apiCourses.length} courses · ${sum.toLocaleString()} students` +
  (total != null ? ` · Udemy's total ${total.toLocaleString()}` : ' · (total not available to cross-check)') +
  (unmatched.length ? ` · ${unmatched.length} unmatched: ${unmatched.slice(0, 5).join('; ')}` : '') +
  (lower.length ? ` · ${lower.length} lower than before (refunds/removals)` : ''));
