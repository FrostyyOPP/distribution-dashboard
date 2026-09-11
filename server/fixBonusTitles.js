// Refresh the course titles inside every live bonus lecture, in place.
//
// Two surfaces go stale independently, both frozen at authoring time:
//   1. SELF — "Thank you for completing <name> with Starweaver!"
//   2. RECS — the anchor TEXT of each recommendation link.
//
// Only text is touched. Every href is left byte-identical, so referral codes,
// UTM links and the Journeybuilder/social links are untouched — that is the
// single most important invariant here and it is enforced by a guard, not by
// care alone.
//
// Titles come from the live instructor API via the local dashboard, keyed by
// published_title slug, so this stays correct as Udemy titles keep changing.
//
// Idempotent: a lecture already carrying current titles is detected as
// unchanged and skipped without a write.
//
// Run: node fixBonusTitles.js --dry-run       (writes nothing, reports the diff)
//      node fixBonusTitles.js                 (applies)
//      node fixBonusTitles.js --limit=5       (first N courses, for a pilot)
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { liveBonusCourses } from './bonusCourseList.js';

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
const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;


const live = await fetch('http://localhost:5055/api/courses', {
  headers: dashboardHeaders(),
}).then((r) => r.json()).catch(() => null);
if (!live?.results?.length) { console.error('❌ could not read /api/courses — is the backend up?'); process.exit(1); }
const titleBySlug = {};
const titleById = {};
for (const c of live.results) { titleBySlug[c.published_title] = c.title; titleById[String(c.id)] = c.title; }

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

// Work list comes from the LIVE catalogue, not the CSV-derived table.
const courses = (await liveBonusCourses(page)).slice(0, LIMIT);
console.log(`${DRY ? '[DRY RUN] ' : ''}${courses.length} courses to process\n`);

mkdirSync(join(__dirname, 'bonus-lecture-backups'), { recursive: true });
const results = []; const backups = [];
const save = () => {
  writeFileSync('/tmp/bonus_title_fix_results.json', JSON.stringify(results, null, 2));
  if (backups.length) writeFileSync(join(__dirname, 'bonus-lecture-backups', 'bodies_before_title_fix.json'), JSON.stringify(backups, null, 2));
};

for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  const tag = `${String(i + 1).padStart(3)}/${courses.length}`;
  const rec = { courseId: c.realCourseId, title: c.title, stage: null, selfFixed: false, recsFixed: 0 };
  try {
    await page.goto(`https://www.udemy.com/course/${c.realCourseId}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // Poll for the CSRF cookie rather than guessing a sleep — every API call
    // below needs it, and a fixed wait is what made runs flaky.
    await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    if (/login|join\/passwordless/.test(page.url())) { rec.stage = 'session-lost'; results.push(rec); save(); console.log(`\n❌ ${tag} session lost — reconnect Udemy and re-run`); break; }

    const attempt = async () => page.evaluate(async ({ cid, realTitle, titles, dry }) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const H = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' };
      const J = async (m, u, p) => { const o = { method: m, credentials: 'include', headers: H }; if (p !== undefined) o.body = JSON.stringify(p);
        const res = await fetch(`https://www.udemy.com${u}`, o); const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
        return { status: res.status, json: j, text: t.slice(0, 220) }; };

      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const dec = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’')
        .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      // Curly-vs-straight quotes and "&" vs "and" are not real drift.
      const key = (s) => dec(s).toLowerCase().replace(/[‘’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

      // Distinguish "this course genuinely has no bonus article" from "the
      // request failed". Without the status check a throttled response reads
      // as no-bonus and the course is silently skipped as if it were fine.
      const cu = await J('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=600&fields[lecture]=title&fields[chapter]=title`);
      if (cu.status !== 200 || !Array.isArray(cu.json?.results)) return { stage: 'retry', why: `curriculum ${cu.status}` };
      const bonus = cu.json.results.find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (!bonus) return { stage: 'no-bonus' };
      const lec = await J('GET', `/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
      if (lec.status !== 200 || !lec.json?.asset) return { stage: 'retry', why: `lecture ${lec.status}` };
      if (lec.json.asset.asset_type !== 'Article') return { stage: 'not-article', assetType: lec.json.asset.asset_type };
      const before = lec.json.asset.body || '';
      if (!before) return { stage: 'empty-body' };

      let after = before;
      let selfFixed = false, recsFixed = 0;
      const changes = [];

      // --- 1. the thank-you line ---------------------------------------
      // Replace only the captured name, never the surrounding sentence.
      after = after.replace(/(Thank you for completing\s+)(.+?)(\s+with Starweaver)/i, (mm, a, name, b) => {
        if (key(name) === key(realTitle)) return mm;
        selfFixed = true; changes.push({ kind: 'self', from: dec(name), to: realTitle });
        return a + esc(realTitle) + b;
      }).replace(/(Gracias por completar\s+)(.+?)(\s+con Starweaver)/i, (mm, a, name, b) => {
        if (key(name) === key(realTitle)) return mm;
        selfFixed = true; changes.push({ kind: 'self', from: dec(name), to: realTitle });
        return a + esc(realTitle) + b;
      });

      // --- 2. recommendation anchor text --------------------------------
      // The href is captured and re-emitted verbatim — only the text changes.
      //
      // Two authoring styles are live: the 43 lectures generated from the
      // template use plain text inside the <a>, while the ~98 older ones wrap
      // it in <strong>. Rewrite the text in both, preserving the wrapper.
      // Anything else inside the anchor (an image, nested elements) is left
      // alone rather than guessed at.
      const WRAPPED = /^(\s*<(strong|em|b|i)>)([\s\S]*?)(<\/\2>\s*)$/i;
      after = after.replace(
        /(<a [^>]*href="https:\/\/www\.udemy\.com\/course\/([^/"?]+)[^"]*"[^>]*>)([\s\S]*?)(<\/a>)/gi,
        (mm, open, slug, inner, close) => {
          const real = titles[slug];
          if (!real) return mm;                       // destination we don't know
          const w = inner.match(WRAPPED);
          const text = w ? w[3] : inner;
          if (/<[a-z]/i.test(text)) return mm;        // still markup inside — skip
          if (key(text) === key(real)) return mm;
          recsFixed++; changes.push({ kind: 'rec', slug, from: dec(text), to: real });
          const rebuilt = w ? w[1] + esc(real) + w[4] : esc(real);
          return open + rebuilt + close;
        }
      );

      if (after === before) return { stage: 'unchanged' };

      // --- guards -------------------------------------------------------
      const hrefs = (s) => (s.match(/href="[^"]*"/g) || []);
      const hb = hrefs(before), ha = hrefs(after);
      if (hb.length !== ha.length || hb.some((h, k) => h !== ha[k])) return { stage: 'guard', detail: 'href changed', before };
      const links = (s) => (s.match(/https:\/\/www\.udemy\.com\/course\//g) || []).length;
      if (links(after) !== links(before)) return { stage: 'guard', detail: 'course-link count changed', before };
      const refs = (s) => (s.match(/referralCode=[A-Za-z0-9]+/g) || []).length;
      if (refs(after) !== refs(before)) return { stage: 'guard', detail: 'referral code count changed', before };
      const thanks = (s) => (s.match(/Thank you for completing|Gracias por completar/g) || []).length;
      if (thanks(after) !== thanks(before)) return { stage: 'guard', detail: 'thank-you line count changed', before };
      if (/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/i.test(after)) return { stage: 'guard', detail: 'double blank line', before };
      if (/&amp;amp;/.test(after)) return { stage: 'guard', detail: 'double-escaped ampersand', before };

      if (dry) return { stage: 'dry', selfFixed, recsFixed, changes, before, after };

      // Udemy rejects bodies containing course links unless warnings are
      // explicitly ignored — the same flag its own editor sends.
      const as = await J('POST', '/api-2.0/users/me/article-assets/', { body: after, ignore_warnings: true });
      if (as.status !== 201) return { stage: 'asset', status: as.status, detail: as.text, before };
      const ln = await J('PATCH', `/api-2.0/users/me/taught-courses/${cid}/lectures/${bonus.id}/`, { asset: as.json.id });
      if (ln.status !== 200) return { stage: 'link', status: ln.status, before };
      const v = await J('GET', `/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=body`);
      const liveBody = v.json?.asset?.body || '';
      return { stage: 'done', selfFixed, recsFixed, changes, matches: liveBody === after, before };
    }, { cid: c.realCourseId, realTitle: c.title, titles: titleBySlug, dry: DRY });

    // Transient failures (throttling, a page that wasn't ready) look exactly
    // like "nothing to do" unless they are retried explicitly.
    let r;
    for (let a = 0; a < 3; a++) {
      try { r = await attempt(); } catch (e) { r = { stage: 'retry', why: e.message.slice(0, 80) }; }
      if (r.stage !== 'retry') break;
      await sleep(3000 * (a + 1));
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 30000 }).catch(() => {});
      await sleep(1500);
    }
    if (r.stage === 'retry') r = { stage: 'failed', detail: r.why };

    Object.assign(rec, r);
    if (r.before) { backups.push({ courseId: c.realCourseId, title: c.title, body: r.before }); delete rec.before; }
    results.push(rec); save();

    const label = String(c.title).slice(0, 38);
    if (r.stage === 'unchanged') console.log(`${tag} ok (already current)        — ${label}`);
    else if (r.stage === 'dry') console.log(`${tag} would fix self=${r.selfFixed ? 'Y' : 'n'} recs=${r.recsFixed}   — ${label}`);
    else if (r.stage === 'done') console.log(`${tag} FIXED self=${r.selfFixed ? 'Y' : 'n'} recs=${r.recsFixed} verified=${r.matches} — ${label}`);
    else console.log(`${tag} ${r.stage}${r.detail ? ` (${r.detail})` : ''} — ${label}`);
  } catch (e) {
    rec.stage = 'error'; rec.error = e.message; results.push(rec); save();
    console.log(`${tag} error: ${e.message}`);
  }
}

await browser.close();

const by = (s) => results.filter((r) => r.stage === s).length;
const touched = results.filter((r) => r.stage === 'done' || r.stage === 'dry');
console.log(`\n${'='.repeat(62)}`);
console.log(`${DRY ? 'WOULD FIX' : 'FIXED'}      : ${touched.length}`);
console.log(`  self titles : ${touched.filter((r) => r.selfFixed).length}`);
console.log(`  rec labels  : ${touched.reduce((s, r) => s + (r.recsFixed || 0), 0)}`);
console.log(`already current: ${by('unchanged')}`);
for (const s of ['no-bonus', 'not-article', 'empty-body', 'guard', 'asset', 'link', 'error', 'failed', 'session-lost']) {
  if (by(s)) console.log(`${s.padEnd(15)}: ${by(s)}`);
}
if (!DRY) {
  const bad = results.filter((r) => r.stage === 'done' && !r.matches);
  console.log(bad.length ? `\n⚠️  ${bad.length} saved but did not verify byte-for-byte` : '\nAll writes verified byte-for-byte.');
  console.log(`backups: server/bonus-lecture-backups/bodies_before_title_fix.json`);
}
console.log('detail -> /tmp/bonus_title_fix_results.json');
