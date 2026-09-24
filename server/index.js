import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import XLSX from 'xlsx';
import { udemyGet } from './udemyClient.js';
import { SUPPORTED_LANGS, startJob as startCaptionJob, getJob as getCaptionJob } from './localizeCaptions.js';
import {
  readEnrollment, readRevenue, readCaptions, readCoupons, readCouponQuota, readUdemyRealCourseIds, readTranscripts, setTranscript,
  readBatchCoverage, readBatchCourseRevenue, readBatchDashboard, readCourseMapDashboard, readParentRevenueTree,
  readFeedCatalog, readFeedRevenue,
  readCourseraCourses, readCourseraMetrics, readCourseraOverview, readCourseraCourseInstructors, latestUpdatedAt,
  readCourseraCourseStatus, readCourseraReviews, readCourseraCinReviews, readCourseraRevenueImport,
  readCourseraRevenueQuarterly, readCourseraQuarterTotals,
  readCourseraCourseItems, searchCourseraItems, readCourseraInstructorProfiles,
  readBookmarks, addBookmark, removeBookmark,
  readCourseraCinCourses, readCourseraCinMetrics, readCourseraCinOverview,
  readFutureLearnCourses, readLinkedInCourses, readGo1Courses, readGo1Lifetime, readGo1Catalog, readEngagement,
  readRevenueDashboard, readCourseRevenueAcrossPlatforms,
  readFreshness, readPlatformFreshness, rawQuery,
} from './db.js';

const app = express();
const PORT = process.env.PORT || 5055;
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'udemy-auth.json');
const COURSERA_AUTH_FILE = join(__dirname, 'coursera-auth.json');
const FUTURELEARN_AUTH_FILE = join(__dirname, 'futurelearn-auth.json');
const LINKEDIN_AUTH_FILE = join(__dirname, 'linkedin-auth.json');
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

// --- The royalty tool, tunnelled ----------------------------------------
// ~/course-map binds 127.0.0.1 only and has no auth of its own, so this proxy
// is the single public door to it and the lock has to be here.
//
// ITS OWN CREDENTIAL, NOT THE DASHBOARD'S. This serves what every SME is owed,
// the advances against it and the contract terms — the most sensitive data on
// this machine — so it gets a lock of its own, shared with nobody else.
//
// MOUNTED ABOVE express.json() DELIBERATELY. Below it the body would already be
// buffered and parsed here, and piping the request onward would hang; the
// upload tab posts files of up to 120 MB through this route.
const ROYALTY_TARGET = process.env.ROYALTY_TARGET || 'http://127.0.0.1:5059';
const ROYALTY_USER = process.env.ROYALTY_USER || 'finance';
const ROYALTY_PASS = process.env.ROYALTY_PASSWORD;

// The page resolves its API calls from its own URL, so it must be reached with
// the trailing slash or every fetch would climb to the dashboard's root.
// Express matches "/royalty/" on this route too, so the bare path has to be
// tested explicitly — redirecting on both is an infinite loop.
app.get('/royalty', (req, res, next) => (
  /^\/royalty(\?|$)/.test(req.originalUrl) ? res.redirect(301, '/royalty/') : next()
));

app.use('/royalty', (req, res, next) => {
  // No password configured means not exposed. Failing closed matters more here
  // than anywhere else in this file: the alternative is publishing it.
  if (!ROYALTY_PASS) {
    return res.status(503).type('text/plain').send(
      'The royalty tool is not exposed. Set ROYALTY_PASSWORD in server/.env to turn it on.\n');
  }
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    // Compared at constant time so the password cannot be recovered a character
    // at a time by watching how long the answer takes.
    const ok = (a, b) => {
      const A = Buffer.from(String(a)), B = Buffer.from(String(b));
      return A.length === B.length && timingSafeEqual(A, B);
    };
    if (ok(u, ROYALTY_USER) && ok(p, ROYALTY_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Starweaver Royalty"');
  return res.status(401).type('text/plain').send('Authentication required');
}, (req, res) => {
  const target = new URL(req.originalUrl.replace(/^\/royalty/, '') || '/', ROYALTY_TARGET);
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization;          // ours, not course-map's business
  const up = httpRequest({
    hostname: target.hostname, port: target.port, path: target.pathname + target.search,
    method: req.method, headers,
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => res.status(502).type('text/plain').send(
    `The royalty tool is not answering at ${ROYALTY_TARGET} (${e.message}).\n` +
    'On this machine it is the com.starweaver.course-map launchd agent.\n'));
  req.pipe(up);
});

app.use(express.json());

// --- Public: the Distribution Catalog for Marketing Team -----------------
// Mounted ABOVE the basic-auth gate on purpose, so /distribution-catalog is open
// to anyone with the link (asked for 2026-09-11). Keep it above that gate - moving it
// below puts the catalog behind the dashboard password.
//
// The file is a static build artifact from ~/marketing-tool, rebuilt daily at
// 08:30 by the com.starweaver.marketing-tool-refresh launchd agent. It carries
// only live course titles, links and their SWO/LPS parent + batch; it does not
// touch this dashboard's revenue or enrollment data.
const CATALOG_FILE =
  process.env.CATALOG_FILE || join(__dirname, '..', '..', 'marketing-tool', 'dist', 'catalog.html');

// The catalog lived at /catalog until 2026-09 and that link is already in
// people's hands (and in the marketing-tool README), so the old path keeps
// working — a permanent redirect to the new name, above the auth gate too.
app.get('/catalog', (req, res) => res.redirect(301, '/distribution-catalog'));

app.get('/distribution-catalog', (req, res) => {
  if (!existsSync(CATALOG_FILE)) {
    return res
      .status(503)
      .type('text/plain')
      .send('The course catalog has not been built yet.\nRun: cd ~/marketing-tool && npm run refresh\n');
  }
  // Rebuilt daily, so never let a proxy pin yesterday's copy.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(CATALOG_FILE);
});

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
  res.set('WWW-Authenticate', 'Basic realm="Distribution Dashboard"');
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
// How old each platform's data is, platform by platform — see db.js.
app.get('/api/freshness', (req, res) => res.json(readPlatformFreshness()));

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

// --- LinkedIn Learning connection (session) -------------------------------
app.get('/api/linkedin/connection', (req, res) => {
  res.json({ connected: existsSync(LINKEDIN_AUTH_FILE) });
});

app.post('/api/linkedin/connect', (req, res) => {
  const state = cookiesToState(req.body?.cookies ?? req.body);
  const isLinkedIn = state.cookies.some((c) => /(^|\.)linkedin\.com$/.test(c.domain));
  if (!state.cookies.length || !isLinkedIn) {
    return res.status(400).json({
      error: 'That does not look like a linkedin.com cookie export. Sign in at '
        + 'linkedin.com/learning/instructor-portal/analytics and export the cookies from that tab.',
      cookieCount: state.cookies.length,
      domainsSeen: [...new Set(state.cookies.map((c) => c.domain))],
    });
  }
  writeFileSync(LINKEDIN_AUTH_FILE, JSON.stringify(state, null, 2));
  res.json({ connected: true, cookieCount: state.cookies.length });
});

app.post('/api/linkedin/disconnect', (req, res) => {
  try { if (existsSync(LINKEDIN_AUTH_FILE)) unlinkSync(LINKEDIN_AUTH_FILE); } catch {}
  res.json({ connected: false });
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
  // The scrapers read starweaver.mygo1.com (Content Studio). Cookies for
  // go1.com or learn.go1.com are a DIFFERENT session and will land on the
  // login page — but they end in "go1.com" too, so a loose check accepted them
  // and the connection silently looked fine while every scrape failed.
  const domains = [...new Set(state.cookies.map((c) => c.domain))];
  const hasStudio = state.cookies.some((c) => /(^|\.)mygo1\.com$/.test(c.domain));
  if (!state.cookies.length || !hasStudio) {
    return res.status(400).json({
      error: 'No mygo1.com cookies in that export. Sign in at starweaver.mygo1.com '
        + '(Content Studio) and export the cookies from THAT tab — an export taken on '
        + 'go1.com or learn.go1.com is a different session and cannot read Insights.',
      cookieCount: state.cookies.length,
      domainsSeen: domains,
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
// LinkedIn Learning courses (from the DB).
app.get('/api/linkedin/courses', (req, res) => {
  res.json(readLinkedInCourses());
});

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
// The Go1 catalogue — every live course, with its language. The other Go1
// routes are activity: they list only courses someone studied.
app.get('/api/go1/catalog', (req, res) => {
  const { items, scrapedAt } = readGo1Catalog();
  const courses = items.filter((i) => i.type === 'interactive' && i.state === 'published');
  const byLanguage = courses.reduce((a, c) => ((a[c.language || 'unknown'] = (a[c.language || 'unknown'] || 0) + 1), a), {});
  res.json({ courses, playlists: items.filter((i) => i.type === 'playlist').length, byLanguage, scrapedAt });
});

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
  const { perCourse: coupons, usedUpPerCourse: couponsUsedUp } = readCoupons();
  const { perCourse: couponQuota } = readCouponQuota();
  const { perCourse: engagement } = readEngagement();
  const { perCourse: realIds } = readUdemyRealCourseIds();
  const enrich = (c) => ({
    ...c,
    num_subscribers: counts[c.id] ?? null,
    revenue: perCourse[c.id] ?? null,
    caption_locales: captions[c.id] ?? null,
    coupons: coupons[c.id] ?? null,
    // Kept apart from `coupons`, which means LIVE everywhere it is counted.
    coupons_used_up: couponsUsedUp[c.id] ?? [],
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

// --- One-call export ------------------------------------------------------
// Everything, as a single workbook or a single JSON, so another machine can
// pull the whole dataset in one request instead of stitching a dozen endpoints
// together. Reading is the only thing that travels: the scrapers need the
// session files and a headed browser, so they stay on the machine that has them.
//
//   curl -u user:pass -O -J https://<host>/api/export.xlsx
//   curl -u user:pass https://<host>/api/export.json
const EXPORT_TABLES = [
  ['Udemy courses', 'SELECT * FROM udemy_real_course_ids'],
  ['Udemy revenue by course', 'SELECT * FROM revenue_course'],
  ['Udemy revenue monthly', 'SELECT * FROM revenue_monthly'],
  ['Udemy enrollment', 'SELECT * FROM enrollment'],
  ['Udemy engagement', 'SELECT * FROM engagement_course'],
  ['Udemy captions', 'SELECT * FROM captions'],
  ['Udemy coupons', 'SELECT * FROM coupons'],
  ['Coursera SW metrics', 'SELECT * FROM coursera_metrics'],
  ['Coursera SW status', 'SELECT * FROM coursera_course_status'],
  ['Coursera SW reviews', 'SELECT * FROM coursera_reviews'],
  ['Coursera CIN metrics', 'SELECT * FROM coursera_cin_metrics'],
  ['Coursera CIN reviews', 'SELECT * FROM coursera_cin_reviews'],
  ['Coursera revenue quarterly', 'SELECT * FROM coursera_revenue_quarterly'],
  ['Coursera instructors', 'SELECT * FROM coursera_instructor_profiles'],
  ['Coursera rating history', 'SELECT * FROM coursera_rating_history'],
  ['Coursera course items', 'SELECT * FROM coursera_course_items'],
  ['FutureLearn courses', 'SELECT * FROM futurelearn_courses'],
  ['LinkedIn courses', 'SELECT * FROM linkedin_courses'],
  ['LinkedIn revenue', 'SELECT * FROM linkedin_revenue'],
  ['Go1 courses', 'SELECT * FROM go1_courses'],
  ['Go1 history', 'SELECT * FROM go1_course_history'],
];

function collectExport() {
  const out = {};
  for (const [name, sql] of EXPORT_TABLES) {
    try { out[name] = rawQuery(sql); } catch (e) { out[name] = { error: String(e.message) }; }
  }
  return out;
}

app.get('/api/export.json', (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), freshness: readFreshness(), data: collectExport() });
});

app.get('/api/export.xlsx', (req, res) => {
  const data = collectExport();
  const wb = XLSX.utils.book_new();

  // A README first, so whoever opens it knows how old each feed is rather than
  // assuming every tab was refreshed today.
  const fresh = readFreshness();
  const readme = [
    ['Starweaver — all platform data'],
    ['Generated', new Date().toISOString()],
    [],
    ['Sheet', 'Rows'],
    ...Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 'error']),
    [],
    ['Last successful scrape per job'],
    ['Job', 'Finished', 'Hours ago'],
    ...fresh.map((f) => [f.job, f.lastOk, f.hoursAgo]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readme), 'README');

  for (const [name, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    // Excel caps sheet names at 31 characters.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="starweaver-all-platforms-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

// --- Landing page + the two dashboards -----------------------------------
// `/` is a small chooser; the Distribution Dashboard moves to a named path and
// the Marketing Tool's generated catalog is served alongside it. These are
// registered BEFORE the static/catch-all block below, which otherwise answers
// every path with the React app.
const MARKETING_DIST = process.env.MARKETING_DIST || join(__dirname, '..', '..', 'marketing-tool', 'dist');
const MARKETING_HTML = join(MARKETING_DIST, 'catalog.html');

app.get('/', (req, res) => res.sendFile(join(__dirname, 'home.html')));

// Revenue view — separate from the main dashboard while the SharePoint royalty
// work is still being shaped.
app.get('/api/revenue/combined', (req, res) => res.json(readRevenueDashboard()));
app.get('/api/revenue/by-course', (req, res) => res.json(readCourseRevenueAcrossPlatforms()));
// Live courses per batch, per platform — counted from the live catalogues, not
// from a status column in a spreadsheet.
app.get('/api/batches', (req, res) => res.json(readBatchCoverage()));
// Parent course -> its courses on each platform, with what each earned.
app.get('/api/batch-revenue', (req, res) => res.json(readBatchCourseRevenue()));
app.get('/api/batch-dashboard', (req, res) => res.json(readBatchDashboard()));
// The resolved course map — live title -> Boostr -> parent -> revenue.
app.get('/api/course-map', (req, res) => res.json(readCourseMapDashboard()));
// Parent -> each platform's titles -> what each earned. The all-platforms view.
app.get('/api/parent-tree', (req, res) => res.json(readParentRevenueTree()));

// --- the feed other tools consume ----------------------------------------
// Two stable shapes. Everything else here is shaped for this server's own
// pages; these are an interface.
// UDEMY'S LIVE LIST COMES FROM UDEMY. The stored list (udemy_real_course_ids)
// is scraped, and Udemy scraping is off, so it went stale both ways: it kept 22
// courses that are not published and missed ones published since (2026-09-24).
// The instructor API — an API key, not a scrape — says what is published now.
// If that call fails the stored list is served instead, and the response says so.
app.get('/api/feed/catalog', wrap(async (req, res) => {
  const out = readFeedCatalog(req.query.platform);
  if (req.query.platform && req.query.platform !== 'Udemy') return res.json(out);
  try {
    const live = (await walkAllCourses()).filter((c) => c.is_published && c.published_title);
    if (!live.length) throw new Error('no published courses returned');
    out.courses = [
      ...out.courses.filter((c) => c.platform !== 'Udemy'),
      ...live.map((c) => ({
        platform: 'Udemy', title: c.title, slug: c.published_title,
        url: `https://www.udemy.com${c.url || `/course/${c.published_title}/`}`, status: 'published',
      })),
    ];
    out.total = out.courses.length;
    out.udemySource = 'udemy-api';
  } catch (e) {
    out.udemySource = `stored list (Udemy API unavailable: ${e.message})`;
  }
  res.json(out);
}));
app.get('/api/feed/revenue', (req, res) => res.json(readFeedRevenue(req.query.platform)));
// THE FINANCE PAGES LIVE IN THE PRIVATE ROYALTY REPO, beside this one, because
// this repo is public and they are commercial data. They are still served from
// here so the URLs keep working, but note they are only as private as this
// server is: it is reachable over ngrok behind basic auth, so treat these three
// as exposed and move them behind their own server if that stops being enough.
const ROYALTY_PAGES = join(__dirname, '..', '..', 'starweaver-royalty', 'pages');
const royaltyPage = (file) => (req, res) =>
  res.sendFile(join(ROYALTY_PAGES, file), (err) => {
    if (err) res.status(404).send(
      `${file} lives in the private starweaver-royalty repo, which is expected at ` +
      `~/starweaver-royalty alongside this one. It is not there.`);
  });
app.get(['/revenue', '/revenue-dashboard'], royaltyPage('revenue.html'));
// The confirmed batches, on their own page — local only.
app.get(['/batches', '/swo'], royaltyPage('batches.html'));
app.get(['/course-map', '/map'], royaltyPage('course-map.html'));

app.get(['/marketing-dashboard', '/marketing-dashboard/'], (req, res) => {
  if (!existsSync(MARKETING_HTML)) {
    return res.status(503).send(
      '<p style="font:15px system-ui;padding:40px">The marketing catalog has not been built yet.<br>'
      + 'Run <code>cd ~/marketing-tool &amp;&amp; npm run build:dashboard</code>, then reload.</p>');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(MARKETING_HTML);
});

// the unmatched-courses workbook the marketing build also produces
app.get('/marketing-dashboard/unmatched-courses.xlsx', (req, res) => {
  const f = join(MARKETING_DIST, 'unmatched-courses.xlsx');
  if (!existsSync(f)) return res.status(404).send('not built');
  res.download(f);
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
  console.log(`Distribution Dashboard API running on http://localhost:${PORT}`);
});
