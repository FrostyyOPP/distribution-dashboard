// Remove the X / Facebook / Instagram links from the "Stay Connected" block of
// every course's bonus lecture, leaving Website + LinkedIn, and tighten the
// spacing so nothing renders with a gap where a link used to be.
//
// Idempotent: re-running finds nothing to remove and reports "already-clean".
// Resumable: progress is kept in social-removal-results.json, so a crash or a
// dead browser costs you one course, not the run.
//
//   node removeSocialLinks.js --dry-run   # offline preview, needs AUDIT_JSON
//   node removeSocialLinks.js --limit=1   # canary: stop after one live write
//   node removeSocialLinks.js             # live, writes to Udemy
//
// Env: PW_CHANNEL=msedge drives the system Edge (the bundled Chromium fails to
// launch on some Windows boxes with a side-by-side configuration error).
//
// Every original body is written to bonus-lecture-backups/ BEFORE its course is
// modified, so a bad run can always be reversed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transform, check } from './bonusSocialTransform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
// --limit=N stops after N courses are actually updated (canary runs).
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BACKUP_DIR = join(__dirname, 'bonus-lecture-backups');
const BACKUP_FILE = join(BACKUP_DIR, 'bodies_before_social_removal.json');
const RESULTS_FILE = join(__dirname, 'social-removal-results.json');
const SOCIAL = /facebook\.com|instagram\.com|\/\/x\.com/i;

// --- dry run: no browser, replay against a saved audit ---------------------
if (DRY) {
  const src = process.env.AUDIT_JSON;
  if (!src || !existsSync(src)) { console.error('set AUDIT_JSON to an audit file'); process.exit(1); }
  const R = JSON.parse(readFileSync(src, 'utf8'));
  const arts = R.filter((r) => !r.noBonus && !r.err && r.assetType === 'Article' && r.body);
  let changed = 0, clean = 0, failed = 0; let sample = null;
  for (const r of arts) {
    if (!SOCIAL.test(r.body)) { clean++; continue; }
    const after = transform(r.body);
    const bad = check(r.body, after);
    if (bad.length) { failed++; console.log(`FAIL ${r.title}: ${bad.join(', ')}`); continue; }
    changed++;
    if (!sample) sample = { r, after };
  }
  console.log(`\n[DRY RUN] articles=${arts.length} would-change=${changed} nothing-to-do=${clean} guard-failures=${failed}`);
  if (sample) {
    const cut = (s) => s.slice(s.search(/<p><strong>(?:Stay Connected|Mantente conectado)<\/strong><\/p>/i)).replace(/<\/p>/gi, '</p>\n');
    console.log(`\n--- BEFORE (${sample.r.title}) ---\n${cut(sample.r.body)}`);
    console.log(`--- AFTER ---\n${cut(sample.after)}`);
  }
  process.exit(0);
}

// --- live run --------------------------------------------------------------
const { chromium } = await import('playwright');
const { minimizeWindow } = await import('./browserWindow.js');

// The browser has died mid-run more than once on Windows, so keep it
// replaceable and rebuild it on demand rather than losing the rest of the queue.
let browser, ctx, page;
async function launch() {
  browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || undefined,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  page = await ctx.newPage();
  await minimizeWindow(ctx, page);
}
const isDead = (e) => /Target page, context or browser has been closed|Target closed|browser has been closed|Protocol error/i.test(String(e));
async function revive() {
  console.log('\n  browser died - relaunching');
  try { await browser?.close(); } catch {}
  await launch();
  await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(4000);
}

await launch();
await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(5000);
if (/login|join\/passwordless/.test(page.url())) { console.error('SESSION LOST - reconnect Udemy first.'); await browser.close(); process.exit(1); }

const courses = await page.evaluate(async () => {
  const out = [];
  let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=title,is_published';
  while (url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) break;
    const j = await r.json();
    for (const c of j.results || []) out.push({ id: c.id, title: c.title });
    url = j.next || null;
  }
  return out;
});
console.log(`courses: ${courses.length}`);

mkdirSync(BACKUP_DIR, { recursive: true });
const results = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : [];
const backups = existsSync(BACKUP_FILE) ? JSON.parse(readFileSync(BACKUP_FILE, 'utf8')) : [];
const done = new Set(results.map((r) => r.courseId));
console.log(`resuming: ${done.size} already processed`);
const save = () => { writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 1)); writeFileSync(BACKUP_FILE, JSON.stringify(backups, null, 1)); };

for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  if (done.has(c.id)) continue;
  const tag = `${i + 1}/${courses.length} ${String(c.title).slice(0, 44)}`;
  const rec = { courseId: c.id, title: c.title, ok: false, stage: null };
  try {
    await page.goto(`https://www.udemy.com/course/${c.id}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3800);
    if (/login|join\/passwordless/.test(page.url())) { console.log(`\nSESSION LOST at ${tag}`); break; }

    // READ in the page (same-origin XHR gets past Cloudflare)...
    const read = await page.evaluate(async ({ cid }) => {
      const J = async (u) => { const res = await fetch(`https://www.udemy.com${u}`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: res.status, json: j }; };
      const cu = await J(`/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=500&fields[lecture]=title`);
      const bonus = (cu.json?.results || []).find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (!bonus) return { stage: 'no-bonus' };
      const lec = await J(`/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
      if (lec.json?.asset?.asset_type !== 'Article') return { stage: 'not-article' };
      return { stage: 'read', bonusId: bonus.id, before: lec.json?.asset?.body || '' };
    }, { cid: c.id });

    let r = read;
    if (read.stage === 'read') {
      const before = read.before;
      if (!before) r = { stage: 'empty-body' };
      else if (!SOCIAL.test(before)) r = { stage: 'already-clean' };
      else {
        // ...TRANSFORM in Node. Serialising these functions into the page was
        // the original bug: check() referenced a helper that did not travel.
        const after = transform(before);
        const bad = check(before, after);
        if (bad.length) r = { stage: 'guard', detail: bad.join(', ') };
        else {
          // Back the original up BEFORE the write, not after.
          backups.push({ courseId: c.id, title: c.title, lectureId: read.bonusId, before });
          save();
          // ...then WRITE from the page.
          r = await page.evaluate(async ({ cid, lid, body }) => {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
            const H = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' };
            const J = async (m, u, p) => { const o = { method: m, credentials: 'include', headers: H }; if (p !== undefined) o.body = JSON.stringify(p);
              const res = await fetch(`https://www.udemy.com${u}`, o); const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
              return { status: res.status, json: j, text: t.slice(0, 200) }; };
            const as = await J('POST', '/api-2.0/users/me/article-assets/', { body, ignore_warnings: true });
            if (as.status !== 201) return { stage: 'asset', detail: `${as.status} ${as.text}` };
            const ln = await J('PATCH', `/api-2.0/users/me/taught-courses/${cid}/lectures/${lid}/`, { asset: as.json.id });
            if (ln.status !== 200) return { stage: 'link', detail: String(ln.status) };
            const v = await J('GET', `/api-2.0/users/me/subscribed-courses/${cid}/lectures/${lid}/?fields[lecture]=asset&fields[asset]=body`);
            const live = v.json?.asset?.body || '';
            return { stage: 'done', matches: live === body, residue: /facebook\.com|instagram\.com|\/\/x\.com/i.test(live) };
          }, { cid: c.id, lid: read.bonusId, body: after });
        }
      }
    }

    rec.stage = r.stage;
    rec.ok = r.stage === 'done' ? (r.matches && !r.residue) : r.stage === 'already-clean';
    const icon = rec.ok ? (r.stage === 'already-clean' ? '.' : 'OK') : '!!';
    if (!rec.ok || r.stage !== 'done') console.log(`${icon} ${tag} - ${r.stage}${r.detail ? ': ' + r.detail : ''}`);
    else process.stdout.write(`\rOK ${tag}                    `);
  } catch (e) {
    if (isDead(e)) { await revive().catch(() => {}); i--; continue; } // retry this course on a fresh browser
    rec.stage = String(e).slice(0, 140); console.log(`\nERR ${tag} - ${rec.stage}`);
  }
  results.push(rec); save();
  if (results.filter((x) => x.stage === 'done').length >= LIMIT) { console.log(`\n[--limit=${LIMIT} reached]`); break; }
  await sleep(300);
}

process.stdout.write('\n');
const ok = results.filter((r) => r.ok && r.stage === 'done').length;
const skipped = results.filter((r) => r.stage === 'already-clean').length;
console.log(`\nDONE: updated ${ok} - already clean ${skipped} - total processed ${results.length}`);
results.filter((r) => !r.ok).forEach((r) => console.log(`  NOT UPDATED: ${r.title} - ${r.stage}`));
await browser.close();
