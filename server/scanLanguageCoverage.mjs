// Languages actually present per course, read live from the assets.
//
// Udemy's course-level `caption_locales` only lists a language once it covers
// EVERY lecture, so a partly-captioned course can report zero languages while
// carrying captions on most of its lectures. This probes real assets instead.
//
// Two passes: a cheap 3-asset probe over every course, then a full per-asset
// sweep of anything that looks thin. Resumable via /tmp/lang_coverage.json.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimizeWindow } from './browserWindow.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/lang_coverage.json';
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const THIN = Number(process.env.THIN || 3);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(process.cwd(), 'udemy-auth.json'), userAgent: UA });
const page = await ctx.newPage();
await minimizeWindow(ctx, page);
await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
await sleep(2500);

const courses = await page.evaluate(async () => {
  const out = []; let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=id,published_title,title,status_label';
  while (url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) break;
    const d = await r.json();
    for (const c of d.results || []) if (c.id) out.push({ id: c.id, slug: c.published_title, title: c.title, status: c.status_label });
    url = d.next;
  }
  return out;
});
console.log(`${courses.length} courses · ${Object.keys(done).length} already scanned\n`);

const probe = (cid, limit) => page.evaluate(async ({ cid, limit }) => {
  const nap = (m) => new Promise((x) => setTimeout(x, m));
  const cu = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/subscriber-curriculum-items/?page_size=200&fields[lecture]=asset&fields[asset]=id,asset_type`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!cu.ok) return null;
  const d = await cu.json();
  const vids = (d.results || []).filter((x) => x._class === 'lecture' && x.asset && x.asset.asset_type === 'Video');
  const take = limit ? vids.slice(0, limit) : vids;
  const tally = {};
  for (const v of take) {
    let got = null;
    for (let k = 0; k < 3 && got === null; k++) {
      const cr = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/assets/${v.asset.id}/captions/?fields[caption]=locale_id,status&page_size=50`, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (cr.ok) got = (await cr.json()).results || []; else await nap(1200 * (k + 1));
    }
    if (got === null) return null;
    for (const x of got) { const key = x.locale_id + (x.status === -1 ? '*' : ''); tally[key] = (tally[key] || 0) + 1; }
    await nap(120);
  }
  return { videos: vids.length, sampled: take.length, tally };
}, { cid, limit });

let i = 0;
for (const c of courses) {
  i++;
  if (done[c.id]) continue;
  let r = await probe(c.id, 3).catch(() => null);
  if (!r) { console.log(`  ${i}/${courses.length} ${String(c.slug || c.id).slice(0, 44)} — read failed`); await sleep(3000); continue; }
  // thin on the sample? count every lecture before believing it
  const langs = Object.keys(r.tally).filter((k) => !k.endsWith('*'));
  if (langs.length <= THIN) {
    const full = await probe(c.id, 0).catch(() => null);
    if (full) { r = full; r.deep = true; }
  }
  const published = Object.keys(r.tally).filter((k) => !k.endsWith('*'));
  const drafts = Object.keys(r.tally).filter((k) => k.endsWith('*'));
  done[c.id] = { ...c, videos: r.videos, sampled: r.sampled, deep: !!r.deep, langs: published, drafts, tally: r.tally };
  writeFileSync(OUT, JSON.stringify(done, null, 1));
  if (published.length <= THIN) console.log(`  ${String(published.length)} langs  ${String(c.status).padEnd(11)} ${String(c.slug || c.title).slice(0, 50)}`);
  await sleep(300);
}
const v = Object.values(done);
console.log(`\nscanned ${v.length} · with <= ${THIN} languages: ${v.filter((x) => x.langs.length <= THIN).length}`);
await browser.close();
