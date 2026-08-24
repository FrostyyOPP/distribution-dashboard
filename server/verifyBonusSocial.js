// Independent cross-check: re-read EVERY course's bonus lecture straight from
// Udemy and confirm the social links are gone and nothing else broke. Does not
// trust removeSocialLinks.js's own report — it re-fetches the live bodies.
//
//   PW_CHANNEL=msedge node verifyBonusSocial.js
//
// Writes verify-bonus-social.json (per-course detail) and prints a summary.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { minimizeWindow } from './browserWindow.js';
import { danglingBreaks } from './bonusSocialTransform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'verify-bonus-social.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser, ctx, page;
async function launch() {
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: false,
    args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
  ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  page = await ctx.newPage();
  await minimizeWindow(ctx, page);
  await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(4500);
}
const isDead = (e) => /Target page, context or browser has been closed|Target closed|Protocol error/i.test(String(e));
await launch();
if (/login|join\/passwordless/.test(page.url())) { console.error('SESSION LOST'); await browser.close(); process.exit(1); }

const courses = await page.evaluate(async () => {
  const out = []; let url = 'https://www.udemy.com/api-2.0/users/me/taught-courses/?page_size=100&fields[course]=title,is_published';
  while (url) { const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } }); if (!r.ok) break;
    const j = await r.json(); for (const c of j.results || []) out.push({ id: c.id, title: c.title, published: c.is_published }); url = j.next || null; }
  return out;
});
console.log(`checking ${courses.length} courses`);

const rows = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const done = new Set(rows.map((r) => r.id));

for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  if (done.has(c.id)) continue;
  try {
    const r = await page.evaluate(async ({ cid }) => {
      const J = async (u) => { const res = await fetch(`https://www.udemy.com${u}`, { credentials: 'include', headers: { Accept: 'application/json' } });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {} return j; };
      const cu = await J(`/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=500&fields[lecture]=title`);
      const bonus = (cu?.results || []).find((x) => x._class === 'lecture' && /bonus/i.test(x.title || ''));
      if (!bonus) return { state: 'no-bonus' };
      const lec = await J(`/api-2.0/users/me/subscribed-courses/${cid}/lectures/${bonus.id}/?fields[lecture]=asset&fields[asset]=asset_type,body`);
      if (lec?.asset?.asset_type !== 'Article') return { state: 'not-article', assetType: lec?.asset?.asset_type };
      return { state: 'article', body: lec?.asset?.body || '' };
    }, { cid: c.id });

    const row = { id: c.id, title: c.title, published: c.published, state: r.state, problems: [] };
    if (r.state === 'article') {
      const b = r.body;
      if (/facebook\.com/i.test(b)) row.problems.push('facebook link STILL PRESENT');
      if (/instagram\.com/i.test(b)) row.problems.push('instagram link STILL PRESENT');
      if (/\/\/x\.com/i.test(b)) row.problems.push('x.com link STILL PRESENT');
      // Only meaningful for bodies that carry the Starweaver footer at all.
      if (/Stay Connected|Mantente conectado/i.test(b)) {
        if (!/starweaver\.com/i.test(b)) row.problems.push('website link missing');
        if (!/linkedin\.com/i.test(b)) row.problems.push('linkedin link missing');
        if (!/paulsiegel2/i.test(b)) row.problems.push('udemy profile link missing');
      }
      if (/<p>\s*<\/p>/i.test(b)) row.problems.push('empty paragraph');
      if (/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/i.test(b)) row.problems.push('double blank line');
      if (/\s+<\/p>/i.test(b)) row.problems.push('trailing space before </p>');
      if (/LinkedIn-\s*</i.test(b)) row.problems.push('unspaced "LinkedIn-"');
      const dangling = danglingBreaks(b);
      if (dangling.length) row.problems.push(`dangling <br> at paragraph end (x${dangling.length})`);
      const m = b.match(/<p><strong>(?:Stay Connected|Mantente conectado)<\/strong><\/p>[\s\S]*?(?=<p><br><\/p>|<p>(?:Thank you for being|¡Gracias por ser))/i);
      row.footer = m ? m[0] : null;
    }
    rows.push(row);
    const bad = row.problems.length;
    if (bad || row.state !== 'article') console.log(`${bad ? 'XX' : '..'} ${i + 1}/${courses.length} ${c.title.slice(0, 44)} - ${row.state}${bad ? ': ' + row.problems.join(', ') : ''}`);
    else process.stdout.write(`\rOK ${i + 1}/${courses.length}                    `);
  } catch (e) {
    if (isDead(e)) { console.log('\n  relaunching'); try { await browser?.close(); } catch {} await launch(); i--; continue; }
    rows.push({ id: c.id, title: c.title, state: 'error', problems: [String(e).slice(0, 120)] });
  }
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  await sleep(200);
}
process.stdout.write('\n');

const art = rows.filter((r) => r.state === 'article');
const clean = art.filter((r) => !r.problems.length);
const dirty = art.filter((r) => r.problems.length);
console.log(`\n=== CROSS-CHECK ===`);
console.log(`courses            ${rows.length}`);
console.log(`  article bonus    ${art.length}`);
console.log(`  no bonus lecture ${rows.filter((r) => r.state === 'no-bonus').length}`);
console.log(`  not an article   ${rows.filter((r) => r.state === 'not-article').length}`);
console.log(`  fetch errors     ${rows.filter((r) => r.state === 'error').length}`);
console.log(`\nCLEAN  ${clean.length}/${art.length}`);
console.log(`ISSUES ${dirty.length}`);
dirty.forEach((r) => console.log(`   - ${r.title} :: ${r.problems.join(', ')}`));
const footers = new Map();
art.forEach((r) => { if (r.footer) footers.set(r.footer, (footers.get(r.footer) || 0) + 1); });
console.log(`\nDISTINCT "Stay Connected" FOOTERS: ${footers.size}`);
[...footers.entries()].sort((a, b) => b[1] - a[1]).forEach(([f, n], i) => {
  console.log(`\n[${i + 1}] ${n} course(s)`);
  console.log(f.replace(/<\/p>/gi, '</p>\n').replace(/^/gm, '    '));
});
await browser.close();
