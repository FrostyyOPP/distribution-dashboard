// Create a Udemy course SHELL (a private draft) from a content file:
// landing page, intended learners, and an ordered curriculum of sections,
// empty video lectures and article lectures. Never publishes or submits the course.
//
// The course itself is created through Udemy's own 4-step create form; the
// rest goes through the instructor endpoints the curriculum editor uses (the
// lecture + article-asset calls are the ones createBonusLecture.js verified).
// Every write is read back.
//
// Run:  node createUdemyShell.js <content.json> [--course-id N]
//       --course-id fills an existing draft instead of creating one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = process.argv[2];
const argId = process.argv.includes('--course-id') ? Number(process.argv[process.argv.indexOf('--course-id') + 1]) : null;
const C = JSON.parse(readFileSync(src, 'utf8'));
const fail = async (msg) => { console.error('❌ ' + msg); await browser.close(); process.exit(1); };

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA, viewport: { width: 1300, height: 900 } });
const page = await ctx.newPage();
await parkWindow(ctx, page);

const api = (m, u, b) => page.evaluate(async ([m, u, b]) => {
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  const r = await fetch('https://www.udemy.com' + u, { method: m, credentials: 'include',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
    body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, [m, u, b]);

await page.goto('https://www.udemy.com/instructor/courses/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
await sleep(6000);
if (/join\/passwordless|\/login/.test(page.url())) await fail('Udemy session lost — reconnect Udemy in the dashboard.');

// ── 1. the course ─────────────────────────────────────────────────────────
let cid = argId;
if (!cid) {
  // Never a second copy: stop if a course with this title already exists.
  for (let p = 1; p <= 10; p++) {
    const r = await api('GET', `/api-2.0/users/me/taught-courses/?page=${p}&page_size=100&fields[course]=id,title`);
    const hit = (r.json?.results || []).find((c) => c.title.trim().toLowerCase() === C.title.toLowerCase());
    if (hit) await fail(`A course titled "${hit.title}" already exists (id ${hit.id}). Re-run with --course-id ${hit.id} to fill it.`);
    if (!r.json?.next) break;
  }
  const clickText = async (re) => { const l = page.getByText(re).first(); await l.waitFor({ timeout: 15000 }); await l.click(); };
  const cont = async () => { await page.getByRole('button', { name: /^Continue$/ }).click(); await sleep(2500); };
  await page.goto('https://www.udemy.com/course/create/1', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  const reject = page.getByRole('button', { name: 'Reject All' });
  if (await reject.isVisible().catch(() => false)) { await reject.click(); await sleep(800); }
  await clickText(/^Course$/); await cont();                                            // 1: type
  await page.locator('input[type="text"]').first().fill(C.title); await sleep(500); await cont(); // 2: title
  await page.locator('select').first().selectOption({ label: 'Business' }); await sleep(500); await cont(); // 3: category
  await page.locator('input[type="radio"]').first().check({ force: true }); await sleep(500); // 4: time commitment
  await page.getByRole('button', { name: /Create Course/i }).click();
  await page.waitForURL(/\/course\/\d+\/manage\//, { timeout: 60000 }).catch(() => {});
  cid = Number((page.url().match(/\/course\/(\d+)\/manage\//) || [])[1]);
  if (!cid) await fail(`Create form did not land on a course (at ${page.url()}).`);
  console.log(`✅ created draft course ${cid}`);
  await sleep(3000);
}

const course = await api('GET', `/api-2.0/courses/${cid}/?fields[course]=title,is_published,status_label`);
if (course.status !== 200) await fail(`Cannot read course ${cid}: ${course.status}`);
if (course.json.is_published) await fail(`Course ${cid} is published — this script only fills drafts.`);
console.log(`course ${cid}: "${course.json.title}" (${course.json.status_label})`);

// ── 2. landing page + intended learners ───────────────────────────────────
const F = 'title,headline,description,instructional_level,primary_category,primary_subcategory,what_you_will_learn_data,requirements_data,who_should_attend_data,locale';
const read = async () => (await api('GET', `/api-2.0/courses/${cid}/?fields[course]=${F}&fields[course_category]=id&fields[course_subcategory]=id`)).json;
const patch = async (label, body) => {
  const r = await api('PATCH', `/api-2.0/courses/${cid}/`, body);
  console.log(`${r.status < 300 ? '  ok ' : '  !! '} ${label} → ${r.status}${r.status < 300 ? '' : ' ' + r.text}`);
  return r.status < 300;
};
await patch('headline + description', { headline: C.headline, description: C.description });
await patch('intended learners', {
  what_you_will_learn_data: { items: C.objectives },
  requirements_data: { items: C.requirements },
  who_should_attend_data: { items: C.audience },
});
// Category and subcategory are written as category_id / subcategory_id — the
// primary_category* names read back but do not save (tried 2026-09-28).
await patch('category', { category_id: C.categoryId, subcategory_id: C.subcategoryId });
// The level's id is not documented; find the one that reads back as the wanted level.
let lv = await read();
for (let id = 1; id <= 4 && !new RegExp(C.level, 'i').test(lv.instructional_level || ''); id++) {
  await api('PATCH', `/api-2.0/courses/${cid}/`, { instructional_level_id: id });
  lv = await read();
}
console.log(`  level → "${lv.instructional_level}"`);

// ── 3. curriculum ─────────────────────────────────────────────────────────
const existing = await api('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=200&fields[chapter]=title&fields[lecture]=title`);
const items = existing.json?.results || [];
// A new course comes with Udemy's placeholder: one "Introduction" section holding
// one "Introduction" lecture. That is reused as the first section and lecture;
// anything else already there means the curriculum was started, and is left alone.
const placeholder = items.length === 2 && items[0]._class === 'chapter' && items[1]._class === 'lecture'
  && items.every((x) => x.title === 'Introduction');
if (items.length && !placeholder) {
  console.log(`  curriculum already has ${items.length} item(s) — not adding a second copy.`);
} else {
  const base = `/api-2.0/users/me/taught-courses/${cid}`;
  for (const [si, s] of C.sections.entries()) {
    if (si === 0 && placeholder) {
      const ch = await api('PATCH', `${base}/chapters/${items[0].id}/`, { title: s.title, description: s.objective });
      if (ch.status !== 200) await fail(`rename placeholder section → ${ch.status} ${ch.text}`);
    } else {
      const ch = await api('POST', `${base}/chapters/`, { title: s.title, description: s.objective });
      if (ch.status !== 201) await fail(`section "${s.title}" → ${ch.status} ${ch.text}`);
    }
    for (const [ii, it] of s.items.entries()) {
      const fields = it.kind === 'video' ? { title: it.title, description: it.description } : { title: it.title };
      const reuse = si === 0 && ii === 0 && placeholder;
      const lec = reuse
        ? await api('PATCH', `${base}/lectures/${items[1].id}/`, fields).then((r) => ({ ...r, status: r.status === 200 ? 201 : r.status, json: { id: items[1].id } }))
        : await api('POST', `${base}/lectures/`, fields);
      if (lec.status !== 201) await fail(`lecture "${it.title}" → ${lec.status} ${lec.text}`);
      if (it.kind === 'article') {
        const as = await api('POST', '/api-2.0/users/me/article-assets/', { body: it.body, ignore_warnings: true });
        if (as.status !== 201) await fail(`article body for "${it.title}" → ${as.status} ${as.text}`);
        const ln = await api('PATCH', `${base}/lectures/${lec.json.id}/`, { asset: as.json.id });
        if (ln.status !== 200) await fail(`attach article to "${it.title}" → ${ln.status} ${ln.text}`);
        await api('PATCH', `${base}/lectures/${lec.json.id}/`, { is_published: true });
      }
      await sleep(300);
    }
    console.log(`  ok  section "${s.title}" + ${s.items.length} item(s)`);
  }
}

// ── 4. read everything back ───────────────────────────────────────────────
const got = await read();
const cur = (await api('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=200&fields[chapter]=title&fields[lecture]=title,asset&fields[asset]=asset_type`)).json.results;
const want = C.sections.flatMap((s) => [`chapter: ${s.title}`, ...s.items.map((i) => `lecture: ${i.title}`)]);
const have = cur.map((x) => `${x._class}: ${x.title}`);
const checks = {
  headline: got.headline === C.headline,
  description: (got.description || '').length > 500,
  objectives: JSON.stringify(got.what_you_will_learn_data?.items) === JSON.stringify(C.objectives),
  requirements: JSON.stringify(got.requirements_data?.items) === JSON.stringify(C.requirements),
  audience: JSON.stringify(got.who_should_attend_data?.items) === JSON.stringify(C.audience),
  category: got.primary_category?.id === C.categoryId && got.primary_subcategory?.id === C.subcategoryId,
  level: new RegExp(C.level, 'i').test(got.instructional_level || ''),
  curriculumOrder: JSON.stringify(have) === JSON.stringify(want),
  articles: cur.filter((x) => x.asset?.asset_type === 'Article').length === C.sections.flatMap((s) => s.items).filter((i) => i.kind === 'article').length,
};
console.log('\nverify', JSON.stringify(checks));
if (!checks.curriculumOrder) console.log('curriculum as Udemy has it:\n  ' + have.join('\n  '));
console.log(`\nhttps://www.udemy.com/course/${cid}/manage/curriculum/`);
await browser.close();
