// Create a bonus lecture (article) on courses that have none.
//
// Three calls, discovered against a draft course:
//   1. POST /users/me/taught-courses/{cid}/lectures/        {title}      -> 201, lecture id
//   2. POST /users/me/article-assets/                        {body}       -> 201, asset id
//   3. PATCH /users/me/taught-courses/{cid}/lectures/{lid}/  {asset}      -> 200
// then the lecture is re-read and the body compared, so a silent partial
// failure cannot be reported as success.
//
// Refuses to touch a course that already has a lecture matching /bonus/i —
// this only ever ADDS, and never to a course that already has one.
//
// Input: JSON array of { slug, courseId, cluster, lang? }
// Run:  node createBonusLecture.js <jobs.json> [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { buildBonusBody, DISCOUNT_CODE } from './bonusLectureTemplate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry-run');
const src = process.argv[2];
if (!src || !existsSync(src)) { console.error('Usage: node createBonusLecture.js <jobs.json> [--dry-run]'); process.exit(1); }
const jobs = JSON.parse(readFileSync(src, 'utf8'));

const TITLE = 'Bonus Lecture: Your Next Steps';
const results = [];
const save = () => writeFileSync('/tmp/bonus_created.json', JSON.stringify(results, null, 1));
console.log(`${DRY ? '[DRY RUN] ' : ''}code=${DISCOUNT_CODE} · ${jobs.length} course(s)\n`);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

for (let i = 0; i < jobs.length; i++) {
  const j = jobs[i];
  const tag = `${i + 1}/${jobs.length}`;
  const rec = { slug: j.slug, courseId: j.courseId, cluster: j.cluster, stage: null };
  try {
    const body = buildBonusBody(j.title || j.slug, j.cluster, j.lang || 'en');
    rec.bodyChars = body.length;

    await page.goto(`https://www.udemy.com/instructor/course/${j.courseId}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
    await sleep(4000);
    if (/join\/passwordless|\/login/.test(page.url())) { rec.stage = 'session-lost'; results.push(rec); save(); console.log(`\n❌ ${tag} session lost — reconnect Udemy`); break; }

    const r = await page.evaluate(async ({ cid, html, title, dry }) => {
      const J = async (m, u, b) => {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
        const res = await fetch('https://www.udemy.com' + u, { method: m, credentials: 'include',
          headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
          body: b ? JSON.stringify(b) : undefined });
        let j = null; const t = await res.text(); try { j = JSON.parse(t); } catch {}
        return { status: res.status, text: t.slice(0, 200), json: j };
      };

      // never add a second bonus lecture
      const cur = await J('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=200&fields[lecture]=id,title`);
      const existing = (cur.json?.results || []).find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (existing) return { stage: 'already-has-bonus', existingId: existing.id, existingTitle: existing.title };
      if (dry) return { stage: 'dry', items: (cur.json?.results || []).length };

      const lec = await J('POST', `/api-2.0/users/me/taught-courses/${cid}/lectures/`, { title });
      if (lec.status !== 201) return { stage: 'create-lecture', status: lec.status, detail: lec.text };
      const lid = lec.json.id;

      const as = await J('POST', '/api-2.0/users/me/article-assets/', { body: html, ignore_warnings: true });
      if (as.status !== 201) return { stage: 'create-asset', status: as.status, detail: as.text, lectureId: lid };

      const ln = await J('PATCH', `/api-2.0/users/me/taught-courses/${cid}/lectures/${lid}/`, { asset: as.json.id });
      if (ln.status !== 200) return { stage: 'link-asset', status: ln.status, detail: ln.text, lectureId: lid };

      // A newly created lecture is is_published:false — present for the
      // instructor, invisible to students. Without this it looks created and
      // verifies fine on the instructor endpoint while no learner can see it.
      const pub = await J('PATCH', `/api-2.0/users/me/taught-courses/${cid}/lectures/${lid}/`, { is_published: true });
      if (pub.status !== 200) return { stage: 'publish', status: pub.status, detail: pub.text, lectureId: lid };

      await new Promise((x) => setTimeout(x, 2500));
      // Verify on the INSTRUCTOR endpoint (the learner one returns nothing for
      // a lecture that has only just been published), then confirm separately
      // that students can actually see it.
      const v = await J('GET', `/api-2.0/users/me/taught-courses/${cid}/lectures/${lid}/?fields[lecture]=id,title,is_published,asset&fields[asset]=asset_type,body`);
      const live = v.json?.asset?.body || '';
      const sub = await J('GET', `/api-2.0/courses/${cid}/subscriber-curriculum-items/?page_size=200&fields[lecture]=id`);
      const visible = (sub.json?.results || []).some((x) => x._class === 'lecture' && x.id === lid);
      return { stage: 'done', lectureId: lid, assetId: as.json.id,
               matches: live === html, hasCode: live.includes('SEPT_BESTPRICE'),
               liveChars: live.length, isPublished: v.json?.is_published === true, visible };
    }, { cid: j.courseId, html: body, title: TITLE, dry: DRY });

    Object.assign(rec, r);
    rec.ok = DRY ? r.stage === 'dry' : (r.stage === 'done' && r.matches && r.hasCode && r.isPublished && r.visible);
    results.push(rec); save();
    const label = String(j.slug).slice(0, 44).padEnd(46);
    if (r.stage === 'dry') console.log(`   ${tag} would create — ${label} [${j.cluster}] ${rec.bodyChars} chars`);
    else if (r.stage === 'already-has-bonus') console.log(`   ${tag} SKIP already has "${r.existingTitle}" — ${label}`);
    else console.log(`${rec.ok ? '✅' : '⚠️ '} ${tag} ${label} [${j.cluster}] ${rec.ok ? `lecture ${r.lectureId}` : JSON.stringify({ stage: r.stage, status: r.status, detail: String(r.detail || '').slice(0, 90) })}`);
  } catch (e) {
    rec.stage = 'error'; rec.error = String(e.message).slice(0, 140); results.push(rec); save();
    console.log(`❌ ${tag} ${j.slug} — ${rec.error}`);
  }
  await sleep(1200);
}
await browser.close();
const ok = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(56)}`);
console.log(`${DRY ? 'would create' : 'created'}: ${ok}/${jobs.length}`);
for (const s of ['already-has-bonus', 'create-lecture', 'create-asset', 'link-asset', 'publish', 'error', 'session-lost']) {
  const n = results.filter((r) => r.stage === s).length;
  if (n) console.log(`${s.padEnd(18)}: ${n}`);
}
console.log('detail -> /tmp/bonus_created.json');
