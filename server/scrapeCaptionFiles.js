// Downloads English (.vtt) caption files for every Udemy course, per lecture,
// using the connected session + a HEADED browser. Fast path: warm Cloudflare
// once, then in-page fetch (concurrent) for captions. Saves to caption-files/<slug>/.
// Resumable: skips lectures already downloaded. Run: npm run captions:files
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
// Which caption locale to download. Defaults to English so existing runs are
// unchanged; set SRC_LOCALE=es to pull Spanish instead (needed for the
// Spanish-language courses, which have no English caption to translate from).
const SRC_LOCALE = (process.env.SRC_LOCALE || 'en').toLowerCase();
const SRC_NAME = process.env.SRC_NAME || SRC_LOCALE;
// English keeps the original folder so nothing already downloaded is orphaned.
const OUT_DIR = join(__dirname, SRC_LOCALE === 'en' ? 'caption-files' : `caption-files-src-${SRC_LOCALE}`);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || 'untitled').replace(/[\/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90);

if (!existsSync(AUTH_FILE)) { console.error('❌ Not connected. Connect Udemy first.'); process.exit(1); }
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();

await minimizeWindow(ctx, page); // keep the automation window out of the user's way
// Same-origin JSON fetch from inside the page (carries cf_clearance).
const apiGet = (url) => page.evaluate(async (u) => {
  try { const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch { return null; }
}, url);

// Warm Cloudflare once via a real course page.
async function warm() { await page.goto('https://www.udemy.com/course/business-writing-immersion/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(3000); }
await warm();

// All courses.
const courses = [];
let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=published_title,title';
while (url) {
  const d = await apiGet(url);
  if (!d?.results) break;
  for (const c of d.results) if (c.id && c.published_title) courses.push({ id: c.id, slug: c.published_title });
  url = d.next || null;
}
// COURSE=slug[,slug] limits the run — needed to pilot one course rather than
// downloading captions for the whole catalogue.
const ONLY = (process.env.COURSE || '').split(',').map((x) => x.trim()).filter(Boolean);
if (ONLY.length) {
  const before = courses.length;
  courses.splice(0, courses.length, ...courses.filter((c) => ONLY.includes(c.slug)));
  console.log(`COURSE filter: ${courses.length} of ${before} course(s).`);
}
console.log(`Found ${courses.length} courses.`);

let totalFiles = 0;
for (let ci = 0; ci < courses.length; ci++) {
  const c = courses[ci];
  const dir = join(OUT_DIR, clean(c.slug));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const already = new Set(readdirSync(dir));

  // Full lecture list (owner sees all via public-curriculum-items).
  const lectures = [];
  let cu = `https://www.udemy.com/api-2.0/courses/${c.id}/public-curriculum-items/?page_size=200&fields[lecture]=id,title,asset&fields[asset]=id,asset_type`;
  while (cu) {
    let d = await apiGet(cu);
    if (d === null) { await warm(); d = await apiGet(cu); } // re-warm if CF dropped
    if (!d?.results) break;
    for (const it of d.results) if (it._class === 'lecture' && it.asset?.asset_type === 'Video') lectures.push(it);
    cu = d.next || null;
  }

  // Concurrently fetch each lecture's EN caption URL (chunks of 8).
  const ids = lectures.map((l) => l.id);
  const capUrl = {};
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8);
    const res = await page.evaluate(async ({ cid, chunk, loc, name, assetOf }) => {
      const out = {};
      const want = new RegExp('^' + loc, 'i');
      const pick = (caps) => (caps || []).find((c) => want.test(c.locale_id || ''))
        || (caps || []).find((c) => new RegExp(name, 'i').test(c.title || ''));
      await Promise.all(chunk.map(async (id) => {
        try {
          const r = await fetch(`https://www.udemy.com/api-2.0/users/me/subscribed-courses/${cid}/lectures/${id}/?fields[lecture]=asset&fields[asset]=captions&fields[caption]=url,locale_id,title`, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (r.ok) {
            const hit = pick((await r.json()).asset?.captions);
            if (hit?.url) { out[id] = hit.url; return; }
          }
          // The learner view only lists PUBLISHED captions. A caption still in
          // draft (status -1) is invisible there but perfectly downloadable via
          // the instructor endpoint — that gap silently cost 31 of 42 lectures
          // on ia-para-el-diagnostico. Fall back to the owner's own view.
          const aid = assetOf[id];
          if (!aid) return;
          const ir = await fetch(`https://www.udemy.com/api-2.0/courses/${cid}/assets/${aid}/captions/?fields[caption]=url,locale_id,title&page_size=50`, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!ir.ok) return;
          const hit2 = pick((await ir.json()).results);
          if (hit2?.url) out[id] = hit2.url;
        } catch {}
      }));
      return out;
    }, { cid: c.id, chunk, loc: SRC_LOCALE, name: SRC_NAME,
         assetOf: Object.fromEntries(lectures.map((l) => [l.id, l.asset?.id])) });
    Object.assign(capUrl, res);
    await sleep(120);
  }

  if (process.env.DEBUG_CAPS) console.log(`   [debug] ${lectures.length} lectures, ${Object.keys(capUrl).length} caption URLs resolved`);
  // Download the .vtt files (browser request context bypasses page CORS).
  let n = 0, dlFail = 0;
  for (let li = 0; li < lectures.length; li++) {
    const lec = lectures[li];
    const u = capUrl[lec.id];
    if (!u) continue;
    const fname = `${String(li + 1).padStart(3, '0')}-${clean(lec.title)}.vtt`;
    if (already.has(fname)) { n++; continue; }
    try { const r = await ctx.request.get(u); if (r.ok()) { writeFileSync(join(dir, fname), await r.text()); n++; totalFiles++; } else { dlFail++; } } catch { dlFail++; }
  }
  console.log(`[${ci + 1}/${courses.length}] ${clean(c.slug)} — ${n}/${lectures.length} ${SRC_LOCALE.toUpperCase()} captions (total ${totalFiles})${dlFail ? ` · ${dlFail} download(s) failed` : ''}`);
  await sleep(200);
}

await browser.close();
console.log(`\n✅ Done. ${totalFiles} English .vtt files → caption-files/`);
