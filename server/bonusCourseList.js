// The work list for every bonus-lecture script.
//
// These scripts used to read udemy_real_course_ids alone. That table is
// populated from a manual CSV export of Udemy's bulk-coupon tool, so it lags
// the catalogue: on 2026-08-10 it held 141 rows while 143 courses were live,
// and the two missing ones were silently skipped by every run — no error, just
// absent from the totals.
//
// So: start from the LIVE catalogue and use the table only as an id lookup.
// A live course the table doesn't know gets its numeric id resolved from its
// own public page (the instructor API returns Udemy's opaque base64 id, but
// /manage/ URLs need the numeric one).
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

// The dashboard gates its routes behind basic auth. Read the credentials from
// the environment (server/.env) - never hardcode them, this repo is public.
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const dashboardHeaders = () =>
  DASHBOARD_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASSWORD}`).toString('base64')}` }
    : {};

const __dirname = dirname(fileURLToPath(import.meta.url));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * @param {import('playwright').Page} page  logged-in Udemy page, used only to
 *        resolve numeric ids for courses missing from the table.
 * @returns {Promise<Array<{realCourseId:number,title:string,slug:string|null,resolved:boolean}>>}
 */
export async function liveBonusCourses(page, { auth = null, port = 5055 } = {}) {
  const db = new Database(join(__dirname, 'dashboard.db'), { readonly: true });
  const table = db.prepare('SELECT real_course_id, title FROM udemy_real_course_ids').all();
  db.close();
  const idByTitle = new Map(table.map((r) => [norm(r.title), r.real_course_id]));

  const live = await fetch(`http://localhost:${port}/api/courses`, {
    // An explicit `auth` still wins; otherwise fall back to the environment.
    headers: auth
      ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` }
      : dashboardHeaders(),
  }).then((r) => r.json()).catch(() => null);
  if (!live?.results?.length) throw new Error('could not read /api/courses — is the backend up?');

  const published = live.results.filter((c) => c.is_published);
  const out = [];
  for (const c of published) {
    const known = idByTitle.get(norm(c.title));
    if (known) { out.push({ realCourseId: known, title: c.title, slug: c.published_title, resolved: false }); continue; }
    const id = await resolveNumericId(page, c.published_title, c.title);
    if (id) out.push({ realCourseId: id, title: c.title, slug: c.published_title, resolved: true });
    else console.warn(`   ⚠️  could not resolve a numeric course id for "${c.title}" — skipped`);
  }
  out.sort((a, b) => a.title.localeCompare(b.title));

  const extra = out.filter((c) => c.resolved);
  console.log(`work list: ${out.length} live courses (${table.length} from udemy_real_course_ids` +
    `${extra.length ? `, ${extra.length} resolved live: ${extra.map((c) => c.title).join('; ')}` : ''})`);
  return out;
}

// api-2.0/courses/{slug}/ returns the numeric id. Scraping the rendered course
// page was tried first and found nothing — the id is not in the markup.
//
// The returned title is checked against the expected one: a slug that does not
// belong to us still resolves happily to somebody else's course (guessing
// "ultimate-seo-course" instead of "ultimate-seo-course-z" returned a stranger's
// course id, which would have edited the wrong course's curriculum).
async function resolveNumericId(page, slug, expectedTitle) {
  if (!slug) return null;
  const norml = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  try {
    // The fetch below is same-origin with credentials, so the page has to be on
    // udemy.com — it starts blank when the script first opens the browser.
    if (!/udemy\.com/.test(page.url())) {
      await page.goto('https://www.udemy.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
    }
    const r = await page.evaluate(async (sl) => {
      const res = await fetch(`https://www.udemy.com/api-2.0/courses/${sl}/?fields[course]=id,title`,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      try { return await res.json(); } catch { return null; }
    }, slug);
    if (!r?.id) return null;
    if (norml(r.title) !== norml(expectedTitle)) {
      console.warn(`   ⚠️  slug "${slug}" resolves to "${r.title}", not "${expectedTitle}" — refusing to use it`);
      return null;
    }
    return Number(r.id);
  } catch {
    return null;
  }
}
