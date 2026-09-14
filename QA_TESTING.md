# QA Testing Flow — Distribution Dashboard

A repeatable checklist for verifying the dashboard after any change. Run through this
before considering a feature "done," and re-run the whole thing periodically (e.g.
monthly) to catch regressions.

Ground truth for all math checks comes from the API directly (`curl` against
`/api/*`), not from what the UI shows — always compute the expected number
independently, then compare.

## 1. Cross-platform math consistency

For **each** platform tab (All Platforms, Udemy, Coursera, FutureLearn, Go1), open
Overview and check:

- [ ] Total Courses trend breakdown sums to the big number (`udemy + coursera + futurelearn + go1`)
- [ ] Total Enrollments matches `curl` sums from `/api/courses`, `/api/coursera/metrics`,
      `/api/futurelearn/courses` (Go1 is intentionally excluded from the "All" sum —
      it's a monthly snapshot, not a lifetime total; this is documented in the trend text)
- [ ] Average Rating trend text discloses which platform(s) it covers (don't let a KPI
      silently scope to one platform while a chart right below it scopes to another)
- [ ] Lifetime Revenue matches `total_revenue` from `/api/courses` (note: this will
      NOT exactly equal the sum of the Courses table's Revenue column — Udemy's
      account-level total and per-course breakdown come from two different upstream
      endpoints and don't reconcile to the penny; a few-hundred-dollar gap is normal,
      a gap of thousands+ is worth re-checking)
- [ ] Every chart's data scope matches its own title (e.g. a section titled
      "(Udemy + Coursera)" should actually pool both, not just one)

Known intentional exceptions (not bugs — don't "fix" these):
- Go1 numbers are excluded from "All Platforms" lifetime enrollment sums (monthly snapshot)
- FutureLearn enrollment coverage is genuinely ~15-20% (the platform itself doesn't
  expose it for most courses) — this is not a scraper bug
- Coursera/FutureLearn/Go1 show "—" for Earnings/Minutes/Captions/Coupons — these are
  real Udemy-only features, not missing data

## 2. Buttons and interactive elements (per view)

**Courses (Udemy)**
- [ ] Search box: try a plain title fragment, and a smart-search phrase (`no coupons`,
      `rating below 4.3`) — verify the pill shows the parsed explanation and the
      row count matches an independent `curl` filter
- [ ] Clear search (✕ on the pill) resets to full list
- [ ] Domain filter dropdown changes the shown count
- [ ] Column sort (click header, click again to reverse) actually reorders rows
- [ ] Row click opens the detail drawer; all 4 drawer tabs (Instructors, Reviews,
      Q&A, Coupons) render without errors
- [ ] Refresh button re-fires all `/api/*` calls (check Network tab)
- [ ] Export CSV downloads without a console error
- [ ] Create Coupons / Localize Captions modals open, all fields render — **do not
      submit a live action without explicit user go-ahead**, since both write to the
      real Udemy account

**Coursera / FutureLearn / Go1 Courses**
- [ ] KPI cards match `curl` sums
- [ ] Column sort works
- [ ] Coursera's Instructor column (✓/✗) matches a spot-check against
      `npm run coursera:instructors` output

**Earnings**
- [ ] Days Live uses the course's `published_time` (fall back to `created` only if
      missing) — cross check one course's Days Live against `(today − published_time)`
      in days; if it's off by more than a day or two, check whether the priority
      order in `daysLive()` got reverted
- [ ] $/Day = Total Earning ÷ Days Live, spot check the arithmetic

**Minutes**
- [ ] Column headers show real month names and roll forward correctly as the month changes
- [ ] Export CSV header row matches the visible column month names

**Settings**
- [ ] All 4 connection statuses render (don't click Connect/Disconnect during a
      routine QA pass — that touches real auth state)
- [ ] Dark mode toggle actually re-themes the whole page (sidebar, cards, charts)
- [ ] "Last data refresh" freshness label updates after a Refresh

## 3. Console and network hygiene

After every view/platform combination above:
- [ ] `read_console_messages` (or browser devtools) shows zero errors
- [ ] No failed (4xx/5xx) requests in the Network tab

## 4. Performance spot checks

Run these after any backend change, and periodically regardless:

```bash
# API payload sizes and compression
curl -s -D - -o /dev/null -u admin:PASSWORD -H "Accept-Encoding: gzip" localhost:5055/api/courses | grep -i content-encoding
# should show "Content-Encoding: gzip" — if not, compression middleware broke

# Response latency (should be well under 100ms once warmed;
# only the very first request after a backend restart pays the live-Udemy-API cost)
for i in 1 2 3; do curl -s -o /dev/null -u admin:PASSWORD -w "%{time_total}s\n" localhost:5055/api/courses; done

# Static asset caching (fingerprinted /assets/ files should cache for a year)
curl -s -D - -o /dev/null -u admin:PASSWORD localhost:5055/assets/index-*.js | grep -i cache-control
```

If `/api/courses` is consistently slow (seconds, not milliseconds) even on repeat
requests, the in-memory `walkAllCourses()` cache in `server/index.js` may have been
removed or its TTL bypassed — that cache is the single biggest lever on this
dashboard's perceived speed, since the underlying course list otherwise requires a
live, sequential, multi-page call to the real Udemy API on every load.

## 5. Data-safety check (after any scraper change)

- [ ] Run the changed scraper once, confirm it does NOT log "Refused to write" /
      "guarded" unless a session is genuinely stale
- [ ] Confirm `scrape_runs` table (or the scraper's own stdout) shows `ok: true`
- [ ] Spot check that the affected numbers actually changed (not stuck on old cached
      values) — restart the backend (`launchctl kickstart -k gui/$(id -u)/com.starweaver.dashboard-backend`)
      after ANY code change (routes, JSX, CSS); a data-only scrape does NOT need a
      restart since the API reads the DB fresh per request

## 6. Deploy checklist

1. `cd client && npx vite build`
2. `launchctl kickstart -k gui/$(id -u)/com.starweaver.dashboard-backend`
3. Confirm the new bundle hash is being served: `curl -s -u admin:PASS localhost:5055/ | grep -o 'assets/index-[^"]*\.js'`
4. Confirm the public URL matches: same command against `https://remorse-baggy-cartload.ngrok-free.dev/`
5. Walk sections 1-3 above at least for the views touched by the change
