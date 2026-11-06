// Fill in each Udemy course's slug and public URL.
//
// WHY: a course's URL cannot be renamed out from under us, while its title is
// deliberately rewritten for every platform so Starweaver's own listings do not
// compete in search. That makes the URL far stronger evidence when matching a
// course across systems, and until now Udemy was the only platform with none
// recorded — all 141 of its matches rested on a title comparison alone.
//
// The instructor API already returns both fields; they were simply not stored.
//
// Run: node scrapeUdemyUrls.js [--dry-run]
import { udemyGet } from './udemyClient.js';
import { writeUdemyRealCourseIds, readUdemyRealCourseIds, logScrapeRun } from './db.js';

const DRY = process.argv.includes('--dry-run');

const existing = readUdemyRealCourseIds().courses || [];
const known = new Map(existing.map((c) => [c.course_id ?? c.courseId, c]));

const all = [];
for (let page = 1; ; page++) {
  const res = await udemyGet('/taught-courses/courses/', { page, page_size: 100 });
  const rows = res.results || [];
  all.push(...rows);
  if (all.length >= (res.count || 0) || !rows.length) break;
}
console.log(`${all.length} taught courses from the API`);

// url comes back relative ("/course/<slug>/"); store it absolute so a consumer
// does not have to know that.
const rows = all
  .filter((c) => c.published_title)
  .map((c) => ({
    courseId: c.id,
    realCourseId: known.get(c.id)?.real_course_id ?? null,
    title: c.title,
    slug: c.published_title,
    url: c.url ? new URL(c.url, 'https://www.udemy.com').toString() : `https://www.udemy.com/course/${c.published_title}/`,
  }));

const fresh = rows.filter((r) => !known.get(r.courseId)?.url).length;
console.log(`${rows.length} with a slug · ${fresh} gaining a URL for the first time`);
if (DRY) { console.log('[DRY RUN] nothing written'); process.exit(0); }

const res = writeUdemyRealCourseIds(rows);
logScrapeRun({ job: 'udemy_course_urls', ok: true, rows: res.written });
console.log(`✅ ${res.written} rows updated`);
