import { useEffect, useMemo, useRef, useState } from 'react';
import './v2.css';
import CourseDetail from '../CourseDetail.jsx';
import LocalizeCaptions from '../LocalizeCaptions.jsx';
import CreateCoupons from '../CreateCoupons.jsx';
import ConnectUdemy from '../ConnectUdemy.jsx';
import ConnectCoursera from '../ConnectCoursera.jsx';
import ConnectFutureLearn from '../ConnectFutureLearn.jsx';
import ConnectGo1 from '../ConnectGo1.jsx';
import ConnectLinkedIn from '../ConnectLinkedIn.jsx';
import { BarChart, Donut, Histogram, LineChart, ChartPlaceholder } from './charts.jsx';
import { enrich, classifyDomain, DOMAIN_COLOR, capNames, usd, exportCsv, exportMinutesCsv, exportCourseraCsv, exportFutureLearnCsv, exportLinkedInCsv, exportGo1Csv, exportWatchlistCsv, applyFilter, parseSmartQuery, FILTER_FIELDS } from './data.js';
import FilterBuilder, { specOf, describe } from './FilterBuilder.jsx';

const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const relTime = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const daysLive = (c) => { const d = c.published_time || c.created; return d ? Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null; };
// monthly: [{month:'2026-06-01', amount:N}, ...] newest-first from the API — take the
// most recent N months, sort chronological, and label each point "Jan '24".
const monthlySeries = (monthly, n = 24) => [...monthly].sort((a, b) => a.month.localeCompare(b.month)).slice(-n)
  .map((m) => ({ label: new Date(m.month).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), value: m.amount || 0 }));

// Small hand-rolled stroke icons (no icon library dependency) for the sidebar nav.
const ICONS = {
  overview: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  courses: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  earnings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 6" /><polyline points="14 6 21 6 21 13" /></svg>,
  minutes: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>,
  captions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  coupons: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9a3 3 0 1 0 0 6" /><path d="M22 9a3 3 0 1 1 0 6" /><rect x="2" y="6" width="20" height="12" rx="2" /><line x1="12" y1="6" x2="12" y2="18" strokeDasharray="2 2" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};
const NAV = [['overview', 'Overview'], ['watchlist', 'Watchlist'], ['courses', 'Courses'], ['earnings', 'Earnings'], ['minutes', 'Minutes'], ['captions', 'Captions'], ['coupons', 'Coupons']];

export default function AppV2() {
  const [raw, setRaw] = useState(null);
  const [coursera, setCoursera] = useState([]);
  const [courseraQuarters, setCourseraQuarters] = useState([]);
  const [courseraCin, setCourseraCin] = useState([]);
  const [courseraReviews, setCourseraReviews] = useState({});
  const [courseraCinReviews, setCourseraCinReviews] = useState({});
  const [futurelearn, setFuturelearn] = useState([]);
  const [linkedin, setLinkedin] = useState({ courses: [], totals: { learners: 0, shares: 0, likes: 0 } });
  const [go1, setGo1] = useState({ courses: [], month: null });
  const [go1Catalog, setGo1Catalog] = useState({ courses: [], byLanguage: {} });
  const [go1Lifetime, setGo1Lifetime] = useState({ courses: [], firstMonth: null, lastMonth: null, monthCount: 0 });
  const [conn, setConn] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [view, setView] = useState('overview');
  const [platform, setPlatform] = useState('all');
  const [selected, setSelected] = useState(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [monthly, setMonthly] = useState([]);
  const [engagement, setEngagement] = useState({ totalMinutes: null, activeStudents: null, monthly: [] });
  const [bookmarks, setBookmarks] = useState([]);

  const loadBookmarks = () => fetch('/api/bookmarks').then((r) => r.json()).then((d) => setBookmarks(d.bookmarks || [])).catch(() => {});
  const bookmarkSet = useMemo(() => new Set(bookmarks.map((b) => `${b.platform}:${b.courseKey}`)), [bookmarks]);
  const isBookmarked = (platform, courseKey) => bookmarkSet.has(`${platform}:${courseKey}`);
  const toggleBookmark = (platform, courseKey, title) => {
    const method = isBookmarked(platform, courseKey) ? 'DELETE' : 'POST';
    fetch('/api/bookmarks', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, courseKey, title }) })
      .then(loadBookmarks).catch(() => {});
  };

  const load = () => {
    fetch('/api/courses').then((r) => r.json()).then(setRaw).catch(() => setRaw({ results: [] }));
    fetch('/api/connection').then((r) => r.json()).then(setConn).catch(() => {});
    fetch('/api/last-update').then((r) => r.json()).then((d) => { setLastUpdate(d.updatedAt); setLastRun(d.lastRun || null); }).catch(() => {});
    fetch('/api/freshness').then((r) => r.json()).then(setFreshness).catch(() => {});
    loadBookmarks();
    fetch('/api/coursera/metrics').then((r) => r.json()).then((d) => {
      setCoursera(d.courses || d.results || []);
      setCourseraQuarters(d.revenueQuarters || []);
    }).catch(() => {});
    fetch('/api/coursera-cin/metrics').then((r) => r.json()).then((d) => setCourseraCin(d.courses || d.results || [])).catch(() => {});
    fetch('/api/coursera/reviews').then((r) => r.json()).then((d) => setCourseraReviews(d.bySlug || {})).catch(() => {});
    fetch('/api/coursera-cin/reviews').then((r) => r.json()).then((d) => setCourseraCinReviews(d.bySlug || {})).catch(() => {});
    fetch('/api/revenue/monthly').then((r) => r.json()).then((d) => setMonthly(d.monthly || [])).catch(() => {});
    fetch('/api/futurelearn/courses').then((r) => r.json()).then((d) => setFuturelearn(d.courses || [])).catch(() => {});
    fetch('/api/linkedin/courses').then((r) => r.json()).then((d) => setLinkedin({ courses: d.courses || [], totals: d.totals || { learners: 0, shares: 0, likes: 0 } })).catch(() => {});
    fetch('/api/go1/courses').then((r) => r.json()).then((d) => setGo1({ courses: d.courses || [], month: d.month || null })).catch(() => {});
    fetch('/api/go1/catalog').then((r) => r.json()).then((d) => setGo1Catalog({ courses: d.courses || [], byLanguage: d.byLanguage || {} })).catch(() => {});
    fetch('/api/go1/lifetime').then((r) => r.json()).then((d) => setGo1Lifetime({ courses: d.courses || [], firstMonth: d.firstMonth || null, lastMonth: d.lastMonth || null, monthCount: d.monthCount || 0 })).catch(() => {});
    fetch('/api/engagement').then((r) => r.json()).then(setEngagement).catch(() => {});
  };
  useEffect(load, []);

  const udemy = useMemo(() => (raw?.results || []).filter((c) => c.is_published).map(enrich), [raw]);
  const totalRevenue = raw?.total_revenue ?? null;

  const runFailures = ((lastRun && lastRun.results) || []).filter((r) => r.ok === false);
  const staleList = Object.entries(freshness || {}).filter(([, v]) => v.oldest && v.oldest.ageDays > STALE_DAYS);
  const staleCount = staleList.length;
  if (!raw) return <div className="dcx"><div className="center-note">Loading your dashboard…</div></div>;
  const go = (v) => { setView(v); setSideOpen(false); };

  return (
    <div className={'dcx' + (dark ? ' dark' : '')}>
      <div className="dashboard">
        <aside className={'sidebar' + (sideOpen ? ' open' : '')}>
          <div className="logo"><span className="dot" /> Distribution Dashboard</div>
          <div className="nav-section">
            <div className="nav-label">Main</div>
            {NAV.map(([k, l]) => (
              <div key={k} className={'nav-item' + (view === k ? ' active' : '') + (platform === 'coursera' ? ' p-coursera' : '')} onClick={() => go(k)}>{ICONS[k]}<span>{l}</span></div>
            ))}
          </div>
          <div className="nav-section">
            <div className="nav-label">Tools</div>
            <div className={'nav-item' + (view === 'settings' ? ' active' : '')} onClick={() => go('settings')}>{ICONS.settings}<span>Settings</span></div>
          </div>
          <div className="side-foot">
            {/* "Last updated 3h ago" used to be the NEWEST table anywhere, which is
                how every Udemy figure sat 34 days old under a sidebar calling the
                data fresh. It now names what is fresh and counts what is not. */}
            Last update run {relTime(lastRun?.finishedAt || lastUpdate)}
            {staleCount > 0 && (
              <div className="run-warn" onClick={() => go('settings')} title={staleList.map(([p, v]) => `${PLATFORM_NAMES[p]}: ${v.oldest.ageDays} days`).join('\n')}>
                ⏳ {staleCount} platform{staleCount > 1 ? 's' : ''} with data over {STALE_DAYS} days old
              </div>
            )}
            {runFailures.length > 0 && (
              /* A run where most steps failed used to look identical to a clean
                 one: the guards refused the bad writes, the timestamps stayed
                 old, and the sidebar just said "4h ago". Say it out loud. */
              <div className="run-warn" onClick={() => go('settings')} title={runFailures.map((r) => r.name).join(', ')}>
                ⚠ {runFailures.length} step{runFailures.length > 1 ? 's' : ''} failed in the last update
              </div>
            )}
          </div>
        </aside>

        <main className="main-content">
          <button className="btn btn-secondary menu-btn" style={{ marginBottom: 16 }} onClick={() => setSideOpen((o) => !o)}>☰ Menu</button>
          {view !== 'settings' && <StaleBanner freshness={freshness} platform={platform} />}
          <div className="platform-tabs">
            {[['all', 'All Platforms'], ['udemy', 'Udemy'], ['coursera', 'Coursera'], ['coursera_cin', 'Coursera CIN'], ['futurelearn', 'FutureLearn'], ['linkedin', 'LinkedIn'], ['go1', 'Go1']].map(([k, l]) => (
              <button key={k} className={'ptab' + (platform === k ? ' active' : '') + (k === 'coursera' || k === 'coursera_cin' ? ' p-coursera' : '')} onClick={() => setPlatform(k)}>{l}</button>
            ))}
          </div>
          {view === 'overview' && <Overview udemy={udemy} coursera={coursera} courseraCin={courseraCin} futurelearn={futurelearn} linkedin={linkedin} go1={go1.courses} go1Lifetime={go1Lifetime} go1Catalog={go1Catalog} totalRevenue={totalRevenue} platform={platform} monthly={monthly} engagement={engagement} />}
          {view === 'watchlist' && <Watchlist bookmarks={bookmarks} udemy={udemy} coursera={coursera} courseraCin={courseraCin} futurelearn={futurelearn} linkedin={linkedin.courses} go1={go1Lifetime.courses.length ? go1Lifetime.courses : go1.courses} platform={platform} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} onOpen={setSelected} />}
          {view === 'courses' && (
            /* key by platform — both tabs render CourseraView, and without a
               distinct key React reuses the instance and carries the search
               term and sort over to the other catalog. */
            platform === 'coursera' ? <CourseraView key="coursera" rows={coursera} quarters={courseraQuarters} reviewsBySlug={courseraReviews} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
            : platform === 'coursera_cin' ? <CourseraView key="coursera_cin" rows={courseraCin} label="Coursera CIN" showInstructorCheck={false} reviewsBySlug={courseraCinReviews} platform="coursera_cin" isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
            : platform === 'futurelearn' ? <FutureLearnView rows={futurelearn} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
            : platform === 'linkedin' ? <LinkedInView data={linkedin} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
            : platform === 'go1' ? <Go1View rows={go1.courses} month={go1.month} lifetime={go1Lifetime} catalog={go1Catalog} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
            : <Courses udemy={udemy} totalRevenue={totalRevenue} onOpen={setSelected} onRefresh={load} isBookmarked={isBookmarked} toggleBookmark={toggleBookmark} />
          )}
          {view === 'earnings' && (platform === 'coursera'
            ? <CourseraEarnings rows={coursera} label="Coursera" />
            : platform === 'coursera_cin'
            ? <CourseraEarnings rows={courseraCin} label="Coursera CIN" />
            : platform === 'futurelearn'
            ? <PlatformUnavailable platform={platform} title="Earnings" note="FutureLearn doesn't expose partner revenue — earnings tracking is Udemy-only." />
            : platform === 'go1'
            ? <PlatformUnavailable platform={platform} title="Earnings" note="Your Go1 account doesn't have revenue reporting available yet — earnings tracking is Udemy-only." />
            : platform === 'linkedin'
            ? <PlatformUnavailable platform={platform} title="Earnings" note="The LinkedIn Learning instructor portal exposes no revenue at all — only learners, shares and likes." />
            : <Earnings udemy={udemy} totalRevenue={totalRevenue} monthly={monthly} platform={platform} coursera={coursera} />)}
          {view === 'minutes' && (platform === 'coursera' || platform === 'coursera_cin' || platform === 'futurelearn' || platform === 'linkedin' || platform === 'go1'
            ? <PlatformUnavailable platform={platform} title="Minutes" note="Minutes-consumed tracking is a Udemy feature — this platform's courses aren't covered here." />
            : <MinutesReport udemy={udemy} />)}
          {view === 'captions' && (platform === 'coursera' || platform === 'coursera_cin' || platform === 'futurelearn' || platform === 'linkedin' || platform === 'go1'
            ? <PlatformUnavailable platform={platform} title="Captions" note="Caption localization is a Udemy feature — this platform's courses aren't covered here." />
            : <Captions udemy={udemy} onRefresh={load} />)}
          {view === 'coupons' && (platform === 'coursera' || platform === 'coursera_cin' || platform === 'futurelearn' || platform === 'linkedin' || platform === 'go1'
            ? <PlatformUnavailable platform={platform} title="Coupons" note="Coupon tracking is a Udemy feature — this platform doesn't have promotional codes tracked here." />
            : <Coupons udemy={udemy} />)}
          {view === 'settings' && <Settings conn={conn} dark={dark} setDark={setDark} lastUpdate={lastUpdate} lastRun={lastRun} onRefresh={load} />}
        </main>
      </div>
      {selected && <CourseDetail course={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ---------------- Overview ----------------
const coursraPct = (c) => { const v = c.completionRate; return v == null ? null : (v <= 1 ? v * 100 : v); };

function Overview({ udemy, coursera, courseraCin, futurelearn, linkedin, go1, go1Lifetime, go1Catalog = { courses: [] }, totalRevenue, platform, monthly, engagement }) {
  const isUdemy = platform === 'udemy';
  const isCoursera = platform === 'coursera';
  const isCourseraCin = platform === 'coursera_cin';
  const isFutureLearn = platform === 'futurelearn';
  const isLinkedIn = platform === 'linkedin';
  const isGo1 = platform === 'go1';
  const isAll = platform === 'all';

  const courStats = { count: coursera.length, enroll: coursera.reduce((s, c) => s + (c.enrollments || 0), 0) };
  // Coursera CIN is a separate partner account under the same login — kept out
  // of "All Platforms" totals entirely (it isn't part of Starweaver's own
  // teaching portfolio), only shown when its own tab is selected.
  // LIVE CIN COURSES EXCLUDE DRAFTS — the test the catalogue feed already uses.
  // Counting every row put 5 unlaunched drafts into the total (325 vs 320).
  const cinLive = courseraCin.filter((c) => String(c.status || '').toLowerCase() !== 'draft');
  const courCinStats = { count: cinLive.length, drafts: courseraCin.length - cinLive.length, enroll: cinLive.reduce((s, c) => s + (c.enrollments || 0), 0) };
  // LIVE means in progress AND public — the same test the catalogue feed uses.
  // futurelearn.length counted drafts, finished runs and private runs too (204
  // against 146 live on 2026-09-24).
  const flLive = futurelearn.filter((c) => c.status === 'In progress' && (c.visibility == null || c.visibility === 'Public'));
  const flStats = {
    count: flLive.length,
    known: flLive.filter((c) => c.enrollment != null).length,   // of the live ones, so "known N/M" compares like with like
    enroll: futurelearn.reduce((s, c) => s + (c.enrollment || 0), 0),
    live: futurelearn.filter((c) => c.status === 'In progress').length,
  };
  // Lifetime = every month Go1 has data for, summed per course (Go1 itself only ever
  // returns one month at a time — see scrapeGo1History.js). "month"/"monthEnroll" keep
  // the current-month figure around as a secondary reference point.
  const go1Stats = {
    // Courses ON Go1, from its catalogue — not the courses with learners, which
    // is what the activity tables hold (145 against 182 live on 2026-09-24).
    count: go1Catalog.courses.length || go1Lifetime.courses.length || go1.length,
    enroll: go1Lifetime.courses.reduce((s, c) => s + (c.enrolments || 0), 0),
    month: go1[0]?.month ?? null,
    monthEnroll: go1.reduce((s, c) => s + (c.enrolments || 0), 0),
    firstMonth: go1Lifetime.firstMonth, monthCount: go1Lifetime.monthCount,
  };
  const uEnroll = udemy.reduce((s, c) => s + (c.num_subscribers || 0), 0);
  const reviews = udemy.reduce((s, c) => s + (c.num_reviews || 0), 0);
  const rated = udemy.filter((c) => c.rating);
  const cRated = coursera.filter((c) => c.rating);
  const cCinRated = courseraCin.filter((c) => c.rating);
  const uAvg = rated.length ? rated.reduce((s, c) => s + Number(c.rating) * (c.num_reviews || 1), 0) / rated.reduce((s, c) => s + (c.num_reviews || 1), 0) : 0;
  const cAvg = cRated.length ? cRated.reduce((s, c) => s + Number(c.rating), 0) / cRated.length : 0;
  const cCinAvg = cCinRated.length ? cCinRated.reduce((s, c) => s + Number(c.rating), 0) / cCinRated.length : 0;
  // Go1 DOES rate courses — the catalogue carries a five-star rating and how many
  // ratings it rests on. Weighted by that count, as Udemy's is, so a course with
  // one 5-star rating cannot outweigh one with a hundred at 4.2.
  const go1Rated = (go1Catalog.courses || []).filter((c) => c.rating && c.ratingsCount);
  const go1RatingCount = go1Rated.reduce((s, c) => s + c.ratingsCount, 0);
  const go1Avg = go1RatingCount ? go1Rated.reduce((s, c) => s + c.rating * c.ratingsCount, 0) / go1RatingCount : 0;
  // LinkedIn Learning: the portal reports learners, shares and likes and
  // nothing else — no ratings, no revenue, no minutes.
  const liRows = (linkedin && linkedin.courses) || [];
  const liTotals = (linkedin && linkedin.totals) || { learners: 0, shares: 0, likes: 0 };
  const liStats = { count: liRows.length, enroll: liTotals.learners || 0 };
  const courses = isUdemy ? udemy.length : isCoursera ? courStats.count : isCourseraCin ? courCinStats.count : isFutureLearn ? flStats.count : isLinkedIn ? liStats.count : isGo1 ? go1Stats.count
    // Every platform. LinkedIn (added 2026-09-15) and Coursera CIN were never
    // added to this sum, so "Total Courses" left out 375 of 1,026.
    : udemy.length + courStats.count + courCinStats.count + flStats.count + liStats.count + go1Stats.count;
  const enroll = isUdemy ? uEnroll : isCoursera ? courStats.enroll : isCourseraCin ? courCinStats.enroll : isFutureLearn ? flStats.enroll : isLinkedIn ? liStats.enroll : isGo1 ? go1Stats.enroll
    : uEnroll + courStats.enroll + courCinStats.enroll + flStats.enroll + liStats.enroll + go1Stats.enroll;
  const withPaul = udemy.filter((c) => c.hasPaul).length;
  const finGap = udemy.filter((c) => c.isFinance && !c.hasGlobecon).length;
  const ubCount = udemy.filter((c) => c.is_udemy_business).length;
  const minutesWatched = engagement.totalMinutes != null ? Math.round(engagement.totalMinutes) : null;

  const ratingValue = isCoursera ? cAvg : isCourseraCin ? cCinAvg : isGo1 ? (go1Avg || null) : (isFutureLearn || isLinkedIn) ? null : uAvg;
  const ratingTrend = isCoursera ? `across ${cRated.length} rated courses` : isCourseraCin ? `across ${cCinRated.length} rated courses`
    : isFutureLearn ? 'not offered by FutureLearn' : isGo1 ? (go1Rated.length ? `across ${go1Rated.length} rated courses · ${num(go1RatingCount)} ratings` : 'no ratings yet')
    : isLinkedIn ? 'not exposed by the instructor portal'
    : isAll ? `Udemy only — based on ${num(reviews)} reviews` : `based on ${num(reviews)} reviews`;
  // Real per-course revenue, manually imported from partner revenue reports
  // (Coursera exposes none via any API) — covers only the courses present in
  // whatever report was last imported, not the full catalog.
  const courseraRevenueTotal = coursera.reduce((s, c) => s + (c.revenue || 0), 0);
  const courseraRevenueCount = coursera.filter((c) => c.revenue != null).length;
  const courseraCinRevenueTotal = courseraCin.reduce((s, c) => s + (c.revenue || 0), 0);
  const courseraCinRevenueCount = cinLive.filter((c) => c.revenue != null).length;
  const revenueValue = isCoursera ? (courseraRevenueCount ? usd(courseraRevenueTotal) : '—')
    : isCourseraCin ? (courseraCinRevenueCount ? usd(courseraCinRevenueTotal) : '—')
    : (isFutureLearn || isGo1 || isLinkedIn) ? '—'
    : isAll ? ((totalRevenue == null && !courseraRevenueCount) ? '—' : usd((totalRevenue || 0) + courseraRevenueTotal))
    : (totalRevenue == null ? '—' : usd(totalRevenue));
  const revenueTrend = isCoursera ? (courseraRevenueCount ? `from manually imported report — ${courseraRevenueCount}/${coursera.length} courses` : 'not tracked for Coursera')
    : isCourseraCin ? (courseraCinRevenueCount ? `from manually imported report — ${courseraCinRevenueCount}/${cinLive.length} courses` : 'not tracked for Coursera CIN')
    : isFutureLearn ? 'not exposed to partners' : isGo1 ? 'not yet available'
    : isLinkedIn ? 'no revenue in the instructor portal'
    : isAll ? `Udemy + Coursera (${courseraRevenueCount}/${coursera.length} courses) — FutureLearn/Go1 not tracked`
    : 'Udemy earnings';

  let charts;
  if (isLinkedIn) {
    const top = [...liRows].sort((a, b) => (b.learners || 0) - (a.learners || 0)).slice(0, 8)
      .map((c) => ({ label: c.title, value: c.learners || 0, color: '#0a66c2' }));
    const byLang = {};
    liRows.forEach((c) => { byLang[c.language || 'Unknown'] = (byLang[c.language || 'Unknown'] || 0) + 1; });
    const langDonut = Object.entries(byLang).map(([label, value], i) =>
      ({ label, value, color: ['#0a66c2', '#0c9bae', '#ea7112', '#002fa7', '#9ca3af'][i % 5] }));
    charts = (
      <div className="chart-grid">
        <div className="chart-card"><div className="section-title">Top courses by learners</div>
          {top.length ? <BarChart data={top} /> : <ChartPlaceholder />}</div>
        <div className="chart-card"><div className="section-title">Courses by language</div>
          {langDonut.length ? <Donut data={langDonut} /> : <ChartPlaceholder />}</div>
      </div>
    );
  } else if (isFutureLearn) {
    const statusCounts = {};
    futurelearn.forEach((c) => { statusCounts[c.status || 'Unknown'] = (statusCounts[c.status || 'Unknown'] || 0) + 1; });
    const statusDonut = Object.entries(statusCounts).map(([label, value]) => ({ label, value, color: label === 'In progress' ? '#0c9bae' : label === 'Draft' ? '#ea7112' : '#002fa7' }));
    const byEnroll = [...futurelearn].filter((c) => c.enrollment > 0).sort((a, b) => b.enrollment - a.enrollment).slice(0, 8)
      .map((c) => ({ label: c.title, value: c.enrollment, color: '#002fa7' }));
    charts = (
      <div className="charts-section">
        <h2 className="section-title">📊 FutureLearn Portfolio</h2>
        <div className="charts-grid">
          <div className="chart-card"><h3>Top Courses by Enrollment (known)</h3>{byEnroll.length ? <BarChart data={byEnroll} /> : <div className="chart-placeholder">No enrollment data yet</div>}</div>
          <div className="chart-card"><h3>Run Status</h3>{statusDonut.length ? <Donut data={statusDonut} /> : <div className="chart-placeholder">No data</div>}</div>
        </div>
      </div>
    );
  } else if (isGo1) {
    const byEnroll = [...go1Lifetime.courses].filter((c) => c.enrolments > 0).sort((a, b) => b.enrolments - a.enrolments).slice(0, 8)
      .map((c) => ({ label: c.name, value: c.enrolments, color: '#0c9bae' }));
    const byMonth = [...go1].filter((c) => c.enrolments > 0).sort((a, b) => b.enrolments - a.enrolments).slice(0, 8)
      .map((c) => ({ label: c.name, value: c.enrolments, color: '#ea7112' }));
    charts = (
      <div className="charts-section">
        <h2 className="section-title">📊 Go1 Content Studio — lifetime{go1Stats.firstMonth ? ` (since ${go1Stats.firstMonth})` : ''}</h2>
        <div className="charts-grid">
          <div className="chart-card"><h3>Top Courses by Enrolments (lifetime)</h3>{byEnroll.length ? <BarChart data={byEnroll} /> : <div className="chart-placeholder">No course-level data yet — see the Go1 tab under Courses for status.</div>}</div>
          <div className="chart-card"><h3>Top Courses by Enrolments ({go1Stats.month || 'this month'})</h3>{byMonth.length ? <BarChart data={byMonth} /> : <div className="chart-placeholder">No data</div>}</div>
        </div>
      </div>
    );
  } else if (isCoursera) {
    const byCourse = [...coursera].filter((c) => c.enrollments > 0).sort((a, b) => b.enrollments - a.enrollments).slice(0, 8)
      .map((c) => ({ label: c.name, value: c.enrollments, color: '#0066cc' }));
    const domEnr = {};
    coursera.forEach((c) => { if (c.enrollments > 0) domEnr[c.domain || 'Other'] = (domEnr[c.domain || 'Other'] || 0) + c.enrollments; });
    const donut = Object.entries(domEnr).map(([label, value]) => ({ label, value, color: DOMAIN_COLOR[label] || '#9ca3af' })).sort((a, b) => b.value - a.value).slice(0, 8);
    const buckets = [['< 3.5', 0, 3.5], ['3.5–4', 3.5, 4], ['4–4.5', 4, 4.5], ['4.5–5', 4.5, 5.01]]
      .map(([label, lo, hi]) => ({ label, value: cRated.filter((c) => Number(c.rating) >= lo && Number(c.rating) < hi).length }));
    const compBuckets = [['0–50%', 0, 50], ['50–70%', 50, 70], ['70–85%', 70, 85], ['85–100%', 85, 101]]
      .map(([label, lo, hi]) => { const p = coursraPct; return { label, value: coursera.filter((c) => { const v = p(c); return v != null && v >= lo && v < hi; }).length }; });
    charts = (
      <>
        <div className="charts-section">
          <h2 className="section-title">📊 Enrollment &amp; Completion</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Enrollments by Course (top 8)</h3>{byCourse.length ? <BarChart data={byCourse} /> : <div className="chart-placeholder">No data</div>}</div>
            <div className="chart-card"><h3>Enrollments by Domain</h3>{donut.length ? <Donut data={donut} /> : <div className="chart-placeholder">No data</div>}</div>
          </div>
        </div>
        <div className="charts-section">
          <h2 className="section-title">🎯 Portfolio Quality</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Rating Distribution</h3><Histogram data={buckets} color="#0066cc" /></div>
            <div className="chart-card"><h3>Completion Rate Distribution</h3><Histogram data={compBuckets} color="#0066cc" /></div>
          </div>
        </div>
      </>
    );
  } else if (isCourseraCin) {
    const byCourse = [...courseraCin].filter((c) => c.enrollments > 0).sort((a, b) => b.enrollments - a.enrollments).slice(0, 8)
      .map((c) => ({ label: c.name, value: c.enrollments, color: '#0066cc' }));
    const domEnr = {};
    courseraCin.forEach((c) => { if (c.enrollments > 0) domEnr[c.domain || 'Other'] = (domEnr[c.domain || 'Other'] || 0) + c.enrollments; });
    const donut = Object.entries(domEnr).map(([label, value]) => ({ label, value, color: DOMAIN_COLOR[label] || '#9ca3af' })).sort((a, b) => b.value - a.value).slice(0, 8);
    const buckets = [['< 3.5', 0, 3.5], ['3.5–4', 3.5, 4], ['4–4.5', 4, 4.5], ['4.5–5', 4.5, 5.01]]
      .map(([label, lo, hi]) => ({ label, value: cCinRated.filter((c) => Number(c.rating) >= lo && Number(c.rating) < hi).length }));
    const compBuckets = [['0–50%', 0, 50], ['50–70%', 50, 70], ['70–85%', 70, 85], ['85–100%', 85, 101]]
      .map(([label, lo, hi]) => { const p = coursraPct; return { label, value: courseraCin.filter((c) => { const v = p(c); return v != null && v >= lo && v < hi; }).length }; });
    charts = (
      <>
        <div className="charts-section">
          <h2 className="section-title">📊 Enrollment &amp; Completion (Coursera CIN)</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Enrollments by Course (top 8)</h3>{byCourse.length ? <BarChart data={byCourse} /> : <div className="chart-placeholder">No data</div>}</div>
            <div className="chart-card"><h3>Enrollments by Domain</h3>{donut.length ? <Donut data={donut} /> : <div className="chart-placeholder">No data</div>}</div>
          </div>
        </div>
        <div className="charts-section">
          <h2 className="section-title">🎯 Portfolio Quality</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Rating Distribution</h3><Histogram data={buckets} color="#0066cc" /></div>
            <div className="chart-card"><h3>Completion Rate Distribution</h3><Histogram data={compBuckets} color="#0066cc" /></div>
          </div>
        </div>
      </>
    );
  } else {
    // Udemy-only, or All — revenue only exists for Udemy either way.
    const byCourse = udemy.filter((c) => c.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 8).map((c) => ({ label: c.title, value: c.revenue, color: '#002fa7' }));
    const domRev = {};
    udemy.forEach((c) => { if (c.revenue > 0) domRev[c.domain] = (domRev[c.domain] || 0) + c.revenue; });
    const donut = Object.entries(domRev).map(([label, value]) => ({ label, value, color: DOMAIN_COLOR[label] || '#9ca3af' })).sort((a, b) => b.value - a.value).slice(0, 8);

    // "All" merges both platforms' ratings into one distribution; Udemy-only stays Udemy-only.
    const ratedPool = isAll ? [...rated.map((c) => Number(c.rating)), ...cRated.map((c) => Number(c.rating))] : rated.map((c) => Number(c.rating));
    const buckets = [['< 3.0', 0, 3], ['3–3.5', 3, 3.5], ['3.5–4', 3.5, 4], ['4–4.5', 4, 4.5], ['4.5–5', 4.5, 5.01]]
      .map(([label, lo, hi]) => ({ label, value: ratedPool.filter((r) => r >= lo && r < hi).length }));

    const revSeries = monthlySeries(monthly);
    const engSeries = monthlySeries((engagement.monthly || []).map((m) => ({ month: m.month, amount: Math.round(m.minutesTaught || 0) })));
    const byMinutes = udemy.filter((c) => c.minutes_taught > 0).sort((a, b) => b.minutes_taught - a.minutes_taught).slice(0, 8)
      .map((c) => ({ label: c.title, value: Math.round(c.minutes_taught), color: '#0c9bae' }));
    const ubSeries = monthlySeries((engagement.ubMonthly || []).map((m) => ({ month: m.month, amount: Math.round(m.ubMinutes || 0) })));
    const ubByMinutes = udemy.filter((c) => c.is_udemy_business && c.minutes_taught > 0).sort((a, b) => b.minutes_taught - a.minutes_taught).slice(0, 8)
      .map((c) => ({ label: c.title, value: Math.round(c.minutes_taught), color: '#ea7112' }));

    // "All" also gets a cross-platform enrollment chart since revenue can't merge (Coursera has none).
    // Go1 is excluded — its numbers are a monthly snapshot, not comparable to lifetime totals.
    const combinedEnroll = isAll
      ? [...udemy.map((c) => ({ label: c.title, value: c.num_subscribers || 0, color: '#002fa7' })),
         ...coursera.map((c) => ({ label: c.name, value: c.enrollments || 0, color: '#0066cc' })),
         ...futurelearn.map((c) => ({ label: c.title, value: c.enrollment || 0, color: '#ea7112' }))]
          .sort((a, b) => b.value - a.value).slice(0, 8)
      : null;

    charts = (
      <>
        <div className="charts-section">
          <h2 className="section-title">📊 Revenue &amp; Growth{isAll ? ' (Udemy)' : ''}</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Revenue by Course (top 8)</h3>{byCourse.length ? <BarChart data={byCourse} money /> : <div className="chart-placeholder">No revenue data</div>}</div>
            <div className="chart-card"><h3>Revenue by Domain</h3>{donut.length ? <Donut data={donut} money /> : <div className="chart-placeholder">No revenue data</div>}</div>
          </div>
        </div>
        {combinedEnroll && (
          <div className="charts-section">
            <h2 className="section-title">👥 Enrollments Across Platforms</h2>
            <div className="charts-grid">
              <div className="chart-card" style={{ gridColumn: '1 / -1' }}><h3>Top Courses by Enrollment (Udemy + Coursera + FutureLearn)</h3><BarChart data={combinedEnroll} /></div>
            </div>
          </div>
        )}
        <div className="charts-section">
          <h2 className="section-title">🎧 Engagement{isAll ? ' (Udemy)' : ''}</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Minutes Watched Over Time (last 12mo)</h3>{engSeries.length ? <LineChart data={engSeries} /> : <ChartPlaceholder>No engagement history yet</ChartPlaceholder>}</div>
            <div className="chart-card"><h3>Top Courses by Minutes Watched</h3>{byMinutes.length ? <BarChart data={byMinutes} /> : <div className="chart-placeholder">No engagement data</div>}</div>
          </div>
        </div>
        <div className="charts-section">
          <h2 className="section-title">🏢 Udemy Business Engagement{isAll ? ' (Udemy)' : ''}</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>UB Minutes Watched Over Time (last 12mo)</h3>{ubSeries.length ? <LineChart data={ubSeries} color="#ea7112" /> : <ChartPlaceholder>No UB engagement history yet</ChartPlaceholder>}</div>
            <div className="chart-card"><h3>Top UB Courses by Minutes Watched</h3>{ubByMinutes.length ? <BarChart data={ubByMinutes} /> : <div className="chart-placeholder">No UB engagement data</div>}</div>
          </div>
        </div>
        <div className="charts-section">
          <h2 className="section-title">🎯 Portfolio Quality{isAll ? ' (Udemy + Coursera)' : ''}</h2>
          <div className="charts-grid">
            <div className="chart-card"><h3>Rating Distribution</h3><Histogram data={buckets} /></div>
            <div className="chart-card"><h3>Revenue Over Time (last 24mo, Udemy)</h3>{revSeries.length ? <LineChart data={revSeries} money /> : <ChartPlaceholder>No revenue history yet</ChartPlaceholder>}</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header crumb="OVERVIEW" title="Dashboard" sub={
        isUdemy ? 'Your Udemy portfolio' : isCoursera ? 'Your Coursera portfolio' : isCourseraCin ? 'Coursera CIN partner portfolio' : isFutureLearn ? 'Your FutureLearn portfolio'
        : isGo1 ? 'Your Go1 portfolio' : 'Your teaching portfolio at a glance'
      } actions={isUdemy || isAll ? <button className="btn btn-primary" onClick={() => exportCsv(udemy)}>↓ Export CSV</button> : undefined} />
      <div className="kpi-grid">
        <Kpi icon="📚" bg="rgba(0,47,167,.09)" fg="#002fa7" label="Total Courses" value={num(courses)}
          trend={isAll ? `${udemy.length} Udemy · ${courStats.count} Coursera · ${courCinStats.count} CIN · ${flStats.count} FutureLearn · ${liStats.count} LinkedIn · ${go1Stats.count} Go1`
            // LinkedIn used to fall through to 'Go1' here.
            : isUdemy ? 'Udemy' : isCoursera ? 'Coursera' : isCourseraCin ? `Coursera CIN${courCinStats.drafts ? ` · ${courCinStats.drafts} drafts not counted` : ''}` : isFutureLearn ? 'FutureLearn' : isLinkedIn ? 'LinkedIn Learning' : 'Go1'} />
        <Kpi icon="👥" bg="#cce5ff" fg="#0066cc" label="Total Enrollments" value={num(enroll)}
          trend={isAll ? 'all six platforms, lifetime — LinkedIn counts learners' : isFutureLearn ? `known — ${flStats.known}/${flStats.count} courses` : isGo1 ? `lifetime${go1Stats.firstMonth ? ` (since ${go1Stats.firstMonth})` : ''}` : 'across the portfolio'} />
        <Kpi icon="💵" bg="#dcfce7" fg="#10b981" label="Lifetime Revenue" value={revenueValue} trend={revenueTrend} />
        <Kpi icon="⭐" bg="#fef3c7" fg="#f59e0b" label="Average Rating" value={ratingValue ? ratingValue.toFixed(2) : '—'} trend={ratingTrend} />
        {(isUdemy || isAll) && (
          <>
            <Kpi icon="🎧" bg="rgba(12,155,174,.12)" fg="#0c9bae" label="Minutes Watched" value={minutesWatched != null ? num(minutesWatched) : '—'}
              trend={engagement.activeStudents != null ? `${num(engagement.activeStudents)} active students` : 'Udemy'} />
            <Kpi icon="🏢" bg="rgba(234,113,18,.15)" fg="#ea7112" label="Udemy Business" value={num(ubCount)} trend={`${ubCount}/${udemy.length} courses`} />
          </>
        )}
      </div>
      {(isUdemy || isAll) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 30 }}>
          <span className="pill ok">Paul on {withPaul}/{udemy.length} courses</span>
          <span className={'pill ' + (finGap ? 'draft' : 'ok')}>Finance ∖ Globecon: {finGap}</span>
          <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>{udemy.filter((c) => capNames(c.caption_locales).length > 1).length} courses with 2+ caption languages</span>
        </div>
      )}

      {charts}
    </>
  );
}

// ONE FILTER PER TABLE. Held here rather than inside FilterBuilder so the
// table can read the spec while the menu is shut — closing the panel must not
// drop the filter, and a filter you cannot see is the reason the active
// conditions are always printed above the rows.
function useColumnFilter(platformKey) {
  const fields = FILTER_FIELDS[platformKey];
  const [conditions, setConditions] = useState([]);
  const [combinator, setCombinator] = useState('AND');
  const spec = useMemo(() => specOf(conditions, combinator, fields), [conditions, combinator, fields]);
  return { fields, conditions, setConditions, combinator, setCombinator, spec };
}
// What is being hidden, in words, with one click to undo it. A table quietly
// showing 40 of 320 rows is how somebody reads a filtered total as the truth.
function ActiveFilter({ f, shown, total }) {
  if (!f.spec) return null;
  return (
    <div className="table-header" style={{ paddingTop: 0, gap: 8 }}>
      <span className="pill filter-chip">
        ⛃ {describe(f.conditions, f.combinator, f.fields)}
        <span onClick={() => f.setConditions([])} className="filter-chip-x" title="Clear the filter">✕</span>
      </span>
      <span className="muted">{shown} of {total} rows</span>
    </div>
  );
}
const PLATFORM_LABELS = { coursera: 'Coursera', coursera_cin: 'Coursera CIN', futurelearn: 'FutureLearn', go1: 'Go1' };
function PlatformUnavailable({ title, note, platform }) {
  return (
    <>
      <Header crumb={title.toUpperCase()} title={title} sub={`Not available for ${PLATFORM_LABELS[platform] || platform}`} />
      <div className="chart-card" style={{ maxWidth: 520 }}>
        <p className="muted" style={{ margin: 0 }}>{note}</p>
      </div>
    </>
  );
}

// ---------------- Courses (Udemy, full 12-column parity) ----------------
const COLS = [
  ['title', 'Course', 'str'], ['domain', 'Domain', 'str'], ['num_reviews', 'Total Ratings', 'num'],
  ['num_subscribers', 'Enrollments', 'num'], ['above2k', 'Enroll > 2k', 'str'], ['rating', 'Avg Rating', 'num'],
  ['revenue', 'Revenue', 'num'], ['minutes_taught', 'Minutes Watched', 'num'], ['caption_locales', 'Captions', 'none'], ['coupons', 'Coupons', 'num'],
  ['is_udemy_business', 'Udemy Business', 'none'], ['hasPaul', 'Paul', 'none'], ['hasGlobecon', 'Globecon', 'none'], ['sme', 'SME', 'none'],
];
// One render function per COLS entry, same order — lets the column picker
// show/hide a <td> without duplicating the cell markup elsewhere.
const CELL_RENDERERS = [
  (c, key) => <td key={key} style={{ fontWeight: 500, minWidth: 200 }}>{c.title}</td>,
  (c, key) => <td key={key}><span className="platform-badge" style={{ background: (DOMAIN_COLOR[c.domain] || '#9ca3af') + '22', color: DOMAIN_COLOR[c.domain] || '#6b7280' }}>{c.domain}</span></td>,
  (c, key) => <td key={key} style={{ textAlign: 'right' }}>{num(c.num_reviews) === '—' ? 0 : num(c.num_reviews)}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'right' }}>{c.num_subscribers != null ? num(c.num_subscribers) : <span className="muted">—</span>}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'center' }}>{c.above2k === 'Yes' ? <span className="pill ok">Yes</span> : c.above2k === 'No' ? <span className="pill draft">No</span> : <span className="muted">N/A</span>}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'right' }}>{c.rating ? <span className="rating-stars">★ {Number(c.rating).toFixed(2)}</span> : '—'}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'right', fontWeight: 600, color: c.revenue ? '#10b981' : '#9ca3af' }}>{c.revenue ? usd(c.revenue) : '—'}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'right' }}>{c.minutes_taught ? num(Math.round(c.minutes_taught)) : <span className="muted">—</span>}</td>,
  (c, key) => <td key={key} className="muted" style={{ fontSize: 13 }} title={capNames(c.caption_locales).join(', ')}>{capNames(c.caption_locales).slice(0, 3).join(', ') || '—'}{capNames(c.caption_locales).length > 3 ? ` +${capNames(c.caption_locales).length - 3}` : ''}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'right' }}>{couponFraction(c)}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'center' }}>{c.is_udemy_business ? <span title="Udemy Business" style={{ color: '#ea7112' }}>✓</span> : <span className="muted">—</span>}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'center' }}>{c.hasPaul ? <span title="Active" style={{ color: '#10b981' }}>✓</span> : <span title="Not on course" style={{ color: '#f59e0b' }}>✗</span>}</td>,
  (c, key) => <td key={key} style={{ textAlign: 'center' }}>{c.isFinance ? (c.hasGlobecon ? <span style={{ color: '#10b981' }}>✓</span> : <span title="Missing" style={{ color: '#ef4444' }}>✗</span>) : <span className="muted">—</span>}</td>,
  (c, key) => <td key={key} className="muted" style={{ fontSize: 13, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(c.sme || []).join(', ')}>{(c.sme || []).join(', ') || '—'}</td>,
];
const COLS_STORAGE_KEY = 'dcx-courses-visible-cols';
function loadVisibleCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY));
    if (Array.isArray(saved) && saved.length) return new Set(saved);
  } catch { /* ignore malformed/missing storage */ }
  return new Set(COLS.map(([key]) => key));
}
function ColumnPicker({ visible, setVisible }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);
  const toggle = (key) => setVisible((prev) => {
    const next = new Set(prev);
    if (next.has(key)) { if (next.size > 1) next.delete(key); } else next.add(key);
    localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...next]));
    return next;
  });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-secondary" onClick={() => setOpen((o) => !o)}>☰ Columns</button>
      {open && (
        <div className="col-picker-menu">
          {COLS.map(([key, label]) => (
            <label key={key} className="col-picker-item">
              <input type="checkbox" checked={visible.has(key)} disabled={key === 'title'} onChange={() => toggle(key)} />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
// "N active · M left" — "left" is Udemy's rolling monthly creation allowance
// (remaining_coupon_count: resets monthly, not a fixed lifetime cap).
function couponFraction(c) {
  const gone = (c.coupons_used_up || []).length;
  if (!Array.isArray(c.coupons) && !gone) return <span className="muted">—</span>;
  const active = (c.coupons || []).length;
  // A course whose only coupon ran out used to read "—", as if it never had one.
  const usedUp = gone ? <span style={{ color: '#dc2626' }} title={`Used up: ${c.coupons_used_up.map((x) => x.code).join(', ')}`}> · {gone} used up</span> : null;
  if (c.remaining_coupon_count == null) return <>{active || '0'}{usedUp}</>;
  return <span title="Left = more coupons Udemy will let you create this month on this course">{active} active · {c.remaining_coupon_count} left{usedUp}</span>;
}
function Courses({ udemy, totalRevenue, onOpen, onRefresh, isBookmarked, toggleBookmark }) {
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('All');
  const [sort, setSort] = useState({ key: 'num_reviews', dir: -1 });
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols);
  const f = useColumnFilter('udemy');
  const domains = useMemo(() => ['All', ...[...new Set(udemy.map((c) => c.domain))].sort()], [udemy]);
  const searchSpec = useMemo(() => parseSmartQuery(q), [q]);
  const clearSearch = () => setQ('');
  const shownCols = useMemo(() => COLS.filter(([key]) => visibleCols.has(key)), [visibleCols]);
  const shownRenderers = useMemo(() => COLS.map((col, i) => [col[0], CELL_RENDERERS[i]]).filter(([key]) => visibleCols.has(key)), [visibleCols]);

  const rows = useMemo(() => {
    let r = udemy;
    if (domain !== 'All') r = r.filter((c) => c.domain === domain);
    r = applyFilter(r, searchSpec);
    r = applyFilter(r, f.spec, f.fields);
    const col = COLS.find((c) => c[0] === sort.key);
    return [...r].sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (col?.[2] === 'str') return sort.dir * String(av || '').localeCompare(String(bv || ''));
      if (Array.isArray(av)) av = av.length; if (Array.isArray(bv)) bv = bv.length;
      return sort.dir * ((Number(av) || 0) - (Number(bv) || 0));
    });
  }, [udemy, searchSpec, domain, sort, f.spec, f.fields]);
  const th = ([key, label, type]) => (
    <th key={key} className={type === 'none' ? 'no-sort' : ''} onClick={() => type !== 'none' && setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>
      {label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
    </th>
  );
  return (
    <>
      <Header crumb="COURSES · UDEMY" title="Courses" sub="All Udemy courses — search, filter, sort, export"
        actions={<>
          <button className="btn btn-secondary" onClick={onRefresh}>↻ Refresh</button>
          <button className="btn btn-secondary" onClick={() => exportCsv(rows)}>⬇ Export CSV</button>
          <CreateCoupons courses={udemy} onDone={onRefresh} />
          <LocalizeCaptions courses={udemy} onDone={onRefresh} />
        </>} />
      <div className="table-card">
        <div className="table-header">
          <input
            className="table-search"
            placeholder="Search, or try 'rating below 4.3' or 'no coupons'"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') clearSearch(); }}
          />
          <select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ width: 'auto', minWidth: 180 }}>{domains.map((d) => <option key={d}>{d}</option>)}</select>
          <FilterBuilder {...f} rows={udemy} />
          <ColumnPicker visible={visibleCols} setVisible={setVisibleCols} />
          <span className="muted">{rows.length} shown</span>
        </div>
        <ActiveFilter f={f} shown={rows.length} total={udemy.length} />
        {searchSpec?.conditions.some((c) => c.field !== 'title') && (
          <div className="table-header" style={{ paddingTop: 0, gap: 8 }}>
            <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5' }}>
              ✨ {searchSpec.explanation} <span onClick={clearSearch} style={{ cursor: 'pointer', marginLeft: 6, fontWeight: 700 }}>✕</span>
            </span>
          </div>
        )}
        <div className="table-scroll">
          <table className="wide-table">
            <thead><tr><th className="no-sort"></th>{shownCols.map(th)}</tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => onOpen(c)}>
                  <td onClick={(e) => e.stopPropagation()}><BookmarkButton active={isBookmarked('udemy', c.id)} onClick={() => toggleBookmark('udemy', c.id, c.title)} /></td>
                  {shownRenderers.map(([key, render]) => render(c, key))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------- Coursera (native, full metrics parity) ----------------
const STR_SORT_KEYS = new Set(['name', 'title', 'domain', 'category', 'status', 'code', 'instructorNames']);
const STATUS_STYLE = {
  launched: { bg: '#dcfce7', fg: '#10b981', text: 'Launched' },
  draft: { bg: '#fef3c7', fg: '#f59e0b', text: 'Draft' },
  preenroll: { bg: '#eef2ff', fg: '#4f46e5', text: 'Preenroll' },
};
function StatusBadge({ status }) {
  if (!status) return <span className="muted">—</span>;
  const s = STATUS_STYLE[status] || { bg: '#f3f4f6', fg: '#6b7280', text: status };
  return <span className="pill" style={{ background: s.bg, color: s.fg }}>{s.text}</span>;
}

function CourseraView({ rows, label = 'Coursera', showInstructorCheck = true, reviewsBySlug = {}, platform = 'coursera', isBookmarked, toggleBookmark, quarters = [] }) {
  const [sort, setSort] = useState({ key: 'enrollments', dir: -1 });
  const [q, setQ] = useState('');
  const pct = (r) => (r == null ? '—' : (r <= 1 ? Math.round(r * 100) : Math.round(r)) + '%');
  // search across the fields actually shown in the table, so a hit is visible
  const f = useColumnFilter('coursera');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const bySearch = !s ? rows : rows.filter((c) => [c.name, c.domain, c.status, ...(c.instructorNames || [])]
      .some((v) => String(v || '').toLowerCase().includes(s)));
    return applyFilter(bySearch, f.spec, f.fields);
  }, [rows, q, f.spec, f.fields]);
  // Quarter columns sort on `q<index>`, which lives inside the quarterlyRevenue
  // array rather than being a field of its own.
  const val = (c, key) => (/^q\d+$/.test(key) ? c.quarterlyRevenue?.[Number(key.slice(1))] : c[key]);
  const data = useMemo(() => [...filtered].sort((a, b) => {
    if (STR_SORT_KEYS.has(sort.key)) return sort.dir * String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''));
    return sort.dir * ((Number(val(a, sort.key)) || 0) - (Number(val(b, sort.key)) || 0));
  }), [filtered, sort]);
  if (!rows.length) return (<><Header crumb={`COURSES · ${label.toUpperCase()}`} title={label} sub="Partner course metrics" /><div className="table-card"><div style={{ padding: 24 }} className="muted">No {label} metrics cached. Reconnect Coursera in Settings, then run the metrics scrape.</div></div></>);
  const totE = rows.reduce((s, c) => s + (c.enrollments || 0), 0);
  const totC = rows.reduce((s, c) => s + (c.completions || 0), 0);
  const rated = rows.filter((c) => c.rating);
  const avgR = rated.length ? rated.reduce((s, c) => s + Number(c.rating), 0) / rated.length : 0;
  const withRevenue = rows.filter((c) => c.revenue != null);
  const totRev = withRevenue.reduce((s, c) => s + (c.revenue || 0), 0);
  const th = (key, label, align = 'right') => <th key={key} style={{ textAlign: align }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb={`COURSES · ${label.toUpperCase()}`} title={label} sub={withRevenue.length ? `Partner course metrics — revenue from a manually imported report (${withRevenue.length}/${rows.length} courses)` : 'Partner course metrics'} actions={<button className="btn btn-secondary" onClick={() => exportCourseraCsv(data)}>⬇ Export CSV</button>} />
      <div className="kpi-grid">
        {/* Launched courses. The CIN catalogue includes unlaunched drafts, and the
            table below still lists them (their status says Draft) — but they
            are not courses on sale, so the tile does not count them. */}
        <Kpi icon="📚" bg="#cce5ff" fg="#0066cc" label="Courses" value={num(rows.filter((c) => String(c.status || '').toLowerCase() !== 'draft').length)}
          trend={rows.some((c) => String(c.status || '').toLowerCase() === 'draft') ? `${rows.filter((c) => String(c.status || '').toLowerCase() === 'draft').length} drafts listed below, not counted` : undefined} />
        <Kpi icon="👥" bg="#cce5ff" fg="#0066cc" label="Enrollments" value={num(totE)} />
        <Kpi icon="🎓" bg="#dcfce7" fg="#10b981" label="Completions" value={num(totC)} trend={`${Math.round((totC / (totE || 1)) * 100)}% overall`} />
        <Kpi icon="⭐" bg="#fef3c7" fg="#f59e0b" label="Avg Rating" value={avgR ? avgR.toFixed(2) : '—'} />
        {withRevenue.length > 0 && <Kpi icon="💵" bg="#dcfce7" fg="#10b981" label="Revenue" value={usd(totRev)} trend={`${withRevenue.length}/${rows.length} courses — imported report`} />}
      </div>
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search course, domain, status or instructor…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
          <FilterBuilder {...f} rows={rows} />
          <span className="muted">{data.length === rows.length ? `${rows.length} courses` : `${data.length} of ${rows.length}`}</span>
        </div>
        <ActiveFilter f={f} shown={data.length} total={rows.length} />
        <div className="table-scroll"><table>
        <thead><tr><th className="no-sort"></th>{th('name', 'Course', 'left')}{th('domain', 'Domain', 'left')}{th('status', 'Status', 'center')}{th('enrollments', 'Enrollments')}{th('completions', 'Completions')}{th('completionRate', 'Compl. Rate')}{th('rating', 'Rating')}<th className="no-sort">Reviews</th>{th('revenue', 'Revenue')}{quarters.map((qt, qi) => <th key={qt} style={{ textAlign: 'right' }} onClick={() => setSort((s) => ({ key: `q${qi}`, dir: s.key === `q${qi}` ? -s.dir : -1 }))}>{qt}{sort.key === `q${qi}` ? (sort.dir < 0 ? ' \u2193' : ' \u2191') : ''}</th>)}{showInstructorCheck && <th className="no-sort">Instructor</th>}{showInstructorCheck && th('instructorNames', 'Instructor Names', 'left')}</tr></thead>
        <tbody>
          {data.map((c, i) => {
            const reviews = (c.slug && reviewsBySlug[c.slug]) || [];
            const reviewTitle = reviews.slice(0, 3).map((r) => `${r.rating ? `★${r.rating} ` : ''}${r.reviewText || ''}`).join('\n\n');
            const bmKey = c.slug || c.name;
            return (
            <tr key={i}>
              <td><BookmarkButton active={isBookmarked(platform, bmKey)} onClick={() => toggleBookmark(platform, bmKey, c.name)} /></td>
              <td style={{ fontWeight: 500 }}>{c.name}</td>
              <td className="muted" style={{ fontSize: 13 }}>{c.domain || '—'}</td>
              <td style={{ textAlign: 'center' }}><StatusBadge status={c.status} /></td>
              <td style={{ textAlign: 'right' }}>{num(c.enrollments)}</td>
              <td style={{ textAlign: 'right' }}>{num(c.completions)}</td>
              <td style={{ textAlign: 'right' }}>{pct(c.completionRate)}</td>
              <td style={{ textAlign: 'right' }}>{c.rating ? <span className="rating-stars">★ {Number(c.rating).toFixed(2)}</span> : '—'}</td>
              <td style={{ textAlign: 'center' }} title={reviewTitle || undefined}>{reviews.length ? <span className="pill" style={{ background: '#eef2ff', color: '#4f46e5', cursor: 'help' }}>{reviews.length}</span> : <span className="muted">0</span>}</td>
              <td style={{ textAlign: 'right', fontWeight: 600, color: c.revenue ? '#10b981' : '#9ca3af' }}>{c.revenue != null ? usd(c.revenue) : '—'}</td>
              {quarters.map((qt, qi) => {
                const v = c.quarterlyRevenue?.[qi];
                return <td key={qt} style={{ textAlign: 'right', color: v ? '#374151' : '#9ca3af' }}>{v != null ? usd(v) : '—'}</td>;
              })}
              {showInstructorCheck && <td style={{ textAlign: 'center' }}>{c.hasStarweaverInstructor ? <span title="instructors@starweaver.com is an Instructor" style={{ color: '#10b981' }}>✓</span> : <span title="instructors@starweaver.com not found as Instructor" style={{ color: '#ef4444' }}>✗</span>}</td>}
              {showInstructorCheck && <td className="muted" style={{ fontSize: 13 }}>{c.instructorNames?.length ? c.instructorNames.join(', ') : '—'}</td>}
            </tr>
            );
          })}
        </tbody>
      </table></div></div>
    </>
  );
}

// ---------------- FutureLearn (native: course list + status + enrollment) ----------------
function FutureLearnView({ rows, isBookmarked, toggleBookmark }) {
  const [sort, setSort] = useState({ key: 'enrollment', dir: -1 });
  const [q, setQ] = useState('');
  const f = useColumnFilter('futurelearn');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const bySearch = !s ? rows : rows.filter((c) => [c.title, c.code, c.category, c.status]
      .some((v) => String(v || '').toLowerCase().includes(s)));
    return applyFilter(bySearch, f.spec, f.fields);
  }, [rows, q, f.spec, f.fields]);
  const data = useMemo(() => [...filtered].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (sort.key === 'title' || sort.key === 'category' || sort.key === 'status') return sort.dir * String(av || '').localeCompare(String(bv || ''));
    return sort.dir * ((Number(av) || 0) - (Number(bv) || 0));
  }), [filtered, sort]);
  if (!rows.length) return (<><Header crumb="COURSES · FUTURELEARN" title="FutureLearn" sub="Course list + status" /><div className="table-card"><div style={{ padding: 24 }} className="muted">No FutureLearn courses cached. Connect FutureLearn in Settings, then run <code>npm run futurelearn:courses</code>.</div></div></>);
  const totalEnroll = rows.reduce((s, c) => s + (c.enrollment || 0), 0);
  const live = rows.filter((c) => c.status === 'In progress').length;
  const th = (key, label, align = 'right') => <th key={key} style={{ textAlign: align }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb="COURSES · FUTURELEARN" title="FutureLearn" sub="Course list, run status, and public enrollment counts (no partner API, no ratings exposed)" actions={<button className="btn btn-secondary" onClick={() => exportFutureLearnCsv(data)}>⬇ Export CSV</button>} />
      <div className="kpi-grid">
        <Kpi icon="📚" bg="#cce5ff" fg="#0066cc" label="Courses" value={num(rows.length)} />
        <Kpi icon="🟢" bg="#dcfce7" fg="#10b981" label="Live runs" value={num(live)} />
        <Kpi icon="👥" bg="#cce5ff" fg="#0066cc" label="Enrollments (known)" value={num(totalEnroll)} />
      </div>
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search course, code, category or status…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
          <FilterBuilder {...f} rows={rows} />
          <span className="muted">{data.length === rows.length ? `${rows.length} courses` : `${data.length} of ${rows.length}`}</span>
        </div>
        <ActiveFilter f={f} shown={data.length} total={rows.length} />
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort"></th>{th('title', 'Course', 'left')}{th('code', 'Code', 'left')}{th('category', 'Category', 'left')}{th('status', 'Status')}<th className="no-sort">Start date</th>{th('wishlistCount', 'Wishlist')}{th('enrollment', 'Enrollment')}</tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.slug}>
                <td><BookmarkButton active={isBookmarked('futurelearn', c.slug)} onClick={() => toggleBookmark('futurelearn', c.slug, c.title)} /></td>
                <td style={{ fontWeight: 500, minWidth: 200 }}>{c.title}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.code || '—'}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.category || '—'}</td>
                <td>{c.status || '—'}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.startDate || '—'}</td>
                <td style={{ textAlign: 'right' }}>{num(c.wishlistCount)}</td>
                <td style={{ textAlign: 'right' }}>{c.enrollment != null ? num(c.enrollment) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- LinkedIn Learning ----------------
// The instructor portal's all-courses table is the only view that lists every
// course at once, and it carries just these five fields. Watch time, completion
// rate and demographics exist only on each course's own Analytics page, one page
// per course, so they are absent here by nature rather than by omission.
function LinkedInView({ data, isBookmarked, toggleBookmark }) {
  const rows = data.courses || [];
  const [sort, setSort] = useState({ key: 'learners', dir: -1 });
  const [q, setQ] = useState('');
  const f = useColumnFilter('linkedin');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const bySearch = !s ? rows : rows.filter((c) => [c.title, c.language].some((v) => String(v || '').toLowerCase().includes(s)));
    return applyFilter(bySearch, f.spec, f.fields);
  }, [rows, q, f.spec, f.fields]);
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (sort.key === 'title' || sort.key === 'language' || sort.key === 'lastUpdated') {
      return sort.dir * String(av || '').localeCompare(String(bv || ''));
    }
    return sort.dir * ((Number(av) || 0) - (Number(bv) || 0));
  }), [filtered, sort]);

  if (!rows.length) {
    return (<><Header crumb="COURSES · LINKEDIN" title="LinkedIn Learning" sub="Instructor-portal analytics" />
      <div className="table-card"><div style={{ padding: 24 }} className="muted">
        No LinkedIn Learning courses cached. Connect LinkedIn in Settings, then run <code>node scrapeLinkedInCourses.js</code>.
      </div></div></>);
  }

  const t = data.totals || { learners: 0, shares: 0, likes: 0 };
  const th = (key, label, align = 'right') => <th key={key} style={{ textAlign: align }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb="COURSES · LINKEDIN" title="LinkedIn Learning" sub="Published as Starweaver Group, Inc. Licensor. Watch time and completion are not exposed at this level." actions={<button className="btn btn-secondary" onClick={() => exportLinkedInCsv(sorted)}>⬇ Export CSV</button>} />
      <div className="kpi-grid">
        <Kpi icon="📚" bg="#e0e7ff" fg="#0a66c2" label="Courses" value={num(rows.length)} />
        <Kpi icon="👥" bg="#e0e7ff" fg="#0a66c2" label="Learners" value={num(t.learners)} />
        <Kpi icon="🔁" bg="#e0e7ff" fg="#0a66c2" label="Shares" value={num(t.shares)} />
        <Kpi icon="👍" bg="#e0e7ff" fg="#0a66c2" label="Likes" value={num(t.likes)} />
      </div>
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search course or language…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
          <FilterBuilder {...f} rows={rows} />
          <span className="muted">{sorted.length === rows.length ? `${rows.length} courses` : `${sorted.length} of ${rows.length}`}</span>
        </div>
        <ActiveFilter f={f} shown={sorted.length} total={rows.length} />
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort"></th>{th('title', 'Course', 'left')}{th('language', 'Language', 'left')}{th('learners', 'Learners')}{th('shares', 'Shares')}{th('likes', 'Likes')}{th('lastUpdated', 'Last updated', 'left')}</tr></thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.title}>
                <td><BookmarkButton active={isBookmarked('linkedin', c.title)} onClick={() => toggleBookmark('linkedin', c.title, c.title)} /></td>
                <td style={{ fontWeight: 500, minWidth: 220 }}>{c.title}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.language || '—'}</td>
                <td style={{ textAlign: 'right' }}>{num(c.learners)}</td>
                <td style={{ textAlign: 'right' }}>{num(c.shares)}</td>
                <td style={{ textAlign: 'right' }}>{num(c.likes)}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.lastUpdated || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Go1 (native: lifetime totals + monthly snapshot) ----------------
// Go1 never returns more than one month per request (no lifetime endpoint) — the
// "Lifetime" scope here is built by scrapeGo1History.js scraping every month back
// to when Go1 data starts and summing per course. "This Month" stays available as
// a secondary reference since it's what changed most recently.
const LANG_NAME = { en: 'English', es: 'Spanish', fr: 'French' };
function Go1View({ rows, month, lifetime, catalog = { courses: [], byLanguage: {} }, isBookmarked, toggleBookmark }) {
  const [scope, setScope] = useState('lifetime');
  const [sort, setSort] = useState({ key: 'enrolments', dir: -1 });
  const [q, setQ] = useState('');
  const allRows = scope === 'lifetime' ? lifetime.courses : rows;
  const f = useColumnFilter('go1');
  const activeRows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const bySearch = s ? allRows.filter((c) => String(c.name || '').toLowerCase().includes(s)) : allRows;
    return applyFilter(bySearch, f.spec, f.fields);
  }, [allRows, q, f.spec, f.fields]);
  const data = useMemo(() => [...activeRows].sort((a, b) => {
    if (STR_SORT_KEYS.has(sort.key)) return sort.dir * String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''));
    return sort.dir * ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0));
  }), [activeRows, sort]);
  if (!rows.length && !lifetime.courses.length) return (
    <>
      <Header crumb="COURSES · GO1" title="Go1" sub="Content Studio — course-level consumption" />
      <div className="table-card"><div style={{ padding: 24 }} className="muted">
        No Go1 course data cached yet. Connect Go1 in Settings, then run <code>npm run go1:history</code> for lifetime totals (or <code>npm run go1:courses</code> for just this month).
      </div></div>
    </>
  );
  // KPIs describe the whole scope, not the search result — otherwise the
  // headline totals would silently change as you type.
  const totE = allRows.reduce((s, c) => s + (c.enrolments || 0), 0);
  const totC = allRows.reduce((s, c) => s + (c.completions || 0), 0);
  const isLifetime = scope === 'lifetime';
  const scopeBtn = (key, label) => (
    <button
      className="btn btn-secondary"
      style={scope === key ? { background: '#002fa7', color: '#fff', borderColor: '#002fa7' } : undefined}
      onClick={() => setScope(key)}
    >{label}</button>
  );
  const th = (key, label, align = 'right') => <th key={key} style={{ textAlign: align }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb="COURSES · GO1" title="Go1"
        sub={isLifetime
          ? `Content Studio — lifetime totals${lifetime.firstMonth ? ` (${lifetime.firstMonth} to ${lifetime.lastMonth}, ${lifetime.monthCount} months)` : ''}`
          : `Content Studio — course-level consumption${month ? ` (${month} only)` : ''}`}
        actions={<div style={{ display: 'flex', gap: 8 }}>
          {scopeBtn('lifetime', 'Lifetime')}
          {scopeBtn('month', month || 'This Month')}
          <button className="btn btn-secondary" onClick={() => exportGo1Csv(data)}>⬇ Export CSV</button>
        </div>}
      />
      <div className="kpi-grid">
        {/* Courses ON Go1 come from its catalogue. allRows are the courses with
            learners in the chosen period, which is a different — smaller — number. */}
        <Kpi icon="📚" bg="#cce5ff" fg="#0066cc" label="Courses on Go1" value={num(catalog.courses.length || allRows.length)}
          trend={catalog.courses.length
            ? Object.entries(catalog.byLanguage).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${LANG_NAME[k] || k}`).join(' · ') + ` · ${allRows.length} with learners`
            : `${allRows.length} with learners`} />
        <Kpi icon="👥" bg="#cce5ff" fg="#0066cc" label={isLifetime ? 'Enrolments (lifetime)' : 'Enrolments (month)'} value={num(totE)} />
        <Kpi icon="🎓" bg="#dcfce7" fg="#10b981" label={isLifetime ? 'Completions (lifetime)' : 'Completions (month)'} value={num(totC)} />
      </div>
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search courses…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
          <FilterBuilder {...f} rows={allRows} />
          <span className="muted">{data.length === allRows.length ? `${allRows.length} courses` : `${data.length} of ${allRows.length}`}</span>
        </div>
        <ActiveFilter f={f} shown={data.length} total={allRows.length} />
        <div className="table-scroll"><table>
        <thead><tr><th className="no-sort"></th>{th('name', 'Course', 'left')}{th('enrolments', 'Enrolments')}{th('completions', 'Completions')}{th('totalMinutes', 'Total minutes')}{th('avgSessionMinutes', 'Avg session')}</tr></thead>
        <tbody>
          {data.map((c, i) => (
            <tr key={i}>
              <td><BookmarkButton active={isBookmarked('go1', c.name)} onClick={() => toggleBookmark('go1', c.name, c.name)} /></td>
              <td style={{ fontWeight: 500 }}>{c.name}</td>
              <td style={{ textAlign: 'right' }}>{num(c.enrolments)}</td>
              <td style={{ textAlign: 'right' }}>{num(c.completions)}</td>
              <td style={{ textAlign: 'right' }}>{num(c.totalMinutes)}</td>
              <td style={{ textAlign: 'right' }}>{num(c.avgSessionMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table></div></div>
    </>
  );
}

// ---------------- Watchlist (cross-platform bookmarked courses) ----------------
function Watchlist({ bookmarks, udemy, coursera, courseraCin, futurelearn, linkedin, go1, platform, isBookmarked, toggleBookmark, onOpen }) {
  const byPlatform = useMemo(() => {
    // linkedin was absent here, so a bookmarked LinkedIn course was dropped:
    // the star saved server-side but the Watchlist never showed it.
    const g = { udemy: [], coursera: [], coursera_cin: [], futurelearn: [], linkedin: [], go1: [] };
    bookmarks.forEach((b) => { if (g[b.platform]) g[b.platform].push(b); });
    return g;
  }, [bookmarks]);

  const udemyRows = byPlatform.udemy.map((b) => udemy.find((c) => String(c.id) === String(b.courseKey))).filter(Boolean);
  const courseraRows = byPlatform.coursera.map((b) => coursera.find((c) => (c.slug || c.name) === b.courseKey)).filter(Boolean);
  const courseraCinRows = byPlatform.coursera_cin.map((b) => courseraCin.find((c) => (c.slug || c.name) === b.courseKey)).filter(Boolean);
  const futurelearnRows = byPlatform.futurelearn.map((b) => futurelearn.find((c) => c.slug === b.courseKey)).filter(Boolean);
  const linkedinRows = byPlatform.linkedin.map((b) => (linkedin || []).find((c) => c.title === b.courseKey)).filter(Boolean);
  const go1Rows = byPlatform.go1.map((b) => go1.find((c) => c.name === b.courseKey)).filter(Boolean);

  // The platform tabs are a global filter, so the Watchlist has to honour them.
  // It used to render every platform's section whatever the tab said, which
  // read as the tabs being broken.
  const showAll = !platform || platform === 'all';
  const show = (key) => showAll || platform === key;
  const total = (show('udemy') ? udemyRows.length : 0) + (show('coursera') ? courseraRows.length : 0)
    + (show('coursera_cin') ? courseraCinRows.length : 0) + (show('futurelearn') ? futurelearnRows.length : 0)
    + (show('linkedin') ? linkedinRows.length : 0) + (show('go1') ? go1Rows.length : 0);
  const TAB_LABEL = { udemy: 'Udemy', coursera: 'Coursera', coursera_cin: 'Coursera CIN',
    futurelearn: 'FutureLearn', linkedin: 'LinkedIn', go1: 'Go1' };

  // Flatten every platform into one shape for CSV export. Fields a platform
  // doesn't report are left undefined so they export blank rather than 0.
  const addedAt = useMemo(() => {
    const m = new Map();
    bookmarks.forEach((b) => m.set(`${b.platform}:${b.courseKey}`, (b.addedAt || '').slice(0, 10)));
    return m;
  }, [bookmarks]);
  const when = (platform, key) => addedAt.get(`${platform}:${key}`) ?? '';
  const rating2 = (r) => (r ? Number(r).toFixed(2) : undefined);
  const exportRows = [
    ...udemyRows.map((c) => ({
      platform: 'Udemy', course: c.title, enrollments: c.num_subscribers, rating: rating2(c.rating),
      reviews: c.num_reviews, revenue: c.revenue, minutes: c.minutes_taught != null ? Math.round(c.minutes_taught) : undefined,
      link: c.url ? `https://www.udemy.com${c.url}` : '', addedAt: when('udemy', c.id),
    })),
    ...courseraRows.map((c) => ({
      platform: 'Coursera', course: c.name, status: c.status, enrollments: c.enrollments,
      rating: rating2(c.rating), completions: c.completions, revenue: c.revenue,
      link: c.slug ? `https://www.coursera.org/learn/${c.slug}` : '', addedAt: when('coursera', c.slug || c.name),
    })),
    ...courseraCinRows.map((c) => ({
      platform: 'Coursera CIN', course: c.name, status: c.status, enrollments: c.enrollments,
      rating: rating2(c.rating), completions: c.completions, revenue: c.revenue,
      link: c.slug ? `https://www.coursera.org/learn/${c.slug}` : '', addedAt: when('coursera_cin', c.slug || c.name),
    })),
    ...futurelearnRows.map((c) => ({
      platform: 'FutureLearn', course: c.title, status: c.status, enrollments: c.enrollment,
      link: c.slug ? `https://www.futurelearn.com/courses/${c.slug}` : '', addedAt: when('futurelearn', c.slug),
    })),
    ...go1Rows.map((c) => ({
      platform: 'Go1', course: c.name, enrollments: c.enrolments, completions: c.completions,
      minutes: c.totalMinutes, addedAt: when('go1', c.name),
    })),
  ];

  if (!bookmarks.length) {
    return (
      <>
        <Header crumb="WATCHLIST" title="Watchlist" sub="Bookmark courses from any platform to track them here" />
        <div className="table-card"><div className="watchlist-empty">
          ☆ No bookmarked courses yet.<br />Click the star next to any course in a Courses table to add it here.
        </div></div>
      </>
    );
  }

  const section = (key, label, rows, thead, renderRow) => show(key) && rows.length > 0 && (
    <div className="table-card" style={{ marginBottom: 20 }}>
      <div className="table-header"><strong>{label}</strong><span className="muted">{rows.length} shown</span></div>
      <div className="table-scroll"><table>
        <thead><tr>{thead}</tr></thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table></div>
    </div>
  );

  return (
    <>
      <Header crumb="WATCHLIST" title="Watchlist" sub={showAll ? `${total} bookmarked course${total === 1 ? '' : 's'} across all platforms` : `${total} bookmarked course${total === 1 ? '' : 's'} on ${TAB_LABEL[platform] || platform}`}
        actions={<button className="btn btn-secondary" disabled={!exportRows.length} onClick={() => exportWatchlistCsv(exportRows)}>⬇ Export CSV</button>} />
      {total === 0 && (
        <div className="table-card"><div className="watchlist-empty">
          ☆ Nothing bookmarked on {TAB_LABEL[platform] || platform}.<br />
          Switch to <b>All Platforms</b> to see your other {bookmarks.length} bookmark{bookmarks.length === 1 ? '' : 's'}.
        </div></div>
      )}
      {section('udemy', 'Udemy', udemyRows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th>Rating</th><th>Enrolled</th><th>Reviews</th><th>Revenue</th></>,
        (c) => (
          <tr key={c.id} className="click" onClick={() => onOpen(c)}>
            <td onClick={(e) => e.stopPropagation()}><BookmarkButton active={isBookmarked('udemy', c.id)} onClick={() => toggleBookmark('udemy', c.id, c.title)} /></td>
            <td style={{ fontWeight: 500 }}>{c.title}</td>
            <td style={{ textAlign: 'right' }}>{c.rating ? Number(c.rating).toFixed(2) : '—'}</td>
            <td style={{ textAlign: 'right' }}>{num(c.num_subscribers)}</td>
            <td style={{ textAlign: 'right' }}>{num(c.num_reviews)}</td>
            <td style={{ textAlign: 'right' }}>{c.revenue != null ? usd(c.revenue) : '—'}</td>
          </tr>
        ))}
      {section('coursera', 'Coursera', courseraRows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th style={{ textAlign: 'left' }}>Status</th><th>Rating</th><th>Enrollments</th><th>Revenue</th></>,
        (c, i) => {
          const key = c.slug || c.name;
          return (
            <tr key={i}>
              <td><BookmarkButton active={isBookmarked('coursera', key)} onClick={() => toggleBookmark('coursera', key, c.name)} /></td>
              <td style={{ fontWeight: 500 }}>{c.name}</td>
              <td><StatusBadge status={c.status} /></td>
              <td style={{ textAlign: 'right' }}>{c.rating ? Number(c.rating).toFixed(2) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{num(c.enrollments)}</td>
              <td style={{ textAlign: 'right' }}>{c.revenue != null ? usd(c.revenue) : '—'}</td>
            </tr>
          );
        })}
      {section('coursera_cin', 'Coursera CIN', courseraCinRows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th style={{ textAlign: 'left' }}>Status</th><th>Rating</th><th>Enrollments</th><th>Revenue</th></>,
        (c, i) => {
          const key = c.slug || c.name;
          return (
            <tr key={i}>
              <td><BookmarkButton active={isBookmarked('coursera_cin', key)} onClick={() => toggleBookmark('coursera_cin', key, c.name)} /></td>
              <td style={{ fontWeight: 500 }}>{c.name}</td>
              <td><StatusBadge status={c.status} /></td>
              <td style={{ textAlign: 'right' }}>{c.rating ? Number(c.rating).toFixed(2) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{num(c.enrollments)}</td>
              <td style={{ textAlign: 'right' }}>{c.revenue != null ? usd(c.revenue) : '—'}</td>
            </tr>
          );
        })}
      {section('futurelearn', 'FutureLearn', futurelearnRows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th style={{ textAlign: 'left' }}>Status</th><th>Wishlist</th><th>Enrollment</th></>,
        (c) => (
          <tr key={c.slug}>
            <td><BookmarkButton active={isBookmarked('futurelearn', c.slug)} onClick={() => toggleBookmark('futurelearn', c.slug, c.title)} /></td>
            <td style={{ fontWeight: 500 }}>{c.title}</td>
            <td>{c.status || '—'}</td>
            <td style={{ textAlign: 'right' }}>{num(c.wishlistCount)}</td>
            <td style={{ textAlign: 'right' }}>{c.enrollment != null ? num(c.enrollment) : '—'}</td>
          </tr>
        ))}
      {section('linkedin', 'LinkedIn', linkedinRows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th>Learners</th><th>Shares</th><th>Likes</th></>,
        (c) => (
          <tr key={c.title}>
            <td onClick={(e) => e.stopPropagation()}><BookmarkButton active={isBookmarked('linkedin', c.title)} onClick={() => toggleBookmark('linkedin', c.title, c.title)} /></td>
            <td style={{ fontWeight: 500, minWidth: 220 }}>{c.title}</td>
            <td style={{ textAlign: 'right' }}>{num(c.learners)}</td>
            <td style={{ textAlign: 'right' }}>{num(c.shares)}</td>
            <td style={{ textAlign: 'right' }}>{num(c.likes)}</td>
          </tr>
        ))}
      {section('go1', 'Go1', go1Rows,
        <><th className="no-sort"></th><th style={{ textAlign: 'left' }}>Course</th><th>Enrolments</th><th>Completions</th><th>Total minutes</th></>,
        (c, i) => (
          <tr key={i}>
            <td><BookmarkButton active={isBookmarked('go1', c.name)} onClick={() => toggleBookmark('go1', c.name, c.name)} /></td>
            <td style={{ fontWeight: 500 }}>{c.name}</td>
            <td style={{ textAlign: 'right' }}>{num(c.enrolments)}</td>
            <td style={{ textAlign: 'right' }}>{num(c.completions)}</td>
            <td style={{ textAlign: 'right' }}>{num(c.totalMinutes)}</td>
          </tr>
        ))}
    </>
  );
}

// ---------------- Earnings (native, parity: Days Live + $/day + best) ----------------
function Earnings({ udemy, totalRevenue, monthly, platform, coursera = [] }) {
  const isAll = platform === 'all';
  const earning = udemy.filter((c) => c.revenue > 0);
  const revSeries = monthlySeries(monthly);
  const [sort, setSort] = useState({ key: 'revenue', dir: -1 });
  const withDerived = earning.map((c) => { const d = daysLive(c); return { ...c, _days: d, _perDay: d ? c.revenue / d : 0 }; });
  const rows = useMemo(() => [...withDerived].sort((a, b) => sort.dir * ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0))), [withDerived, sort]);
  const top = rows[0];
  const perDayChart = [...withDerived].sort((a, b) => b._perDay - a._perDay).slice(0, 8).map((c) => ({ label: c.title, value: c._perDay, color: '#0066cc' }));
  const th = (key, label) => <th key={key} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  // Same combination as the Overview KPI: Udemy live revenue + Coursera's manually
  // imported revenue. Coursera CIN stays excluded — it's not part of this portfolio.
  const courseraRevenueTotal = coursera.reduce((s, c) => s + (c.revenue || 0), 0);
  const courseraRevenueCount = coursera.filter((c) => c.revenue != null).length;
  const revenueValue = isAll ? usd((totalRevenue || 0) + courseraRevenueTotal) : usd(totalRevenue);
  const revenueTrend = isAll ? `Udemy + Coursera (${courseraRevenueCount}/${coursera.length} courses)` : 'all-time Udemy';
  return (
    <>
      <Header crumb="EARNINGS" title="Earnings" sub={isAll ? 'Combined revenue, plus a Udemy per-course breakdown below' : 'Published-course revenue, days live, and $/day'} actions={<button className="btn btn-secondary" onClick={() => exportCsv(udemy)}>⬇ Export CSV</button>} />
      <div className="kpi-grid">
        <Kpi label="Lifetime Revenue" value={revenueValue} fg="#10b981" trend={revenueTrend} />
        <Kpi label="Top Course" value={(top?.title || '—').slice(0, 22)} big={false} trend={usd(top?.revenue)} />
        <Kpi label="Courses Earning" value={num(earning.length)} trend={`of ${udemy.length} total`} />
        <Kpi label="Best $/Day" value={usd(top ? [...withDerived].sort((a, b) => b._perDay - a._perDay)[0]?._perDay : null)} trend="top earner per day" />
      </div>
      <div className="charts-section">
        <div className="charts-grid">
          <div className="chart-card"><h3>$ / Day (top earners per day live)</h3>{perDayChart.length ? <BarChart data={perDayChart} money /> : <div className="chart-placeholder">No data</div>}</div>
          <div className="chart-card"><h3>Revenue Over Time (last 24mo)</h3>{revSeries.length ? <LineChart data={revSeries} money /> : <ChartPlaceholder>No revenue history yet</ChartPlaceholder>}</div>
        </div>
      </div>
      <div className="table-card">
        <div className="table-header"><b>Earnings by Course (published{isAll ? ' — Udemy only' : ''})</b><span className="muted">{rows.length} earning</span></div>
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort">Course</th><th className="no-sort">Published</th>{th('_days', 'Days Live')}{th('revenue', 'Total Earning')}{th('_perDay', '$/Day')}</tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 500 }}>{c.title}</td>
                <td className="muted">{(c.published_time || c.created) ? new Date(c.published_time || c.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
                <td style={{ textAlign: 'right' }}>{c._days ? num(c._days) : '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: '#10b981' }}>{usd(c.revenue)}</td>
                <td style={{ textAlign: 'right' }}>{c._perDay ? '$' + c._perDay.toFixed(2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Coursera / Coursera CIN Earnings (manually imported revenue) ----------------
// Same revenue numbers shown on the Overview KPI and the Courses table's Revenue
// column for this platform — kept in one place (readCourseraRevenueImport, merged
// in by index.js) so all three views can never disagree.
function CourseraEarnings({ rows, label = 'Coursera' }) {
  // "withRevenue" (has an imported row, incl. real $0s) is the same coverage
  // count shown on the Overview KPI and the Courses table's sub-header — keep
  // this one in sync with those. "earning" (revenue > 0) is a narrower, Earnings-
  // specific view of which courses actually made money, same distinction Udemy's
  // Earnings tab draws.
  const withRevenue = rows.filter((c) => c.revenue != null);
  const earning = rows.filter((c) => c.revenue > 0);
  const [sort, setSort] = useState({ key: 'revenue', dir: -1 });
  const sorted = useMemo(() => [...earning].sort((a, b) => sort.dir * ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0))), [earning, sort]);
  const total = rows.reduce((s, c) => s + (c.revenue || 0), 0);
  const totalCompletions = rows.reduce((s, c) => s + (c.revenueCompletions || 0), 0);
  const top = sorted[0];
  const th = (key, colLabel) => <th key={key} style={{ textAlign: 'right' }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{colLabel}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb="EARNINGS" title="Earnings" sub={`${label} revenue — from a manually imported partner report (${withRevenue.length}/${rows.length} courses), not a live API`} actions={<button className="btn btn-secondary" onClick={() => exportCourseraCsv(rows)}>⬇ Export CSV</button>} />
      <div className="kpi-grid">
        <Kpi label="Lifetime Revenue" value={usd(total)} fg="#10b981" trend={`${withRevenue.length}/${rows.length} courses — imported report`} />
        <Kpi label="Top Course" value={(top?.name || '—').slice(0, 22)} big={false} trend={usd(top?.revenue)} />
        <Kpi label="Courses Earning" value={num(earning.length)} trend={`of ${rows.length} total`} />
        <Kpi label="Completions (imported)" value={num(totalCompletions)} trend="from the same report" />
      </div>
      <div className="table-card">
        <div className="table-header"><b>Earnings by Course</b><span className="muted">{sorted.length} earning</span></div>
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort" style={{ textAlign: 'left' }}>Course</th><th className="no-sort" style={{ textAlign: 'left' }}>Status</th>{th('revenue', 'Revenue')}{th('revenueCompletions', 'Completions')}</tr></thead>
          <tbody>
            {sorted.map((c, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{c.name}</td>
                <td><StatusBadge status={c.status} /></td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: '#10b981' }}>{usd(c.revenue)}</td>
                <td style={{ textAlign: 'right' }}>{c.revenueCompletions != null ? num(c.revenueCompletions) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Minutes Report (mins consumed per course, last 3 months) ----------------
const monthLabel = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
function MinutesReport({ udemy }) {
  const rows = useMemo(() => udemy.filter((c) => c.recent_months), [udemy]);
  const labels = rows[0]?.recent_months?.map((m) => monthLabel(m.month)) || ['This Month', 'Last Month', '2 Months Ago'];
  const [sort, setSort] = useState({ key: 'm0', dir: -1 });
  const withDerived = rows.map((c) => ({
    ...c,
    m0: c.recent_months?.[0]?.minutes ?? null,
    m1: c.recent_months?.[1]?.minutes ?? null,
    m2: c.recent_months?.[2]?.minutes ?? null,
  }));
  const sorted = useMemo(() => [...withDerived].sort((a, b) => sort.dir * ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0))), [withDerived, sort]);
  const th = (key, label) => <th key={key} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>{label}{sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <Header crumb="MINUTES" title="Minutes Consumed" sub="Learner minutes watched per course, by month" actions={<button className="btn btn-secondary" onClick={() => exportMinutesCsv(sorted)}>⬇ Export CSV</button>} />
      <div className="table-card">
        <div className="table-header"><b>Minutes Consumed by Course</b><span className="muted">{rows.length} courses</span></div>
        <div className="table-scroll"><table>
          <thead><tr>
            <th className="no-sort">Course</th>
            <th className="no-sort">Live Date</th>
            {th('m0', labels[0])}
            {th('m1', labels[1])}
            {th('m2', labels[2])}
          </tr></thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 500 }}>{c.title}</td>
                <td className="muted">{(c.published_time || c.created) ? new Date(c.published_time || c.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
                <td style={{ textAlign: 'right' }}>{c.m0 != null ? num(Math.round(c.m0)) : <span className="muted">—</span>}</td>
                <td style={{ textAlign: 'right' }}>{c.m1 != null ? num(Math.round(c.m1)) : <span className="muted">—</span>}</td>
                <td style={{ textAlign: 'right' }}>{c.m2 != null ? num(Math.round(c.m2)) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Captions ----------------
const COVER_COLS = [['en', 'EN'], ['es', 'ES'], ['fr', 'FR'], ['de', 'DE'], ['pt', 'PT'], ['it', 'IT'], ['ar', 'AR']];
const LANG_MATCH = [['en', /english/i], ['es', /spanish/i], ['fr', /french/i], ['de', /german/i], ['pt', /portuguese/i], ['it', /italian/i], ['ar', /arabic/i]];
const langCodes = (locales = []) => { const set = new Set(); for (const l of capNames(locales)) for (const [c, re] of LANG_MATCH) if (re.test(l)) set.add(c); return set; };
// Captions come from a once-a-day scrape (caption-cache.json), not a live Udemy
// lookup — this re-runs that scrape on demand so a caption added directly on
// Udemy shows up right away instead of waiting for the next 7am refresh.
function RefreshCaptionsButton({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const pollRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);

  async function start() {
    clearInterval(pollRef.current);
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/captions/refresh-cache', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      pollRef.current = setInterval(async () => {
        const r = await fetch('/api/captions/refresh-cache');
        const d = await r.json();
        if (!d.running) {
          clearInterval(pollRef.current); setBusy(false);
          setMsg(d.ok === false ? `Failed: ${d.error || 'unknown error'}` : 'Captions refreshed ✓');
          if (d.ok !== false) onRefresh?.();
        }
      }, 1500);
    } catch (e) { setBusy(false); setMsg(`Failed: ${e.message}`); }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {msg && <span className="muted small" style={{ fontSize: 12 }}>{msg}</span>}
      <button className="btn btn-secondary" onClick={start} disabled={busy}>{busy ? '↻ Refreshing…' : '↻ Refresh Captions'}</button>
    </span>
  );
}

function Captions({ udemy, onRefresh }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => { const s = q.trim().toLowerCase(); return s ? udemy.filter((c) => (c.title || '').toLowerCase().includes(s)) : udemy; }, [udemy, q]);
  const matrix = rows.slice(0, 40);
  return (
    <>
      <Header crumb="CAPTIONS" title="Captions & Localization" sub="Subtitle coverage and localization status" actions={<><RefreshCaptionsButton onRefresh={onRefresh} /><LocalizeCaptions courses={udemy} onDone={onRefresh} /></>} />
      <div className="chart-card" style={{ marginBottom: 22, overflowX: 'auto' }}>
        <h3>Coverage Matrix <span className="muted" style={{ fontWeight: 400 }}>(first {matrix.length} courses)</span></h3>
        <table style={{ minWidth: 520 }}>
          <thead><tr><th className="no-sort">Course</th>{COVER_COLS.map(([, l]) => <th key={l} className="no-sort" style={{ textAlign: 'center' }}>{l}</th>)}</tr></thead>
          <tbody>
            {matrix.map((c) => { const have = langCodes(c.caption_locales); return (
              <tr key={c.id}>
                <td style={{ fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</td>
                {COVER_COLS.map(([code]) => <td key={code} style={{ textAlign: 'center' }}><span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 4, background: have.has(code) ? '#10b981' : '#e5e7eb' }} /></td>)}
              </tr>
            ); })}
          </tbody>
        </table>
      </div>
      <div className="table-card">
        <div className="table-header"><input className="table-search" placeholder="Search courses…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="muted">{rows.length} courses</span></div>
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort">Course</th><th className="no-sort">Languages</th><th className="no-sort">Coverage</th><th className="no-sort">Action</th></tr></thead>
          <tbody>
            {rows.slice(0, 60).map((c) => {
              const have = langCodes(c.caption_locales);
              const pct = Math.round((COVER_COLS.filter(([code]) => have.has(code)).length / COVER_COLS.length) * 100);
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>{c.title}</td>
                  <td><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{capNames(c.caption_locales).slice(0, 4).map((l, i) => <span key={i} className="lang-chip">{l}</span>)}{capNames(c.caption_locales).length > 4 && <span className="lang-chip">+{capNames(c.caption_locales).length - 4}</span>}</div></td>
                  <td><span className="cov-track"><span className="cov-fill" style={{ width: pct + '%' }} /></span> <span style={{ fontSize: 13 }}>{pct}%</span></td>
                  <td><LocalizeCaptions courses={[c]} single onDone={onRefresh} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Coupons ----------------
// discount_value is the coupon's resulting PRICE in dollars (not a percent) —
// is_free is true exactly when that price is $0 (see couponCreate.js / scrapeCoupons.js).
// max_uses null means UNLIMITED, not zero — Udemy leaves it null on coupons with
// no redemption cap. Read as 0 it made every uncapped coupon look spent.
const couponLeft = (r) => (r.max_uses == null ? null : Math.max(0, r.max_uses - (r.used || 0)));

function Coupons({ udemy }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const rows = useMemo(() => {
    const list = [];
    udemy.forEach((c) => (c.coupons || []).forEach((cp) => list.push({ ...cp, course: c.title, courseId: c.id, courseUrl: c.url })));
    return list;
  }, [udemy]);
  // USED UP: every redemption taken while the dates still run. Udemy stops
  // listing these as valid, so they used to vanish from this page along with
  // any sign the course had a coupon at all. They are shown, never counted as
  // active, and never given a link — shared, a used-up link means full price.
  const usedUp = useMemo(() => {
    const list = [];
    udemy.forEach((c) => (c.coupons_used_up || []).forEach((cp) => list.push({ ...cp, course: c.title, courseId: c.id, courseUrl: c.url, usedUp: true })));
    return list;
  }, [udemy]);
  const usedUpCourses = new Set(usedUp.map((r) => r.courseId)).size;
  const active = useMemo(() => rows.filter((r) => r.active), [rows]);
  const totalUsed = active.reduce((s, r) => s + (r.used || 0), 0);
  const totalRemaining = active.reduce((s, r) => s + (couponLeft(r) ?? 0), 0);
  const unlimitedCount = active.filter((r) => couponLeft(r) == null).length;
  // Real quota from Udemy's /coupons-v2/meta/ (remaining_coupon_count, scraped
  // separately from the coupons themselves) — how many NEW coupons Udemy will
  // still let you create this month on each course. Not checked yet == null,
  // kept separate from 0 (quota used up) rather than silently treated as 0.
  const withQuota = udemy.filter((c) => c.remaining_coupon_count != null);
  const headroom = withQuota.filter((c) => c.remaining_coupon_count > 0).length;
  const totalCouponsLeft = withQuota.reduce((s, c) => s + (c.remaining_coupon_count || 0), 0);
  const notChecked = udemy.length - withQuota.length;
  const activeCourseCount = new Set(active.map((r) => r.courseId)).size;
  // Flag courses stacking more than one active coupon at once (worth a second look —
  // could mean two promos are competing for the same enrollment).
  const activeCountByCourse = useMemo(() => {
    const m = new Map();
    active.forEach((r) => m.set(r.courseId, (m.get(r.courseId) || 0) + 1));
    return m;
  }, [active]);
  const stackedCourses = [...activeCountByCourse.entries()].filter(([, n]) => n > 1);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = show === 'live' ? active : show === 'used' ? usedUp : [...active, ...usedUp];
    return s ? base.filter((r) => r.course.toLowerCase().includes(s) || (r.code || '').toLowerCase().includes(s)) : base;
  }, [active, usedUp, q, show]);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');

  const [qQuota, setQQuota] = useState('');
  const quotaRows = useMemo(() => {
    const s = qQuota.trim().toLowerCase();
    const list = s ? udemy.filter((c) => c.title.toLowerCase().includes(s)) : udemy;
    return [...list].sort((a, b) => (b.remaining_coupon_count ?? -1) - (a.remaining_coupon_count ?? -1));
  }, [udemy, qQuota]);

  return (
    <>
      <Header crumb="COUPONS" title="Coupons" sub="Active promotional codes across your Udemy courses" />
      <div className="kpi-grid">
        <Kpi icon="🎟️" bg="#eef2ff" fg="#4f46e5" label="Active Coupons" value={num(active.length)} trend={`across ${activeCourseCount} course${activeCourseCount === 1 ? '' : 's'}`} />
        <Kpi icon="👥" bg="#cce5ff" fg="#0066cc" label="Learners Used" value={num(totalUsed)} trend="redemptions so far" />
        <Kpi icon="🎯" bg="#dcfce7" fg="#10b981" label="Enrollment Slots Left" value={num(totalRemaining)} trend={`before capped coupons run out${unlimitedCount ? ` · +${unlimitedCount} with no cap` : ''}`} />
        <Kpi icon="⛔" bg="#fee2e2" fg="#dc2626" label="Used Up" value={num(usedUp.length)} trend={usedUp.length ? `ran out before their end date · ${usedUpCourses} course${usedUpCourses === 1 ? '' : 's'}` : 'none ran out early'} />
        <Kpi icon="➕" bg="#fef3c7" fg="#f59e0b" label="Coupon Creation Headroom" value={num(headroom)} trend={`courses with quota left · ${num(totalCouponsLeft)} total slots${notChecked ? ` · ${notChecked} not checked yet` : ''}`} />
      </div>
      {stackedCourses.length > 0 && (
        <div className="banner warn" style={{ marginBottom: 22 }}>
          ⚠️ {stackedCourses.length} course{stackedCourses.length === 1 ? '' : 's'} currently {stackedCourses.length === 1 ? 'has' : 'have'} more than one active coupon at once — two promos competing for the same enrollment:{' '}
          {stackedCourses.map(([cid], i) => {
            const codes = active.filter((r) => r.courseId === cid).map((r) => r.code).join(' + ');
            const name = active.find((r) => r.courseId === cid)?.course;
            return <span key={cid}>{i > 0 ? ', ' : ''}<b>{name}</b> ({codes})</span>;
          })}
        </div>
      )}
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search course or code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={show} onChange={(e) => setShow(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">Live + used up ({active.length + usedUp.length})</option>
            <option value="live">Live only ({active.length})</option>
            <option value="used">Used up only ({usedUp.length})</option>
          </select>
          <span className="muted">{shown.length} coupon{shown.length === 1 ? '' : 's'}</span>
        </div>
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort">Course</th><th className="no-sort">Code</th><th className="no-sort">Status</th><th className="no-sort">Type</th><th className="no-sort">Used / Max</th><th className="no-sort">Remaining</th><th className="no-sort">Expires</th><th className="no-sort">Link</th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>No coupons to show.</td></tr>}
            {shown.map((r, i) => {
              const remaining = couponLeft(r);
              const pct = r.max_uses ? Math.round(((r.used || 0) / r.max_uses) * 100) : 0;
              const stacked = !r.usedUp && (activeCountByCourse.get(r.courseId) || 0) > 1;
              const link = !r.usedUp && r.courseUrl ? `https://www.udemy.com${r.courseUrl}?couponCode=${encodeURIComponent(r.code)}` : null;
              return (
                <tr key={i} style={r.usedUp ? { opacity: 0.6 } : undefined}>
                  <td style={{ fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.course}{stacked && <span className="pill draft" style={{ marginLeft: 6, fontSize: 11 }}>×{activeCountByCourse.get(r.courseId)} active</span>}
                  </td>
                  <td className="mono">{r.code}</td>
                  <td>{r.usedUp ? <span className="pill" style={{ background: '#fee2e2', color: '#dc2626' }}>Used up</span> : <span className="pill ok">Live</span>}</td>
                  <td><span className={'pill ' + (r.is_free ? 'ok' : 'draft')}>{r.is_free ? 'Free enrollment' : `$${r.discount_value} price`}</span></td>
                  <td>{r.max_uses == null
                    ? <>{r.used || 0} <span className="muted">· no cap</span></>
                    : <>{r.used || 0}/{r.max_uses} <span className="cov-track" style={{ marginLeft: 6 }}><span className="cov-fill" style={{ width: pct + '%' }} /></span></>}</td>
                  <td>{remaining == null ? <span className="muted">Unlimited</span> : remaining}</td>
                  <td className="muted">{fmtDate(r.end)}</td>
                  <td>{link ? <a href={link} target="_blank" rel="noreferrer">Open ↗</a>
                    : r.usedUp ? <span className="muted" title="Every redemption has been taken — this link would no longer apply the coupon">no longer applies</span>
                    : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      <Header crumb="COUPONS" title="Coupon Creation Quota" sub="How many new coupons Udemy will still let you create this month, per course" />
      <div className="table-card">
        <div className="table-header">
          <input className="table-search" placeholder="Search course…" value={qQuota} onChange={(e) => setQQuota(e.target.value)} />
          <span className="muted">{quotaRows.length} shown</span>
        </div>
        <div className="table-scroll"><table>
          <thead><tr><th className="no-sort">Course</th><th className="no-sort">Active Coupons</th><th className="no-sort">Used Up</th><th className="no-sort">Coupons Left This Month</th></tr></thead>
          <tbody>
            {quotaRows.map((c) => {
              const activeCount = (c.coupons || []).filter((cp) => cp.active).length;
              const left = c.remaining_coupon_count;
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</td>
                  <td>{activeCount || <span className="muted">0</span>}</td>
                  <td>{(c.coupons_used_up || []).length
                    ? <span className="pill" style={{ background: '#fee2e2', color: '#dc2626' }} title={(c.coupons_used_up || []).map((x) => x.code).join(', ')}>{(c.coupons_used_up || []).map((x) => x.code).join(', ')}</span>
                    : <span className="muted">—</span>}</td>
                  <td>
                    {left == null ? <span className="muted" title="Quota not scraped yet for this course">not checked</span>
                      : left > 0 ? <span className="pill ok">{left} left</span>
                      : <span className="pill draft">0 left</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </>
  );
}

// ---------------- Settings (connect flows + theme + refresh) ----------------
function Settings({ conn, dark, setDark, lastUpdate, lastRun, onRefresh }) {
  const connected = conn?.connected;
  return (
    <>
      <Header crumb="SETTINGS" title="Settings" sub="Connections, appearance, and data" actions={<button className="btn btn-secondary" onClick={onRefresh}>↻ Refresh data</button>} />
      <div className="table-card" style={{ maxWidth: 680 }}>
        <div style={{ padding: 24 }}>
          <div className="setting">
            <label>Udemy connection</label>
            <div className={connected ? 'status-ok' : 'status-bad'} style={{ marginBottom: 10 }}>{connected ? '✓ Connected — session active' : '✕ Not connected'}</div>
            <ConnectUdemy onConnected={onRefresh} />
          </div>
          <div className="setting">
            <label>Coursera connection</label>
            <ConnectCoursera onConnected={onRefresh} />
          </div>
          <div className="setting">
            <label>FutureLearn connection</label>
            <ConnectFutureLearn onConnected={onRefresh} />
          </div>
          <div className="setting">
            <label>Go1 connection</label>
            <ConnectGo1 onConnected={onRefresh} />
          </div>
          <div className="setting-row">
            <label>LinkedIn Learning connection</label>
            <ConnectLinkedIn onConnected={onRefresh} />
          </div>
          <div className="setting">
            <label>Data feeds</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{['enrollment', 'revenue', 'captions'].map((k) => <span key={k} className={'pill ' + (conn?.data?.[k] ? 'ok' : 'draft')}>{k} {conn?.data?.[k] ? '✓' : '—'}</span>)}</div>
          </div>
          <div className="setting">
            <label>Theme</label>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn btn-secondary" style={{ flex: 1, outline: dark ? 'none' : '2px solid #002fa7' }} onClick={() => setDark(false)}>☀️ Light</button>
              <button className="btn btn-secondary" style={{ flex: 1, outline: dark ? '2px solid #002fa7' : 'none' }} onClick={() => setDark(true)}>🌙 Dark</button>
            </div>
          </div>
          <div className="setting"><label>Last data refresh</label><div className="muted">{relTime(lastUpdate)} — updates run daily</div></div>
          <div className="setting">
            {/* Per-step outcome of the last daily run. Previously only
                last-update.json held this and nothing read it, so a run with
                four failed steps was indistinguishable from a clean one. */}
            <label>Last update run</label>
            {!lastRun ? <div className="muted">No run recorded yet.</div> : (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>
                  Finished {relTime(lastRun.finishedAt)}
                  {lastRun.results?.some((r) => r.ok === false)
                    && <b style={{ color: '#dc2626' }}> — {lastRun.results.filter((r) => r.ok === false).length} step(s) failed</b>}
                </div>
                <div className="run-steps">
                  {(lastRun.results || []).map((r) => (
                    <div key={r.name} className={'run-step ' + (r.skipped ? 'skip' : r.ok ? 'ok' : 'bad')}>
                      <span>{r.skipped ? '⏭' : r.ok ? '✓' : '✕'}</span>
                      <span className="rs-name">{r.name}</span>
                      <span className="muted">{r.skipped ? r.skipped : `${r.secs}s`}</span>
                    </div>
                  ))}
                </div>
                {lastRun.results?.some((r) => r.ok === false) && (
                  <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
                    A failed step means the write guard refused bad data, so the old figures are still
                    in place — they are simply not current. The usual cause is an expired session:
                    reconnect the platform above and re-run.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------- shared ----------------
// WHEN THE NUMBERS ON THIS PAGE ARE FROM. Shown only when they are older than
// STALE_DAYS, and named by source, so "Revenue: 34 days" is on the page that
// shows revenue rather than buried in Settings. On "All Platforms" it lists
// every platform that is behind, since the overview mixes them all.
const STALE_DAYS = 2;
const PLATFORM_NAMES = { udemy: 'Udemy', coursera: 'Coursera', coursera_cin: 'Coursera CIN', futurelearn: 'FutureLearn', linkedin: 'LinkedIn', go1: 'Go1' };
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function StaleBanner({ freshness, platform }) {
  if (!freshness) return null;
  const keys = platform === 'all' ? Object.keys(PLATFORM_NAMES) : [platform];
  const stale = keys
    .map((k) => [k, (freshness[k]?.sources || []).filter((x) => x.ageDays != null && x.ageDays > STALE_DAYS)])
    .filter(([, list]) => list.length);
  if (!stale.length) return null;
  return (
    <div className="banner warn" style={{ marginBottom: 16 }}>
      ⏳ <b>Some figures here are not current.</b>{' '}
      {stale.map(([k, list], i) => (
        <span key={k}>{i > 0 ? ' · ' : ''}<b>{PLATFORM_NAMES[k]}</b> — {list.map((x) => `${x.label.toLowerCase()} as of ${fmtDay(x.updatedAt)} (${Math.round(x.ageDays)} days)`).join(', ')}</span>
      ))}
    </div>
  );
}

function Header({ title, sub, actions, crumb }) {
  return (<div className="page-header"><div>{crumb && <div className="page-crumb">{crumb}</div>}<h1 className="page-title">{title}</h1><p className="page-subtitle">{sub}</p></div>{actions && <div className="header-actions">{actions}</div>}</div>);
}
function Kpi({ icon, bg, fg, label, value, trend, big = true }) {
  return (<div className="kpi-card">{icon && <div className="kpi-icon" style={{ background: bg, color: fg }}>{icon}</div>}<div className="kpi-label">{label}</div><div className="kpi-value" style={{ color: fg && !icon ? fg : undefined, fontSize: big ? undefined : 18 }}>{value}</div>{trend && <div className="kpi-trend">{trend}</div>}</div>);
}
function BookmarkButton({ active, onClick, title }) {
  return (
    <button
      className="bookmark-btn"
      title={title || (active ? 'Remove from Watchlist' : 'Add to Watchlist')}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ color: active ? '#f59e0b' : '#c8ceda' }}
    >
      {active ? '★' : '☆'}
    </button>
  );
}
