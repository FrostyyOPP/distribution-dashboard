# Setting this up on a new machine

The Distribution Dashboard collects course, revenue and engagement data from
five platforms that offer no usable API, stores it in SQLite, and serves it as a
local web app.

Everything here works on **macOS and Windows**. Five things differ between them
and each is called out inline.

---

## 1. What "the main machine" means

Whichever machine holds these three things is the source of truth:

- `server/dashboard.db` — every figure the dashboard shows
- `server/*-auth.json` — the logged-in session for each platform
- the scheduled job that runs the scrapers

**Run the scrapers on exactly one machine.** Two machines scraping means two
databases that quietly diverge with no way to merge them, and platforms —
LinkedIn especially — react badly to one account automating from two IPs.

Other machines should read over HTTP instead:

```bash
curl -u <user>:<pass> https://<your-host>/api/export.xlsx -o all-platforms.xlsx
```

One request, every platform, any OS. See §8.

---

## 2. Prerequisites

| | |
|---|---|
| **Node 24** | **not 26.** `better-sqlite3` is a native module and its ABI breaks on 26 with `ERR_DLOPEN_FAILED`. This is the single most common setup failure. |
| Git | |
| A real browser | Playwright downloads its own Chromium |
| Python 3 + openpyxl | only for building spreadsheet deliverables |

```bash
# macOS / Linux
nvm install 24 && nvm use 24

# Windows (PowerShell, via nvm-windows)
nvm install 24.15.0
nvm use 24.15.0

node -v     # must print v24.x
```

**Windows also needs C++ build tools** so `better-sqlite3` can compile:
install "Desktop development with C++" from the Visual Studio Build Tools,
or run `npm i -g windows-build-tools`.

---

## 3. Install

```bash
git clone https://github.com/FrostyyOPP/distribution-dashboard.git
cd distribution-dashboard

cd server && npm install && npx playwright install chromium && cd ..
cd client && npm install && npx vite build && cd ..
```

If `npm install` fails in `server/` on `better-sqlite3`, you are almost
certainly on the wrong Node — check `node -v` before anything else.

---

## 4. Configuration

Create `server/.env` — it is gitignored and must never be committed:

```ini
# Udemy instructor API key (Settings -> API clients in the Udemy instructor UI)
UDEMY_API_KEY=your-key-here

PORT=5055

# Basic-auth pair protecting the dashboard. Choose your own; do not reuse
# anything published anywhere.
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=choose-a-strong-one
```

`DASHBOARD_PASSWORD` guards every page and every API route, including the full
data export. Treat it as a real credential.

---

## 5. Connecting the platforms

None of these have an "authorise this app" flow, so the scrapers reuse your own
signed-in session. Start the server (§6), open Settings, and connect each one.

| Platform | Export cookies from | Notes |
|---|---|---|
| Udemy | `udemy.com` signed in as instructor | or run `npm run auth:udemy`, which opens a real Chrome and captures the session when you finish logging in |
| Coursera | `coursera.org` | expires most often — roughly weekly |
| FutureLearn | `futurelearn.com/admin/organisations/starweaver` | |
| Go1 | **`starweaver.mygo1.com`** | must be this host. An export from `go1.com` or `learn.go1.com` is a different session and every scrape lands on the login page |
| LinkedIn | `linkedin.com/learning/instructor-portal/analytics` | |

Cookie export uses the **Cookie-Editor** browser extension → Export → Export as
JSON → paste into the dashboard.

Sessions are stored as `server/<platform>-auth.json`, gitignored. **They are
portable** — copying them to another machine works, and saves re-authenticating.

---

## 6. Running it

```bash
cd server && npm start          # API + the built UI on http://localhost:5055
cd client && npm run dev        # optional: hot-reloading UI on :5173
```

Open `http://localhost:5055` and sign in with the values from `.env`.

Routes: `/` a landing page, `/distribution-dashboard` the main app,
`/marketing-dashboard` the catalog (needs the separate `marketing-tool` repo).

The redesigned UI (`client/src/v2/`) is the default. Append `?ui=old` for the
original app — the choice persists in `localStorage` — and `?ui=new` to return.

---

## 7. Scheduling

`npm run update` runs every scraper in sequence. One failing step never stops
the rest, and results land in `last-update.json` — which the dashboard reads, so
a failed run is visible in the sidebar rather than silent.

### macOS — launchd

Four agents live in `~/Library/LaunchAgents/`:

| Label | When |
|---|---|
| `com.starweaver.dashboard-backend` | always (KeepAlive) |
| `com.starweaver.dashboard-ngrok` | always (KeepAlive) |
| `com.starweaver.dashboard-update` | daily 07:00 |
| `com.starweaver.dashboard-monthly-snapshot` | 1st of the month, 07:00 |

```bash
launchctl load ~/Library/LaunchAgents/com.starweaver.dashboard-update.plist
launchctl kickstart -k gui/$(id -u)/com.starweaver.dashboard-update   # run now
launchctl list | grep starweaver
```

### Windows — Task Scheduler

launchd does not exist. Create the equivalent tasks:

```powershell
# daily scrape at 07:00
schtasks /create /tn "Dashboard update" /tr `
  "C:\nvm\v24.15.0\node.exe C:\path\to\distribution-dashboard\server\update-all.js" `
  /sc daily /st 07:00

# monthly rating snapshot, 1st at 07:00
schtasks /create /tn "Dashboard monthly snapshot" /tr `
  "C:\nvm\v24.15.0\node.exe C:\path\to\distribution-dashboard\server\snapshotCourseraRatings.js --closing" `
  /sc monthly /d 1 /st 07:00
```

Keep the backend running with a service wrapper (`nssm`, or a task set to
"run at startup" calling `npm start`).

### Linux — systemd

One service per always-on process (backend, tunnel) and a `systemd` timer for
the daily update. Everything else is identical; nothing in the Node code is
macOS-specific except the two items in §9.

**The machine must be awake.** A sleeping machine at 07:00 means no refresh —
launchd catches up on wake, Task Scheduler needs "Run task as soon as possible
after a scheduled start is missed" ticked.

---

## 8. Reading the data from elsewhere

```bash
curl -u <user>:<pass> https://<host>/api/export.xlsx -o all-platforms.xlsx
curl -u <user>:<pass> https://<host>/api/export.json
```

21 sheets, every platform, plus a README tab stating how old each feed is.
No scraping involved, so it works from any OS.

To publish the local server, `ngrok http 5055` (cross-platform). On the free
plan the hostname is assigned, cannot be renamed, and browsers see a one-time
interstitial — `curl` does not.

---

## 9. Windows differences, in full

1. **launchd → Task Scheduler** (§7).
2. **Four shell scripts are bash**: `server/refreshCaptionsOnce.sh`,
   `runTranslateAll.sh`, `runUploadAll.sh`, and `marketing-tool/scripts/refresh.sh`.
   Run them under WSL or Git Bash, or port them. Everything else is Node and
   runs natively.
3. **`updateUdemyThumbnails.js` calls `sips`**, the macOS image resizer, to make
   750x422 thumbnails. On Windows swap that one `execFileSync` for `sharp`
   (`npm i sharp`). Nothing else shells out to a platform tool.
4. **`better-sqlite3` needs C++ build tools** (§2).
5. **`refreshCaptionsOnce.sh` calls `launchctl`** to delete its own job when done.

---

## 10. Things that will waste your afternoon

- **Wrong Node.** `ERR_DLOPEN_FAILED` means Node 26, not a broken install.
- **Headless does not work.** Cloudflare blocks it on Udemy and Coursera. Every
  scraper runs a visible browser; it is minimised, not hidden. Leave it alone
  while it runs — closing the window kills the scrape.
- **An expired session rarely says so.** Coursera redirects to a login page,
  but **LinkedIn serves a "this page doesn't exist" shell** that reads like a
  dead URL, and **Go1's Insights iframe simply never renders**. If a scraper
  reports "not found", reconnect before debugging the selector.
- **Write guards refuse bad data.** A scrape returning 0 rows is rejected rather
  than wiping the table, and logged to `scrape_runs`. "Refused" in the output is
  the guard working, not a bug.
- **Looker under-reports Coursera enrollment**, by ~20% when it misbehaves. The
  daily job now re-reads enrollment from the admin table and repairs it straight
  after. Do not remove those two steps.
- **Pagination fails silently.** Several portals paginate 10 rows at a time; a
  slow page yields nothing and the run still "succeeds". The scrapers retry
  empty pages and reconcile against on-page totals — keep those checks.
- **Never commit** `.env`, `*-auth.json`, `dashboard.db`, `snapshots/`, or
  anything under `caption-files*/`. This repo is public and has leaked twice.

---

## 11. Moving the main machine

1. Stop the scheduled jobs on the old machine.
2. Copy `server/dashboard.db` and `server/*-auth.json` across.
3. Follow §2–§6 on the new machine.
4. Set up the schedule (§7) and confirm one manual `npm run update`.
5. Only then remove the jobs from the old machine.

The database is a single SQLite file — copying it is the whole migration.
