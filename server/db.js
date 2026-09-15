// Local SQLite store for all scraped data (enrollment, revenue, captions,
// coupons, transcripts, Coursera courses/metrics/overview).
//
// Why this exists: every scraper used to `writeFileSync` a whole cache JSON
// file per run. If a run scraped 0 rows (expired session, Cloudflare block,
// etc.) but didn't throw, it still overwrote the file — silently wiping
// good data (this happened to caption-cache.json and coupon-cache.json).
//
// Fix: `guardedReplaceAll` is the ONE place that decides whether a fresh
// scrape is trustworthy enough to replace what's stored. A run that comes
// back empty (or drastically smaller than what's already there) is rejected
// — the existing rows are left untouched and the attempt is logged to
// `scrape_runs` as guarded, instead of silently succeeding.
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { EXCLUDED_CIN_SLUGS } from './courseraCinExclusions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DASHBOARD_DB_FILE || join(__dirname, 'dashboard.db');

const db = new DatabaseCtor(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS enrollment (
    course_id TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_course (
    course_id TEXT PRIMARY KEY,
    amount REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_monthly (
    month TEXT PRIMARY KEY,
    amount REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captions (
    course_id TEXT PRIMARY KEY,
    languages TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coupons (
    course_id TEXT NOT NULL,
    code TEXT NOT NULL,
    is_free INTEGER,
    discount_value REAL,
    max_uses INTEGER,
    used INTEGER,
    start_time TEXT,
    end_time TEXT,
    active INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course_id, code)
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    course_id TEXT PRIMARY KEY,
    languages TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coupon_quota (
    course_id TEXT PRIMARY KEY,
    remaining_coupon_count INTEGER,
    updated_at TEXT NOT NULL
  );

  -- Real numeric Udemy course id (as used by Udemy's own bulk-coupon-creation
  -- tool export), matched by title to our course_id (the Instructor API's
  -- base64-ish id). Manually imported from a CSV export, not scraped.
  CREATE TABLE IF NOT EXISTS udemy_real_course_ids (
    course_id TEXT PRIMARY KEY,
    real_course_id INTEGER,
    title TEXT,
    currency TEXT,
    best_price_value REAL,
    min_custom_price REAL,
    max_custom_price REAL,
    coupons_remaining INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_courses (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_metrics (
    course_name TEXT PRIMARY KEY,
    domain TEXT,
    in_specialization INTEGER,
    launch_date TEXT,
    enrollments INTEGER,
    paid_enrollments INTEGER,
    completions INTEGER,
    completion_rate REAL,
    rating REAL,
    updated_at TEXT NOT NULL
  );

  -- Slug + publish status per course, merge-written (never wiped by the
  -- Looker-driven coursera_metrics refresh above, which doesn't know slugs).
  -- Same enrichment pattern as coursera_course_instructors below.
  CREATE TABLE IF NOT EXISTS coursera_course_status (
    course_name TEXT PRIMARY KEY,
    slug TEXT,
    status TEXT,
    updated_at TEXT NOT NULL
  );

  -- Real per-course revenue, manually imported from partner-provided revenue
  -- reports (e.g. "ANGUS + ALEX ... .xlsx") — Coursera's Partner API exposes
  -- no revenue data at all, for either the Starweaver or CIN account, so
  -- there is no live scrape source for this; it's refreshed only when a new
  -- report file is provided. Keyed by slug, applies across BOTH coursera_metrics
  -- (Starweaver) and coursera_cin_metrics (CIN) — confirmed by slug overlap
  -- that a single revenue report covers courses living in both accounts.
  CREATE TABLE IF NOT EXISTS coursera_revenue_import (
    slug TEXT PRIMARY KEY,
    course_name TEXT,
    revenue REAL,
    completions INTEGER,
    quarter_count INTEGER,
    source_file TEXT,
    imported_at TEXT NOT NULL
  );

  -- Same revenue reports, but kept PER QUARTER instead of collapsed to a
  -- lifetime total. The table above cannot answer "what did this course earn
  -- last quarter" — and because the source exports live wherever they were
  -- downloaded, a deleted file used to mean the quarter split was gone for
  -- good. This is the durable copy.
  --
  -- Keyed by (catalog, course_key, quarter). course_key is the slug when the
  -- export provides one and a normalised course name when it does not (the
  -- historical "ALL Coursera Data" report has no slug column). catalog is
  -- 'starweaver' or 'cin'. product_type separates course revenue from
  -- specialization/bundle revenue, which must not be attributed to a course.
  CREATE TABLE IF NOT EXISTS coursera_revenue_quarterly (
    catalog TEXT NOT NULL,
    course_key TEXT NOT NULL,
    quarter TEXT NOT NULL,
    product_type TEXT NOT NULL DEFAULT 'course',
    course_name TEXT,
    slug TEXT,
    revenue REAL NOT NULL DEFAULT 0,
    net_sales REAL,
    completions INTEGER,
    source_file TEXT,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (catalog, course_key, quarter, product_type)
  );
  CREATE INDEX IF NOT EXISTS idx_crq_quarter ON coursera_revenue_quarterly (quarter);
  CREATE INDEX IF NOT EXISTS idx_crq_slug ON coursera_revenue_quarterly (slug);

  -- Every item inside every Coursera course: the full module / lesson / item
  -- tree, one row per item, with its type.
  --
  -- This is the content INVENTORY — the denominator for "what is actually
  -- being consumed". It answers what exists and in what form (video, reading,
  -- interactive widget) before any engagement question can be asked.
  --
  -- Source is onDemandCourseMaterials.v2, which is PUBLIC — no partner session
  -- needed, so this refreshes even when the Coursera login has lapsed. The
  -- catch: graded items (quizzes, peer reviews) are hidden from anonymous
  -- callers, verified against a course known to contain them. So the row set
  -- is a floor, not a complete curriculum, and per-learner consumption is not
  -- here at all — that needs an authenticated partner export.
  CREATE TABLE IF NOT EXISTS coursera_course_items (
    course_slug TEXT NOT NULL,
    item_id TEXT NOT NULL,
    catalog TEXT NOT NULL DEFAULT 'starweaver',
    course_name TEXT,
    module_order INTEGER,
    module_name TEXT,
    lesson_order INTEGER,
    lesson_name TEXT,
    item_order INTEGER,
    item_slug TEXT,
    item_name TEXT,
    item_type TEXT,
    asset_type TEXT,
    contains_widget INTEGER,
    is_locked INTEGER,
    minutes REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course_slug, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cci_type ON coursera_course_items (item_type);
  CREATE INDEX IF NOT EXISTS idx_cci_course ON coursera_course_items (course_slug);

  -- One row per PERSON who teaches on Coursera, with their profile content.
  --
  -- Distinct from coursera_course_instructors above, which is one row per
  -- COURSE holding names as text. A Coursera profile belongs to the individual,
  -- not to a partner org, so somebody teaching on both the Starweaver and CIN
  -- catalogues has a single profile and appears once here.
  --
  -- Sourced from the public instructors.v1 API, so it refreshes without a
  -- partner session. The five website_* columns are Coursera's entire set of
  -- link slots; an empty string means the SME left the slot blank, which is
  -- what makes this table useful as a completeness audit.
  CREATE TABLE IF NOT EXISTS coursera_instructor_profiles (
    instructor_id TEXT PRIMARY KEY,
    full_name TEXT,
    title TEXT,
    bio TEXT,
    photo TEXT,
    website TEXT,
    website_linkedin TEXT,
    website_twitter TEXT,
    website_facebook TEXT,
    website_gplus TEXT,
    profile_url TEXT,
    on_starweaver INTEGER DEFAULT 0,
    on_cin INTEGER DEFAULT 0,
    sw_courses INTEGER DEFAULT 0,
    cin_courses INTEGER DEFAULT 0,
    enrollments INTEGER DEFAULT 0,
    is_shared_account INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  -- Month-by-month snapshot of each course's headline numbers.
  --
  -- Why this exists: coursera_metrics is REPLACED on every scrape, so it only
  -- ever holds today's rating and enrollment. That makes "how did this course's
  -- rating move since last month" unanswerable — the previous value is gone the
  -- moment a scrape runs. This table appends one row per course per month
  -- instead, so the history accumulates.
  --
  -- Keyed on (catalog, course_name, month): re-running in the same month
  -- overwrites that month's row rather than adding a duplicate, so it is safe
  -- to run daily — the last run of a month is the one that stands.
  CREATE TABLE IF NOT EXISTS coursera_rating_history (
    catalog TEXT NOT NULL,             -- 'starweaver' | 'cin'
    course_name TEXT NOT NULL,
    month TEXT NOT NULL,               -- 'YYYY-MM'
    rating REAL,
    enrollments INTEGER,
    paid_enrollments INTEGER,
    completions INTEGER,
    completion_rate REAL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (catalog, course_name, month)
  );

  -- A handful of real learner reviews per course (text + rating), separate
  -- from the aggregate rating column in coursera_metrics since it's one-to-many.
  -- Fetched via Coursera's feedback.v1 API, keyed by slug (needs
  -- coursera_course_status.slug populated first).
  CREATE TABLE IF NOT EXISTS coursera_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    course_name TEXT,
    rating INTEGER,
    review_text TEXT,
    reviewer_name TEXT,
    review_date TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_coursera_reviews_slug ON coursera_reviews(slug);

  CREATE TABLE IF NOT EXISTS coursera_course_instructors (
    course_name TEXT PRIMARY KEY,
    has_starweaver_instructor INTEGER,
    instructor_names TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_overview_kpis (
    label TEXT PRIMARY KEY,
    value INTEGER,
    updated_at TEXT NOT NULL
  );

  -- Coursera CIN: a second partner account ("coursera" org slug) reachable from
  -- the same Coursera login as Starweaver — fully separate courses/metrics, kept
  -- in its own tables rather than mixed into the coursera_* ones above.
  CREATE TABLE IF NOT EXISTS coursera_cin_courses (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_cin_metrics (
    slug TEXT PRIMARY KEY,
    course_name TEXT,
    domain TEXT,
    in_specialization INTEGER,
    launch_date TEXT,
    enrollments INTEGER,
    paid_enrollments INTEGER,
    completions INTEGER,
    completion_rate REAL,
    rating REAL,
    status TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_cin_overview_kpis (
    label TEXT PRIMARY KEY,
    value INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coursera_cin_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    course_name TEXT,
    rating INTEGER,
    review_text TEXT,
    reviewer_name TEXT,
    review_date TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_coursera_cin_reviews_slug ON coursera_cin_reviews(slug);

  CREATE TABLE IF NOT EXISTS engagement_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engagement_monthly (
    month TEXT PRIMARY KEY,
    minutes_taught REAL,
    active_students INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engagement_course (
    course_id TEXT PRIMARY KEY,
    minutes_taught REAL,
    active_students INTEGER,
    is_udemy_business INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engagement_ub_monthly (
    month TEXT PRIMARY KEY,
    ub_minutes REAL,
    non_ub_minutes REAL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engagement_course_monthly (
    course_id TEXT NOT NULL,
    month TEXT NOT NULL,
    minutes_taught REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course_id, month)
  );

  CREATE TABLE IF NOT EXISTS futurelearn_courses (
    slug TEXT PRIMARY KEY,
    title TEXT,
    code TEXT,
    category TEXT,
    status TEXT,
    -- FutureLearn shows a run state AND a visibility flag in one cell; an
    -- "In progress" course that is Private is not publicly enrollable, so the
    -- two are stored separately rather than as one concatenated string.
    visibility TEXT,
    start_date TEXT,
    wishlist_count INTEGER,
    enrollment INTEGER,
    updated_at TEXT NOT NULL
  );

  -- LinkedIn Learning, published under "Starweaver Group, Inc. Licensor".
  --
  -- The instructor portal's all-courses table is the only place that lists
  -- every course at once, and it exposes just these fields — there is no watch
  -- time, completion rate or demographic data at this level. Those live on each
  -- course's own Analytics page, one page per course, so they are deliberately
  -- not modelled here.
  --
  -- Keyed on the title because the portal exposes no course id or slug in the
  -- table view.
  CREATE TABLE IF NOT EXISTS linkedin_courses (
    title TEXT PRIMARY KEY,
    language TEXT,
    learners INTEGER,
    shares INTEGER,
    likes INTEGER,
    last_updated TEXT,
    updated_at TEXT NOT NULL
  );

  -- LinkedIn Learning royalty statements, one row per course per period.
  --
  -- Columns mirror the statements table at
  --   /learning/instructor-portal/payments/statements?instructorUrn=...
  -- which reports a single "selected period" at a time, so the scraper walks
  -- the period picker and appends. Keyed on (course_id, period) so re-running a
  -- month refreshes it rather than duplicating.
  --
  -- earnings_to_date is a running lifetime figure, NOT a per-period value —
  -- summing it across periods would multiply the real total.
  CREATE TABLE IF NOT EXISTS linkedin_revenue (
    course_id TEXT NOT NULL,
    period TEXT NOT NULL,              -- 'YYYY-MM'
    course_name TEXT,
    payment REAL,                      -- paid for the selected period
    earnings REAL,                     -- earned in the selected period
    royalty_earnings REAL,
    earnings_prev_period REAL,
    earnings_to_date REAL,             -- lifetime running total, do not sum
    alacarte_earnings REAL,
    alacarte_units INTEGER,
    grants REAL,
    advance_remaining REAL,
    advances_total REAL,
    royalty_pct REAL,
    release_date TEXT,
    languages TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course_id, period)
  );

  CREATE TABLE IF NOT EXISTS go1_course_history (
    course_name TEXT NOT NULL,
    month TEXT NOT NULL,
    enrolments INTEGER,
    completions INTEGER,
    total_minutes INTEGER,
    avg_session_minutes INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (course_name, month)
  );

  CREATE TABLE IF NOT EXISTS go1_courses (
    name TEXT PRIMARY KEY,
    enrolments INTEGER,
    completions INTEGER,
    total_minutes INTEGER,
    avg_session_minutes INTEGER,
    month TEXT,
    updated_at TEXT NOT NULL
  );

  -- A small cross-platform watchlist — pin specific courses (regardless of
  -- platform) to check daily without hunting through the full course lists.
  -- course_key is whatever identifier that platform's data already uses:
  -- Udemy -> course id, Coursera/CIN -> slug, FutureLearn -> slug, Go1 -> name.
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    course_key TEXT NOT NULL,
    title TEXT,
    added_at TEXT NOT NULL,
    UNIQUE(platform, course_key)
  );

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    guarded INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER,
    error TEXT
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function tableCount(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function recordRun({ job, startedAt, ok, guarded, rowCount, error }) {
  db.prepare(
    `INSERT INTO scrape_runs (job, started_at, finished_at, ok, guarded, row_count, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(job, startedAt, nowIso(), ok ? 1 : 0, guarded ? 1 : 0, rowCount ?? null, error ?? null);
}

// The core safety net. `rows` must be the COMPLETE fresh snapshot for `table`
// (not a partial page) — on success the whole table is replaced atomically.
// Refuses the replace (and logs a guarded scrape_run) when the new snapshot
// looks like a failed/partial run rather than a real drop in data:
//   - 0 rows while the table currently has data, or
//   - fewer than `minRatio` (default 50%) of the current row count.
function guardedReplaceAll(table, rows, insertFn, { job, minRatio = 0.5 } = {}) {
  const startedAt = nowIso();
  const before = tableCount(table);
  const shrunk = before > 0 && rows.length < before * minRatio;
  if (before > 0 && (rows.length === 0 || shrunk)) {
    recordRun({
      job, startedAt, ok: false, guarded: true, rowCount: rows.length,
      error: `refused: ${rows.length} new rows vs ${before} existing (guard: empty or >${Math.round((1 - minRatio) * 100)}% drop)`,
    });
    return { ok: false, guarded: true, written: 0 };
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run();
    for (const row of rows) insertFn(row);
  });
  tx();
  recordRun({ job, startedAt, ok: true, guarded: false, rowCount: rows.length });
  return { ok: true, guarded: false, written: rows.length };
}

// Merge-style write for datasets scrapers already fetch incrementally
// (enrollment, transcripts) — only ever adds/updates rows, never deletes.
function upsertMerge(table, rows, insertFn, { job } = {}) {
  const startedAt = nowIso();
  const tx = db.transaction(() => { for (const row of rows) insertFn(row); });
  tx();
  recordRun({ job, startedAt, ok: true, guarded: false, rowCount: rows.length });
  return { ok: true, guarded: false, written: rows.length };
}

// --- Enrollment (merge) ---------------------------------------------------
const upsertEnrollmentStmt = db.prepare(
  `INSERT INTO enrollment (course_id, count, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(course_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
);
export function writeEnrollment(counts) {
  const rows = Object.entries(counts).map(([course_id, count]) => ({ course_id, count }));
  const ts = nowIso();
  return upsertMerge('enrollment', rows, (r) => upsertEnrollmentStmt.run(r.course_id, r.count, ts), { job: 'enrollment' });
}
export function readEnrollment() {
  const rows = db.prepare('SELECT course_id, count FROM enrollment').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM enrollment').get().t;
  const counts = {};
  for (const r of rows) counts[r.course_id] = r.count;
  return { counts, scrapedAt };
}

// --- Revenue (guarded snapshot) -------------------------------------------
const insertRevenueCourseStmt = db.prepare('INSERT INTO revenue_course (course_id, amount, updated_at) VALUES (?, ?, ?)');
const insertRevenueMonthlyStmt = db.prepare('INSERT INTO revenue_monthly (month, amount, updated_at) VALUES (?, ?, ?)');
const upsertRevenueMetaStmt = db.prepare(
  `INSERT INTO revenue_meta (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
export function writeRevenue({ total, currency, monthly, perCourse }) {
  const startedAt = nowIso();
  const ts = nowIso();
  const courseRows = Object.entries(perCourse || {}).map(([course_id, amount]) => ({ course_id, amount }));
  const beforeCourse = tableCount('revenue_course');
  const shrunk = beforeCourse > 0 && courseRows.length < beforeCourse * 0.5;
  const badTotal = total == null;

  if ((beforeCourse > 0 && (courseRows.length === 0 || shrunk)) || badTotal) {
    recordRun({
      job: 'revenue', startedAt, ok: false, guarded: true, rowCount: courseRows.length,
      error: badTotal ? 'refused: total amount missing' : `refused: ${courseRows.length} new rows vs ${beforeCourse} existing`,
    });
    return { ok: false, guarded: true, written: 0 };
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM revenue_course').run();
    for (const r of courseRows) insertRevenueCourseStmt.run(r.course_id, r.amount, ts);
    db.prepare('DELETE FROM revenue_monthly').run();
    for (const m of monthly || []) insertRevenueMonthlyStmt.run(m.month, m.amount, ts);
    upsertRevenueMetaStmt.run('total', String(total), ts);
    upsertRevenueMetaStmt.run('currency', currency || 'USD', ts);
  });
  tx();
  recordRun({ job: 'revenue', startedAt, ok: true, guarded: false, rowCount: courseRows.length });
  return { ok: true, guarded: false, written: courseRows.length };
}
export function readRevenue() {
  const perCourse = {};
  for (const r of db.prepare('SELECT course_id, amount FROM revenue_course').all()) perCourse[r.course_id] = r.amount;
  const monthly = db.prepare('SELECT month, amount FROM revenue_monthly ORDER BY month').all();
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM revenue_meta').all().map((r) => [r.key, r.value]));
  const scrapedAt = db.prepare(
    `SELECT MAX(t) AS t FROM (
       SELECT MAX(updated_at) AS t FROM revenue_course
       UNION ALL SELECT MAX(updated_at) FROM revenue_monthly
       UNION ALL SELECT MAX(updated_at) FROM revenue_meta
     )`
  ).get().t;
  return {
    perCourse,
    monthly,
    total: meta.total != null ? Number(meta.total) : null,
    currency: meta.currency || 'USD',
    scrapedAt,
  };
}

// --- Engagement: minutes watched + Udemy Business coverage (guarded) -----
const insertEngagementCourseStmt = db.prepare(
  `INSERT INTO engagement_course (course_id, minutes_taught, active_students, is_udemy_business, updated_at)
   VALUES (?, ?, ?, ?, ?)`
);
const insertEngagementMonthlyStmt = db.prepare('INSERT INTO engagement_monthly (month, minutes_taught, active_students, updated_at) VALUES (?, ?, ?, ?)');
const insertEngagementUbMonthlyStmt = db.prepare('INSERT INTO engagement_ub_monthly (month, ub_minutes, non_ub_minutes, updated_at) VALUES (?, ?, ?, ?)');
const insertEngagementCourseMonthlyStmt = db.prepare('INSERT INTO engagement_course_monthly (course_id, month, minutes_taught, updated_at) VALUES (?, ?, ?, ?)');
const upsertEngagementMetaStmt = db.prepare(
  `INSERT INTO engagement_meta (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
export function writeEngagement({ totalMinutes, activeStudents, monthly, perCourse, ubMonthly, courseMonthly }) {
  const startedAt = nowIso();
  const ts = nowIso();
  const courseRows = Object.entries(perCourse || {});
  const beforeCourse = tableCount('engagement_course');
  const shrunk = beforeCourse > 0 && courseRows.length < beforeCourse * 0.5;
  const badTotal = totalMinutes == null;

  if ((beforeCourse > 0 && (courseRows.length === 0 || shrunk)) || badTotal) {
    recordRun({
      job: 'engagement', startedAt, ok: false, guarded: true, rowCount: courseRows.length,
      error: badTotal ? 'refused: total minutes missing' : `refused: ${courseRows.length} new rows vs ${beforeCourse} existing`,
    });
    return { ok: false, guarded: true, written: 0 };
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM engagement_course').run();
    for (const [courseId, c] of courseRows) insertEngagementCourseStmt.run(courseId, c.minutesTaught ?? null, c.activeStudents ?? null, c.isUdemyBusiness ? 1 : 0, ts);
    db.prepare('DELETE FROM engagement_monthly').run();
    for (const m of monthly || []) insertEngagementMonthlyStmt.run(m.month, m.minutesTaught, m.activeStudents, ts);
    db.prepare('DELETE FROM engagement_ub_monthly').run();
    for (const m of ubMonthly || []) insertEngagementUbMonthlyStmt.run(m.month, m.ubMinutes, m.nonUbMinutes, ts);
    db.prepare('DELETE FROM engagement_course_monthly').run();
    for (const r of courseMonthly || []) insertEngagementCourseMonthlyStmt.run(r.courseId, r.month, r.minutesTaught, ts);
    upsertEngagementMetaStmt.run('totalMinutes', String(totalMinutes), ts);
    upsertEngagementMetaStmt.run('activeStudents', String(activeStudents ?? ''), ts);
  });
  tx();
  recordRun({ job: 'engagement', startedAt, ok: true, guarded: false, rowCount: courseRows.length });
  return { ok: true, guarded: false, written: courseRows.length };
}
export function readEngagement() {
  const perCourse = {};
  for (const r of db.prepare('SELECT course_id, minutes_taught, active_students, is_udemy_business FROM engagement_course').all()) {
    perCourse[r.course_id] = { minutesTaught: r.minutes_taught, activeStudents: r.active_students, isUdemyBusiness: !!r.is_udemy_business };
  }
  const monthly = db.prepare('SELECT month, minutes_taught AS minutesTaught, active_students AS activeStudents FROM engagement_monthly ORDER BY month').all();
  const ubMonthly = db.prepare('SELECT month, ub_minutes AS ubMinutes, non_ub_minutes AS nonUbMinutes FROM engagement_ub_monthly ORDER BY month').all();

  // Attach each course's last 3 FULLY COMPLETED months of minutes (most recent
  // first) so the client can render a "minutes consumed by month" report without
  // its own date math. The current calendar month is always excluded — it's
  // partial/in-progress and not comparable to a full month's total.
  const courseMonthlyMap = {};
  for (const r of db.prepare('SELECT course_id, month, minutes_taught FROM engagement_course_monthly').all()) {
    (courseMonthlyMap[r.course_id] ||= {})[r.month] = r.minutes_taught;
  }
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const completedMonthly = monthly.filter((m) => !m.month.startsWith(currentMonthKey));
  const recentMonths = completedMonthly.slice(-3).map((m) => m.month).reverse();
  for (const [courseId, c] of Object.entries(perCourse)) {
    c.recentMonths = recentMonths.map((month) => ({ month, minutes: courseMonthlyMap[courseId]?.[month] ?? null }));
  }

  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM engagement_meta').all().map((r) => [r.key, r.value]));
  const scrapedAt = db.prepare(
    `SELECT MAX(t) AS t FROM (
       SELECT MAX(updated_at) AS t FROM engagement_course
       UNION ALL SELECT MAX(updated_at) FROM engagement_monthly
       UNION ALL SELECT MAX(updated_at) FROM engagement_ub_monthly
       UNION ALL SELECT MAX(updated_at) FROM engagement_course_monthly
       UNION ALL SELECT MAX(updated_at) FROM engagement_meta
     )`
  ).get().t;
  return {
    perCourse,
    monthly,
    ubMonthly,
    totalMinutes: meta.totalMinutes != null ? Number(meta.totalMinutes) : null,
    activeStudents: meta.activeStudents ? Number(meta.activeStudents) : null,
    scrapedAt,
  };
}

// --- Captions (guarded snapshot) ------------------------------------------
const insertCaptionsStmt = db.prepare('INSERT INTO captions (course_id, languages, updated_at) VALUES (?, ?, ?)');
export function writeCaptions(perCourse) {
  const ts = nowIso();
  const rows = Object.entries(perCourse || {}).map(([course_id, languages]) => ({ course_id, languages }));
  return guardedReplaceAll('captions', rows, (r) => insertCaptionsStmt.run(r.course_id, JSON.stringify(r.languages), ts), { job: 'captions' });
}
export function readCaptions() {
  const rows = db.prepare('SELECT course_id, languages FROM captions').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM captions').get().t;
  const perCourse = {};
  for (const r of rows) perCourse[r.course_id] = JSON.parse(r.languages);
  return { perCourse, scrapedAt };
}

// --- Coupons (guarded snapshot, flattened) --------------------------------
const insertCouponStmt = db.prepare(
  `INSERT INTO coupons (course_id, code, is_free, discount_value, max_uses, used, start_time, end_time, active, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeCoupons(perCourse) {
  const ts = nowIso();
  const rows = [];
  for (const [course_id, list] of Object.entries(perCourse || {})) {
    for (const c of list) rows.push({ course_id, ...c });
  }
  // Guard on distinct-course coverage (matches how the scraper reports progress),
  // not raw coupon-row count, since courses legitimately have 0-1 coupons each.
  const beforeCourses = db.prepare('SELECT COUNT(DISTINCT course_id) AS n FROM coupons').get().n;
  const afterCourses = new Set(Object.keys(perCourse || {})).size;
  const startedAt = ts;
  if (beforeCourses > 0 && (afterCourses === 0 || afterCourses < beforeCourses * 0.5)) {
    recordRun({
      job: 'coupons', startedAt, ok: false, guarded: true, rowCount: rows.length,
      error: `refused: ${afterCourses} courses covered vs ${beforeCourses} existing`,
    });
    return { ok: false, guarded: true, written: 0 };
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM coupons').run();
    for (const r of rows) {
      insertCouponStmt.run(
        r.course_id, r.code, r.is_free ? 1 : 0, r.discount_value ?? null, r.max_uses ?? null,
        r.used ?? null, r.start ?? null, r.end ?? null, r.active ? 1 : 0, ts
      );
    }
  });
  tx();
  recordRun({ job: 'coupons', startedAt, ok: true, guarded: false, rowCount: rows.length });
  return { ok: true, guarded: false, written: rows.length };
}
export function readCoupons() {
  const rows = db.prepare('SELECT * FROM coupons').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coupons').get().t;
  const perCourse = {};
  for (const r of rows) {
    (perCourse[r.course_id] ||= []).push({
      code: r.code, is_free: !!r.is_free, discount_value: r.discount_value,
      max_uses: r.max_uses, used: r.used, start: r.start_time, end: r.end_time, active: !!r.active,
    });
  }
  return { perCourse, scrapedAt };
}

// --- Coupon quota (merge) --------------------------------------------------
// Per-course "remaining_coupon_count" from /coupons-v2/meta/ — how many more
// coupons Udemy will let you create this month on that course (a rolling
// monthly allowance, NOT a fixed lifetime cap, and independent of whether any
// currently-active coupon exists).
const upsertCouponQuotaStmt = db.prepare(
  `INSERT INTO coupon_quota (course_id, remaining_coupon_count, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(course_id) DO UPDATE SET remaining_coupon_count = excluded.remaining_coupon_count, updated_at = excluded.updated_at`
);
export function writeCouponQuota(perCourse) {
  const ts = nowIso();
  const rows = Object.entries(perCourse || {}).map(([course_id, remaining]) => ({ course_id, remaining }));
  return upsertMerge('coupon_quota', rows, (r) => upsertCouponQuotaStmt.run(r.course_id, r.remaining, ts), { job: 'coupon_quota' });
}
export function readCouponQuota() {
  const rows = db.prepare('SELECT course_id, remaining_coupon_count FROM coupon_quota').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coupon_quota').get().t;
  const perCourse = {};
  for (const r of rows) perCourse[r.course_id] = r.remaining_coupon_count;
  return { perCourse, scrapedAt };
}

// --- Udemy real course ids (manual CSV import, upsert-merge) ---------------
const upsertRealCourseIdStmt = db.prepare(
  `INSERT INTO udemy_real_course_ids
     (course_id, real_course_id, title, currency, best_price_value, min_custom_price, max_custom_price, coupons_remaining, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(course_id) DO UPDATE SET
     real_course_id = excluded.real_course_id, title = excluded.title, currency = excluded.currency,
     best_price_value = excluded.best_price_value, min_custom_price = excluded.min_custom_price,
     max_custom_price = excluded.max_custom_price, coupons_remaining = excluded.coupons_remaining,
     updated_at = excluded.updated_at`
);
export function writeUdemyRealCourseIds(rows) {
  const ts = nowIso();
  return upsertMerge(
    'udemy_real_course_ids', rows,
    (r) => upsertRealCourseIdStmt.run(
      r.courseId, r.realCourseId, r.title, r.currency ?? null,
      r.bestPriceValue ?? null, r.minCustomPrice ?? null, r.maxCustomPrice ?? null,
      r.couponsRemaining ?? null, ts
    ),
    { job: 'udemy_real_course_ids' }
  );
}
export function readUdemyRealCourseIds() {
  const rows = db.prepare('SELECT * FROM udemy_real_course_ids').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM udemy_real_course_ids').get().t;
  const perCourse = {};
  for (const r of rows) {
    perCourse[r.course_id] = {
      realCourseId: r.real_course_id, currency: r.currency, bestPriceValue: r.best_price_value,
      minCustomPrice: r.min_custom_price, maxCustomPrice: r.max_custom_price, couponsRemaining: r.coupons_remaining,
    };
  }
  return { perCourse, scrapedAt };
}

// --- Transcripts (merge) ---------------------------------------------------
const upsertTranscriptStmt = db.prepare(
  `INSERT INTO transcripts (course_id, languages, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(course_id) DO UPDATE SET languages = excluded.languages, updated_at = excluded.updated_at`
);
export function writeTranscripts(transcripts) {
  const ts = nowIso();
  const rows = Object.entries(transcripts).map(([course_id, languages]) => ({ course_id, languages }));
  return upsertMerge('transcripts', rows, (r) => upsertTranscriptStmt.run(r.course_id, JSON.stringify(r.languages), ts), { job: 'transcripts' });
}
export function setTranscript(courseId, languages) {
  upsertTranscriptStmt.run(courseId, JSON.stringify(languages), nowIso());
}
export function readTranscripts() {
  const rows = db.prepare('SELECT course_id, languages FROM transcripts').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM transcripts').get().t;
  const transcripts = {};
  for (const r of rows) transcripts[r.course_id] = JSON.parse(r.languages);
  return { transcripts, scrapedAt };
}

// --- Coursera courses (guarded snapshot) ----------------------------------
const insertCourseraCourseStmt = db.prepare('INSERT INTO coursera_courses (id, name, slug, updated_at) VALUES (?, ?, ?, ?)');
export function writeCourseraCourses(courses) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_courses', courses,
    (c) => insertCourseraCourseStmt.run(c.id, c.name, c.slug, ts),
    { job: 'coursera_courses' }
  );
}
export function readCourseraCourses() {
  const courses = db.prepare('SELECT id, name, slug FROM coursera_courses').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_courses').get().t;
  return { courses, scrapedAt };
}

// --- Coursera metrics (guarded snapshot) ----------------------------------
const insertCourseraMetricStmt = db.prepare(
  `INSERT INTO coursera_metrics
     (course_name, domain, in_specialization, launch_date, enrollments, paid_enrollments, completions, completion_rate, rating, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraMetrics(courses) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_metrics', courses,
    (c) => insertCourseraMetricStmt.run(
      c.name, c.domain ?? null, c.inSpecialization ? 1 : 0, c.launchDate ?? null,
      c.enrollments ?? null, c.paidEnrollments ?? null, c.completions ?? null,
      c.completionRate ?? null, c.rating ?? null, ts
    ),
    { job: 'coursera_metrics' }
  );
}
export function readCourseraMetrics() {
  const rows = db.prepare('SELECT * FROM coursera_metrics').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_metrics').get().t;
  const courses = rows.map((r) => ({
    name: (r.course_name || '').trim(), domain: r.domain, inSpecialization: !!r.in_specialization, launchDate: r.launch_date,
    enrollments: r.enrollments, paidEnrollments: r.paid_enrollments, completions: r.completions,
    completionRate: r.completion_rate, rating: r.rating,
  }));
  return { courses, scrapedAt };
}

// --- Coursera course instructors (guarded snapshot) -----------------------
// Per course: whether instructors@starweaver.com is on staff with the
// "Instructor" role, and the real named instructors (excluding that shared
// account) — a course with no row means "not yet checked", not "no instructor".
const insertCourseraCourseInstructorsStmt = db.prepare(
  'INSERT INTO coursera_course_instructors (course_name, has_starweaver_instructor, instructor_names, updated_at) VALUES (?, ?, ?, ?)'
);
export function writeCourseraCourseInstructors(rows) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_course_instructors', rows,
    (r) => insertCourseraCourseInstructorsStmt.run(r.courseName, r.hasStarweaverInstructor ? 1 : 0, JSON.stringify(r.instructorNames || []), ts),
    { job: 'coursera_course_instructors' }
  );
}
export function readCourseraCourseInstructors() {
  const rows = db.prepare('SELECT course_name, has_starweaver_instructor, instructor_names FROM coursera_course_instructors').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_course_instructors').get().t;
  const byName = {};
  for (const r of rows) {
    const names = JSON.parse(r.instructor_names || '[]').map((n) => (n || '').trim()).filter(Boolean);
    byName[r.course_name] = { hasStarweaverInstructor: !!r.has_starweaver_instructor, instructorNames: names };
  }
  return { byName, scrapedAt };
}

// --- Coursera course status + slug (merge — never wiped by the Looker-driven
// coursera_metrics refresh, which has no slug of its own) ------------------
const upsertCourseraCourseStatusStmt = db.prepare(
  `INSERT INTO coursera_course_status (course_name, slug, status, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(course_name) DO UPDATE SET slug = excluded.slug, status = excluded.status, updated_at = excluded.updated_at`
);
export function writeCourseraCourseStatus(rows) {
  const ts = nowIso();
  return upsertMerge('coursera_course_status', rows, (r) => upsertCourseraCourseStatusStmt.run(r.courseName, r.slug ?? null, r.status ?? null, ts), { job: 'coursera_course_status' });
}
export function readCourseraCourseStatus() {
  const rows = db.prepare('SELECT course_name, slug, status FROM coursera_course_status').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_course_status').get().t;
  const byName = {};
  for (const r of rows) byName[r.course_name] = { slug: r.slug, status: r.status };
  return { byName, scrapedAt };
}

// --- Coursera revenue (manual import — see table comment) -----------------
const upsertCourseraRevenueStmt = db.prepare(
  `INSERT INTO coursera_revenue_import (slug, course_name, revenue, completions, quarter_count, source_file, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(slug) DO UPDATE SET course_name = excluded.course_name, revenue = excluded.revenue,
     completions = excluded.completions, quarter_count = excluded.quarter_count,
     source_file = excluded.source_file, imported_at = excluded.imported_at`
);
export function writeCourseraRevenueImport(rows, sourceFile) {
  const ts = nowIso();
  const tx = db.transaction(() => {
    for (const r of rows) upsertCourseraRevenueStmt.run(r.slug, r.courseName ?? null, r.revenue ?? 0, r.completions ?? 0, r.quarterCount ?? 0, sourceFile, ts);
  });
  tx();
  return { ok: true, written: rows.length };
}
export function readCourseraRevenueImport() {
  const rows = db.prepare('SELECT slug, course_name, revenue, completions, quarter_count, source_file, imported_at FROM coursera_revenue_import').all();
  const importedAt = db.prepare('SELECT MAX(imported_at) AS t FROM coursera_revenue_import').get().t;
  const bySlug = {};
  for (const r of rows) bySlug[r.slug] = { revenue: r.revenue, completions: r.completions, quarterCount: r.quarter_count, sourceFile: r.source_file };
  return { bySlug, importedAt, totalRevenue: rows.reduce((s, r) => s + (r.revenue || 0), 0) };
}

// --- Coursera revenue per quarter (manual import — see table comment) -----
// Upsert-merge, never a wholesale replace: each import usually covers only the
// quarters in the files passed, and wiping the table would throw away every
// earlier quarter whose source file is long gone.
const upsertCourseraRevenueQuarterStmt = db.prepare(
  `INSERT INTO coursera_revenue_quarterly
     (catalog, course_key, quarter, product_type, course_name, slug, revenue, net_sales, completions, source_file, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(catalog, course_key, quarter, product_type) DO UPDATE SET
     course_name = COALESCE(excluded.course_name, course_name),
     slug = COALESCE(excluded.slug, slug),
     revenue = excluded.revenue,
     net_sales = COALESCE(excluded.net_sales, net_sales),
     completions = COALESCE(excluded.completions, completions),
     source_file = excluded.source_file,
     imported_at = excluded.imported_at`
);
export function writeCourseraRevenueQuarterly(rows, sourceFile) {
  const ts = nowIso();
  const startedAt = ts;
  if (!rows.length) {
    recordRun({ job: 'coursera_revenue_quarterly', startedAt, ok: false, guarded: true, rowCount: 0, error: 'refused: no rows' });
    return { ok: false, guarded: true, written: 0 };
  }
  const before = tableCount('coursera_revenue_quarterly');
  const tx = db.transaction(() => {
    for (const r of rows) {
      upsertCourseraRevenueQuarterStmt.run(
        r.catalog, r.courseKey, r.quarter, r.productType || 'course',
        r.courseName ?? null, r.slug ?? null, r.revenue ?? 0,
        r.netSales ?? null, r.completions ?? null, sourceFile, ts
      );
    }
  });
  tx();
  const after = tableCount('coursera_revenue_quarterly');
  recordRun({ job: 'coursera_revenue_quarterly', startedAt, ok: true, rowCount: rows.length });
  return { ok: true, written: rows.length, before, after };
}

// Returns { bySlug: { slug: { '2026 Q2': 123.45, ... } }, quarters: [...] } for
// course-type rows only — specialization revenue is a separate product and must
// not be folded into a course's figures.
export function readCourseraRevenueQuarterly({ catalog = 'starweaver', quarters = null } = {}) {
  let sql = `SELECT slug, course_key, course_name, quarter, revenue, net_sales
             FROM coursera_revenue_quarterly
             WHERE catalog = ? AND product_type = 'course'`;
  const params = [catalog];
  if (quarters?.length) {
    sql += ` AND quarter IN (${quarters.map(() => '?').join(',')})`;
    params.push(...quarters);
  }
  const rows = db.prepare(sql).all(...params);
  const importedAt = db.prepare('SELECT MAX(imported_at) AS t FROM coursera_revenue_quarterly').get().t;
  const bySlug = {};
  const byName = {};
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.quarter);
    const bucket = (obj, key) => { if (!key) return; (obj[key] ||= {})[r.quarter] = r.revenue; };
    bucket(bySlug, r.slug);
    bucket(byName, (r.course_name || '').trim().toLowerCase());
  }
  return { bySlug, byName, quarters: [...seen].sort(), importedAt };
}

// Every quarter on record with its portfolio total — cheap enough to compute on
// demand and it's what the Earnings view needs.
export function readCourseraQuarterTotals(catalog = 'starweaver') {
  return db.prepare(
    `SELECT quarter, product_type, SUM(revenue) AS revenue, COUNT(*) AS rows
     FROM coursera_revenue_quarterly WHERE catalog = ?
     GROUP BY quarter, product_type ORDER BY quarter`
  ).all(catalog);
}

// --- Coursera course items (content inventory — see table comment) --------
const insertCourseraCourseItemStmt = db.prepare(
  `INSERT INTO coursera_course_items
     (course_slug, item_id, catalog, course_name, module_order, module_name, lesson_order, lesson_name,
      item_order, item_slug, item_name, item_type, asset_type, contains_widget, is_locked, minutes, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraCourseItems(rows) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_course_items', rows,
    (r) => insertCourseraCourseItemStmt.run(
      r.courseSlug, r.itemId, r.catalog || 'starweaver', r.courseName ?? null,
      r.moduleOrder ?? null, r.moduleName ?? null, r.lessonOrder ?? null, r.lessonName ?? null,
      r.itemOrder ?? null, r.itemSlug ?? null, r.itemName ?? null, r.itemType ?? null,
      r.assetType ?? null, r.containsWidget ? 1 : 0, r.isLocked ? 1 : 0, r.minutes ?? null, ts
    ),
    { job: 'coursera_course_items' }
  );
}

// Content mix per course plus a catalogue-wide tally — what the "is anyone
// using the Role Plays?" question actually needs as its denominator.
export function readCourseraCourseItems({ catalog = 'starweaver' } = {}) {
  const rows = db.prepare(
    `SELECT course_slug, course_name, item_type, COUNT(*) AS items, SUM(minutes) AS minutes
     FROM coursera_course_items WHERE catalog = ?
     GROUP BY course_slug, item_type`
  ).all(catalog);
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_course_items').get().t;
  const byCourse = {};
  const totals = {};
  for (const r of rows) {
    const c = (byCourse[r.course_slug] ||= { name: r.course_name, types: {}, minutes: {}, items: 0 });
    c.types[r.item_type] = r.items;
    c.minutes[r.item_type] = r.minutes;
    c.items += r.items;
    totals[r.item_type] = (totals[r.item_type] || 0) + r.items;
  }
  return { byCourse, totals, courseCount: Object.keys(byCourse).length, scrapedAt };
}

// Free-text search over item names — how you find whether a format (role play,
// coach dialogue, hands-on lab) exists at all, and how it was published.
export function searchCourseraItems(pattern, { catalog = 'starweaver', limit = 200 } = {}) {
  // Match with punctuation flattened, so searching "role play" also finds
  // "Role-Playing". A plain LIKE returns zero for that and reads as "we have
  // none", which is the wrong answer for the one item that does exist.
  const flat = (col) => `replace(replace(replace(lower(${col}), '-', ' '), '_', ' '), '  ', ' ')`;
  const needle = `%${String(pattern).toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()}%`;
  return db.prepare(
    `SELECT course_name, course_slug, item_name, item_type, asset_type, contains_widget, minutes
     FROM coursera_course_items
     WHERE catalog = ? AND (${flat('item_name')} LIKE ? OR lower(item_name) LIKE ?)
     ORDER BY course_name, module_order, lesson_order, item_order
     LIMIT ?`
  ).all(catalog, needle, needle, limit);
}

// --- Coursera instructor profiles (per person — see table comment) --------
const insertCourseraInstructorProfileStmt = db.prepare(
  `INSERT INTO coursera_instructor_profiles
     (instructor_id, full_name, title, bio, photo, website, website_linkedin, website_twitter,
      website_facebook, website_gplus, profile_url, on_starweaver, on_cin, sw_courses, cin_courses,
      enrollments, is_shared_account, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraInstructorProfiles(rows) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_instructor_profiles', rows,
    (r) => insertCourseraInstructorProfileStmt.run(
      r.instructorId, r.fullName ?? null, r.title ?? null, r.bio ?? null, r.photo ?? null,
      r.website ?? null, r.linkedin ?? null, r.twitter ?? null, r.facebook ?? null, r.gplus ?? null,
      r.profileUrl ?? null, r.onStarweaver ? 1 : 0, r.onCin ? 1 : 0,
      r.swCourses ?? 0, r.cinCourses ?? 0, r.enrollments ?? 0, r.isShared ? 1 : 0, ts
    ),
    { job: 'coursera_instructor_profiles' }
  );
}

// Returns the roster plus a completeness audit: which profile fields each SME
// has left blank. `deadWebsite` flags go.starweaver.com, which now serves a
// soft 404 rather than a channel page.
export function readCourseraInstructorProfiles({ includeShared = false } = {}) {
  const rows = db.prepare('SELECT * FROM coursera_instructor_profiles ORDER BY enrollments DESC').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_instructor_profiles').get().t;
  const people = rows
    .filter((r) => includeShared || !r.is_shared_account)
    .map((r) => ({
      id: r.instructor_id, name: r.full_name, title: r.title,
      profileUrl: r.profile_url, photo: r.photo,
      website: r.website || null, linkedin: r.website_linkedin || null,
      twitter: r.website_twitter || null, facebook: r.website_facebook || null,
      gplus: r.website_gplus || null,
      sides: [r.on_starweaver ? 'starweaver' : null, r.on_cin ? 'cin' : null].filter(Boolean),
      courses: (r.sw_courses || 0) + (r.cin_courses || 0),
      swCourses: r.sw_courses, cinCourses: r.cin_courses,
      enrollments: r.enrollments,
      isShared: !!r.is_shared_account,
      missing: {
        website: !r.website, linkedin: !r.website_linkedin,
        bio: !r.bio, title: !r.title, photo: !r.photo,
      },
      deadWebsite: !!(r.website && /go\.starweaver\.com/i.test(r.website)),
    }));
  const summary = {
    people: people.length,
    missingWebsite: people.filter((p) => p.missing.website).length,
    deadWebsite: people.filter((p) => p.deadWebsite).length,
    workingWebsite: people.filter((p) => p.website && !p.deadWebsite).length,
    missingBio: people.filter((p) => p.missing.bio).length,
    missingTitle: people.filter((p) => p.missing.title).length,
    missingPhoto: people.filter((p) => p.missing.photo).length,
    missingLinkedin: people.filter((p) => p.missing.linkedin).length,
    onBothSides: people.filter((p) => p.sides.length === 2).length,
  };
  return { people, summary, scrapedAt };
}

// --- Coursera reviews (guarded snapshot — SW) ------------------------------
const insertCourseraReviewStmt = db.prepare(
  `INSERT INTO coursera_reviews (slug, course_name, rating, review_text, reviewer_name, review_date, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraReviews(reviews) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_reviews', reviews,
    (r) => insertCourseraReviewStmt.run(r.slug, r.courseName ?? null, r.rating ?? null, r.reviewText ?? null, r.reviewerName ?? null, r.reviewDate ?? null, ts),
    { job: 'coursera_reviews', minRatio: 0 } // count naturally varies a lot run to run — don't guard on shrink
  );
}
export function readCourseraReviews() {
  const rows = db.prepare('SELECT slug, course_name, rating, review_text, reviewer_name, review_date FROM coursera_reviews').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_reviews').get().t;
  const bySlug = {};
  for (const r of rows) {
    (bySlug[r.slug] ||= []).push({ rating: r.rating, reviewText: r.review_text, reviewerName: r.reviewer_name, reviewDate: r.review_date });
  }
  return { bySlug, scrapedAt };
}

// --- Coursera CIN reviews (guarded snapshot) -------------------------------
const insertCourseraCinReviewStmt = db.prepare(
  `INSERT INTO coursera_cin_reviews (slug, course_name, rating, review_text, reviewer_name, review_date, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraCinReviews(reviews) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_cin_reviews', reviews,
    (r) => insertCourseraCinReviewStmt.run(r.slug, r.courseName ?? null, r.rating ?? null, r.reviewText ?? null, r.reviewerName ?? null, r.reviewDate ?? null, ts),
    { job: 'coursera_cin_reviews', minRatio: 0 }
  );
}
export function readCourseraCinReviews() {
  const rows = db.prepare('SELECT slug, course_name, rating, review_text, reviewer_name, review_date FROM coursera_cin_reviews').all()
    .filter((r) => !EXCLUDED_CIN_SLUGS.has(r.slug));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_cin_reviews').get().t;
  const bySlug = {};
  for (const r of rows) {
    (bySlug[r.slug] ||= []).push({ rating: r.rating, reviewText: r.review_text, reviewerName: r.reviewer_name, reviewDate: r.review_date });
  }
  return { bySlug, scrapedAt };
}

// --- Coursera overview KPIs (guarded snapshot) ----------------------------
const insertCourseraKpiStmt = db.prepare('INSERT INTO coursera_overview_kpis (label, value, updated_at) VALUES (?, ?, ?)');
export function writeCourseraOverview(kpis) {
  const ts = nowIso();
  const rows = Object.entries(kpis || {}).map(([label, value]) => ({ label, value }));
  return guardedReplaceAll(
    'coursera_overview_kpis', rows,
    (r) => insertCourseraKpiStmt.run(r.label, r.value, ts),
    { job: 'coursera_overview' }
  );
}
export function readCourseraOverview() {
  const rows = db.prepare('SELECT label, value FROM coursera_overview_kpis').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_overview_kpis').get().t;
  const kpis = {};
  for (const r of rows) kpis[r.label] = r.value;
  return { kpis, scrapedAt };
}

// --- Coursera CIN courses (guarded snapshot) — second partner, see table comment ---
const insertCourseraCinCourseStmt = db.prepare('INSERT INTO coursera_cin_courses (id, name, slug, updated_at) VALUES (?, ?, ?, ?)');
export function writeCourseraCinCourses(courses) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_cin_courses', courses,
    (c) => insertCourseraCinCourseStmt.run(c.id, c.name, c.slug, ts),
    { job: 'coursera_cin_courses' }
  );
}
export function readCourseraCinCourses() {
  const courses = db.prepare('SELECT id, name, slug FROM coursera_cin_courses').all()
    .filter((c) => !EXCLUDED_CIN_SLUGS.has(c.slug));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_cin_courses').get().t;
  return { courses, scrapedAt };
}

// --- Coursera CIN metrics (guarded snapshot) ------------------------------
// Keyed by slug, not course_name — CIN's much larger catalog has genuine
// duplicate titles (e.g. two separate "GenAI for Learning and Development"
// courses), which crashed an earlier version of this table keyed by name.
const insertCourseraCinMetricStmt = db.prepare(
  `INSERT INTO coursera_cin_metrics
     (slug, course_name, domain, in_specialization, launch_date, enrollments, paid_enrollments, completions, completion_rate, rating, status, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeCourseraCinMetrics(courses) {
  const ts = nowIso();
  return guardedReplaceAll(
    'coursera_cin_metrics', courses,
    (c) => insertCourseraCinMetricStmt.run(
      c.slug, c.name, c.domain ?? null, c.inSpecialization ? 1 : 0, c.launchDate ?? null,
      c.enrollments ?? null, c.paidEnrollments ?? null, c.completions ?? null,
      c.completionRate ?? null, c.rating ?? null, c.status ?? null, ts
    ),
    { job: 'coursera_cin_metrics' }
  );
}
export function readCourseraCinMetrics() {
  const rows = db.prepare('SELECT * FROM coursera_cin_metrics').all()
    .filter((r) => !EXCLUDED_CIN_SLUGS.has(r.slug));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_cin_metrics').get().t;
  const courses = rows.map((r) => ({
    name: (r.course_name || '').trim(), slug: r.slug, domain: r.domain, inSpecialization: !!r.in_specialization, launchDate: r.launch_date,
    enrollments: r.enrollments, paidEnrollments: r.paid_enrollments, completions: r.completions,
    completionRate: r.completion_rate, rating: r.rating, status: r.status,
  }));
  return { courses, scrapedAt };
}

// --- Coursera CIN overview KPIs (guarded snapshot) ------------------------
const insertCourseraCinKpiStmt = db.prepare('INSERT INTO coursera_cin_overview_kpis (label, value, updated_at) VALUES (?, ?, ?)');
export function writeCourseraCinOverview(kpis) {
  const ts = nowIso();
  const rows = Object.entries(kpis || {}).map(([label, value]) => ({ label, value }));
  return guardedReplaceAll(
    'coursera_cin_overview_kpis', rows,
    (r) => insertCourseraCinKpiStmt.run(r.label, r.value, ts),
    { job: 'coursera_cin_overview' }
  );
}
export function readCourseraCinOverview() {
  const rows = db.prepare('SELECT label, value FROM coursera_cin_overview_kpis').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coursera_cin_overview_kpis').get().t;
  const kpis = {};
  for (const r of rows) kpis[r.label] = r.value;
  return { kpis, scrapedAt };
}

// --- FutureLearn courses (guarded snapshot, + a merge-style enrollment update) ---
const insertFutureLearnCourseStmt = db.prepare(
  `INSERT INTO futurelearn_courses (slug, title, code, category, status, visibility, start_date, wishlist_count, enrollment, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
export function writeFutureLearnCourses(courses) {
  const ts = nowIso();
  // Preserve enrollment numbers already on file (a separate scraper fills those in)
  // when the course-list snapshot replaces the table.
  const existingEnrollment = Object.fromEntries(
    db.prepare('SELECT slug, enrollment FROM futurelearn_courses').all().map((r) => [r.slug, r.enrollment])
  );
  return guardedReplaceAll(
    'futurelearn_courses', courses,
    (c) => insertFutureLearnCourseStmt.run(
      c.slug, c.title, c.code ?? null, c.category ?? null, c.status ?? null,
      c.visibility ?? null,
      c.startDate ?? null, c.wishlistCount ?? null, existingEnrollment[c.slug] ?? null, ts
    ),
    { job: 'futurelearn_courses' }
  );
}
const updateFutureLearnEnrollmentStmt = db.prepare(
  `INSERT INTO futurelearn_courses (slug, enrollment, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(slug) DO UPDATE SET enrollment = excluded.enrollment, updated_at = excluded.updated_at`
);
export function writeFutureLearnEnrollment(perSlug) {
  const ts = nowIso();
  const rows = Object.entries(perSlug).map(([slug, enrollment]) => ({ slug, enrollment }));
  return upsertMerge(
    'futurelearn_courses', rows,
    (r) => updateFutureLearnEnrollmentStmt.run(r.slug, r.enrollment, ts),
    { job: 'futurelearn_enrollment' }
  );
}
export function readFutureLearnCourses() {
  const courses = db.prepare('SELECT * FROM futurelearn_courses').all().map((r) => ({
    slug: r.slug, title: r.title, code: r.code, category: r.category, status: r.status,
    startDate: r.start_date, wishlistCount: r.wishlist_count, enrollment: r.enrollment,
  }));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM futurelearn_courses').get().t;
  return { courses, scrapedAt };
}

// --- Go1 courses (guarded monthly snapshot) -------------------------------
const insertGo1CourseStmt = db.prepare(
  `INSERT INTO go1_courses (name, enrolments, completions, total_minutes, avg_session_minutes, month, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeGo1Courses(courses, month) {
  const ts = nowIso();
  return guardedReplaceAll(
    'go1_courses', courses,
    (c) => insertGo1CourseStmt.run(c.name, c.enrolments ?? null, c.completions ?? null, c.totalMinutes ?? null, c.avgSessionMinutes ?? null, month, ts),
    { job: 'go1_courses' }
  );
}
export function readGo1Courses() {
  const courses = db.prepare('SELECT * FROM go1_courses').all().map((r) => ({
    name: r.name, enrolments: r.enrolments, completions: r.completions,
    totalMinutes: r.total_minutes, avgSessionMinutes: r.avg_session_minutes, month: r.month,
  }));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM go1_courses').get().t;
  const month = courses[0]?.month ?? null;
  return { courses, month, scrapedAt };
}

// --- Go1 course history (guarded, full re-scan every run) -----------------
// Go1 only exposes a MONTHLY snapshot per request (no lifetime endpoint), so
// "full data" means scraping every month back to when Go1 data starts (found
// live: March 2025 and earlier are empty, April 2025 is the first real month)
// and summing per course. Table is wiped+reinserted whole on each history
// scrape (cheap — ~15 months) rather than merged incrementally, so a month
// that Go1 revises retroactively self-corrects instead of going stale.
const insertGo1HistoryStmt = db.prepare(
  `INSERT INTO go1_course_history (course_name, month, enrolments, completions, total_minutes, avg_session_minutes, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeGo1History(rows) {
  const ts = nowIso();
  return guardedReplaceAll(
    'go1_course_history', rows,
    (r) => insertGo1HistoryStmt.run(r.courseName, r.month, r.enrolments ?? null, r.completions ?? null, r.totalMinutes ?? null, r.avgSessionMinutes ?? null, ts),
    { job: 'go1_course_history', minRatio: 0.7 }
  );
}
export function readGo1Lifetime() {
  const rows = db.prepare('SELECT course_name, month, enrolments, completions, total_minutes, avg_session_minutes FROM go1_course_history ORDER BY month').all();
  const byCourse = {};
  for (const r of rows) {
    const c = (byCourse[r.course_name] ||= {
      name: r.course_name, enrolments: 0, completions: 0, totalMinutes: 0,
      avgSessionSum: 0, avgSessionCount: 0, months: [],
    });
    c.enrolments += r.enrolments || 0;
    c.completions += r.completions || 0;
    c.totalMinutes += r.total_minutes || 0;
    if (r.avg_session_minutes != null) { c.avgSessionSum += r.avg_session_minutes; c.avgSessionCount += 1; }
    c.months.push(r.month);
  }
  const courses = Object.values(byCourse).map((c) => ({
    name: c.name, enrolments: c.enrolments, completions: c.completions, totalMinutes: c.totalMinutes,
    avgSessionMinutes: c.avgSessionCount ? Math.round(c.avgSessionSum / c.avgSessionCount) : null,
    monthsCovered: c.months.length,
  }));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM go1_course_history').get().t;
  return { courses, firstMonth: months[0] ?? null, lastMonth: months[months.length - 1] ?? null, monthCount: months.length, scrapedAt };
}

// --- Bookmarks (user-managed watchlist, not a scraped dataset) ------------
const insertBookmarkStmt = db.prepare(
  'INSERT OR IGNORE INTO bookmarks (platform, course_key, title, added_at) VALUES (?, ?, ?, ?)'
);
export function addBookmark({ platform, courseKey, title }) {
  const info = insertBookmarkStmt.run(platform, courseKey, title ?? null, nowIso());
  return { added: info.changes > 0 };
}
export function removeBookmark({ platform, courseKey }) {
  const info = db.prepare('DELETE FROM bookmarks WHERE platform = ? AND course_key = ?').run(platform, courseKey);
  return { removed: info.changes > 0 };
}
export function readBookmarks() {
  return db.prepare('SELECT platform, course_key AS courseKey, title, added_at AS addedAt FROM bookmarks ORDER BY added_at DESC').all();
}

// --- Cross-cutting: last-update / scrape history --------------------------
const ALL_TABLES = [
  'enrollment', 'revenue_course', 'revenue_monthly', 'revenue_meta', 'captions',
  'coupons', 'coupon_quota', 'udemy_real_course_ids', 'transcripts', 'coursera_courses', 'coursera_metrics', 'coursera_overview_kpis', 'coursera_course_instructors',
  'coursera_course_status', 'coursera_reviews', 'coursera_cin_reviews', 'coursera_revenue_import',
  'coursera_revenue_quarterly', 'coursera_course_items', 'coursera_instructor_profiles',
  'coursera_cin_courses', 'coursera_cin_metrics', 'coursera_cin_overview_kpis', 'coursera_rating_history',
  'linkedin_courses', 'linkedin_revenue',
  'futurelearn_courses', 'go1_courses', 'go1_course_history', 'engagement_course', 'engagement_monthly', 'engagement_meta', 'engagement_ub_monthly',
  'engagement_course_monthly',
];
// Most scrape tables stamp `updated_at`; a few use a different column name.
const TIMESTAMP_COLUMN_OVERRIDES = {
  coursera_revenue_import: 'imported_at',
  coursera_revenue_quarterly: 'imported_at',
  coursera_rating_history: 'captured_at',
};
export function latestUpdatedAt() {
  let newest = null;
  for (const t of ALL_TABLES) {
    const col = TIMESTAMP_COLUMN_OVERRIDES[t] || 'updated_at';
    const row = db.prepare(`SELECT MAX(${col}) AS t FROM ${t}`).get();
    if (row.t && (!newest || new Date(row.t) > new Date(newest))) newest = row.t;
  }
  return newest;
}
export function recentScrapeRuns(limit = 20) {
  return db.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT ?').all(limit);
}

export { db };

// ---- Coursera rating history -------------------------------------------------
// Appends this month's snapshot for every course currently in coursera_metrics
// and coursera_cin_metrics. Never deletes: an upsert on (catalog, course, month)
// so running it repeatedly in a month just refreshes that month's value.
const insertRatingHistoryStmt = db.prepare(
  `INSERT INTO coursera_rating_history
     (catalog, course_name, month, rating, enrollments, paid_enrollments, completions, completion_rate, captured_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(catalog, course_name, month) DO UPDATE SET
     rating = excluded.rating,
     enrollments = excluded.enrollments,
     paid_enrollments = excluded.paid_enrollments,
     completions = excluded.completions,
     completion_rate = excluded.completion_rate,
     captured_at = excluded.captured_at`
);

// opts: { month: 'YYYY-MM', catalogs: ['starweaver'] }
// Defaults to the Starweaver catalogue only — that is the side being tracked
// month to month. Pass catalogs explicitly to include CIN.
export function snapshotCourseraRatings(opts = {}) {
  const { month, catalogs = ['starweaver'] } = typeof opts === 'string' ? { month: opts } : opts;
  const ts = new Date().toISOString();
  const m = month || ts.slice(0, 7);
  const sources = [
    ['starweaver', 'coursera_metrics'],
    ['cin', 'coursera_cin_metrics'],
  ].filter(([c]) => catalogs.includes(c));
  let written = 0;
  const run = db.transaction(() => {
    for (const [catalog, table] of sources) {
      const rows = db.prepare(
        `SELECT course_name, rating, enrollments, paid_enrollments, completions, completion_rate FROM ${table}`
      ).all();
      for (const r of rows) {
        insertRatingHistoryStmt.run(catalog, r.course_name, m, r.rating, r.enrollments,
          r.paid_enrollments, r.completions, r.completion_rate, ts);
        written++;
      }
    }
  });
  run();
  return { month: m, written };
}

// Rating for each course in two given months, side by side.
export function readCourseraRatingComparison(monthA, monthB) {
  return db.prepare(
    `SELECT catalog, course_name,
            MAX(CASE WHEN month = ? THEN rating END)      AS rating_a,
            MAX(CASE WHEN month = ? THEN rating END)      AS rating_b,
            MAX(CASE WHEN month = ? THEN enrollments END) AS enrollments_a,
            MAX(CASE WHEN month = ? THEN enrollments END) AS enrollments_b
       FROM coursera_rating_history
      WHERE month IN (?, ?)
      GROUP BY catalog, course_name
      ORDER BY catalog, course_name`
  ).all(monthA, monthB, monthA, monthB, monthA, monthB);
}

// --- LinkedIn Learning courses --------------------------------------------
const insertLinkedInCourseStmt = db.prepare(
  `INSERT INTO linkedin_courses (title, language, learners, shares, likes, last_updated, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
export function writeLinkedInCourses(courses) {
  const ts = nowIso();
  return guardedReplaceAll(
    'linkedin_courses', 'linkedin_revenue', courses,
    (c) => insertLinkedInCourseStmt.run(
      c.title, c.language ?? null, c.learners ?? null, c.shares ?? null,
      c.likes ?? null, c.lastUpdated ?? null, ts
    ),
    { job: 'linkedin_courses' }
  );
}
export function readLinkedInCourses() {
  const courses = db.prepare('SELECT * FROM linkedin_courses ORDER BY learners DESC').all().map((r) => ({
    title: r.title, language: r.language, learners: r.learners,
    shares: r.shares, likes: r.likes, lastUpdated: r.last_updated,
  }));
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM linkedin_courses').get().t;
  const totals = courses.reduce((a, c) => ({
    learners: a.learners + (c.learners || 0),
    shares: a.shares + (c.shares || 0),
    likes: a.likes + (c.likes || 0),
  }), { learners: 0, shares: 0, likes: 0 });
  return { courses, totals, scrapedAt };
}

// --- LinkedIn Learning revenue (append-only per period) --------------------
const insertLinkedInRevenueStmt = db.prepare(
  `INSERT INTO linkedin_revenue
     (course_id, period, course_name, payment, earnings, royalty_earnings, earnings_prev_period,
      earnings_to_date, alacarte_earnings, alacarte_units, grants, advance_remaining,
      advances_total, royalty_pct, release_date, languages, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(course_id, period) DO UPDATE SET
     course_name = excluded.course_name, payment = excluded.payment, earnings = excluded.earnings,
     royalty_earnings = excluded.royalty_earnings, earnings_prev_period = excluded.earnings_prev_period,
     earnings_to_date = excluded.earnings_to_date, alacarte_earnings = excluded.alacarte_earnings,
     alacarte_units = excluded.alacarte_units, grants = excluded.grants,
     advance_remaining = excluded.advance_remaining, advances_total = excluded.advances_total,
     royalty_pct = excluded.royalty_pct, release_date = excluded.release_date,
     languages = excluded.languages, updated_at = excluded.updated_at`
);
// Upsert, never replace: each run covers only the periods it walked, and the
// table is the accumulated history of every period ever scraped.
export function writeLinkedInRevenue(rows) {
  const ts = nowIso();
  let n = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      insertLinkedInRevenueStmt.run(
        String(r.courseId), r.period, r.courseName ?? null,
        r.payment ?? null, r.earnings ?? null, r.royaltyEarnings ?? null, r.earningsPrevPeriod ?? null,
        r.earningsToDate ?? null, r.alacarteEarnings ?? null, r.alacarteUnits ?? null,
        r.grants ?? null, r.advanceRemaining ?? null, r.advancesTotal ?? null,
        r.royaltyPct ?? null, r.releaseDate ?? null, r.languages ?? null, ts,
      );
      n++;
    }
  });
  run();
  return { written: n };
}

export function readLinkedInRevenue() {
  const rows = db.prepare('SELECT * FROM linkedin_revenue').all();
  // Per-period totals. earnings_to_date is a lifetime running figure, so the
  // lifetime total is the LATEST value per course, never a sum over periods.
  const byPeriod = {};
  for (const r of rows) {
    const p = (byPeriod[r.period] ||= { period: r.period, earnings: 0, payment: 0, courses: 0 });
    p.earnings += r.earnings || 0;
    p.payment += r.payment || 0;
    p.courses++;
  }
  const months = Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period));
  const latest = db.prepare(
    `SELECT course_id, course_name, earnings_to_date, advance_remaining, royalty_pct, period
       FROM linkedin_revenue r
      WHERE period = (SELECT MAX(period) FROM linkedin_revenue WHERE course_id = r.course_id)`
  ).all();
  const lifetime = latest.reduce((a, r) => a + (r.earnings_to_date || 0), 0);
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM linkedin_revenue').get().t;
  return {
    months,
    courses: latest.map((r) => ({
      courseId: r.course_id, courseName: r.course_name, earningsToDate: r.earnings_to_date,
      advanceRemaining: r.advance_remaining, royaltyPct: r.royalty_pct, latestPeriod: r.period,
    })),
    lifetime,
    periodCount: months.length,
    scrapedAt,
  };
}

// --- scrape freshness ------------------------------------------------------
// Built on the scrape_runs table guardedReplaceAll already writes — job,
// started_at, finished_at, ok, guarded, row_count, error. No second log.
const insertRunStmt = db.prepare(
  `INSERT INTO scrape_runs (job, started_at, finished_at, ok, guarded, row_count, error)
   VALUES (?, ?, ?, ?, 0, ?, ?)`
);
// For scrapers that do not go through guardedReplaceAll (upserts, appends) so
// their freshness is recorded the same way as everything else.
export function logScrapeRun({ job, ok, rows = null, error = null, startedAt = null }) {
  const now = nowIso();
  insertRunStmt.run(job, startedAt || now, now, ok ? 1 : 0, rows, error);
}

// Hours since the last SUCCESSFUL run of a job. null = never run.
// A scraper can use this to refuse to re-fetch something it pulled an hour ago,
// which is what stops development runs from hammering a site.
export function hoursSinceLastRun(job) {
  const r = db.prepare(
    'SELECT MAX(finished_at) AS t FROM scrape_runs WHERE job = ? AND ok = 1'
  ).get(job);
  if (!r || !r.t) return null;
  return (Date.now() - Date.parse(r.t)) / 36e5;
}

// Last successful run per job — what the dashboard shows instead of guessing.
export function readFreshness() {
  return db.prepare(
    `SELECT job, MAX(finished_at) AS lastOk, row_count AS rows
       FROM scrape_runs WHERE ok = 1 GROUP BY job ORDER BY job`
  ).all().map((r) => ({
    job: r.job, lastOk: r.lastOk, rows: r.rows,
    hoursAgo: r.lastOk ? Number(((Date.now() - Date.parse(r.lastOk)) / 36e5).toFixed(1)) : null,
  }));
}

export function readScrapeRuns(limit = 50) {
  return db.prepare(
    'SELECT job, ok, row_count AS rows, error, finished_at FROM scrape_runs ORDER BY finished_at DESC LIMIT ?'
  ).all(limit);
}

// Read-only passthrough used by the export endpoints. SELECT only — this exists
// to dump whole tables, not to accept arbitrary statements from a request.
export function rawQuery(sql) {
  if (!/^\s*SELECT\s/i.test(sql) || /;/.test(sql.trim().replace(/;\s*$/, ''))) {
    throw new Error('rawQuery accepts a single SELECT');
  }
  return db.prepare(sql).all();
}
