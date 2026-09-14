// Which of ALL taught courses have a bonus lecture, and what code does it show?
//
// Why not reuse applyBonusDiscountBlock's list: that script iterates
// udemy_real_course_ids (141 rows), while the account actually has 183 courses.
// The 42-course difference is invisible to it — those lectures are never
// updated and never reported. This reads the live taught-courses list instead.
//
// READ-ONLY. Writes /tmp/bonus_presence.json
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimizeWindow } from './browserWindow.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/tmp/bonus_presence.json';
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

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
console.log(`${courses.length} courses · ${Object.keys(done).length} already checked\n`);

let i = 0;
for (const c of courses) {
  i++;
  if (done[c.id]) continue;
  const r = await page.evaluate(async (cid) => {
    const J = async (u) => { const x = await fetch('https://www.udemy.com' + u, { credentials: 'include', headers: { Accept: 'application/json' } }); return x.ok ? x.json() : null; };
    const cu = await J(`/api-2.0/courses/${cid}/subscriber-curriculum-items/?page_size=200&fields[lecture]=id,title,asset&fields[asset]=asset_type`);
    if (!cu) return { stage: 'read-failed' };
    const lectures = (cu.results || []).filter((x) => x._class === 'lecture');
    const bonus = lectures.find((x) => /bonus/i.test(x.title || ''));
    if (!bonus) return { stage: 'no-bonus', lectures: lectures.length };
    if (bonus.asset?.asset_type !== 'Article') return { stage: 'not-article', assetType: bonus.asset?.asset_type, bonusTitle: bonus.title };
    const lec = await J(`/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
    const body = lec?.asset?.body || '';
    return {
      stage: 'ok', bonusTitle: bonus.title, lectureId: bonus.id,
      hasDiscountBlock: /Exclusive Student Discount|Descuento exclusivo/i.test(body),
      code: (body.match(/<strong>([A-Z0-9][A-Z0-9_-]{3,30})<\/strong>/) || [])[1] || null,
    };
  }, c.id).catch(() => ({ stage: 'error' }));
  done[c.id] = { ...c, ...r };
  writeFileSync(OUT, JSON.stringify(done, null, 1));
  if (r.stage !== 'ok' || r.code !== 'SEPT_BESTPRICE') {
    console.log(`  ${String(i).padStart(3)}/${courses.length}  ${String(r.stage).padEnd(12)} ${String(r.code || '').padEnd(16)} ${String(c.title).slice(0, 46)}`);
  }
  await sleep(350);
}
const v = Object.values(done);
console.log(`\nchecked            : ${v.length}`);
console.log(`with bonus article : ${v.filter((x) => x.stage === 'ok').length}`);
console.log(`  showing SEPT_BESTPRICE : ${v.filter((x) => x.code === 'SEPT_BESTPRICE').length}`);
console.log(`  showing something else : ${v.filter((x) => x.stage === 'ok' && x.code !== 'SEPT_BESTPRICE').length}`);
console.log(`NO bonus lecture   : ${v.filter((x) => x.stage === 'no-bonus').length}`);
console.log(`bonus not an article: ${v.filter((x) => x.stage === 'not-article').length}`);
await browser.close();
