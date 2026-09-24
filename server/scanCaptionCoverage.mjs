// True English-caption coverage per course, read live, one asset at a time.
//
// Why not the captions table: Udemy's course-level `caption_locales` only lists
// a language once it covers EVERY lecture, so a partly-captioned course reports
// nothing at all. And the analytics course_id it is keyed on does not resolve to
// a slug for every course. Both make it useless for deciding what still needs work.
//
// Resumable: results append to /tmp/coverage.json, and a re-run skips what is
// already recorded — a rate-limit stop costs only the courses not yet done.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimizeWindow } from './browserWindow.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/coverage.json';
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(process.cwd(), 'udemy-auth.json'), userAgent: UA });
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
    for (const c of d.results || []) if (c.id) out.push({ id: c.id, slug: c.published_title, title: c.title });
    url = d.next;
  }
  return out;
});
console.log(`${courses.length} courses · ${Object.keys(done).length} already scanned\n`);

let i = 0;
for (const c of courses) {
  i++;
  if (done[c.id]) continue;
  const r = await page.evaluate(async (cid) => {
    const nap = (m) => new Promise((x) => setTimeout(x, m));
    const cu = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/subscriber-curriculum-items/?page_size=200&fields[lecture]=asset&fields[asset]=id,asset_type`, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!cu.ok) return null;
    const d = await cu.json();
    const vids = (d.results || []).filter((x) => x._class === 'lecture' && x.asset && x.asset.asset_type === 'Video');
    const tally = {};
    for (const v of vids) {
      let got = null;
      for (let k = 0; k < 3 && got === null; k++) {
        const cr = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/assets/${v.asset.id}/captions/?fields[caption]=locale_id,status&page_size=50`, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (cr.ok) got = (await cr.json()).results || []; else await nap(1500 * (k + 1));
      }
      if (got === null) return null;                       // partial read -> record nothing
      for (const x of got) {
        const key = x.locale_id + (x.status === -1 ? ' (draft)' : '');
        tally[key] = (tally[key] || 0) + 1;
      }
      await nap(130);
    }
    return { videos: vids.length, tally };
  }, c.id).catch(() => null);

  if (!r) { console.log(`  ${i}/${courses.length} ${String(c.slug || c.id).slice(0, 44)} — read failed`); await sleep(4000); continue; }
  const en = Object.entries(r.tally).filter(([k]) => /^en/.test(k) && !/draft/.test(k)).reduce((a, [, v]) => Math.max(a, v), 0);
  done[c.id] = { slug: c.slug, title: c.title, videos: r.videos, en, tally: r.tally };
  writeFileSync(OUT, JSON.stringify(done, null, 1));
  if (en < r.videos) console.log(`  ${String(en).padStart(3)}/${String(r.videos).padEnd(3)} en  ${String(c.slug || '(no slug)').slice(0, 46)}`);
  await sleep(400);
}
console.log(`\nscanned ${Object.keys(done).length} courses -> ${OUT}`);
await browser.close();
