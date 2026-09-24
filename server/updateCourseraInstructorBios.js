// Replace the `bio` on Coursera instructor profiles.
//
// Same mechanism as updateCourseraInstructorLinks.js: the partner console hides
// this, but the course-scoped editor at
//   /teach/{courseSlug}/course/settings/course-staff/profile/{instructorId}
// is backed by instructorProfiles.v1, and PUT there is accepted with our session.
//
// ONLY `bio` is changed. The whole profile object is read, that one field is
// swapped, everything else is re-sent verbatim; after the write the profile is
// re-read and compared field by field, and anything other than `bio` differing
// is reported as a failure. Every original is backed up before its first write.
//
// Bios are stored as PLAIN TEXT with \n\n paragraph breaks — not HTML.
//
// Input: JSON array of { id, name, slug, bio }
// Run: node updateCourseraInstructorBios.js <todo.json> [--dry-run] [--limit=N]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimizeWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const file = process.argv[2];
if (!file || !existsSync(file)) { console.error('Usage: node updateCourseraInstructorBios.js <todo.json> [--dry-run] [--limit=N]'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');
const lim = process.argv.find((a) => a.startsWith('--limit='));
const todo = JSON.parse(readFileSync(file, 'utf8')).slice(0, lim ? Number(lim.split('=')[1]) : Infinity);

const BACKUP = join(__dirname, 'coursera-bio-backups.json');
const backups = existsSync(BACKUP) ? JSON.parse(readFileSync(BACKUP, 'utf8')) : [];
const backedUp = new Set(backups.map((b) => String(b.id)));
const results = [];
const save = () => {
  writeFileSync(BACKUP, JSON.stringify(backups, null, 1));
  writeFileSync('/tmp/coursera_bio_updates.json', JSON.stringify(results, null, 1));
};

console.log(`${DRY ? '[DRY RUN] ' : ''}${todo.length} instructor bio(s)\n`);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'coursera-auth.json'), userAgent: UA });
const page = await ctx.newPage();
await minimizeWindow(ctx, page);

for (let i = 0; i < todo.length; i++) {
  const t = todo[i];
  const tag = `${String(i + 1).padStart(2)}/${todo.length}`;
  const rec = { id: t.id, name: t.name, newWords: String(t.bio).split(/\s+/).filter(Boolean).length, stage: null };
  try {
    await page.goto(`https://www.coursera.org/teach/${t.slug}/course/settings/course-staff/profile/${t.id}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => /CSRF3-Token=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
    await sleep(3000);
    if (/\/login|authMode=login/.test(page.url())) {
      rec.stage = 'session-lost'; results.push(rec); save();
      console.log(`\n❌ ${tag} session lost — reconnect Coursera and re-run`); break;
    }

    const r = await page.evaluate(async ({ id, newBio, dry }) => {
      const csrf = document.cookie.match(/CSRF3-Token=([^;]+)/)?.[1] || '';
      const H = { 'Content-Type': 'application/json', 'X-CSRF3-Token': csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
      const U = `https://www.coursera.org/api/instructorProfiles.v1/${id}`;
      const get = async () => (await (await fetch(U, { credentials: 'include', headers: { Accept: 'application/json' } })).json()).elements?.[0];

      const before = await get();
      if (!before) return { stage: 'no-profile' };
      if ((before.bio || '') === newBio) return { stage: 'already-set', before };
      if (dry) return { stage: 'dry', before, oldWords: (before.bio || '').split(/\s+/).filter(Boolean).length };

      const body = JSON.parse(JSON.stringify(before));
      delete body.id;
      body.bio = newBio;
      const put = await fetch(U, { method: 'PUT', credentials: 'include', headers: H, body: JSON.stringify(body) });
      if (!put.ok) return { stage: 'put-failed', status: put.status, detail: (await put.text()).slice(0, 200), before };

      await new Promise((x) => setTimeout(x, 1500));
      const after = await get();
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after || {})])];
      const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after?.[k]));
      return { stage: 'done', before, saved: after?.bio || '', onlyBio: changed.length === 1 && changed[0] === 'bio', changed };
    }, { id: t.id, newBio: t.bio, dry: DRY });

    Object.assign(rec, { stage: r.stage, onlyBio: r.onlyBio, changed: r.changed, detail: r.detail, status: r.status, oldWords: r.oldWords });
    if (r.before && !backedUp.has(String(t.id))) {
      backups.push({ id: t.id, name: t.name, capturedAt: new Date().toISOString(), bio: r.before.bio, profile: r.before });
      backedUp.add(String(t.id));
    }
    rec.savedWords = r.saved ? r.saved.split(/\s+/).filter(Boolean).length : null;
    rec.ok = DRY ? r.stage === 'dry' : (r.stage === 'done' && r.saved === t.bio && r.onlyBio);
    results.push(rec); save();

    const label = String(t.name).slice(0, 22).padEnd(24);
    if (r.stage === 'dry') console.log(`   ${tag} would update ${label} ${r.oldWords}w -> ${rec.newWords}w`);
    else if (r.stage === 'already-set') console.log(`   ${tag} already set  ${label}`);
    else console.log(`${rec.ok ? '✅' : '⚠️ '} ${tag} ${label} ${rec.savedWords}w${rec.ok ? '' : ' — ' + JSON.stringify({ stage: r.stage, status: r.status, onlyBio: r.onlyBio, changed: r.changed, detail: String(r.detail || '').slice(0, 80) })}`);
  } catch (e) {
    rec.stage = 'error'; rec.error = String(e.message).slice(0, 140); results.push(rec); save();
    console.log(`❌ ${tag} ${t.name} — ${rec.error}`);
  }
  await sleep(900);
}
await browser.close();

const good = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(56)}`);
console.log(`${DRY ? 'would update' : 'updated'}: ${good}/${todo.length}`);
for (const s of ['already-set', 'put-failed', 'no-profile', 'error', 'session-lost']) {
  const n = results.filter((r) => r.stage === s).length;
  if (n) console.log(`${s.padEnd(14)}: ${n}`);
}
if (!DRY) console.log(`\nbackups: server/coursera-bio-backups.json (${backups.length} profiles)`);
console.log('detail -> /tmp/coursera_bio_updates.json');
