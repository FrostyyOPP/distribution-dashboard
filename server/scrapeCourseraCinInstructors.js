// Coursera CIN — the instructors named on every CIN course, for the "Instructor Names"
// column of the Coursera CIN tab. Uses Coursera's PUBLIC API (courses.v1 by slug →
// instructorIds → instructors.v1), so it needs no login and no browser, and cannot
// hit the shared-viewer mix-ups of the partner dashboards. The shared "Starweaver"
// account is not a person and is dropped unless it is a course's only instructor.
// Guarded write: an empty or much smaller result never replaces the table.
//   node scrapeCourseraCinInstructors.js            every CIN course
//   node scrapeCourseraCinInstructors.js --dry      fetch and print, write nothing
import { db, writeCourseraCinInstructors } from './db.js';

const DRY = process.argv.includes('--dry');
const API = 'https://api.coursera.org/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch { /* network blip — retry */ }
    await sleep(1500 * attempt);
  }
  return null;
}

// Every CIN course the dashboard knows (metrics rows carry the name; the course list may have more).
const courses = new Map();
for (const r of db.prepare('SELECT slug, course_name FROM coursera_cin_metrics WHERE slug IS NOT NULL').all()) courses.set(r.slug, r.course_name);
for (const r of db.prepare('SELECT COALESCE(slug, id) AS slug, name FROM coursera_cin_courses').all()) if (r.slug && !courses.has(r.slug)) courses.set(r.slug, r.name);
console.log(`${courses.size} CIN courses`);

// 1. instructor ids per course (a few requests at a time)
const idsBySlug = new Map();
const notFound = [];
const slugs = [...courses.keys()];
for (let i = 0; i < slugs.length; i += 4) {
  await Promise.all(slugs.slice(i, i + 4).map(async (slug) => {
    const j = await getJson(`${API}/courses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=instructorIds`);
    const e = j?.elements?.[0];
    if (e) idsBySlug.set(slug, e.instructorIds || []); else notFound.push(slug);
  }));
  await sleep(250);
}

// 2. instructor names, 50 ids per request
const allIds = [...new Set([...idsBySlug.values()].flat())];
const nameById = new Map();
for (let i = 0; i < allIds.length; i += 50) {
  const j = await getJson(`${API}/instructors.v1?ids=${allIds.slice(i, i + 50).join(',')}&fields=fullName,firstName,lastName`);
  for (const e of j?.elements || []) nameById.set(String(e.id), (e.fullName || `${e.firstName || ''} ${e.lastName || ''}`).trim());
  await sleep(250);
}

const isShared = (n) => /^starweaver$/i.test(n);
const rows = [...idsBySlug].map(([slug, ids]) => {
  const names = ids.map((id) => nameById.get(String(id))).filter(Boolean);
  const people = names.filter((n) => !isShared(n));
  return { slug, courseName: courses.get(slug), instructorNames: people.length ? people : names };
});

const withNames = rows.filter((r) => r.instructorNames.length).length;
console.log(`instructors found for ${withNames} of ${courses.size} courses · ${allIds.length} distinct instructor ids` +
  (notFound.length ? ` · ${notFound.length} not on Coursera's public API: ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}` : ''));
for (const r of rows.slice(0, 5)) console.log(`  ${r.slug}: ${r.instructorNames.join(', ') || '—'}`);
if (DRY) process.exit(0);

const res = writeCourseraCinInstructors(rows);
console.log(res.ok ? `✅ saved ${res.written} rows to coursera_cin_instructors` : '⛔ refused by the write guard (result much smaller than what is stored) — nothing changed');
process.exit(res.ok ? 0 : 1);
