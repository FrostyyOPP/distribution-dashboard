// IBM courses: each course's Coursera Analytics › Progress Funnel, plus the course list of
// every IBM Professional Certificate in certificate order (C1, C2, …).
// Run: node scrapeCourseraFunnel.js            every course of the IBM certificates (+ the IBM list)
//      node scrapeCourseraFunnel.js --slugs=a,b
//
// Added 2026-11-18 at the user's request: the IBM report needs, per course, the funnel's
// Completion Rate and the learner drop-off before and after Module 1, as on
//   https://www.coursera.org/teach/<slug>/course/analytics/course-progress-funnel
// The page is read as Coursera opens it (eligible learners, last 1 year, live version):
//   completion rate    Course Level Metrics › Completion Rate (Completed/Enrollment)
//   drop before Mod 1  Checkpoint Heatmap › "Module 01 Started Item" drop rate
//                      (enrolled learners who never started Module 1)
//   drop after Mod 1   1 − Π(1 − drop rate) over the checkpoints after "Module 01 Completed
//                      Module" up to "Completed Course Branch" — of the learners who completed
//                      Module 1, the share who did not complete the course
// Stored in coursera_course_funnel (+ a daily row in coursera_course_funnel_daily).
//
// Traps (same Looker embed as the Summary page): the first page opened can stall or show the
// course Looker was last on — so a fresh page per attempt, and the course name on the Course
// Level Metrics tile must match. Never run alongside another Coursera Looker reader.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { db, logScrapeRun } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const ONLY = process.argv.find((a) => a.startsWith('--slugs='))?.slice(8).split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
if (!existsSync(AUTH_FILE)) { console.error('❌ Coursera not connected.'); process.exit(1); }

// ---- 1. the certificates' course lists (public API, no login) ----
const certs = db.prepare(`SELECT slug, name FROM ibm_coursera_monthly WHERE kind = 'certificate'
  AND month = (SELECT MAX(month) FROM ibm_coursera_monthly)`).all();
const api = async (path) => {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch('https://api.coursera.org/api/' + path, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (r.ok) return r.json(); } catch {}
    await sleep(1000);
  }
  return null;
};
const putCert = db.prepare(`INSERT INTO ibm_certificate_courses (cert_slug, cert_name, course_no, course_id, slug, name, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cert_slug, course_no) DO UPDATE SET cert_name=excluded.cert_name, course_id=excluded.course_id,
  slug=excluded.slug, name=excluded.name, updated_at=excluded.updated_at`);
for (const c of certs) {
  const s = (await api(`onDemandSpecializations.v1?q=slug&slug=${encodeURIComponent(c.slug)}&fields=courseIds,name`))?.elements?.[0];
  if (!s?.courseIds?.length) { console.log(`  ⚠️ ${c.name}: course list not read — kept as it was`); continue; }
  const cs = (await api(`onDemandCourses.v1?ids=${s.courseIds.join(',')}&fields=slug,name`))?.elements || [];
  const byId = new Map(cs.map((x) => [x.id, x]));
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM ibm_certificate_courses WHERE cert_slug = ?').run(c.slug);
    s.courseIds.forEach((id, i) => putCert.run(c.slug, c.name, i + 1, id, byId.get(id)?.slug ?? null, (byId.get(id)?.name || '').trim() || null, now));
  })();
}

// ---- 2. which courses to read ----
const list = new Map();
for (const r of db.prepare('SELECT slug, name FROM ibm_certificate_courses WHERE slug IS NOT NULL').all()) list.set(r.slug, r.name);
try {
  for (const r of db.prepare(`SELECT slug, name FROM ibm_coursera_monthly WHERE kind = 'course' AND in_list = 1
    AND month = (SELECT MAX(month) FROM ibm_coursera_monthly)`).all()) if (!list.has(r.slug)) list.set(r.slug, r.name);
} catch {}
const courses = [...list].map(([slug, name]) => ({ slug, name })).filter((c) => !ONLY || ONLY.includes(c.slug));
for (const s of ONLY || []) if (!list.has(s)) courses.push({ slug: s, name: null });
console.log(`${certs.length} IBM certificates · ${courses.length} courses to read`);

// ---- 3. read each funnel page ----
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
function sameCourse(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y || x === y || x.includes(y) || y.includes(x)) return true;
  const wx = new Set(x.split(' ')), wy = new Set(y.split(' '));
  return [...wx].filter((w) => wy.has(w)).length / Math.max(wx.size, wy.size) >= 0.8;
}
const num = (s) => Number(String(s).replace(/[,%]/g, ''));
function parse(text) {   // → { name, enrolled, firstHalf, completed, rate, checkpoints } | { empty } | null (not ready)
  const L = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const cl = L.findIndex((l, i) => l === 'Course Level Metrics' && /^Top line metrics at course level/.test(L[i + 1] || ''));
  const hm = L.indexOf('Checkpoint Heatmap', cl);
  const bl = L.indexOf('Branch Level Metrics', hm);
  if (cl < 0 || hm < 0 || bl < 0) return null;
  const sec = L.slice(cl, hm);
  if (sec.some((l) => /^No Results$/i.test(l))) return { empty: true };
  const p = sec.findIndex((l) => /^\d+(\.\d+)?%$/.test(l));
  if (p < 4) return null;
  const [name, enrolled, firstHalf, completed] = sec.slice(p - 4, p);
  const blob = '|' + L.slice(hm, bl).join('|') + '|';
  const checkpoints = [...blob.matchAll(/\|\d+\|((?:Enrolled|Module|Completed)[^|]*)\|(∅|[\d.]+%)(?=\|)/g)]
    .map((m) => [m[1], m[2] === '∅' ? null : num(m[2]) / 100]);
  if (!checkpoints.some(([k]) => k === 'Completed Course Branch')) return null;
  return { name, enrolled: num(enrolled), firstHalf: num(firstHalf), completed: num(completed), rate: num(sec[p]) / 100, checkpoints };
}
function dropOffs(cps) {
  const at = (k) => cps.find(([n]) => n === k)?.[1] ?? null;
  const i = cps.findIndex(([n]) => n === 'Module 01 Completed Module');
  let keep = 1;
  if (i >= 0) for (const [, d] of cps.slice(i + 1)) keep *= 1 - (d || 0);
  return { before: at('Module 01 Started Item'), after: i >= 0 ? 1 - keep : null,
    modules: new Set(cps.map(([n]) => n.match(/^Module (\d+)/)?.[1]).filter(Boolean)).size };
}

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 9000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const put = db.prepare(`INSERT INTO coursera_course_funnel (slug, course_name, enrolled, first_half, completed, completion_rate, drop_before_m1, drop_after_m1, modules, checkpoints, no_access, captured_at, all_enrolled, all_completed, all_completion_rate, all_drop_before_m1, all_drop_after_m1)
  VALUES (@slug, @course_name, @enrolled, @first_half, @completed, @completion_rate, @drop_before_m1, @drop_after_m1, @modules, @checkpoints, @no_access, @captured_at,
    @all_enrolled, @all_completed, @all_completion_rate, @all_drop_before_m1, @all_drop_after_m1)
  ON CONFLICT(slug) DO UPDATE SET course_name=excluded.course_name, enrolled=excluded.enrolled, first_half=excluded.first_half, completed=excluded.completed,
    completion_rate=excluded.completion_rate, drop_before_m1=excluded.drop_before_m1, drop_after_m1=excluded.drop_after_m1, modules=excluded.modules,
    checkpoints=excluded.checkpoints, no_access=excluded.no_access, captured_at=excluded.captured_at, all_enrolled=excluded.all_enrolled,
    all_completed=excluded.all_completed, all_completion_rate=excluded.all_completion_rate, all_drop_before_m1=excluded.all_drop_before_m1,
    all_drop_after_m1=excluded.all_drop_after_m1`);
const putDay = db.prepare(`INSERT OR REPLACE INTO coursera_course_funnel_daily (slug, date, enrolled, completed, completion_rate, drop_before_m1, drop_after_m1)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');

let ok = 0, locked = 0, empty = 0, failed = 0;
try {
  for (const [k, c] of courses.entries()) {
    const tag = `  ${String(k + 1).padStart(2)}/${courses.length} · ${c.slug}`;
    let res = null, wrong = null, noAccess = false, all = null;
    for (let attempt = 0; attempt < 3 && !res && !noAccess; attempt++) {
      const page = await ctx.newPage();
      if (attempt === 0 && k === 0) await parkWindow(ctx, page).catch(() => {});
      await page.goto(`https://www.coursera.org/teach/${c.slug}/course/analytics/course-progress-funnel`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      for (let t = 0; t < 30; t++) {
        await sleep(1000);
        // no educator access: Coursera sends us to the course overview, or off /teach altogether
        // (e.g. a learner organisation page for an IBM course we don't author)
        if (/\/course\/overview/.test(page.url()) || (t >= 3 && !/\/teach\//.test(page.url()))) { noAccess = true; break; }
        const f = page.frames().find((x) => /looker.*\/dashboards\//.test(x.url()));
        if (!f) continue;
        const r = parse(await f.evaluate(() => document.body?.innerText || '').catch(() => ''));
        if (!r) continue;
        if (r.empty) { res = r; break; }
        if (c.name && !sameCourse(r.name, c.name)) { wrong = r.name; break; }   // another course's page — fresh page
        res = r; break;
      }
      // Same page, Eligible Learner filter cleared → all learners (see the table's note in db.js).
      const f0 = res && !res.empty && page.frames().find((x) => /looker.*\/dashboards\//.test(x.url()));
      if (f0 && /Eligible\+Learner=/.test(f0.url())) {
        await f0.goto(f0.url().replace(/Eligible\+Learner=[^&]*/, 'Eligible+Learner='), { timeout: 30000 }).catch(() => {});
        for (let t = 0; t < 30 && !all; t++) {
          await sleep(1000);
          const f = page.frames().find((x) => /looker.*\/dashboards\/.*Eligible\+Learner=(&|$)/.test(x.url()));
          const r = f && parse(await f.evaluate(() => document.body?.innerText || '').catch(() => ''));
          if (r && !r.empty && sameCourse(r.name, res.name)) all = r;
        }
      }
      await page.close().catch(() => {});
    }
    const now = new Date().toISOString();
    if (noAccess) {
      locked++; put.run({ slug: c.slug, course_name: c.name, enrolled: null, first_half: null, completed: null, completion_rate: null, drop_before_m1: null,
        drop_after_m1: null, modules: null, checkpoints: null, no_access: 1, captured_at: now,
        all_enrolled: null, all_completed: null, all_completion_rate: null, all_drop_before_m1: null, all_drop_after_m1: null });
      console.log(`${tag}: no Analytics access for this account`); continue;
    }
    if (!res) { failed++; console.log(`${tag}: ❌ ${wrong ? `page kept showing another course ("${wrong}")` : 'funnel did not load'} — kept as it was`); continue; }
    if (res.empty) { empty++; console.log(`${tag}: no learners in the funnel yet`); continue; }
    const d = dropOffs(res.checkpoints), da = all ? dropOffs(all.checkpoints) : {};
    put.run({ slug: c.slug, course_name: res.name, enrolled: res.enrolled, first_half: res.firstHalf, completed: res.completed, completion_rate: res.rate,
      drop_before_m1: d.before, drop_after_m1: d.after, modules: d.modules, checkpoints: JSON.stringify(res.checkpoints), no_access: 0, captured_at: now,
      all_enrolled: all?.enrolled ?? null, all_completed: all?.completed ?? null, all_completion_rate: all?.rate ?? null,
      all_drop_before_m1: da.before ?? null, all_drop_after_m1: da.after ?? null });
    putDay.run(c.slug, now.slice(0, 10), res.enrolled, res.completed, res.rate, d.before, d.after);
    ok++;
    console.log(`${tag}: completion ${pct(res.rate)} (${res.completed}/${res.enrolled}) · drop before M1 ${pct(d.before)} · after M1 ${pct(d.after)}` +
      (all ? ` | all learners ${pct(all.rate)} (${all.completed}/${all.enrolled}) · ${pct(da.before)} · ${pct(da.after)}` : ' | all learners: not read'));
  }
} finally {
  await browser.close();
}
const okRun = failed <= Math.max(2, 0.2 * courses.length);
logScrapeRun({ job: 'coursera_course_funnel', ok: okRun, rows: ok, startedAt, error: okRun ? null : `${failed} course(s) failed` });
console.log(`✅ Progress Funnel: ${ok} read · ${empty} without learners · ${locked} without access · ${failed} failed`);
process.exit(okRun ? 0 : 1);
