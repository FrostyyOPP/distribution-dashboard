// Uploads translated .vtt caption files back to Udemy as captions for a locale.
// Flow (reverse-engineered from Udemy Studio):
//   1) POST /api-2.0/s3-upload-signatures/   {expiration, conditions}  -> {policy, signature}
//   2) POST https://udemy-web-upload-transitional.s3.amazonaws.com/    (multipart form + file)
//   3) POST /api-2.0/courses/{cid}/assets/{assetId}/draft-captions/    {locale_id, asset, file_name, uuid, title, bucket}
//   4) poll GET .../draft-captions/{id}/  until published_caption_id  (auto-publishes)
//
// Runs in a HEADED browser so all calls inherit your session + CSRF + S3 CORS.
// Maps each caption-files-<code>/<course>/NNN-<title>.vtt -> its lecture's assetId
// by re-reading the course's video-lecture order (same order the download used).
//
// Env:
//   COURSE      course slug (required)         e.g. capital-market-immersion
//   LANG_CODE   Udemy locale id (default es_LA)
//   SRC         source dir (default caption-files-<lang-prefix>, see below)
//   MAX         cap number of uploads (use MAX=1 for the single-lecture test)
//   DRY_RUN=1   only print the file->asset mapping; make NO writes
//   UDEMY_AWS_KEY   the AWSAccessKeyId from the real S3 upload form (required for real runs)
//
// Run test:  COURSE=<slug> MAX=1 DRY_RUN=1 npm run captions:upload   (safe, reads only)
//     then:  COURSE=<slug> MAX=1 UDEMY_AWS_KEY=... npm run captions:upload   (one real upload)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LANG_CODE = process.env.LANG_CODE || 'es_LA';
const CODE_PREFIX = LANG_CODE.split('_')[0];               // es_LA -> es -> caption-files-es
const SRC = process.env.SRC || join(__dirname, `caption-files-${CODE_PREFIX}`);
const COURSE = process.env.COURSE;
const MAX = process.env.MAX ? Number(process.env.MAX) : Infinity;
const DRY = process.env.DRY_RUN === '1';
// Udemy's static bucket-uploader key (public: browser sends it on every caption upload).
const AWS_KEY = process.env.UDEMY_AWS_KEY || 'AKIA5IZMAQTGTLHQJLAD';
const BUCKET = 'udemy-web-upload-transitional';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!COURSE) { console.error('❌ Set COURSE=<course-slug>'); process.exit(1); }
const srcDir = join(SRC, COURSE);
if (!existsSync(srcDir)) { console.error(`❌ No translated files at ${srcDir}`); process.exit(1); }
// AWSAccessKeyId comes from the signatures response at runtime; UDEMY_AWS_KEY is an optional fallback.

const files = readdirSync(srcDir).filter((f) => f.endsWith('.vtt')).sort();
console.log(`Course ${COURSE}: ${files.length} translated ${LANG_CODE} files. ${DRY ? '(DRY RUN — no writes)' : ''}`);

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
const apiGet = (u) => page.evaluate(async (x) => { try { const r = await fetch(x, { credentials: 'include', headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch { return null; } }, u);
await page.goto(`https://www.udemy.com/course/${COURSE}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await sleep(3000);

// resolve courseId by slug
let courseId = null;
let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=published_title';
while (url && !courseId) {
  const d = await apiGet(url); if (!d?.results) break;
  const hit = d.results.find((c) => c.published_title === COURSE);
  if (hit) courseId = hit.id; url = d.next || null;
}
if (!courseId) { console.error('❌ Course not found in your taught-courses.'); await browser.close(); process.exit(1); }

// video lectures in order -> assetId (reproduces the download's NNN index)
const lectures = [];
let cu = `https://www.udemy.com/api-2.0/courses/${courseId}/public-curriculum-items/?page_size=200&fields[lecture]=id,title,asset&fields[asset]=asset_type,id`;
while (cu) { const d = await apiGet(cu); if (!d?.results) break;
  for (const it of d.results) if (it._class === 'lecture' && it.asset?.asset_type === 'Video') lectures.push({ id: it.id, assetId: it.asset.id, title: it.title });
  cu = d.next || null;
}
console.log(`courseId=${courseId}, video lectures=${lectures.length}`);

// upload one file (in-page so S3 CORS + session + CSRF all apply)
async function uploadOne(vttText, filename, assetId) {
  return page.evaluate(async ({ vttText, filename, assetId, LANG_CODE, BUCKET, AWS_KEY }) => {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const uuid = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random().toString(16).slice(2));
    const key = uuid + '.vtt';
    const metaName = encodeURIComponent(filename);
    const exp = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const conditions = [
      { acl: 'private' }, { bucket: BUCKET }, { 'Content-Type': 'text/vtt' },
      { success_action_status: '200' }, { key }, { 'x-amz-meta-qqfilename': metaName },
      ['content-length-range', '1', '4000000000'],
    ];
    // 1) sign
    const sigRes = await fetch('https://www.udemy.com/api-2.0/s3-upload-signatures/', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf },
      body: JSON.stringify({ expiration: exp, conditions }),
    });
    const sig = await sigRes.json().catch(() => ({}));
    if (!sigRes.ok) return { step: 'sign', status: sigRes.status, sig };
    // 2) S3 multipart POST
    const fd = new FormData();
    fd.append('key', key);
    fd.append('acl', 'private');
    fd.append('Content-Type', 'text/vtt');
    fd.append('success_action_status', '200');
    fd.append('x-amz-meta-qqfilename', metaName);
    fd.append('AWSAccessKeyId', sig.AWSAccessKeyId || sig.access_key || AWS_KEY);
    fd.append('policy', sig.policy);
    fd.append('signature', sig.signature);
    fd.append('file', new Blob([vttText], { type: 'text/vtt' }), filename);
    const s3 = await fetch(`https://${BUCKET}.s3.amazonaws.com/`, { method: 'POST', body: fd });
    if (!(s3.status === 200 || s3.status === 201 || s3.status === 204)) return { step: 's3', status: s3.status, body: (await s3.text()).slice(0, 400), sigKeys: Object.keys(sig) };
    // 3) register draft caption
    const dc = await fetch(`https://www.udemy.com/api-2.0/courses/${window.__CID}/assets/${assetId}/draft-captions/?fields[draft_caption]=locale,title,url,source,status`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRFToken': csrf },
      body: JSON.stringify({ locale_id: LANG_CODE, asset: assetId, file_name: key, uuid, title: filename, bucket: BUCKET }),
    });
    const draft = await dc.json().catch(() => ({}));
    if (!dc.ok) return { step: 'draft', status: dc.status, draft };
    // 4) poll publish
    let pub = null;
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`https://www.udemy.com/api-2.0/courses/${window.__CID}/assets/${assetId}/draft-captions/${draft.id}/?fields[draft_caption]=status,published_caption_id`, { credentials: 'include', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (j.published_caption_id) { pub = j.published_caption_id; break; }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return { step: 'done', draftId: draft.id, published_caption_id: pub };
  }, { vttText, filename, assetId, LANG_CODE, BUCKET, AWS_KEY });
}
await page.evaluate((cid) => { window.__CID = cid; }, courseId);

// Each file spends a few seconds uploading, then waits up to 50s (25 polls x 2s)
// for Udemy to finish publishing. Run one at a time, that idle wait IS the
// runtime (~1 min/lecture). The waits are independent, so overlap them.
// Work order no longer matters; results print in file order at the end.
const CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 6);
const queue = [];
for (const file of files) {
  if (queue.length >= MAX) break;
  const idx = parseInt(file.slice(0, 3), 10);          // NNN prefix -> 1-based lecture index
  const lec = lectures[idx - 1];
  if (!lec) { console.log(`  ? ${file} -> no lecture at index ${idx} (skip)`); continue; }
  queue.push({ file, lec, title: file.replace(/^\d+-/, '') });
}
console.log(`  ${queue.length} file(s)${DRY ? ' (dry run)' : `, ${CONCURRENCY} at a time`}\n`);

let ok = 0, failed = 0, finished = 0, cursor = 0;
const out = new Array(queue.length);
async function worker() {
  for (;;) {
    const k = cursor++;
    if (k >= queue.length) return;
    const { file, lec, title } = queue[k];
    if (DRY) { out[k] = `  ${file}  ->  lecture "${(lec.title || '').slice(0, 40)}"  asset ${lec.assetId}`; ok++; continue; }
    const res = await uploadOne(readFileSync(join(srcDir, file), 'utf8'), title, lec.assetId)
      .catch((e) => ({ step: 'threw', status: String(e.message).slice(0, 80) }));
    let line = `  ${file}  ->  asset ${lec.assetId}\n`;
    if (res.step === 'done' && res.published_caption_id) { line += `     published caption ${res.published_caption_id}`; ok++; }
    else { line += `     FAILED at ${res.step} (status ${res.status})`; failed++; }
    out[k] = line;
    finished++;
    if (finished % 5 === 0 || finished === queue.length) console.log(`     ... ${finished}/${queue.length} (${ok} ok, ${failed} failed)`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
out.filter(Boolean).forEach((l) => console.log(l));
console.log(`\n${DRY ? 'DRY RUN mapped' : 'Uploaded'} ${ok} file(s)${failed ? `, ${failed} failed` : ''}.`);
await browser.close();
