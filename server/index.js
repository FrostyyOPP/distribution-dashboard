import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { udemyGet } from './udemyClient.js';
import { SUPPORTED_LANGS, startJob as startCaptionJob, getJob as getCaptionJob } from './localizeCaptions.js';
import {
  readEnrollment, readRevenue, readCaptions, readCoupons, readCouponQuota, readUdemyRealCourseIds, readTranscripts, setTranscript,
  readCourseraCourses, readCourseraMetrics, readCourseraOverview, readCourseraCourseInstructors, latestUpdatedAt,
  readCourseraCourseStatus, readCourseraReviews, readCourseraCinReviews, readCourseraRevenueImport,
  readCourseraRevenueQuarterly, readCourseraQuarterTotals,
  readCourseraCourseItems, searchCourseraItems, readCourseraInstructorProfiles,
  readBookmarks, addBookmark, removeBookmark,
  readCourseraCinCourses, readCourseraCinMetrics, readCourseraCinOverview,
  readFutureLearnCourses, readGo1Courses, readGo1Lifetime, readEngagement,
} from './db.js';

const app = express();
const PORT = process.env.PORT || 5055;
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
const COURSERA_AUTH_FILE = join(__dirname, 'coursera-auth.json');
const FUTURELEARN_AUTH_FILE = join(__dirname, 'futurelearn-auth.json');
const GO1_AUTH_FILE = join(__dirname, 'go1-auth.json');

// Convert a Cookie-Editor JSON export into a Playwright session (storageState).
const sameSiteMap = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
function cookiesToState(list) {
  const cookies = (Array.isArray(list) ? list : list?.cookies || [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: sameSiteMap[String(c.sameSite || '').toLowerCase()] || 'Lax',
      expires: c.expirationDate ?? c.expires ? Math.floor(Number(c.expirationDate ?? c.expires)) : -1,
    }));
  return { cookies, origins: [] };
}

app.use(compression());
app.use(cors());
app.use(express.json());

// --- Access control ------------------------------------------------------
// Gate everything behind HTTP basic auth when DASHBOARD_PASSWORD is set.
// (Unset in local dev = open; set on Render = private.)
const AUTH_USER = process.env.DASHBOARD_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASSWORD;
app.use((req, res, next) => {
  if (!AUTH_PASS) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === AUTH_USER && p === AUTH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Udemy Dashboard"');
  return res.status(401).send('Authentication required');
});

// Wrap async route handlers so thrown errors hit the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Health / auth check -------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.UDEMY_API_KEY) });
});

// When was the data last refreshed? Newest timestamp across all caches + the
// last scheduled `npm run update` run.
app.get('/api/last-update', (req, res) => {
  let run = null;
  const lu = join(__dirname, 'last-update.json');
  if (existsSync(lu)) { try { run = JSON.parse(readFileSync(lu, 'utf8')); } catch {} }
  res.json({ updatedAt: latestUpdatedAt(), lastRun: run });
});

// --- Bookmarks (cross-platform watchlist) ---------------------------------
app.get('/api/bookmarks', (req, res) => {
  res.json({ bookmarks: readBookmarks() });
});
app.post('/api/bookmarks', (req, res) => {
  const { platform, courseKey, title } = req.body || {};
  if (!platform || !courseKey) return res.status(400).json({ error: 'platform and courseKey are required' });
  res.json(addBookmark({ platform, courseKey, title }));
});
app.delete('/api/bookmarks', (req, res) => {
  const { platform, courseKey } = req.body || {};
  if (!platform || !courseKey) return res.status(400).json({ error: 'platform and courseKey are required' });
  res.json(removeBookmark({ platform, courseKey }));
});

// --- Udemy account connection (session) ----------------------------------
// Connection status: is a session saved, and which scraped datasets exist?
app.get('/api/connection', (req, res) => {
  res.json({
    connected: existsSync(AUTH_FILE),
    data: {
      enrollment: Object.keys(readEnrollment().counts).length > 0,
      revenue: readRevenue().total != null,
      captions: Object.keys(readCaptions().perCourse).length > 0,
    },
  });
});

// Connect by submitting a Cookie-Editor export of udemy.com cookies.
app.post('/api/connect', (req, res) => {
  const state = cookiesToState(req.body?.cookies ?? req.body);
  const names = state.cookies.map((c) => c.name);
  // Sanity: must look like a logged-in Udemy session.
  const isUdemy = state.cookies.some((c) => /udemy\.com$/.test(c.domain));
  const loggedIn = names.includes('dj_session_id') || names.includes('ud_cache_logged_in');
  if (!state.cookies.length || !isUdemy || !loggedIn) {
    return res.status(400).json({
      error: 'That does not look like a logged-in udemy.com cookie export. Export from udemy.com while signed in.',
      cookieCount: state.cookies.length,
    });
  }
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
  res.json({ connected: true, cookieCount: state.cookies.length });
});

// Disconnect: remove the saved session.
app.post('/api/disconnect', (req, res) => {
  try { if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE); } catch {}
  res.json({ connected: false });
});

// --- Coursera account connection (session) -------------------------------
app.get('/api/coursera/connection', (req, res) => {
  res.json({ connected: existsSync(COURSERA_AUTH_FILE) });
});

app.post('/api/coursera/connect', (req, res) => {
  const state = cookiesToState(req.body?.cookies ?? req.body);
  const names = state.cookies.map((c) => c.name);
  const isCoursera = state.cookies.some((c) => /coursera\.org$/.test(c.domain));
  const loggedIn = names.includes('CAUTH'); // Coursera's auth cookie
  if (!state.cookies.length || !isCoursera || !loggedIn) {
    return res.status(400).json({
      error: 'That does not look like a logged-in coursera.org cookie export (missing CAUTH). Export from coursera.org while signed in.',
      cookieCount: state.cookies.length,
    });
  }
  writeFileSync(COURSERA_AUTH_FILE, JSON.stringify(state, null, 2));
  res.json({ connected: true, cookieCount: state.cookies.length });
});

app.post('/api/coursera/disconnect', (req, res) => {
  try { if (existsSync(COURSERA_AUTH_FILE)) unlinkSync(COURSERA_AUTH_FILE); } catch {}
  res.json({ connected: false });
});

// --- FutureLearn account connection (session) -----------------------------
app.get('/api/futurelearn/connection', (req, res) => {
  res.json({ connected: existsSync(FUTURELEARN_AUTH_FILE) });
});

app.post('/api/futurelearn/connect', (req, res) => {
  const state = cookiesToState(req.body?.cookies ?? req.body);
  const isFutureLearn = state.cookies.some((c) => /futurelearn\.com$/.test(c.domain));
  if (!state.cookies.length || !isFutureLearn) {
    return res.status(400).json({
      error: 'That does not look like a futurelearn.com cookie export. Export from futurelearn.com while signed in.',
      cookieCount: state.cookies.length,
    });
  }
  writeFileSync(FUTURELEARN_AUTH_FILE, JSON.stringify(state, null, 2));
  res.json({ connected: true, cookieCount: state.cookies.length });
});

app.post('/api/futurelearn/disconnect', (req, res) => {
  try { if (existsSync(FUTURELEARN_AUTH_FILE)) unlinkSync(FUTURELEARN_AUTH_FILE); } catch {}
  res.json({ connected: false });
});

// --- Go1 account connection (session) -------------------------------------
app.get('/api/go1/connection', (req, res) => {
  res.json({ connected: existsSync(GO1_AUTH_FILE) });
});

app.post('/api/go1/connect', (req, res) => {
  const state = cookiesToState(req.body?.cookies ?? req.body);
  const isGo1 = state.cookies.some((c) => /go1\.com$/.test(c.domain));
  if (!state.cookies.length || !isGo1) {
    return res.status(400).json({
      error: 'That does not look like a go1.com cookie export. Export from your mygo1.com dashboard while signed in.',
      cookieCount: state.cookies.length,
    });
  }
  writeFileSync(GO1_AUTH_FILE, JSON.stringify(state, null, 2));
  res.json({ connected: true, cookieCount: state.cookies.length });
});

app.post('/api/go1/disconnect', (req, res) => {
  try { if (existsSync(GO1_AUTH_FILE)) unlinkSync(GO1_AUTH_FILE); } catch {}
  res.json({ connected: false });
});

// Coursera course list (from the DB).
app.get('/api/coursera/courses', (req, res) => {
  res.json(readCourseraCourses());
});

// Coursera partner overview KPIs (from the Looker dashboard).
app.get('/api/coursera/overview', (req, res) => {
  res.json(readCourseraOverview());
});

// Monthly revenue history (real, from Udemy's own share-holders API — full
// lifetime series, not a growing snapshot). Powers the "Revenue Over Time" chart.
app.get('/api/revenue/monthly', (req, res) => {
  const { monthly, currency, scrapedAt } = readRevenue();
  res.json({ monthly: monthly || [], currency: currency || 'USD', scrapedAt: scrapedAt || null });
});

// Engagement: total minutes watched, active students, monthly trend, and
// per-course Udemy Business coverage (course id -> {minutesTaught, isUdemyBusiness}).
app.get('/api/engagement', (req, res) => {
  res.json(readEngagement());
});

// Coursera per-course metrics (enrollments/completions/rating).
const normalizeName = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
app.get('/api/coursera/metrics', (req, res) => {
  const metrics = readCourseraMetrics();
  const { byName: instructorByName } = readCourseraCourseInstructors();
  const { byName: statusByName } = readCourseraCourseStatus();
  const { bySlug: revenueBySlug } = readCourseraRevenueImport();
  // Per-quarter revenue is keyed by slug where the export had one and by course
  // name where it didn't (the historical roll-up has no slug column), so look
  // up both. Only the most recent quarters are sent — the table holds every
  // quarter back to 2023 Q3 and the courses grid only shows the recent ones.
  const { bySlug: qBySlug, byName: qByName, quarters: allQuarters } = readCourseraRevenueQuarterly({ catalog: 'starweaver' });
  const recentQuarters = allQuarters.slice(-3);
  const normalizedInstructors = {};
  for (const [name, v] of Object.entries(instructorByName)) normalizedInstructors[normalizeName(name)] = v;
  const normalizedStatus = {};
  for (const [name, v] of Object.entries(statusByName)) normalizedStatus[normalizeName(name)] = v;
  res.json({
    ...metrics,
    revenueQuarters: recentQuarters,
    courses: metrics.courses.map((c) => {
      const info = normalizedInstructors[normalizeName(c.name)];
      const statusInfo = normalizedStatus[normalizeName(c.name)];
      const slug = statusInfo?.slug || null;
      const revInfo = slug ? revenueBySlug[slug] : null;
      const q = { ...(qByName[(c.name || '').trim().toLowerCase()] || {}), ...(slug ? qBySlug[slug] || {} : {}) };
      const quarterlyRevenue = recentQuarters.map((qt) => (qt in q ? q[qt] : null));
      return {
        ...c,
        hasStarweaverInstructor: !!info?.hasStarweaverInstructor, instructorNames: info?.instructorNames || [],
        slug, status: statusInfo?.status || null,
        revenue: revInfo?.revenue ?? null, revenueCompletions: revInfo?.completions ?? null,
        quarterlyRevenue,
        quarterlyRevenueTotal: quarterlyRevenue.some((v) => v != null)
          ? quarterlyRevenue.reduce((s, v) => s + (v || 0), 0) : null,
      };
    }),
  });
});

// Instructor profiles across both partner sides, one row per person, with a
// completeness audit of which profile fields each SME has left blank.
app.get('/api/coursera/instructors', (req, res) => {
  res.json(readCourseraInstructorProfiles({ includeShared: req.query.includeShared === '1' }));
});

// Content inventory: what each course is actually made of. `?q=` searches item
// names, which is how you check whether a format (role play, coach dialogue,
// hands-on lab) exists at all and how it was published.
app.get('/api/coursera/content', (req, res) => {
  const catalog = req.query.catalog === 'cin' ? 'cin' : 'starweaver';
  if (req.query.q) return res.json({ catalog, query: req.query.q, matches: searchCourseraItems(req.query.q, { catalog }) });
  res.json(readCourseraCourseItems({ catalog }));
});

// Every quarter on record, course and specialization totals split out. Backs
// the Earnings view and is the durable answer to "revenue for the last N
// quarters" that the lifetime-only import table could never give.
app.get('/api/coursera/revenue-quarterly', (req, res) => {
  const catalog = req.query.catalog === 'cin' ? 'cin' : 'starweaver';
  const { bySlug, byName, quarters, importedAt } = readCourseraRevenueQuarterly({ catalog });
  res.json({ catalog, quarters, importedAt, totals: readCourseraQuarterTotals(catalog), bySlug, byName });
});

// Real learner review text (not just the aggregate rating) — Starweaver.
app.get('/api/coursera/reviews', (req, res) => {
  res.json(readCourseraReviews());
});

// Draft/preenroll Starweaver courses not yet in the Looker metrics snapshot
// (that dashboard only ever shows launched courses with real traffic).
app.get('/api/coursera/course-status', (req, res) => {
  res.json(readCourseraCourseStatus());
});

// Coursera CIN — second partner account (org slug "coursera") reachable from
// the same login as Starweaver. Fully separate course catalog/metrics.
app.get('/api/coursera-cin/courses', (req, res) => {
  res.json(readCourseraCinCourses());
});
app.get('/api/coursera-cin/overview', (req, res) => {
  res.json(readCourseraCinOverview());
});
app.get('/api/coursera-cin/metrics', (req, res) => {
  const metrics = readCourseraCinMetrics();
  const { bySlug: revenueBySlug } = readCourseraRevenueImport();
  res.json({
    ...metrics,
    courses: metrics.courses.map((c) => {
      const revInfo = c.slug ? revenueBySlug[c.slug] : null;
      return { ...c, revenue: revInfo?.revenue ?? null, revenueCompletions: revInfo?.completions ?? null };
    }),
  });
});
app.get('/api/coursera/revenue', (req, res) => {
  res.json(readCourseraRevenueImport());
});
app.get('/api/coursera-cin/reviews', (req, res) => {
  res.json(readCourseraCinReviews());
});

// FutureLearn course list (title, code, category, status, run date, wishlist, enrollment).
app.get('/api/futurelearn/courses', (req, res) => {
  res.json(readFutureLearnCourses());
});

// Go1 course-level learning content (enrolments/completions/minutes) — a single
// month's snapshot (Go1 doesn't expose a lifetime aggregate to partners).
app.get('/api/go1/courses', (req, res) => {
  res.json(readGo1Courses());
});

// Go1 full-history totals, built by scraping every month back to when Go1
// data starts and summing per course (no lifetime endpoint exists upstream).
app.get('/api/go1/lifetime', (req, res) => {
  res.json(readGo1Lifetime());
});

// Bulk-create coupons. User-triggered write. dryRun:true previews only.
// Requires a connected session; opens a headed browser to POST to Udemy.
app.post('/api/coupons/create', (req, res, next) => {
  if (!existsSync(AUTH_FILE)) return res.status(400).json({ error: 'Not connected. Use Connect Udemy first.' });
  import('./couponCreate.js')
    .then(({ createCoupons }) => createCoupons(req.body || {}))
    .then((out) => res.json(out))
    .catch(next);
});

// --- Caption localization ------------------------------------------------
// Translate + upload captions in multiple languages. A job runs a headed
// browser in the background; the client polls /api/captions/jobs/:id.

// Languages offered by the picker (Core 6 pinned first).
app.get('/api/captions/languages', (req, res) => {
  res.json({ languages: SUPPORTED_LANGS.map(({ name, locale, core }) => ({ name, locale, core: !!core })) });
});

// Start a localization job. Body: { slugs:[], locales:[], dryRun:bool }.
// dryRun translates + maps but makes NO writes to Udemy.
app.post('/api/captions/localize', (req, res) => {
  if (!existsSync(AUTH_FILE)) return res.status(400).json({ error: 'Not connected. Use Connect Udemy first.' });
  try {
    const { slugs = [], locales = [], dryRun = false, limit = 0 } = req.body || {};
    const job = startCaptionJob({ slugs, locales, dryRun: !!dryRun, limit });
    res.json({ jobId: job.id, status: job.status });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Poll job progress.
app.get('/api/captions/jobs/:id', (req, res) => {
  const job = getCaptionJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// On-demand refresh of caption-cache.json (read-only — re-runs scrapeCaptions.js).
// Captions are normally refreshed once a day; this lets the dashboard catch up
// right away after a caption is added/changed directly on Udemy.
let captionRefresh = { running: false, startedAt: null, finishedAt: null, ok: null, error: null };
app.post('/api/captions/refresh-cache', (req, res) => {
  if (!existsSync(AUTH_FILE)) return res.status(400).json({ error: 'Not connected. Use Connect Udemy first.' });
  if (captionRefresh.running) return res.status(409).json({ error: 'A refresh is already running.' });
  captionRefresh = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null };
  const p = spawn(process.execPath, [join(__dirname, 'scrapeCaptions.js')], { cwd: __dirname });
  let stderr = '';
  p.stderr?.on('data', (d) => { stderr += d.toString(); });
  p.on('close', (code) => {
    captionRefresh = {
      running: false, startedAt: captionRefresh.startedAt, finishedAt: new Date().toISOString(),
      ok: code === 0, error: code === 0 ? null : (stderr.trim().slice(-500) || `exit code ${code}`),
    };
  });
  p.on('error', (e) => {
    captionRefresh = { running: false, startedAt: captionRefresh.startedAt, finishedAt: new Date().toISOString(), ok: false, error: e.message };
  });
  res.json({ started: true });
});
app.get('/api/captions/refresh-cache', (req, res) => res.json(captionRefresh));

// --- Typed routes for the common instructor resources --------------------

const COURSE_FIELDS =
  '@default,published_title,rating,num_reviews,headline,is_published,created,published_time,visible_instructors';

// The full course walk below hits the live Udemy API sequentially, one page at
// a time — course title/rating/published-status barely change minute to minute,
// so cache the walked list briefly rather than re-fetching it (which took
// 4.5-10.5s per dashboard load, dwarfing everything else). Per-course revenue/
// captions/coupons/engagement still come from the local DB fresh on every request.
let coursesWalkCache = { results: null, fetchedAt: 0 };
const COURSES_CACHE_TTL_MS = 5 * 60 * 1000;
async function walkAllCourses() {
  const now = Date.now();
  if (coursesWalkCache.results && (now - coursesWalkCache.fetchedAt) < COURSES_CACHE_TTL_MS) {
    return coursesWalkCache.results;
  }
  const results = [];
  let page = 1;
  while (true) {
    const data = await udemyGet('/taught-courses/courses/', {
      page, page_size: 100, 'fields[course]': COURSE_FIELDS,
    });
    results.push(...(data.results || []));
    if (!data.next) break;
    page += 1;
    if (page > 50) break; // safety stop
  }
  coursesWalkCache = { results, fetchedAt: now };
  return results;
}

// List your taught courses. By default fetches ALL pages (168 is small);
// pass ?page=N for a single page.
app.get('/api/courses', wrap(async (req, res) => {
  const { counts, scrapedAt } = readEnrollment();
  const { perCourse, total: totalRevenue, currency } = readRevenue();
  const { perCourse: captions } = readCaptions();
  const { perCourse: coupons } = readCoupons();
  const { perCourse: couponQuota } = readCouponQuota();
  const { perCourse: engagement } = readEngagement();
  const { perCourse: realIds } = readUdemyRealCourseIds();
  const enrich = (c) => ({
    ...c,
    num_subscribers: counts[c.id] ?? null,
    revenue: perCourse[c.id] ?? null,
    caption_locales: captions[c.id] ?? null,
    coupons: coupons[c.id] ?? null,
    remaining_coupon_count: couponQuota[c.id] ?? null,
    minutes_taught: engagement[c.id]?.minutesTaught ?? null,
    is_udemy_business: engagement[c.id]?.isUdemyBusiness ?? null,
    recent_months: engagement[c.id]?.recentMonths ?? null,
    real_course_id: realIds[c.id]?.realCourseId ?? null,
    best_price_value: realIds[c.id]?.bestPriceValue ?? null,
    min_custom_price: realIds[c.id]?.minCustomPrice ?? null,
    max_custom_price: realIds[c.id]?.maxCustomPrice ?? null,
  });

  if (req.query.page) {
    const data = await udemyGet('/taught-courses/courses/', {
      page: req.query.page,
      page_size: req.query.page_size || 100,
      'fields[course]': COURSE_FIELDS,
    });
    data.results = (data.results || []).map(enrich);
    data.enrollment_scraped_at = scrapedAt;
    data.total_revenue = totalRevenue;
    data.currency = currency;
    return res.json(data);
  }

  // Walk every page and return the combined list (cached — see walkAllCourses).
  const results = await walkAllCourses();
  res.json({
    count: results.length,
    results: results.map(enrich),
    enrollment_scraped_at: scrapedAt,
    total_revenue: totalRevenue,
    currency,
  });
}));

// Reviews — filtered to a course via ?course=<id>, or all if omitted.
app.get('/api/reviews', wrap(async (req, res) => {
  const data = await udemyGet('/taught-courses/reviews/', {
    course: req.query.course,
    page: req.query.page || 1,
    page_size: req.query.page_size || 20,
  });
  res.json(data);
}));

// Q&A questions — filtered to a course via ?course=<id>, or all if omitted.
app.get('/api/questions', wrap(async (req, res) => {
  const data = await udemyGet('/taught-courses/questions/', {
    course: req.query.course,
    page: req.query.page || 1,
    page_size: req.query.page_size || 20,
  });
  res.json(data);
}));

// --- Transcript data receiver — bookmarklet uses GET (avoids HTTPS→HTTP mixed-content block) ---
// /api/transcripts/save?slug=commercial-credit-analysis&lang=English&lang=Spanish
app.get('/api/transcripts/save', wrap(async (req, res) => {
  const slug = req.query.slug;
  const langs = req.query.lang ? (Array.isArray(req.query.lang) ? req.query.lang : [req.query.lang]) : [];
  req.body = { slug, languages: langs };
  // fall through to shared handler below
  return saveTranscript(req, res);
}));

async function saveTranscript(req, res) {
  const { courseId, slug, languages } = req.body || {};
  if (!courseId && !slug) return res.status(400).json({ error: 'courseId or slug required' });
  if (!Array.isArray(languages)) return res.status(400).json({ error: 'languages must be an array' });

  let resolvedId = courseId;
  if (!resolvedId && slug) {
    let page = 1;
    outer: while (page < 10) {
      const data = await udemyGet('/taught-courses/courses/', {
        page, page_size: 100, 'fields[course]': '@default,published_title,is_published'
      }).catch(() => ({ results: [], next: null }));
      const match = (data.results || []).find(c => c.published_title === slug);
      if (match) { resolvedId = match.id; break outer; }
      if (!data.next) break;
      page++;
    }
  }
  if (!resolvedId) return res.status(404).json({ error: 'Course not found' });
  setTranscript(resolvedId, languages);
  const isHtml = (req.headers.accept || '').includes('text/html');
  if (isHtml) {
    const msg = languages.length ? languages.join(', ') : '(no captions on this course)';
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Saved</title>
<style>body{font-family:system-ui;background:#0f1117;color:#e6e8ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}
h1{color:#4ade80;font-size:28px;margin:0;}p{color:#9aa0ad;margin:0;}</style></head>
<body><h1>✓ Saved</h1><p>${slug}</p><p style="color:#c79bff">${msg}</p>
<p style="margin-top:20px;font-size:13px">You can close this tab.</p>
<script>setTimeout(()=>window.close(),2000);</script></body></html>`);
  }
  res.json({ ok: true, courseId: resolvedId, languages });
}

// --- Transcript data receiver — bookmarklet POSTs here -------------------
// Accepts { courseId, slug, languages: string[] } and saves to transcript-cache.json
app.post('/api/transcripts', express.json(), wrap(async (req, res) => {
  return saveTranscript(req, res);
}));

// Transcript status — how many courses have been captured
app.get('/api/transcripts/status', wrap(async (req, res) => {
  const { transcripts, scrapedAt } = readTranscripts();
  const captured = Object.keys(transcripts).length;
  const withData = Object.values(transcripts).filter(v => Array.isArray(v) && v.length > 0).length;
  res.json({ captured, withData, scrapedAt });
}));

// --- Generic passthrough -------------------------------------------------
// Hit ANY instructor endpoint without writing new code, e.g.:
//   /api/udemy/taught-courses/courses/?page=1
app.get('/api/udemy/*', wrap(async (req, res) => {
  const path = '/' + req.params[0];
  const data = await udemyGet(path, req.query);
  res.json(data);
}));

// Serve the bookmarklet installer page
app.get('/bookmarklet', (req, res) => {
  const file = join(__dirname, 'bookmarklet.html');
  if (existsSync(file)) res.sendFile(file);
  else res.status(404).send('bookmarklet.html not found');
});

// Serve the Marketing Tool course catalog. It is a single self-contained file
// built by the marketing-tool pipeline, so there is nothing to bundle here.
// Registered before the SPA catch-all below, which would otherwise swallow it,
// and it inherits the same basic-auth gate as every other route.
app.get('/catalog', (req, res) => {
  const file = join(__dirname, 'catalog.html');
  if (existsSync(file)) res.sendFile(file);
  else res.status(404).send('catalog.html not found - run the marketing-tool build and copy dist/index.html here');
});

// --- Serve the built frontend (production) -------------------------------
// In prod the React build is served from the same origin, so the client's
// relative /api calls work with no proxy.
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  // Vite content-hashes filenames under /assets/ (e.g. index-Bn-n1T3e.js), so those
  // are safe to cache for a year — a new build always gets a new filename. index.html
  // itself must stay revalidate-on-every-load so users always get the latest build.
  app.use(express.static(clientDist, {
    setHeaders(res, path) {
      res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
}

// --- Error handler -------------------------------------------------------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message, status, body: err.body });
});

app.listen(PORT, () => {
  console.log(`Udemy dashboard API running on http://localhost:${PORT}`);
});
