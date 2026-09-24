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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  -- Royalty figures maintained by hand in a master spreadsheet, covering every
  -- platform in one place.
  --
  -- This exists because most platforms expose no revenue the scrapers can read:
  -- Coursera has no revenue API at all, FutureLearn exposes none to partners,
  -- Go1 has no reporting on this account, and LinkedIn's sits behind a
  -- statements page that has to be walked month by month. The spreadsheet is
  -- the authoritative record; the dashboard reads it rather than guessing.
  --
  -- Keyed on (platform, course_key, period) so re-importing a corrected sheet
  -- updates rows in place instead of duplicating them. Scraped revenue is kept
  -- in its own tables and never overwritten by this.
  CREATE TABLE IF NOT EXISTS revenue_master (
    platform TEXT NOT NULL,            -- Udemy | Coursera | Coursera CIN | FutureLearn | LinkedIn | Go1
    course_key TEXT NOT NULL,          -- course id where there is one, else the normalised title
    period TEXT NOT NULL,              -- 'YYYY-MM' or 'YYYY-Qn'
    course_name TEXT,
    amount REAL,
    currency TEXT DEFAULT 'USD',
    note TEXT,
    source_file TEXT,
    source_row INTEGER,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (platform, course_key, period)
  );
  CREATE INDEX IF NOT EXISTS idx_revenue_master_period ON revenue_master (period);

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

  -- Every title a course is known by, pointing at its parent.
  --
  -- The royalty sheets carry an "Original Title" column, which is enough to join
  -- the platforms to each other. It is NOT enough to join a SCRAPED platform,
  -- because the title on the platform drifts: a sheet written last quarter says
  -- "Credit Risk Essentials: Analytics, AI & Underwriting" while Udemy now
  -- lists "Credit Risk Analysis & AI-Powered Underwriting 2026". Keyed on the
  -- normalised title so any spelling of a known alias resolves to one parent.
  CREATE TABLE IF NOT EXISTS course_title_map (
    title_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    parent_title TEXT NOT NULL,
    platform TEXT,
    source TEXT,
    updated_at TEXT NOT NULL
  );

  -- THE RESOLVED COURSE MAP. One row per live course on a platform, carrying
  -- everything needed to attach money to it, so the APIs are called once and
  -- never again for a course already resolved.
  --
  -- Resolution runs in a cascade and records WHICH step succeeded, because a
  -- match found by title is not worth the same as one found by URL, and a
  -- report that hides the difference invites trust it has not earned.
  --
  --   platform title -> Boostr (client = platform)   by URL, then title
  --   Boostr record  -> parent, contract, batch, SME  (if relationship = Child)
  --   parent/title   -> financial row                 title, parent, batch, SME
  --
  -- The uid is stable across runs: platform + normalised title. A course renamed
  -- on the platform therefore arrives as a NEW row rather than silently
  -- overwriting the old one's history.
  CREATE TABLE IF NOT EXISTS course_map (
    uid TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    boostr_id TEXT,
    relationship TEXT,              -- Parent | Child | N/A
    parent_title TEXT,
    parent_boostr_id TEXT,
    contract TEXT,
    program TEXT,
    batch TEXT,
    sme TEXT,
    distribution_link TEXT,
    boostr_status TEXT,
    boostr_method TEXT,             -- url | title | normalised | none
    revenue_title TEXT,             -- the row it matched in the financial source
    revenue_method TEXT,            -- title | parent | batch | sme | none
    revenue_confidence TEXT,        -- exact | corroborated | weak | unmatched
    first_seen TEXT NOT NULL,
    resolved_at TEXT,
    last_checked TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_course_map_platform ON course_map (platform);
  CREATE INDEX IF NOT EXISTS idx_course_map_parent ON course_map (parent_title);

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

// Columns added after the table first shipped. SQLite has no "ADD COLUMN IF NOT
// EXISTS", and an existing database must not be dropped, so each is attempted
// and the duplicate-column error swallowed.
for (const [table, col, decl] of [
  ['revenue_master', 'original_title', 'TEXT'],
  ['revenue_master', 'platform_title', 'TEXT'],
  ['revenue_master', 'batch', 'TEXT'],
  ['course_title_map', 'batch', 'TEXT'],
  // The Boostr client of the matched record, and of its parent. The whole
  // categorisation turns on these, so they are stored rather than re-derived.
  ['course_map', 'boostr_client', 'TEXT'],
  ['course_map', 'parent_client', 'TEXT'],
  // The course's own slug and URL. A URL cannot be renamed out from under us,
  // so it is far stronger evidence than a title when matching a course across
  // systems — and Udemy titles are deliberately rewritten per platform.
  ['udemy_real_course_ids', 'slug', 'TEXT'],
  ['udemy_real_course_ids', 'url', 'TEXT'],
  // 'live' or 'used_up'. A used-up coupon is one Udemy has stopped listing as
  // valid because every redemption was taken, while its dates still run. Kept,
  // not dropped, so a course whose free coupon ran out still shows that it did.
  ['coupons', 'status', "TEXT NOT NULL DEFAULT 'live'"],
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

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
  `INSERT INTO coupons (course_id, code, is_free, discount_value, max_uses, used, start_time, end_time, active, status, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        r.used ?? null, r.start ?? null, r.end ?? null, r.active ? 1 : 0,
        r.status === 'used_up' ? 'used_up' : 'live', ts
      );
    }
  });
  tx();
  recordRun({ job: 'coupons', startedAt, ok: true, guarded: false, rowCount: rows.length });
  return { ok: true, guarded: false, written: rows.length };
}
// perCourse is LIVE coupons only — the meaning every caller already relies on
// ("N active" is c.coupons.length in half a dozen places). Used-up coupons come
// back separately, so they are visible without inflating any of those counts.
export function readCoupons() {
  const rows = db.prepare('SELECT * FROM coupons').all();
  const scrapedAt = db.prepare('SELECT MAX(updated_at) AS t FROM coupons').get().t;
  const perCourse = {};
  const usedUpPerCourse = {};
  for (const r of rows) {
    const c = {
      code: r.code, is_free: !!r.is_free, discount_value: r.discount_value,
      max_uses: r.max_uses, used: r.used, start: r.start_time, end: r.end_time, active: !!r.active,
      status: r.status || 'live',
    };
    ((r.status === 'used_up' ? usedUpPerCourse : perCourse)[r.course_id] ||= []).push(c);
  }
  return { perCourse, usedUpPerCourse, scrapedAt };
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
     (course_id, real_course_id, title, slug, url, currency, best_price_value, min_custom_price, max_custom_price, coupons_remaining, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(course_id) DO UPDATE SET
     real_course_id = excluded.real_course_id, title = excluded.title,
     -- Keep a slug already known when a caller cannot supply one.
     slug = COALESCE(excluded.slug, udemy_real_course_ids.slug),
     url = COALESCE(excluded.url, udemy_real_course_ids.url),
     currency = excluded.currency,
     best_price_value = excluded.best_price_value, min_custom_price = excluded.min_custom_price,
     max_custom_price = excluded.max_custom_price, coupons_remaining = excluded.coupons_remaining,
     updated_at = excluded.updated_at`
);
export function writeUdemyRealCourseIds(rows) {
  const ts = nowIso();
  return upsertMerge(
    'udemy_real_course_ids', rows,
    (r) => upsertRealCourseIdStmt.run(
      r.courseId, r.realCourseId, r.title, r.slug ?? null, r.url ?? null, r.currency ?? null,
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
  'linkedin_courses', 'linkedin_revenue', 'revenue_master',
  'futurelearn_courses', 'go1_courses', 'go1_course_history', 'engagement_course', 'engagement_monthly', 'engagement_meta', 'engagement_ub_monthly',
  'engagement_course_monthly',
];
// Most scrape tables stamp `updated_at`; a few use a different column name.
const TIMESTAMP_COLUMN_OVERRIDES = {
  revenue_master: 'imported_at',
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
  // Two blind find-and-replaces aimed at the ALL_TABLES list also caught this
  // call, and stuffed two table names in front of `courses`. Every argument after
  // the first then shifted: the options object received the course array, `job`
  // became undefined, and the run log's NOT NULL job column crashed the write —
  // so no LinkedIn scrape could save anything. One table, the rows, the writer.
  return guardedReplaceAll(
    'linkedin_courses', courses,
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

// HOW OLD EACH PLATFORM'S DATA IS, as a reader would ask it. readFreshness()
// above reports scrape JOBS from the run log; latestUpdatedAt() answers "when
// did anything change", which is the wrong question for someone reading a page:
// on 2026-09-24 it said "3h ago" because Coursera was fresh, while the Coursera
// metrics had been stuck for 13 days until that morning and every Udemy figure
// was 34 days old. This goes by the tables each page actually reads, and judges
// a platform by its OLDEST one — one fresh table cannot vouch for a stale one.
const PLATFORM_SOURCES = {
  udemy: [['revenue_course', 'Revenue'], ['enrollment', 'Enrollments'], ['engagement_course', 'Minutes watched'],
          ['captions', 'Captions'], ['coupons', 'Coupons']],
  coursera: [['coursera_metrics', 'Enrollments & ratings'], ['coursera_course_status', 'Status & reviews']],
  coursera_cin: [['coursera_cin_metrics', 'Enrollments & ratings'], ['coursera_cin_courses', 'Course list']],
  futurelearn: [['futurelearn_courses', 'Courses & enrollment']],
  linkedin: [['linkedin_courses', 'Learners, shares & likes']],
  go1: [['go1_courses', 'Courses'], ['go1_course_history', 'Monthly history']],
};
export function readPlatformFreshness() {
  const now = Date.now();
  const out = {};
  for (const [platform, sources] of Object.entries(PLATFORM_SOURCES)) {
    const list = sources.map(([table, label]) => {
      const col = TIMESTAMP_COLUMN_OVERRIDES[table] || 'updated_at';
      let at = null;
      try { at = db.prepare(`SELECT MAX(${col}) AS t FROM ${table}`).get().t; } catch { /* table absent */ }
      return { table, label, updatedAt: at, ageDays: at ? +((now - Date.parse(at)) / 864e5).toFixed(1) : null };
    });
    const known = list.filter((x) => x.ageDays != null);
    out[platform] = { sources: list, oldest: known.length ? known.reduce((a, b) => (b.ageDays > a.ageDays ? b : a)) : null };
  }
  return out;
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

// --- master revenue spreadsheet -------------------------------------------
const insertRevenueMasterStmt = db.prepare(
  `INSERT INTO revenue_master
     (platform, course_key, period, course_name, original_title, platform_title, batch,
      amount, currency, note, source_file, source_row, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(platform, course_key, period) DO UPDATE SET
     course_name = excluded.course_name,
     original_title = excluded.original_title,
     platform_title = excluded.platform_title,
     batch = COALESCE(excluded.batch, revenue_master.batch),
     amount = excluded.amount,
     currency = excluded.currency, note = excluded.note,
     source_file = excluded.source_file, source_row = excluded.source_row,
     imported_at = excluded.imported_at`
);
// Upsert, never replace. An import usually covers the months the sheet happens
// to hold; replacing would delete every period the latest file omits.
//
// `course_key` is derived HERE rather than trusted from the caller, so every
// importer keys rows the same way and a course can never end up split across
// two keys because one script normalised differently. It comes from the
// Original Title — the parent — which is what makes the same course line up
// across platforms. `platform_title` is what the dashboard displays.
export function writeRevenueMaster(rows, sourceFile) {
  const ts = nowIso();

  // AGGREGATE BEFORE WRITING. A sheet routinely carries several rows for the
  // same course and quarter — Coursera splits each one across "Course",
  // "Coursera Plus" and "Specialization" product types — and the table holds
  // one total per course per period. Upserting them one at a time made each
  // row overwrite the last, so only the final product type survived and the
  // Coursera total came out at roughly 2% of the real figure.
  const agg = new Map();
  for (const r of rows) {
    // A sheet with one title column (Coursera) supplies the same string twice.
    const original = r.originalTitle ?? r.courseName ?? r.platformTitle ?? null;
    const shown = r.platformTitle ?? r.courseName ?? original;
    const key = courseMappingKey(original) || String(r.courseKey ?? '').trim();
    if (!key || !r.period) continue;
    const id = `${r.platform}\u0000${key}\u0000${r.period}`;
    const cur = agg.get(id);
    if (!cur) {
      agg.set(id, {
        platform: r.platform, key, period: r.period, original, shown,
        batch: r.batch ?? null,
        amount: r.amount ?? null, currency: r.currency || 'USD',
        note: r.note ?? null, sourceRow: r.sourceRow ?? null, parts: 1,
      });
    } else {
      if (r.amount != null) cur.amount = (cur.amount ?? 0) + r.amount;
      cur.note ??= r.note ?? null;
      cur.batch ??= r.batch ?? null;
      cur.parts++;
    }
  }

  const run = db.transaction(() => {
    for (const a of agg.values()) {
      // Say so on the row itself when it is a sum, so a figure that does not
      // match a single line in the sheet is explainable.
      const note = a.parts > 1
        ? [a.note, `summed from ${a.parts} sheet rows`].filter(Boolean).join(' · ')
        : a.note;
      insertRevenueMasterStmt.run(
        a.platform, a.key, a.period, a.shown ?? null, a.original, a.shown ?? null,
        a.batch ?? null, a.amount, a.currency, note, sourceFile ?? null, a.sourceRow, ts,
      );
    }
  });
  run();
  return { written: agg.size, input: rows.length };
}

export function readRevenueMaster({ platform, period } = {}) {
  const where = [];
  const args = [];
  if (platform) { where.push('platform = ?'); args.push(platform); }
  if (period) { where.push('period = ?'); args.push(period); }
  const sql = 'SELECT * FROM revenue_master' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const rows = db.prepare(sql).all(...args);

  const byPlatform = {};
  const byPeriod = {};
  for (const r of rows) {
    (byPlatform[r.platform] ||= { platform: r.platform, amount: 0, courses: new Set(), periods: new Set() });
    byPlatform[r.platform].amount += r.amount || 0;
    byPlatform[r.platform].courses.add(r.course_key);
    byPlatform[r.platform].periods.add(r.period);
    (byPeriod[r.period] ||= { period: r.period, amount: 0 }).amount += r.amount || 0;
  }
  return {
    rows: rows.map((r) => ({
      platform: r.platform, courseKey: r.course_key, period: r.period,
      courseName: r.course_name,
      originalTitle: r.original_title ?? r.course_name,
      platformTitle: r.platform_title ?? r.course_name,
      amount: r.amount, currency: r.currency, note: r.note,
    })),
    byPlatform: Object.values(byPlatform).map((p) => ({
      platform: p.platform, amount: p.amount, courses: p.courses.size, periods: p.periods.size,
    })).sort((a, b) => b.amount - a.amount),
    byPeriod: Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period)),
    total: rows.reduce((a, r) => a + (r.amount || 0), 0),
    importedAt: db.prepare('SELECT MAX(imported_at) AS t FROM revenue_master').get().t,
  };
}

// --- combined revenue, one precedence rule --------------------------------
// Udemy revenue comes from the live scrape and instructor API — it is reported
// per course and per month straight from the platform. Every other platform
// exposes nothing a scraper can read (Coursera has no revenue API, FutureLearn
// shows partners nothing, Go1 has no reporting on this account), so those come
// from the royalty spreadsheets on SharePoint.
//
// Keeping that decision in one function means the dashboard, the exports and
// any report all agree, instead of each picking a source.
export const REVENUE_SOURCE = {
  Udemy: 'scrape',
  Coursera: 'sheet',
  'Coursera CIN': 'sheet',
  FutureLearn: 'sheet',
  LinkedIn: 'sheet',
  Go1: 'sheet',
};

export function readCombinedRevenue() {
  const out = [];

  // Udemy — scraped lifetime total per course.
  const udemy = db.prepare('SELECT course_id, amount FROM revenue_course').all();
  const udemyTotal = udemy.reduce((a, r) => a + (r.amount || 0), 0);
  if (udemy.length) {
    out.push({ platform: 'Udemy', source: 'scrape', amount: udemyTotal, courses: udemy.length, periods: null });
  }

  // Everything else — the SharePoint sheets. Udemy rows are ignored even if a
  // sheet carries them, so the two sources can never double-count.
  const master = db.prepare(
    `SELECT platform, SUM(amount) AS amount, COUNT(DISTINCT course_key) AS courses,
            COUNT(DISTINCT period) AS periods
       FROM revenue_master WHERE platform <> 'Udemy' GROUP BY platform`
  ).all();
  master.forEach((r) => out.push({
    platform: r.platform, source: 'sheet', amount: r.amount || 0,
    courses: r.courses, periods: r.periods,
  }));

  return {
    platforms: out.sort((a, b) => b.amount - a.amount),
    total: out.reduce((a, r) => a + r.amount, 0),
    note: 'Udemy from the live scrape; all other platforms from the SharePoint royalty sheets.',
  };
}

// Everything the revenue page needs, in one call.
export function readRevenueDashboard() {
  const combined = readCombinedRevenue();
  // Udemy is excluded here for the same reason it is excluded from
  // readCombinedRevenue: its revenue comes from the live scrape. Its sheet rows
  // are imported all the same, because they carry the Original Title <-> Title
  // on Udemy pairing the cross-platform mapping needs — but counting them here
  // as well would double the platform's revenue.
  const master = db.prepare("SELECT * FROM revenue_master WHERE platform <> 'Udemy'").all();

  const byPeriod = {};
  for (const r of master) {
    const p = (byPeriod[r.period] ||= { period: r.period, total: 0, platforms: {} });
    p.total += r.amount || 0;
    p.platforms[r.platform] = (p.platforms[r.platform] || 0) + (r.amount || 0);
  }

  // `course` is the on-platform title, because that is what the dashboard shows.
  // The parent title travels alongside it for grouping and search.
  const courses = master.map((r) => ({
    platform: r.platform,
    course: r.platform_title ?? r.course_name,
    originalTitle: r.original_title ?? r.course_name,
    period: r.period,
    amount: r.amount, currency: r.currency, note: r.note, source: r.source_file,
  })).sort((a, b) => (b.amount || 0) - (a.amount || 0));

  // Udemy's own monthly series, which the scrape does provide.
  let udemyMonthly = [];
  try {
    udemyMonthly = db.prepare('SELECT month, amount FROM revenue_monthly ORDER BY month').all()
      .map((r) => ({ period: String(r.month).slice(0, 7), amount: r.amount }));
  } catch { /* table shape differs on older databases */ }

  return {
    combined,
    byPeriod: Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period)),
    courses,
    udemyMonthly,
    sourceFiles: [...new Set(master.map((r) => r.source_file).filter(Boolean))],
    importedAt: db.prepare('SELECT MAX(imported_at) AS t FROM revenue_master').get().t,
  };
}

// --- one course across every platform ------------------------------------
// THE MAPPING RULE, in one place:
//
//   mapping key  = Original Title   (the Starweaver parent title)
//   display name = Title on <Platform>
//
// Every royalty sheet carries both, so courses are grouped on the parent title
// and shown under the name the platform actually publishes. Coursera's sheet
// carries one title only — its listing name IS the parent title — so there the
// two are the same string.
//
// Normalising still happens because the parent title is typed by hand into each
// sheet: case, accents, punctuation, "&" versus "and", a trailing year, and the
// marketing words that creep in ("Course", "Masterclass", "(English translation)").
//
// Matching is EXACT on the normalised form. Nothing is grouped by resemblance:
// a near-miss is left as its own row rather than silently merging two courses
// and reporting one wrong total.
export const courseMappingKey = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ')
  // Markers the platforms append that say nothing about which course this is.
  .replace(/\((?:english translation|private|public|unlisted|new|copy)\)/g, ' ')
  // British vs American spelling. FutureLearn writes "Modernising Business
  // Workflows" where Udemy writes "Modernizing" — the same course, and the
  // commonest reason a pair failed to match. The transform only has to be
  // CONSISTENT, not linguistically right: both sides go through it, so turning
  // "advertise" into "advertize" costs nothing and joining "analyse" to
  // "analyze" is the whole point.
  .replace(/isation|isational/g, 'ization')
  .replace(/is(e|ed|es|ing)\b/g, 'iz$1')
  .replace(/ys(e|ed|es|ing)\b/g, 'yz$1')
  .replace(/([a-z])ll(ing|ed|er|ors?)\b/g, '$1l$2')     // modelling -> modeling
  .replace(/\bprogramme(s?)\b/g, 'program$1')
  .replace(/(colour|behaviour|favour|labour|honour|neighbour|flavour)/g, (m) => `${m.slice(0, -2)}r`)
  .replace(/\b(cent|theat|met|fib|lit)re(s?)\b/g, '$1er$2')
  .replace(/\b(defen|offen|licen|preten)ce\b/g, '$1se')   // Threat Defence -> Defense
  .replace(/[^a-z0-9]+/g, ' ')
  // Brand names written both ways. Coursera lists "Gen AI For Sustainability"
  // where every other platform writes "GenAI".
  .replace(/\bgen ai\b/g, 'genai')
  .replace(/\bchat gpt\b/g, 'chatgpt')
  .replace(/\bcyber security\b/g, 'cybersecurity')
  .replace(/\be commerce\b/g, 'ecommerce')
  .replace(/\be learning\b/g, 'elearning')
  .replace(/\b(20\d\d)\b/g, ' ')
  .replace(/\b(the complete|complete|ultimate|masterclass|master class|course|training|certification|bootcamp|guide|essentials|fundamentals)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Upsert-merge: an alias learnt from one source is never dropped because the
// next source did not mention it.
const insertTitleMapStmt = db.prepare(
  `INSERT INTO course_title_map (title_key, title, parent_title, platform, batch, source, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(title_key) DO UPDATE SET
     title = excluded.title, parent_title = excluded.parent_title,
     platform = excluded.platform,
     -- A source that knows no batch must not erase one another source supplied.
     batch = COALESCE(excluded.batch, course_title_map.batch),
     source = excluded.source, updated_at = excluded.updated_at`
);
export function writeCourseTitleMap(rows, source) {
  const ts = nowIso();
  let n = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      const key = courseMappingKey(r.title);
      if (!key || !r.parentTitle) continue;
      insertTitleMapStmt.run(key, r.title, r.parentTitle, r.platform ?? null,
        r.batch ?? null, source ?? null, ts);
      n++;
    }
  });
  run();
  return { written: n };
}

// title -> parent title, for every alias the map knows. Built once per read.
function titleAliasIndex() {
  const idx = new Map();
  for (const r of db.prepare('SELECT title_key, parent_title FROM course_title_map').all()) {
    idx.set(r.title_key, r.parent_title);
  }
  return idx;
}

export function readCourseTitleMap() {
  const rows = db.prepare(
    'SELECT title, parent_title, platform, source FROM course_title_map ORDER BY parent_title, platform'
  ).all();
  return {
    rows,
    parents: new Set(rows.map((r) => r.parent_title)).size,
    aliases: rows.length,
  };
}

// PLATFORMS THAT NEVER SHARE A COURSE WITH ANOTHER.
//
// Coursera CIN is its own catalogue, not a second channel for the same courses:
// 324 parent courses, its own batch series (6-10, numbered independently of
// Starweaver's 1-7), and no course in common with anywhere else. Treating it as
// exclusive is a RULE, not an observation — its titles are never resolved
// through the shared title map, and its groups are namespaced so a future
// coincidence of wording cannot silently merge a CIN course into a Starweaver
// one and double-count the pair.
export const EXCLUSIVE_PLATFORMS = new Set(['Coursera CIN']);
const groupKeyFor = (platform, parent) => {
  const k = courseMappingKey(parent);
  return EXCLUSIVE_PLATFORMS.has(platform) ? `${platform}\u0000${k}` : k;
};

// --- live courses per batch, per platform ---------------------------------
// The question this answers: for Batch N, how many courses are actually live on
// each platform. It is counted from the LIVE catalogues each scraper maintains,
// not from a status column in a spreadsheet, so a course that was pulled or
// never shipped does not keep counting.
//
// A batch belongs to the parent course, and comes from whichever source knows
// it: the distribution workbooks cover batches 1-7, the Coursera royalty sheet
// covers 6-10. Titles that resolve to no parent are reported as unmapped rather
// than dropped — otherwise a gap in the title map reads as an empty batch.
const LIVE_CATALOGUES = [
  ['Udemy', 'SELECT title AS t FROM udemy_real_course_ids'],
  ['Coursera', 'SELECT course_name AS t FROM coursera_metrics'],
  ['Coursera CIN', 'SELECT name AS t FROM coursera_cin_courses'],
  // FutureLearn calls a running course "In progress"; Draft and Finished are not live.
  ['FutureLearn', "SELECT title AS t FROM futurelearn_courses WHERE status = 'In progress'"],
  // go1_courses is a MONTHLY ACTIVITY snapshot — only courses with at least one
  // enrolment that month (73 in June 2026). The catalogue is the union with the
  // history, which carries 145 distinct courses over 15 months. Using the
  // snapshot alone understated Go1 and made shipped courses look missing.
  ['Go1', `SELECT DISTINCT name AS t FROM go1_courses
           UNION SELECT DISTINCT course_name AS t FROM go1_course_history`],
  ['LinkedIn', 'SELECT title AS t FROM linkedin_courses'],
];

export function readBatchCoverage() {
  // parent key -> batch. The title map is authoritative; the royalty sheets
  // fill in the batches it does not cover.
  // "SWO Batch 1" beats a bare "Batch 1" for the same parent: the programme is
  // what distinguishes three unrelated cohorts that all number themselves 1.
  const named = (b) => /^(SWO|LPS|RD|CIN)\b/i.test(String(b));
  const parentBatch = new Map();
  const setBatch = (k, b) => {
    if (!k || !b) return;
    const cur = parentBatch.get(k);
    if (cur && (named(cur) || !named(b))) return;
    parentBatch.set(k, b);
  };
  for (const r of db.prepare(
    'SELECT parent_title, batch FROM course_title_map WHERE batch IS NOT NULL'
  ).all()) setBatch(courseMappingKey(r.parent_title), r.batch);
  // TWO BATCH SERIES SHARE THE SAME NUMBERS. Starweaver's own batches run 1-7
  // and come from the distribution workbooks. Coursera CIN numbers its batches
  // 6-10 independently — a different programme, a different set of courses.
  // Merging them under a bare "Batch 6" would report two unrelated things as
  // one, so CIN's are prefixed.
  for (const r of db.prepare(
    'SELECT DISTINCT platform, original_title, batch FROM revenue_master WHERE batch IS NOT NULL'
  ).all()) {
    const k = groupKeyFor(r.platform, r.original_title);
    if (!k) continue;
    setBatch(k, EXCLUSIVE_PLATFORMS.has(r.platform) && !named(r.batch)
      ? `CIN ${r.batch}` : r.batch);
  }

  // any known title -> parent title
  const alias = titleAliasIndex();

  const batches = new Map();
  const row = (b) => {
    const e = batches.get(b) || { batch: b, platforms: {}, parents: new Set() };
    batches.set(b, e);
    return e;
  };
  const unmapped = {};

  for (const [platform, sql] of LIVE_CATALOGUES) {
    let titles = [];
    try { titles = db.prepare(sql).all().map((r) => r.t).filter(Boolean); } catch { continue; }
    const exclusive = EXCLUSIVE_PLATFORMS.has(platform);
    for (const title of titles) {
      // An exclusive platform's titles are never looked up in the shared map.
      const parent = exclusive ? title : (alias.get(courseMappingKey(title)) || title);
      const gk = groupKeyFor(platform, parent);
      const batch = parentBatch.get(gk);
      if (!batch) { (unmapped[platform] ||= []).push(title); continue; }
      const e = row(batch);
      (e.platforms[platform] ||= { platform, courses: 0, titles: [] });
      e.platforms[platform].courses++;
      e.platforms[platform].titles.push(title);
      e.parents.add(gk);
    }
  }

  // "Batch 10" after "Batch 9", and anything unnumbered last.
  // Grouped by programme — SWO, then LPS, then RD, then CIN, then anything
  // whose programme no sheet names — and by batch number within each.
  const PROGRAM_ORDER = { SWO: 0, LPS: 1, RD: 2, CIN: 3 };
  const order = (b) => {
    const s = String(b);
    const p = (s.match(/^(SWO|LPS|RD|CIN)\b/i) || [])[1];
    const m = s.match(/(\d+)/);
    return (p ? PROGRAM_ORDER[p.toUpperCase()] : 4) * 1000 + (m ? Number(m[1]) : 999);
  };
  const rows = [...batches.values()]
    .sort((a, b) => order(a.batch) - order(b.batch) || String(a.batch).localeCompare(String(b.batch)))
    .map((e) => ({
      batch: e.batch,
      parents: e.parents.size,
      total: Object.values(e.platforms).reduce((a, p) => a + p.courses, 0),
      platforms: Object.fromEntries(Object.entries(e.platforms).map(([k, v]) => [k, v.courses])),
      titles: Object.fromEntries(Object.entries(e.platforms).map(([k, v]) => [k, v.titles.sort()])),
    }));

  return {
    batches: rows,
    platforms: LIVE_CATALOGUES.map(([p]) => p),
    unmapped: Object.fromEntries(Object.entries(unmapped).map(([k, v]) => [k, v.sort()])),
    unmappedCount: Object.values(unmapped).reduce((a, v) => a + v.length, 0),
  };
}

// --- batch revenue, one row per parent with its courses underneath ---------
// Parent course -> total, and under it each platform's own course titles with
// what each earned. Scoped to the batches whose parent list has been confirmed
// (titleMapOverrides.scope), because the inferred batch labels are not reliable
// enough to report money against.
//
// The two sides are NOT the same shape and the UI has to say so: Udemy is a
// LIFETIME figure from the live scrape, Coursera is a sum of QUARTERS from the
// royalty sheet. Coursera CIN is excluded by rule (EXCLUSIVE_PLATFORMS).
export function readBatchCourseRevenue() {
  let ov = {};
  try {
    ov = JSON.parse(readFileSync(join(__dirname, 'titleMapOverrides.json'), 'utf8'));
  } catch { return { batches: [], courses: [], total: 0, scope: [] }; }

  const scope = new Set(ov.scope?.confirmedBatches || []);
  const parents = new Map(Object.entries(ov.parentBatches || {})
    .filter(([, b]) => !scope.size || scope.has(b))
    .map(([p, b]) => [courseMappingKey(p), { parent: p, batch: b, sme: ov.smes?.[p] || null }]));

  const alias = titleAliasIndex();
  const parentOf = (t) => courseMappingKey(alias.get(courseMappingKey(t)) || t);

  const out = new Map();
  for (const [k, meta] of parents) out.set(k, { key: k, ...meta, total: 0, platforms: {} });
  const put = (k, platform, title, amount, source) => {
    const e = out.get(k);
    if (!e) return;
    const p = (e.platforms[platform] ||= { platform, source, amount: 0, courses: [] });
    p.amount += amount || 0;
    e.total += amount || 0;
    const hit = p.courses.find((c) => c.title === title);
    if (hit) hit.amount += amount || 0;
    else p.courses.push({ title, amount: amount || 0 });
  };

  db.prepare(
    `SELECT r.amount, u.title FROM revenue_course r
       JOIN udemy_real_course_ids u ON u.course_id = r.course_id`
  ).all().forEach((r) => put(parentOf(r.title), 'Udemy', r.title, r.amount, 'scrape'));

  db.prepare(
    `SELECT course_name, revenue FROM coursera_revenue_quarterly WHERE catalog = 'starweaver'`
  ).all().forEach((r) => put(parentOf(r.course_name), 'Coursera', r.course_name, r.revenue, 'sheet'));

  const courses = [...out.values()].map((e) => ({
    ...e,
    total: +e.total.toFixed(2),
    platforms: Object.values(e.platforms)
      .map((p) => ({ ...p, amount: +p.amount.toFixed(2), courses: p.courses.map((c) => ({ ...c, amount: +c.amount.toFixed(2) })).sort((a, b) => b.amount - a.amount) }))
      .sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.total - a.total);

  const batches = [...new Set(courses.map((c) => c.batch))].sort().map((b) => ({
    batch: b,
    parents: courses.filter((c) => c.batch === b).length,
    total: +courses.filter((c) => c.batch === b).reduce((a, c) => a + c.total, 0).toFixed(2),
  }));

  return {
    courses,
    batches,
    scope: [...scope],
    total: +courses.reduce((a, c) => a + c.total, 0).toFixed(2),
    note: 'Udemy is lifetime revenue from the live scrape; Coursera is the Starweaver royalty sheet summed over 2023 Q3 - 2026 Q2. Coursera CIN is a separate catalogue and is excluded.',
  };
}

// --- everything the SWO batch dashboard needs, in one call -----------------
// Parents in the confirmed batches, each with: what is live on every platform,
// what the trackers planned, what it earned, and the production gaps. Shaped so
// the page never has to decide what counts — that decision lives here.
export function readBatchDashboard() {
  let ov = {};
  try { ov = JSON.parse(readFileSync(join(__dirname, 'titleMapOverrides.json'), 'utf8')); }
  catch { return { scope: [], parents: [], batches: [], platforms: [], gaps: [] }; }

  const scope = new Set(ov.scope?.confirmedBatches || []);
  const PLATFORMS = ['Coursera', 'Udemy', 'Go1', 'FutureLearn', 'LinkedIn'];
  const LIVE = {
    Coursera: 'SELECT course_name AS t FROM coursera_metrics',
    Udemy: 'SELECT title AS t FROM udemy_real_course_ids',
    Go1: `SELECT DISTINCT name AS t FROM go1_courses
          UNION SELECT DISTINCT course_name AS t FROM go1_course_history`,
    FutureLearn: "SELECT title AS t FROM futurelearn_courses WHERE status = 'In progress'",
    LinkedIn: 'SELECT title AS t FROM linkedin_courses',
  };

  const alias = titleAliasIndex();
  const parentKeyOf = (t) => courseMappingKey(alias.get(courseMappingKey(t)) || t);
  // A localised child is written "Spanish (English)" in the trackers, the
  // platform lists the bare form, and Udemy truncates at 60 characters.
  const forms = (t) => {
    const o = [String(t)];
    const m = String(t).match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (m) o.push(m[1].trim(), m[2].trim());
    o.slice().forEach((f) => { if (f.length > 60) o.push(f.slice(0, 60).trim()); });
    return [...new Set(o)];
  };

  const out = new Map();
  for (const [p, b] of Object.entries(ov.parentBatches || {})) {
    if (!scope.has(b)) continue;
    out.set(courseMappingKey(p), {
      key: courseMappingKey(p), parent: p, batch: b, sme: ov.smes?.[p] || null,
      total: 0, notLive: ov.notLive?.[p] || null,
      platforms: Object.fromEntries(PLATFORMS.map((x) => [x, { platform: x, live: [], planned: [], amount: 0 }])),
    });
  }

  const liveKeys = {};
  for (const [plat, sql] of Object.entries(LIVE)) {
    let list = [];
    try { list = db.prepare(sql).all().map((r) => r.t).filter(Boolean); } catch { /* table absent */ }
    liveKeys[plat] = new Set(list.map(courseMappingKey));
    for (const t of list) {
      const e = out.get(parentKeyOf(t));
      if (e) e.platforms[plat].live.push({ title: t, amount: 0 });
    }
  }

  // Planned children, with whether each one actually shipped.
  const gaps = [];
  for (const [plat, kids] of Object.entries(ov.platformChildren || {})) {
    if (!PLATFORMS.includes(plat)) continue;
    for (const [child, meta] of Object.entries(kids)) {
      if (!scope.has(meta.batch)) continue;
      const e = out.get(courseMappingKey(meta.parent));
      if (!e) continue;
      const isLive = forms(child).some((f) => liveKeys[plat].has(courseMappingKey(f)));
      e.platforms[plat].planned.push({ title: child, status: meta.status || null, live: isLive });
      if (!isLive) gaps.push({ platform: plat, title: child, parent: meta.parent, batch: meta.batch, sme: e.sme, status: meta.status || null });
    }
  }

  const addMoney = (plat, title, amount) => {
    const e = out.get(parentKeyOf(title));
    if (!e) return;
    e.platforms[plat].amount += amount || 0;
    e.total += amount || 0;
    const hit = e.platforms[plat].live.find((c) => c.title === title);
    if (hit) hit.amount += amount || 0;
    else e.platforms[plat].live.push({ title, amount: amount || 0, bundle: true });
  };
  db.prepare(`SELECT u.title AS t, r.amount AS a FROM revenue_course r
                JOIN udemy_real_course_ids u ON u.course_id = r.course_id`)
    .all().forEach((r) => addMoney('Udemy', r.t, r.a));
  db.prepare(`SELECT course_name AS t, revenue AS a FROM coursera_revenue_quarterly
               WHERE catalog = 'starweaver'`).all().forEach((r) => addMoney('Coursera', r.t, r.a));
  for (const plat of ['Go1', 'FutureLearn', 'LinkedIn']) {
    db.prepare(`SELECT COALESCE(platform_title, course_name) AS t, amount AS a
                  FROM revenue_master WHERE platform = ?`).all(plat)
      .forEach((r) => addMoney(plat, r.t, r.a));
  }

  const parents = [...out.values()].map((e) => ({
    ...e,
    total: +e.total.toFixed(2),
    platforms: Object.fromEntries(Object.entries(e.platforms).map(([k, v]) => [k, {
      ...v,
      amount: +v.amount.toFixed(2),
      live: v.live.map((c) => ({ ...c, amount: +c.amount.toFixed(2) })).sort((a, b) => b.amount - a.amount),
    }])),
  })).sort((a, b) => a.batch.localeCompare(b.batch) || b.total - a.total);

  const batches = [...scope].sort().map((b) => {
    const g = parents.filter((p) => p.batch === b);
    return {
      batch: b,
      parents: g.length,
      total: +g.reduce((a, p) => a + p.total, 0).toFixed(2),
      platforms: Object.fromEntries(PLATFORMS.map((x) => [x, {
        parents: g.filter((p) => p.platforms[x].live.length).length,
        courses: g.reduce((a, p) => a + p.platforms[x].live.length, 0),
        amount: +g.reduce((a, p) => a + p.platforms[x].amount, 0).toFixed(2),
        tracked: g.some((p) => p.platforms[x].planned.length),
      }])),
    };
  });

  return {
    scope: [...scope], platforms: PLATFORMS, parents, batches, gaps,
    total: +parents.reduce((a, p) => a + p.total, 0).toFixed(2),
    updatedAt: latestUpdatedAt(),
  };
}

// --- THE PUBLIC FEED ------------------------------------------------------
// The contract another tool consumes. Deliberately small and stable: two
// shapes, one row per course, no dashboard-specific structure. Everything else
// on this server is shaped for its own pages and may change with them; these
// two are an interface and should not.
//
// Anything that needs the catalogue or the money reads these, not the database.
const FEED_CATALOG = {
  // A Udemy course gets a public slug only once it is published, so the slug
  // is the published test — the instructor API exposes no status field.
  Udemy: `SELECT title AS title, slug, url, NULL AS status
            FROM udemy_real_course_ids WHERE slug IS NOT NULL`,
  // A draft is not live. coursera_metrics happens to carry only launched
  // courses today, but that is a coincidence of how it is built, not a
  // guarantee — so the exclusion is stated rather than assumed.
  Coursera: `SELECT m.course_name AS title, s.slug AS slug,
                    CASE WHEN s.slug IS NULL THEN NULL
                         ELSE 'https://www.coursera.org/learn/' || s.slug END AS url,
                    s.status AS status
               FROM coursera_metrics m
               LEFT JOIN coursera_course_status s ON s.course_name = m.course_name
              WHERE s.status IS NULL OR LOWER(s.status) <> 'draft'`,
  // A DRAFT IS NOT LIVE, on CIN as on Coursera. coursera_cin_courses is the
  // whole catalogue including unpublished work, and the status lives in
  // coursera_cin_metrics, so the two have to be joined to answer "what is on
  // sale". Without this, 5 drafts were reported as live — among them an
  // unpublished retitling of a course that IS live, which then read downstream
  // as a duplicate listing of the real one.
  'Coursera CIN': `SELECT c.name AS title, c.slug AS slug,
                          'https://www.coursera.org/learn/' || c.slug AS url, m.status AS status
                     FROM coursera_cin_courses c
                     LEFT JOIN coursera_cin_metrics m ON m.slug = c.slug
                    WHERE m.status IS NULL OR LOWER(m.status) <> 'draft'`,
  // LIVE ONLY. 'In progress' is FutureLearn's running state — Draft and
  // Finished are not live. Private is a closed cohort, not a public listing, so
  // it is excluded too: 50 of 196 runs are private, and 6 courses exist ONLY as
  // a private run and therefore drop out entirely. That is correct — they are
  // not on sale.
  FutureLearn: `SELECT title AS title, slug AS slug,
                       'https://www.futurelearn.com/courses/' || slug AS url, status AS status
                  FROM futurelearn_courses
                 WHERE status = 'In progress' AND visibility = 'Public'`,
  // go1_courses is a MONTHLY ACTIVITY snapshot, not the catalogue — the union
  // with the history is the catalogue. See readBatchCoverage.
  Go1: `SELECT DISTINCT name AS title, NULL AS slug, NULL AS url, NULL AS status FROM go1_courses
        UNION SELECT DISTINCT course_name, NULL, NULL, NULL FROM go1_course_history`,
  LinkedIn: `SELECT title AS title, NULL AS slug, NULL AS url, NULL AS status FROM linkedin_courses`,
};

export function readFeedCatalog(platform) {
  const wanted = platform ? [platform] : Object.keys(FEED_CATALOG);
  const out = [];
  for (const p of wanted) {
    if (!FEED_CATALOG[p]) continue;
    try {
      db.prepare(FEED_CATALOG[p]).all().forEach((r) => {
        if (r.title) out.push({ platform: p, ...r });
      });
    } catch { /* table absent on an older database */ }
  }
  return { platforms: Object.keys(FEED_CATALOG), total: out.length, courses: out, updatedAt: latestUpdatedAt() };
}

// One row per course per period. Udemy's period is 'lifetime' because the
// scrape gives a running total, not a series — the caller must not assume the
// two are comparable.
export function readFeedRevenue(platform) {
  const rows = [];
  const add = (p, list) => list.forEach((r) => rows.push({ platform: p, ...r }));
  const want = (p) => !platform || platform === p;

  if (want('Udemy')) {
    add('Udemy', db.prepare(
      `SELECT u.title AS title, r.amount AS amount, 'lifetime' AS period, 'scrape' AS source,
              'course' AS type
         FROM revenue_course r JOIN udemy_real_course_ids u ON u.course_id = r.course_id`
    ).all());
  }
  for (const [p, cat] of [['Coursera', 'starweaver'], ['Coursera CIN', 'cin']]) {
    if (!want(p)) continue;
    try {
      // product_type distinguishes a specialization — a bundle sold under its
      // own name — from the courses inside it. Without it, a consumer sums both
      // and double-counts.
      add(p, db.prepare(
        `SELECT course_name AS title, revenue AS amount, quarter AS period, 'sheet' AS source,
                CASE WHEN LOWER(product_type) LIKE '%special%' THEN 'specialization' ELSE 'course' END AS type
           FROM coursera_revenue_quarterly WHERE catalog = ?`
      ).all(cat));
    } catch { /* table absent */ }
  }
  for (const p of ['Go1', 'FutureLearn', 'LinkedIn']) {
    if (!want(p)) continue;
    // revenue_master is populated by the SharePoint import, which not every
    // install runs. Absent, these platforms simply report no revenue rather
    // than the whole feed failing.
    try {
      add(p, db.prepare(
        `SELECT COALESCE(platform_title, course_name) AS title, amount, period, 'sheet' AS source,
                'course' AS type
           FROM revenue_master WHERE platform = ?`
      ).all(p));
    } catch { /* table not present */ }
  }
  return {
    total: rows.length,
    revenue: rows,
    note: "Udemy's period is 'lifetime' — a running total from the scrape, not a series.",
    updatedAt: latestUpdatedAt(),
  };
}

// --- the resolved course map ----------------------------------------------
const upsertCourseMapStmt = db.prepare(
  `INSERT INTO course_map (uid, platform, platform_title, title_key, boostr_id, relationship,
     parent_title, parent_boostr_id, contract, program, batch, sme, distribution_link,
     boostr_status, boostr_method, revenue_title, revenue_method, revenue_confidence,
     boostr_client, parent_client, first_seen, resolved_at, last_checked)
   VALUES (@uid, @platform, @platformTitle, @titleKey, @boostrId, @relationship,
     @parentTitle, @parentBoostrId, @contract, @program, @batch, @sme, @distributionLink,
     @boostrStatus, @boostrMethod, @revenueTitle, @revenueMethod, @revenueConfidence,
     @boostrClient, @parentClient, @now, @resolvedAt, @now)
   ON CONFLICT(uid) DO UPDATE SET
     platform_title = excluded.platform_title,
     boostr_id = COALESCE(excluded.boostr_id, course_map.boostr_id),
     relationship = COALESCE(excluded.relationship, course_map.relationship),
     parent_title = COALESCE(excluded.parent_title, course_map.parent_title),
     parent_boostr_id = COALESCE(excluded.parent_boostr_id, course_map.parent_boostr_id),
     contract = COALESCE(excluded.contract, course_map.contract),
     program = COALESCE(excluded.program, course_map.program),
     batch = COALESCE(excluded.batch, course_map.batch),
     sme = COALESCE(excluded.sme, course_map.sme),
     distribution_link = COALESCE(excluded.distribution_link, course_map.distribution_link),
     boostr_status = COALESCE(excluded.boostr_status, course_map.boostr_status),
     boostr_method = COALESCE(excluded.boostr_method, course_map.boostr_method),
     revenue_title = COALESCE(excluded.revenue_title, course_map.revenue_title),
     revenue_method = COALESCE(excluded.revenue_method, course_map.revenue_method),
     revenue_confidence = COALESCE(excluded.revenue_confidence, course_map.revenue_confidence),
     boostr_client = COALESCE(excluded.boostr_client, course_map.boostr_client),
     parent_client = COALESCE(excluded.parent_client, course_map.parent_client),
     resolved_at = COALESCE(excluded.resolved_at, course_map.resolved_at),
     last_checked = excluded.last_checked`
);
// Merge, never replace: a field already resolved is kept when a later run
// cannot resolve it. `first_seen` survives by never being in the UPDATE list.
export function writeCourseMap(rows) {
  const now = nowIso();
  let n = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      upsertCourseMapStmt.run({
        uid: r.uid, platform: r.platform, platformTitle: r.platformTitle, titleKey: r.titleKey,
        boostrId: r.boostrId ?? null, relationship: r.relationship ?? null,
        parentTitle: r.parentTitle ?? null, parentBoostrId: r.parentBoostrId ?? null,
        contract: r.contract ?? null, program: r.program ?? null, batch: r.batch ?? null,
        sme: r.sme ?? null, distributionLink: r.distributionLink ?? null,
        boostrStatus: r.boostrStatus ?? null, boostrMethod: r.boostrMethod ?? null,
        revenueTitle: r.revenueTitle ?? null, revenueMethod: r.revenueMethod ?? null,
        revenueConfidence: r.revenueConfidence ?? null,
        boostrClient: r.boostrClient ?? null, parentClient: r.parentClient ?? null,
        resolvedAt: r.resolvedAt ?? null, now,
      });
      n++;
    }
  });
  run();
  return { written: n };
}

// Courses already resolved — the ones a daily run must NOT ask the APIs about.
export function readCourseMap({ platform, unresolvedOnly } = {}) {
  const where = [];
  const args = [];
  if (platform) { where.push('platform = ?'); args.push(platform); }
  if (unresolvedOnly) where.push("(boostr_id IS NULL OR revenue_confidence = 'unmatched')");
  const rows = db.prepare('SELECT * FROM course_map'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY platform, platform_title').all(...args);
  const by = (f) => rows.reduce((o, r) => { const k = r[f] || '(none)'; o[k] = (o[k] || 0) + 1; return o; }, {});
  return {
    rows,
    total: rows.length,
    byPlatform: by('platform'),
    byBoostrMethod: by('boostr_method'),
    byRevenueConfidence: by('revenue_confidence'),
    resolved: rows.filter((r) => r.boostr_id).length,
  };
}

// Everything the course-map page needs: the resolved rows, the unresolved ones,
// and the counts behind each. Kept in one call so the page never has to decide
// what "resolved" means — that decision lives here.
export function readCourseMapDashboard() {
  const rows = db.prepare('SELECT * FROM course_map ORDER BY platform, platform_title').all();
  const map = (r) => ({
    uid: r.uid, platform: r.platform, title: r.platform_title,
    parent: r.parent_title, relationship: r.relationship,
    contract: r.contract, batch: r.batch, sme: r.sme,
    boostrId: r.boostr_id, boostrMethod: r.boostr_method, boostrStatus: r.boostr_status,
    url: r.distribution_link,
    revenueTitle: r.revenue_title, revenueMethod: r.revenue_method,
    revenueConfidence: r.revenue_confidence,
    resolvedAt: r.resolved_at,
  });
  const all = rows.map(map);
  const platforms = [...new Set(all.map((r) => r.platform))].sort().map((p) => {
    const g = all.filter((r) => r.platform === p);
    return {
      platform: p, total: g.length,
      resolved: g.filter((r) => r.boostrId).length,
      withRevenue: g.filter((r) => r.revenueConfidence === 'exact').length,
      withUrl: g.filter((r) => r.url).length,
      byMethod: g.reduce((o, r) => { const k = r.boostrMethod || 'none'; o[k] = (o[k] || 0) + 1; return o; }, {}),
    };
  });
  return {
    courses: all,
    unresolved: all.filter((r) => !r.boostrId),
    platforms,
    total: all.length,
    resolved: all.filter((r) => r.boostrId).length,
    withRevenue: all.filter((r) => r.revenueConfidence === 'exact').length,
    lastBuilt: db.prepare("SELECT MAX(last_checked) AS t FROM course_map").get().t,
  };
}

// WHICH PROGRAMME A COURSE BELONGS TO, decided from its contract number.
//
//   Exclusive  the contract names a platform ("Udemy - Batch 1", "Udemy-001",
//              "LIL - Batch 1"). Verified in the data: of 41 such courses, ZERO
//              appear on any other platform and 40 of 41 are standalone with no
//              child. Built for one platform and sold only there.
//   Originals  the multi-platform programmes, in three lines:
//                 SWO                           the SWO - Batch N contracts
//                 LPS                           the LPS - Batch N contracts
//                 Coursera - Starweaver Branded a bare "Batch N" whose parent
//                                               sits with Coursera
//   Other      everything else — RD, LPS, and bare "Batch N" contracts. Shown
//              rather than swept into one of the two above, because guessing
//              which programme they belong to is how the batch labels went wrong
//              in the first place.
// "LIL" and "Lil" are both LinkedIn Learning.
const EXCLUSIVE_CONTRACT = /\b(udemy|coursera|go\s*1|futurelearn|linkedin|lil|edflex|packt|aztec|ec\s*council|codio|wiley|pearson)\b/i;

// A BARE "Batch N" contract — no programme prefix at all — belongs to the
// Coursera-branded Originals line when the parent sits with Coursera. Verified:
// all 56 such courses have a Boostr parent whose client is Coursera. Without
// the parent-client test a bare "Batch N" says nothing, which is why it is
// required rather than assumed from the number alone.
// The label a batch is shown under. A bare "Batch 3" is meaningless on its own
// — three different programmes number their batches from 1 — so the
// Coursera-branded line is prefixed CS, the way SWO and LPS prefix theirs.
export function batchLabel(contract, sub) {
  if (!contract) return null;
  const raw = String(contract).trim();
  // "RD - B3" is the same thing as "RD - Batch 3", written short once.
  const m = raw.match(/\bbatch\s*[-\u2013]?\s*(\d+)/i) || raw.match(/\bb\s*(\d+)\b/i);
  if (!m) return raw;
  const n = Number(m[1]);
  const prog = (raw.match(/^\s*([A-Za-z]+)\b/) || [])[1];
  // Only a BARE "Batch N" is the Coursera-branded content batch. An RD number
  // is a delivery batch and does not line up with it — RD - Batch 2 children
  // sit under parents in Batch 3 and Batch 5 — so it keeps its own prefix
  // rather than being relabelled into a CS batch that does not contain them.
  if (!prog || /^batch$/i.test(prog)) {
    return sub === 'Coursera - Starweaver Branded' ? `CS - Batch ${n}` : `Batch ${n}`;
  }
  return `${prog.toUpperCase()} - Batch ${n}`;
}

export function courseCategory(contract, parentClient) {
  if (!contract) return { category: 'Other', sub: null };
  if (EXCLUSIVE_CONTRACT.test(contract)) return { category: 'Exclusive', sub: null };
  if (/^\s*swo\b/i.test(contract)) return { category: 'Originals', sub: 'SWO' };
  if (/^\s*lps\b/i.test(contract)) return { category: 'Originals', sub: 'LPS' };
  // RD is a DELIVERY contract, not a content line: these are Coursera
  // Starweaver-branded courses pushed out to the other platforms. Their parent
  // is the Coursera-branded course, so they belong to that line.
  if (/^\s*rd\b/i.test(contract)) return { category: 'Originals', sub: 'Coursera - Starweaver Branded' };
  if (/^\s*batch\s*\d+/i.test(contract) && parentClient === 'Coursera') {
    return { category: 'Originals', sub: 'Coursera - Starweaver Branded' };
  }
  return { category: 'Other', sub: null };
}

// --- every parent, every platform, with the money underneath ---------------
// Parent course -> total, and under it each platform's own titles and what each
// earned. Built from course_map, so it covers the whole catalogue rather than
// the confirmed batches only.
//
// A course with no parent is its own root. It is shown, not hidden: a catalogue
// view that silently drops the unparented ones under-reports the total, and the
// gap is exactly what someone needs to see.
export function readParentRevenueTree() {
  const rows = db.prepare('SELECT * FROM course_map').all();
  // Parents sold as a bundle rather than a single course.
  let specials = new Set();
  try {
    const ov = JSON.parse(readFileSync(join(__dirname, 'titleMapOverrides.json'), 'utf8'));
    specials = new Set((ov.specializations || []).map(courseMappingKey));
  } catch { /* no overrides file */ }

  // Revenue per course title, per platform, from whichever source is agreed.
  const rev = {};
  const put = (plat, title, amount) => {
    (rev[plat] ||= new Map());
    const k = courseMappingKey(title);
    rev[plat].set(k, (rev[plat].get(k) || 0) + (amount || 0));
  };
  db.prepare(`SELECT u.title AS t, r.amount AS a FROM revenue_course r
                JOIN udemy_real_course_ids u ON u.course_id = r.course_id`)
    .all().forEach((r) => put('Udemy', r.t, r.a));
  db.prepare(`SELECT course_name AS t, revenue AS a FROM coursera_revenue_quarterly
               WHERE catalog = 'starweaver'`).all().forEach((r) => put('Coursera', r.t, r.a));
  for (const plat of ['Go1', 'FutureLearn', 'LinkedIn']) {
    db.prepare(`SELECT COALESCE(platform_title, course_name) AS t, amount AS a
                  FROM revenue_master WHERE platform = ?`).all(plat)
      .forEach((r) => put(plat, r.t, r.a));
  }

  const groups = new Map();
  for (const r of rows) {
    // No parent recorded: the course stands as its own root rather than vanishing.
    const parent = r.parent_title || r.platform_title;
    const key = courseMappingKey(parent);
    if (!key) continue;
    const g = groups.get(key) || {
      key, parent, batch: r.batch || null, sme: r.sme || null,
      contract: null, category: 'Other', sub: null, batchLabel: null, fromParentRow: false,
      orphan: !r.parent_title, specialization: specials.has(key), total: 0, platforms: {},
    };
    if (!g.batch && r.batch) g.batch = r.batch;
    if (!g.sme && r.sme) g.sme = r.sme;

    // THE PARENT'S OWN ROW DECIDES THE LINE AND BATCH for the whole group.
    // A child's contract is its delivery contract and often disagrees: RD -
    // Batch 2 children hang off parents in Batch 3 and Batch 5, so taking the
    // child's number would file the group under a batch it is not in.
    const isParentRow = courseMappingKey(r.platform_title) === key;
    if (r.contract && (isParentRow ? !g.fromParentRow : !g.contract)) {
      const c = courseCategory(r.contract, r.parent_client);
      g.contract = r.contract;
      g.category = c.category; g.sub = c.sub;
      g.batchLabel = batchLabel(r.contract, c.sub);
      if (isParentRow) g.fromParentRow = true;
    }
    if (r.parent_title) g.orphan = false;

    // The revenue row this course matched, else the course's own title.
    const amount = rev[r.platform]?.get(courseMappingKey(r.revenue_title || r.platform_title)) || 0;
    const p = (g.platforms[r.platform] ||= { platform: r.platform, amount: 0, courses: [] });
    if (!p.courses.some((c) => c.title === r.platform_title)) {
      p.courses.push({
        title: r.platform_title, amount: +amount.toFixed(2),
        url: r.distribution_link || null,
        matched: r.revenue_confidence === 'exact',
        method: r.boostr_method,
      });
      p.amount += amount;
      g.total += amount;
    }
    groups.set(key, g);
  }

  const out = [...groups.values()].map((g) => ({
    ...g,
    total: +g.total.toFixed(2),
    platformCount: Object.keys(g.platforms).length,
    courseCount: Object.values(g.platforms).reduce((a, p) => a + p.courses.length, 0),
    platforms: Object.values(g.platforms)
      .map((p) => ({ ...p, amount: +p.amount.toFixed(2), courses: p.courses.sort((a, b) => b.amount - a.amount) }))
      .sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.total - a.total || a.parent.localeCompare(b.parent));

  // Batches in programme order, then by number — "Batch 10" after "Batch 9".
  const batchList = (group) => {
    const m = new Map();
    group.forEach((x) => {
      const b = x.batchLabel;
      if (!b) return;
      const e = m.get(b) || { batch: b, parents: 0, total: 0 };
      e.parents++; e.total += x.total;
      m.set(b, e);
    });
    return [...m.values()]
      .map((e) => ({ ...e, total: +e.total.toFixed(2) }))
      .sort((a, b) => {
        const pa = (a.batch.match(/^([A-Za-z]+)/) || [])[1] || '';
        const pb = (b.batch.match(/^([A-Za-z]+)/) || [])[1] || '';
        if (pa !== pb) return pa.localeCompare(pb);
        return (Number((a.batch.match(/(\d+)/) || [])[1]) || 999) - (Number((b.batch.match(/(\d+)/) || [])[1]) || 999);
      });
  };

  const categories = ['Originals', 'Exclusive', 'Other'].map((c) => {
    const g = out.filter((x) => x.category === c);
    const subs = [...new Set(g.map((x) => x.sub).filter(Boolean))].sort().map((sname) => {
      const sg = g.filter((x) => x.sub === sname);
      return {
        sub: sname, parents: sg.length,
        courses: sg.reduce((a, x) => a + x.courseCount, 0),
        total: +sg.reduce((a, x) => a + x.total, 0).toFixed(2),
        platforms: [...new Set(sg.flatMap((x) => x.platforms.map((p) => p.platform)))].sort(),
        batches: batchList(sg),
      };
    });
    return {
      category: c, parents: g.length,
      courses: g.reduce((a, x) => a + x.courseCount, 0),
      total: +g.reduce((a, x) => a + x.total, 0).toFixed(2),
      platforms: [...new Set(g.flatMap((x) => x.platforms.map((p) => p.platform)))].sort(),
      batches: batchList(g),
      subs,
    };
  }).filter((c) => c.parents);

  return {
    parents: out,
    categories,
    specializations: out.filter((g) => g.specialization).length,
    batches: batchList(out),
    total: +out.reduce((a, g) => a + g.total, 0).toFixed(2),
    multiPlatform: out.filter((g) => g.platformCount > 1).length,
    orphans: out.filter((g) => g.orphan).length,
    platforms: [...new Set(rows.map((r) => r.platform))].sort(),
  };
}

export function readCourseRevenueAcrossPlatforms() {
  const groups = new Map();
  const alias = titleAliasIndex();
  // The parent named by the sheet is the first choice. Where the title map knows
  // a parent for either title, it wins: it is maintained against the live
  // catalogue, so it catches courses the platform has renamed since the sheet
  // was written.
  const parentOf = (platform, original, shown) => {
    // An exclusive platform keeps its own title as the parent — it is never
    // resolved through the shared map, so it cannot land in a shared group.
    if (EXCLUSIVE_PLATFORMS.has(platform)) return original;
    return alias.get(courseMappingKey(original)) || alias.get(courseMappingKey(shown)) || original;
  };
  // `original` decides which group the row joins; `shown` is what the dashboard
  // prints for that platform. They differ on every platform except Coursera.
  const add = (platform, originalIn, shown, amount, period, source) => {
    const original = parentOf(platform, originalIn, shown);
    if (!courseMappingKey(original)) return;
    const k = groupKeyFor(platform, original);
    const g = groups.get(k) || { key: k, title: original, platforms: {}, total: 0, titles: new Set() };
    // The parent title names the group. Sheets spell it slightly differently
    // from one platform to the next; keep the fullest spelling seen.
    if (String(original).length > String(g.title).length) g.title = original;
    if (shown) g.titles.add(shown);
    const p = (g.platforms[platform] ||= { platform, amount: 0, source, periods: [], titles: new Set() });
    p.amount += amount || 0;
    if (shown) p.titles.add(shown);
    if (period && !p.periods.includes(period)) p.periods.push(period);
    g.total += amount || 0;
    groups.set(k, g);
  };

  // Udemy — scraped lifetime revenue, titled via udemy_real_course_ids. The
  // scrape only knows the on-Udemy title, so it is both key and display name
  // until a sheet supplies the parent. Where the royalty sheet DOES carry the
  // pair, it wins: look the parent up before falling back.
  const udemyParent = new Map();
  db.prepare(
    `SELECT platform_title, original_title FROM revenue_master
      WHERE platform = 'Udemy' AND platform_title IS NOT NULL AND original_title IS NOT NULL`
  ).all().forEach((r) => udemyParent.set(courseMappingKey(r.platform_title), r.original_title));

  db.prepare(
    `SELECT r.amount, u.title FROM revenue_course r
       LEFT JOIN udemy_real_course_ids u ON u.course_id = r.course_id
      WHERE u.title IS NOT NULL`
  ).all().forEach((r) => {
    // The sheet's pairing only reaches titles Udemy has not changed since; the
    // title map covers the rest, so it is tried first.
    const parent = alias.get(courseMappingKey(r.title))
      || udemyParent.get(courseMappingKey(r.title))
      || r.title;
    add('Udemy', parent, r.title, r.amount, null, 'scrape');
  });

  // Everything else — the royalty spreadsheets.
  db.prepare(
    `SELECT platform, period, amount,
            COALESCE(original_title, course_name) AS original,
            COALESCE(platform_title, course_name) AS shown
       FROM revenue_master WHERE platform <> 'Udemy'`
  ).all().forEach((r) => add(r.platform, r.original, r.shown, r.amount, r.period, 'sheet'));

  const out = [...groups.values()].map((g) => ({
    key: g.key,
    title: g.title,
    total: +g.total.toFixed(2),
    platformCount: Object.keys(g.platforms).length,
    // On-platform names that differ from the parent — what each platform calls it.
    aliases: [...g.titles].filter((t) => t !== g.title),
    platforms: Object.values(g.platforms).map((p) => ({
      platform: p.platform, source: p.source, amount: +p.amount.toFixed(2),
      periods: p.periods.sort(),
      title: [...p.titles][0] || g.title,
      titles: [...p.titles],
    })).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.total - a.total);

  return {
    courses: out,
    multiPlatform: out.filter((c) => c.platformCount > 1).length,
    singlePlatform: out.filter((c) => c.platformCount === 1).length,
    total: +out.reduce((a, c) => a + c.total, 0).toFixed(2),
  };
}
