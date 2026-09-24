# Distribution Dashboard — what the UI actually contains

A reference for anyone redesigning or extending the interface. It describes what
is on screen today, where each number comes from, and which conventions the
existing screens already follow.

Stack: **React 18 + Vite**, no UI framework, no component library. All styling is
hand-written CSS in one file. Charts are hand-rolled SVG — no charting library.

---

## 1. Shell

```
┌────────────┬──────────────────────────────────────────────┐
│  sidebar   │  platform tabs                               │
│            ├──────────────────────────────────────────────┤
│  Main      │  page title + actions                        │
│   nav      │  KPI row                                     │
│  Tools     │  charts / tables                             │
│            │                                              │
│  last upd. │                                              │
└────────────┴──────────────────────────────────────────────┘
```

- **Sidebar** — deep navy, fixed. Logo (dot + "Distribution Dashboard"), a
  **Main** group of 7 nav items, a **Tools** group with Settings, and a footer
  showing a relative "Last updated" time.
- **Platform tabs** — a horizontal segmented control above every view:
  `All Platforms · Udemy · Coursera · Coursera CIN · FutureLearn · Go1`.
  This is a **global filter**, not navigation — it re-scopes whichever view you
  are on. Coursera tabs get their own accent colour.
- **Mobile** — the sidebar collapses behind a `☰ Menu` button.

Everything is scoped under a single `.dcx` root class so the styles can never
leak into anything else on the page.

---

## 2. The seven views

| View | What it shows |
|---|---|
| **Overview** | KPI row + charts. Adapts entirely to the selected platform. |
| **Watchlist** | Only bookmarked courses, across every platform. |
| **Courses** | The full course table for the selected platform. |
| **Earnings** | Revenue: lifetime, monthly trend, per course. Udemy + Coursera. |
| **Minutes** | Minutes consumed, split Udemy / Udemy Business, plus Go1. |
| **Captions** | Caption-language coverage per course, and a refresh action. |
| **Coupons** | Active coupons per course and the coupon-creation quota. |
| **Settings** | Connect / disconnect each platform; theme. |

**Overview is platform-dependent, not one fixed layout.** Each platform supplies
different KPIs and a different chart set — e.g. Udemy leads with revenue and
ratings, Coursera with enrollments and completions, Go1 with minutes. A platform
with no data renders a `PlatformUnavailable` state rather than empty charts.

---

## 3. Components in use

Layout / chrome
: `Header` (page title + right-aligned actions), `Kpi` (label, value, optional
  delta), `StatusBadge`, `BookmarkButton`, `PlatformUnavailable`.

Tables
: One table pattern reused everywhere: sortable headers, a search box, a
  `ColumnPicker` (`☰ Columns` toggles visibility), and `⬇ Export CSV`.

Charts — all hand-written SVG in `charts.jsx`
: `BarChart` (horizontal, top-N), `Donut` (share by domain), `Histogram`,
  `LineChart` (monthly trend), `ChartPlaceholder` (empty state).

There is **no** design-system package, no Tailwind, no Recharts/Chart.js. Adding
one would be a real change of approach, not a drop-in.

---

## 4. Design tokens

Defined once on `.dcx` in `client/src/v2/v2.css`.

```
navy-900  #0a1a3f     sidebar / headings
navy-950  #071230     sidebar deep
blue-600  #002fa7     primary accent
teal-600  #0c9bae     secondary
orange-500 #ea7112    tertiary / FutureLearn
slate-400 #6b7ba0     muted text
border    #d3dbec     bg-app #f4f6fb
```

Platform colours: **Udemy** `#a435f0` · **Coursera** `#0066cc` ·
**Go1** `#0c9bae` · **FutureLearn** `#ea7112`.

Type: **Space Grotesk** (display), **IBM Plex Sans** (UI), **IBM Plex Mono**
(numerics), loaded from Google Fonts.

**Dark mode** is a `.dark` class on the root that re-points the same tokens —
not a separate stylesheet. Any new colour must be added as a token in both
blocks or it will break one theme.

Breakpoints: **1024px** and **640px**.

---

## 5. Interactions worth preserving

- **Bookmarks** persist server-side (`/api/bookmarks`), so the Watchlist follows
  the user across devices — it is not `localStorage`.
- **Smart search** parses a small query language, not just substring match:
  `rating > 4.5 and enrollments > 2000`, clauses joined by `and` or commas.
  Plain text falls back to "title contains". The parsed query is echoed back to
  the user in words.
- **CSV export** is per-view, each with its own column set (`exportCsv`,
  `exportMinutesCsv`, `exportCourseraCsv`, `exportFutureLearnCsv`,
  `exportGo1Csv`, `exportWatchlistCsv`).
- **Domain classification** (`classifyDomain`) buckets every course into a
  subject domain and gives it a stable colour used across all charts.
- Courses view is **keyed by platform** so React remounts it on tab change —
  otherwise the search box carries stale text between platforms.

---

## 6. Where the data comes from

The UI is read-only over a local Express API; there is no client-side database.

```
/api/courses              Udemy courses (+ revenue, captions, coupons)
/api/revenue/monthly      monthly revenue series
/api/engagement           minutes taught, active students
/api/coursera/metrics     Coursera Starweaver: enrollments, completions, rating
/api/coursera/reviews     review text
/api/coursera-cin/metrics Coursera CIN equivalents
/api/coursera-cin/reviews
/api/futurelearn/courses  FutureLearn course list + status
/api/go1/courses          Go1 latest month
/api/go1/lifetime         Go1 all months combined
/api/bookmarks            watchlist (GET/POST/DELETE)
/api/last-update          timestamp for the sidebar footer
/api/connection           per-platform connection state
```

Every table is refreshed by scrapers, not by the UI. See `server/SCRAPING.md`.

---

## 7. Constraints a redesign has to respect

- **Data is only as fresh as the last scrape.** The sidebar's "Last updated" is
  the honest signal and should stay visible.
- **Platforms are not symmetrical.** Udemy has revenue and coupons; Coursera has
  completions; Go1 has only monthly activity and no per-course status;
  FutureLearn has run status and visibility. A single unified table would have
  to show a lot of N/A — which is why Overview branches per platform today.
- **Some sources under-report.** Coursera's Looker export has twice returned low
  enrollment. Anywhere a number could be stale or partial, the UI should be able
  to say so rather than presenting a bare figure.
- The app is served at **`/distribution-dashboard`** behind basic auth, from a
  homepage that also links the Marketing Dashboard.

---

## 8. Files

```
client/src/v2/AppV2.jsx    1,365 lines — shell, all views, all components
client/src/v2/charts.jsx     191 lines — the five SVG chart primitives
client/src/v2/v2.css         229 lines — tokens, layout, dark mode, responsive
client/src/v2/data.js                  — enrich, filter, smart query, CSV export
client/src/App.jsx                     — the older v1 UI, still reachable via ?ui=old
server/index.js                        — API + static serving + basic auth
server/home.html                       — the two-card landing page
```

`AppV2.jsx` holds the entire application in one file. That is the first thing a
redesign would want to split.
