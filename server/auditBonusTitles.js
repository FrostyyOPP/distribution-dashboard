// READ-ONLY audit of the titles inside every live bonus lecture.
//
// Two title surfaces can drift out of date, independently:
//   1. SELF  — "Thank you for completing <course name>", written when the
//      lecture was created. Rename the course on Udemy and this goes stale.
//   2. RECS  — the six recommendation links. The anchor text is a course title
//      captured at authoring time; the href is a referral URL. Rename the
//      DESTINATION course and the link still works but shows the old name.
//
// Writes /tmp/bonus_title_audit.json with the full per-course detail so a
// follow-up fix script can act on it. Changes nothing on Udemy.
//
// Run: node auditBonusTitles.js [--limit=N]
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';

// The dashboard gates its routes behind basic auth. Read the credentials from
// the environment (server/.env) - never hardcode them, this repo is public.
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const dashboardHeaders = () =>
  DASHBOARD_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASSWORD}`).toString('base64')}` }
    : {};


const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const dec = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
// Compare loosely: curly vs straight quotes and & vs "and" are not real drift.
const key = (s) => dec(s).toLowerCase().replace(/[‘’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

const db = new Database(join(__dirname, 'dashboard.db'), { readonly: true });
const courses = db.prepare('SELECT real_course_id, title FROM udemy_real_course_ids ORDER BY title').all().slice(0, LIMIT);

// Current live titles, keyed by slug, straight from the instructor API.
const live = await fetch('http://localhost:5055/api/courses', {
  headers: dashboardHeaders(),
}).then((r) => r.json()).catch(() => null);
if (!live?.results?.length) { console.error('❌ could not read /api/courses — is the backend up?'); process.exit(1); }
const titleBySlug = {};
for (const c of live.results) titleBySlug[c.published_title] = c.title;
console.log(`${courses.length} courses with a bonus lecture to check · ${live.results.length} live titles loaded\n`);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

const out = [];
const save = () => writeFileSync('/tmp/bonus_title_audit.json', JSON.stringify(out, null, 2));

for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  const tag = `${i + 1}/${courses.length}`;
  const rec = { courseId: c.real_course_id, dbTitle: c.title, stage: null };
  try {
    await page.goto(`https://www.udemy.com/course/${c.real_course_id}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3800);
    if (/login|join\/passwordless/.test(page.url())) { rec.stage = 'session-lost'; out.push(rec); save(); console.log(`\n❌ ${tag} session lost — reconnect Udemy`); break; }

    const r = await page.evaluate(async (cid) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const H = { Accept: 'application/json, text/plain, */*', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' };
      const J = async (u) => { const res = await fetch(`https://www.udemy.com${u}`, { credentials: 'include', headers: H });
        try { return await res.json(); } catch { return null; } };
      const cu = await J(`/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=600&fields[lecture]=title&fields[chapter]=title`);
      const bonus = (cu?.results || []).find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (!bonus) return { stage: 'no-bonus' };
      const lec = await J(`/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
      if (lec?.asset?.asset_type !== 'Article') return { stage: 'not-article', assetType: lec?.asset?.asset_type };
      return { stage: 'ok', lectureId: bonus.id, body: lec.asset.body || '' };
    }, c.real_course_id);

    Object.assign(rec, { stage: r.stage, lectureId: r.lectureId, assetType: r.assetType });
    if (r.stage !== 'ok') { out.push(rec); save(); console.log(`${tag} ${r.stage} — ${String(c.title).slice(0, 44)}`); continue; }

    const body = r.body;
    rec.lang = /Ruta de aprendizaje personalizada|Gracias y próximos pasos/i.test(body) ? 'es' : 'en';

    // 1. self title, from the thank-you line
    const m = body.match(/Thank you for completing\s+(.+?)\s+with Starweaver/i)
      || body.match(/Gracias por completar\s+(.+?)\s+con Starweaver/i);
    rec.selfTitleInArticle = m ? dec(m[1]) : null;
    rec.selfTitleStale = !!(rec.selfTitleInArticle && key(rec.selfTitleInArticle) !== key(c.title));

    // 2. recommendation anchors -> destination slug + shown text
    rec.recs = [...body.matchAll(/<a href="https:\/\/www\.udemy\.com\/course\/([^/"?]+)[^"]*"[^>]*>(.*?)<\/a>/gis)]
      .map((mm) => {
        const slug = mm[1];
        const shown = dec(mm[2].replace(/<[^>]+>/g, ''));
        const real = titleBySlug[slug] ?? null;
        return { slug, shown, real, stale: !!(real && key(shown) !== key(real)), unknown: real === null };
      });
    rec.staleRecs = rec.recs.filter((x) => x.stale).length;
    out.push(rec);
    save();
    console.log(`${tag} ${rec.lang} self=${rec.selfTitleStale ? 'STALE' : 'ok'} recs=${rec.staleRecs}/${rec.recs.length} — ${String(c.title).slice(0, 40)}`);
  } catch (e) {
    rec.stage = 'error'; rec.error = e.message; out.push(rec); save();
    console.log(`${tag} error: ${e.message}`);
  }
}

await browser.close();

const ok = out.filter((r) => r.stage === 'ok');
const selfStale = ok.filter((r) => r.selfTitleStale);
const recStale = ok.filter((r) => r.staleRecs > 0);
console.log(`\n${'='.repeat(60)}`);
console.log(`bonus lectures read : ${ok.length} of ${courses.length}`);
console.log(`stale SELF title    : ${selfStale.length}`);
console.log(`any stale REC label : ${recStale.length}  (${ok.reduce((s, r) => s + r.staleRecs, 0)} links total)`);
console.log(`skipped             : ${out.filter((r) => r.stage !== 'ok').map((r) => r.stage).join(', ') || 'none'}`);
if (selfStale.length) {
  console.log('\nStale self titles:');
  for (const r of selfStale) console.log(`  article: ${r.selfTitleInArticle}\n  real   : ${r.dbTitle}\n`);
}
console.log('\nfull detail -> /tmp/bonus_title_audit.json');
