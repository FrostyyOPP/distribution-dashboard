// Which courses have Spanish captions but no English?
// Reads the live state from Udemy rather than the captions table, which stores
// an opaque analytics id (no slug) and is only as fresh as the last scrape.
// Output: /tmp/caption_gaps.json  [{ slug, courseId, locales }]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimizeWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
const page = await ctx.newPage();
await minimizeWindow(ctx, page);
await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
await sleep(3000);

const courses = await page.evaluate(async () => {
  const out = []; let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=id,published_title,title';
  while (url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) break;
    const d = await r.json();
    for (const c of d.results || []) if (c.id && c.published_title) out.push({ id: c.id, slug: c.published_title, title: c.title });
    url = d.next;
  }
  return out;
});
console.log(`courses: ${courses.length}`);

const rows = [];
for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  const locales = await page.evaluate(async (cid) => {
    const r = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/subscriber-curriculum-items/?page_size=200&fields[lecture]=asset&fields[asset]=id,asset_type`,
      { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    const vids = (d.results || []).filter((x) => x._class === 'lecture' && x.asset && x.asset.asset_type === 'Video');
    const seen = new Set();
    // one probe asset is enough to know which locales the course carries
    for (const v of vids.slice(0, 3)) {
      const cr = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/assets/${v.asset.id}/captions/?fields[caption]=locale_id&page_size=50`,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (cr.ok) for (const x of (await cr.json()).results || []) seen.add(x.locale_id);
    }
    return { locales: [...seen], videos: vids.length };
  }, c.id).catch(() => null);
  if (!locales) { console.log(`  ${i + 1}/${courses.length} ${c.slug} — read failed`); continue; }
  rows.push({ ...c, ...locales });
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${courses.length}`);
  await sleep(250);
}

const gaps = rows.filter((r) => r.locales.some((l) => /^es/.test(l)) && !r.locales.some((l) => /^en/.test(l)));
const zero = rows.filter((r) => r.videos > 0 && r.locales.length === 0);
writeFileSync('/tmp/caption_gaps.json', JSON.stringify(gaps, null, 1));
writeFileSync('/tmp/caption_zero.json', JSON.stringify(zero, null, 1));
console.log(`\nSpanish but NO English : ${gaps.length}`);
gaps.forEach((g) => console.log(`   ${g.slug}  (${g.videos} videos) [${g.locales.join(',')}]`));
console.log(`\nno captions at all     : ${zero.length}`);
await browser.close();
