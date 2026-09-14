// Insert (or refresh) the "Exclusive Student Discount" block in every course's
// bonus lecture, advertising the current DISCOUNT_CODE.
//
// The block sits between "Recommended Next Courses" and the Learning Path
// section — the position it occupied before it was removed on 2026-07-30.
// Idempotent: if a discount block is already present it is REPLACED, so
// re-running after a coupon change simply updates the code.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { DISCOUNT_CODE } from './bonusLectureTemplate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry-run');

const COPY = {
  en: { h: 'Exclusive Student Discount', body: (c) => `Use code <strong>${c}</strong> to access the best price on all our Udemy courses.`,
        anchors: [/Personalis(ed|ed)\s+Learning\s+Path/i, /Personalized\s+Learning\s+Path/i] },
  es: { h: 'Descuento exclusivo para estudiantes', body: (c) => `Usa el código <strong>${c}</strong> para acceder al mejor precio en todos nuestros cursos de Udemy.`,
        anchors: [/Ruta de aprendizaje personalizada/i] },
};
const BR = '<p><br></p>';
const blockFor = (lang) => `<p><strong>${COPY[lang].h}</strong></p><p>${COPY[lang].body(DISCOUNT_CODE)}</p>${BR}`;
// matches an existing discount block in either language, with any code
const EXISTING = /<p><strong>(?:Exclusive Student Discount|Descuento exclusivo para estudiantes)<\/strong><\/p>\s*<p>.*?<\/p>\s*(?:<p>\s*<br\s*\/?>\s*<\/p>\s*)?/is;

// COURSE=<slug|id>[,...] limits the run to specific courses.
const ONLY = (process.env.COURSE || '').split(',').map((x) => x.trim()).filter(Boolean);
// Course list source. udemy_real_course_ids holds 141 rows while the account
// has 183 courses, so for a long time 42 were silently never updated — they
// were not reported as failures either, because the loop never saw them.
// The live taught-courses list is fetched below; the table is only a fallback.
const db = new Database(join(__dirname, 'dashboard.db'), { readonly: true });
let courses = db.prepare('SELECT real_course_id, title FROM udemy_real_course_ids ORDER BY title').all();

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);
await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
await sleep(2500);
{
  const live = await page.evaluate(async () => {
    const out = []; let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=id,published_title,title';
    while (url) {
      const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) break;
      const d = await r.json();
      for (const c of d.results || []) if (c.id) out.push({ real_course_id: c.id, slug: c.published_title, title: c.title });
      url = d.next;
    }
    return out;
  }).catch(() => []);
  if (live.length >= courses.length) courses = live.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  else console.log(`⚠️  live list returned ${live.length} (< ${courses.length} in the table) — keeping the table`);
}
if (ONLY.length) {
  courses = courses.filter((c) => ONLY.includes(String(c.real_course_id)) || ONLY.includes(c.slug));
}
console.log(`${DRY ? '[DRY RUN] ' : ''}code=${DISCOUNT_CODE} · courses=${courses.length}`);

mkdirSync(join(__dirname, 'bonus-lecture-backups'), { recursive: true });
const results = []; const backups = [];
const save = () => {
  writeFileSync('/tmp/discount_block_results.json', JSON.stringify(results, null, 2));
  if (backups.length) writeFileSync(join(__dirname, 'bonus-lecture-backups', 'bodies_before_discount_block.json'), JSON.stringify(backups, null, 2));
};

for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  const tag = `${i + 1}/${courses.length} ${String(c.title).slice(0, 42)}`;
  const rec = { courseId: c.real_course_id, title: c.title, ok: false, action: null, lang: null, note: null };
  try {
    await page.goto(`https://www.udemy.com/course/${c.real_course_id}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4200);
    if (/login|join\/passwordless/.test(page.url())) { rec.note = 'session lost'; results.push(rec); save(); console.log(`\n❌ ${tag} — session lost`); break; }

    const r = await page.evaluate(async ({ cid, blocks, existingSrc, anchorsEn, anchorsEs, dry }) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const H = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' };
      const J = async (m, u, p) => { const o = { method: m, credentials: 'include', headers: H }; if (p !== undefined) o.body = JSON.stringify(p);
        const res = await fetch(`https://www.udemy.com${u}`, o); const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
        return { status: res.status, json: j, text: t.slice(0, 200) }; };

      const cu = await J('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=500&fields[lecture]=title&fields[chapter]=title`);
      const bonus = (cu.json?.results || []).find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (!bonus) return { stage: 'no-bonus' };
      const lec = await J('GET', `/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
      if (lec.json?.asset?.asset_type !== 'Article') return { stage: 'not-article', assetType: lec.json?.asset?.asset_type };
      const before = lec.json?.asset?.body || '';
      if (!before) return { stage: 'empty-body' };

      // language from the body's own copy, not the course title
      const isEs = /Ruta de aprendizaje personalizada|Gracias y próximos pasos/i.test(before);
      const lang = isEs ? 'es' : 'en';
      const block = blocks[lang];
      const existing = new RegExp(existingSrc, 'is');

      let after, action;
      if (existing.test(before)) { after = before.replace(existing, block); action = 'replaced'; }
      else {
        const anchors = (isEs ? anchorsEs : anchorsEn).map((s) => new RegExp(s, 'i'));
        const a = anchors.map((re) => before.search(re)).filter((x) => x >= 0).sort((x, y) => x - y)[0];
        if (a == null || a < 0) return { stage: 'no-anchor', lang };
        // step back to the start of that heading's <p>
        const pStart = before.lastIndexOf('<p', a);
        if (pStart < 0) return { stage: 'no-anchor-p', lang };
        after = before.slice(0, pStart) + block + before.slice(pStart);
        action = 'inserted';
      }

      // guards: exactly one discount block, code present, nothing else lost
      const countCode = (after.match(new RegExp(blocks.code, 'g')) || []).length;
      const countH = (after.match(/Exclusive Student Discount|Descuento exclusivo para estudiantes/g) || []).length;
      const links = (s) => (s.match(/https:\/\/www\.udemy\.com\/course\//g) || []).length;
      if (countH !== 1) return { stage: 'guard', detail: `heading count ${countH}`, lang };
      if (countCode !== 1) return { stage: 'guard', detail: `code count ${countCode}`, lang };
      if (links(after) !== links(before)) return { stage: 'guard', detail: 'course-link count changed', lang };
      if (/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/i.test(after)) return { stage: 'guard', detail: 'double blank line', lang };
      if (dry) return { stage: 'dry', action, lang, before, after };

      const as = await J('POST', '/api-2.0/users/me/article-assets/', { body: after, ignore_warnings: true });
      if (as.status !== 201) return { stage: 'asset', status: as.status, detail: as.text, lang, before };
      const ln = await J('PATCH', `/api-2.0/users/me/taught-courses/${cid}/lectures/${bonus.id}/`, { asset: as.json.id });
      if (ln.status !== 200) return { stage: 'link', status: ln.status, lang, before };
      const v = await J('GET', `/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=body`);
      const live = v.json?.asset?.body || '';
      return { stage: 'done', action, lang, matches: live === after, hasCode: live.includes(blocks.code), before };
    }, { cid: c.real_course_id, dry: DRY, existingSrc: EXISTING.source,
         anchorsEn: COPY.en.anchors.map((r) => r.source), anchorsEs: COPY.es.anchors.map((r) => r.source),
         blocks: { en: blockFor('en'), es: blockFor('es'), code: DISCOUNT_CODE } });

    rec.action = r.action ?? r.stage; rec.lang = r.lang ?? null; rec.note = r.stage;
    rec.ok = DRY ? r.stage === 'dry' : (r.stage === 'done' && r.matches && r.hasCode);
    if (r.before) backups.push({ courseId: c.real_course_id, title: c.title, before: r.before });
    console.log(`${rec.ok ? '✅' : '⚠️ '} ${tag} [${rec.lang || '?'}] ${rec.action}${rec.ok ? '' : ' — ' + JSON.stringify({ stage: r.stage, detail: r.detail })}`);
  } catch (e) { rec.note = String(e).slice(0, 150); console.log(`❌ ${tag} — ${rec.note}`); }
  results.push(rec); save();
  await sleep(300);
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n\n${DRY ? '[DRY RUN] ' : ''}DONE: ${ok}/${results.length}`);
const byAction = {}; results.filter((r) => r.ok).forEach((r) => { byAction[r.action] = (byAction[r.action] || 0) + 1; });
console.log('actions:', JSON.stringify(byAction));
results.filter((r) => !r.ok).forEach((r) => console.log(`  FAILED: ${r.title} — ${r.note}`));
await browser.close();
