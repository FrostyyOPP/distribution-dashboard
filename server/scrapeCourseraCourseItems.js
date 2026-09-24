// Walk every live Coursera course and store its full content inventory:
// module -> lesson -> item, with each item's type.
//
// This is the denominator for "what is actually being consumed". Before you can
// ask whether the Role Plays and Coach Dialogues earn their keep, you have to
// know how many exist and how they were published.
//
// Source is onDemandCourseMaterials.v2, which is PUBLIC. No partner session is
// needed, so this keeps working when the Coursera login has lapsed.
//
// KNOWN LIMIT: graded items (quizzes, peer reviews) are hidden from anonymous
// callers — verified by running a course known to contain quizzes and getting
// back only lectures and supplements. Everything stored here is real, but the
// inventory is a floor. Per-learner consumption needs an authenticated export
// and is not collected here.
//
// Run: node scrapeCourseraCourseItems.js [--cin]
import { writeCourseraCourseItems, readCourseraCourseItems, readCourseraCourseStatus, readCourseraCinCourses } from './db.js';

const CIN = process.argv.includes('--cin');
const CATALOG = CIN ? 'cin' : 'starweaver';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Course list: the Starweaver partner console snapshot (launched only), or the
// CIN course table.
let courses;
if (CIN) {
  const { courses: cin } = readCourseraCinCourses();
  courses = cin.filter((c) => c.slug).map((c) => ({ slug: c.slug, name: c.name }));
} else {
  // Exclude drafts and pre-enrol, but keep rows whose status never resolved —
  // three of those were confirmed launched against Coursera's own API, and
  // filtering on status === 'launched' alone silently dropped them.
  // A slug that is genuinely not public just 404s below.
  const { byName } = readCourseraCourseStatus();
  const SKIP = new Set(['draft', 'preenroll']);
  courses = Object.entries(byName)
    .filter(([, v]) => v.slug && !SKIP.has((v.status || '').toLowerCase()))
    .map(([name, v]) => ({ slug: v.slug, name: name.trim() }));
}
// ONE COURSE, ONE READ. The status table keeps a renamed course under both of
// its names, pointing at one slug — 23 of them on 2026-09-24 — so a course
// list built by name fetched those twice and stored every item twice, and the
// (course_slug, item_id) key crashed the write. The run had not saved since
// mid-August. Collected by slug instead; which name labels it does not matter.
courses = [...new Map(courses.map((c) => [c.slug, c])).values()];
if (!courses.length) { console.error('❌ no courses to scan — is the course-status table populated?'); process.exit(1); }
console.log(`${CATALOG}: scanning ${courses.length} courses\n`);

const FIELDS = [
  'onDemandCourseMaterialModules.v1(name,slug)',
  'onDemandCourseMaterialLessons.v1(name,slug)',
  'onDemandCourseMaterialItems.v2(name,slug,timeCommitment,contentSummary,isLocked,lessonId)',
].join(',');

const rows = [];
let failed = 0;
for (let i = 0; i < courses.length; i++) {
  const c = courses[i];
  let data = null, err = null;
  for (let a = 0; a < 3 && !data; a++) {
    try {
      const res = await fetch(
        `https://api.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${encodeURIComponent(c.slug)}`
        + `&includes=modules,lessons,items&fields=${encodeURIComponent(FIELDS)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.status === 404) { err = 'not-found'; break; }
      if (!res.ok) { err = `http-${res.status}`; await sleep(800); continue; }
      data = await res.json();
    } catch (e) { err = e.message; await sleep(800); }
  }
  if (!data) { failed++; console.log(`  ⚠️  ${c.slug}: ${err}`); continue; }

  const L = data.linked || {};
  const modules = L['onDemandCourseMaterialModules.v1'] || [];
  const lessons = L['onDemandCourseMaterialLessons.v1'] || [];
  const items = L['onDemandCourseMaterialItems.v2'] || [];
  // Order comes from array position — the API returns these already ordered,
  // and lessons carry itemIds in presentation order.
  const modOrder = new Map(modules.map((m, ix) => [m.id, { ix, name: m.name }]));
  const lesOrder = new Map(lessons.map((l, ix) => [l.id, { ix, name: l.name, moduleId: l.moduleId }]));
  const itemIx = new Map();
  for (const l of lessons) (l.itemIds || []).forEach((id, ix) => itemIx.set(id, ix));

  for (const it of items) {
    const les = lesOrder.get(it.lessonId);
    const mod = modOrder.get(it.moduleId ?? les?.moduleId);
    const cs = it.contentSummary || {};
    rows.push({
      courseSlug: c.slug, itemId: it.id, catalog: CATALOG, courseName: c.name,
      moduleOrder: mod?.ix ?? null, moduleName: mod?.name ?? null,
      lessonOrder: les?.ix ?? null, lessonName: les?.name ?? null,
      itemOrder: itemIx.get(it.id) ?? null,
      itemSlug: it.slug ?? null, itemName: (it.name || '').trim(),
      itemType: cs.typeName ?? null,
      assetType: cs.definition?.assetTypeName ?? null,
      containsWidget: !!cs.definition?.containsWidget,
      isLocked: !!it.isLocked,
      minutes: it.timeCommitment ? it.timeCommitment / 60000 : null,
    });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${courses.length} · ${rows.length} items so far`);
  await sleep(110);
}

if (failed) console.log(`\n${failed} course(s) could not be read`);
const uniqueRows = [...new Map(rows.map((r) => [`${r.courseSlug}|${r.itemId}`, r])).values()];
if (uniqueRows.length !== rows.length) console.log(`  (${rows.length - uniqueRows.length} duplicate item rows dropped)`);
const res = writeCourseraCourseItems(uniqueRows);
if (!res.ok) { console.error(`❌ refused: ${res.error || 'guard tripped'}`); process.exit(1); }
console.log(`\n✅ ${res.written} items stored across ${new Set(uniqueRows.map((r) => r.courseSlug)).size} courses`);

const { totals } = readCourseraCourseItems({ catalog: CATALOG });
console.log('\ncontent mix:');
for (const [t, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(t).padEnd(18)} ${String(n).padStart(6)}`);
}
const widgets = rows.filter((r) => r.containsWidget || r.itemType === 'ungradedWidget');
console.log(`\ninteractive items (widget type, or a reading with an embedded widget): ${widgets.length}`);
for (const w of widgets.slice(0, 15)) console.log(`   [${w.itemType}] ${w.itemName.slice(0, 60)} · ${String(w.courseName).slice(0, 30)}`);
console.log('\nNOTE: graded items are hidden from the public API, so this is a floor.');
