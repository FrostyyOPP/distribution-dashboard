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

---

## 12. Master royalty sheet from SharePoint (Microsoft Graph)

Most platforms expose no revenue a scraper can read — Coursera has no revenue
API, FutureLearn shows partners nothing, Go1 has no reporting on this account.
The master spreadsheet is the authoritative record, and Graph pulls it directly.

Graph is used rather than a captured session because **client credentials do not
expire**. Every other platform here needs reconnecting roughly weekly; this one
runs unattended.

### Azure app registration (one-off, ~20 minutes)

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.**
   Name it something like `distribution-dashboard`. Single tenant. No redirect URI.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** from Overview.
3. **Certificates & secrets → New client secret.** Copy the **Value** immediately —
   it is shown once, and the *Secret ID* is not the secret.
4. **API permissions → Add → Microsoft Graph → Application permissions.**
   Choose **`Sites.Selected`** — it grants nothing until a specific site is
   granted to the app, which is why it is preferred over `Sites.Read.All`.
   Then **Grant admin consent**.
5. Grant the app access to just that one site (run as a Graph admin):

   ```
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   { "roles": ["read"],
     "grantedToIdentities": [ { "application": { "id": "<client-id>", "displayName": "distribution-dashboard" } } ] }
   ```

   With `Sites.Read.All` instead, step 5 is unnecessary — but the app can then
   read every site in the tenant, which is more access than this needs.

### Configure

Add to `server/.env` (gitignored — **never commit the secret; this repo is public**):

```ini
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
SHAREPOINT_HOST=yourtenant.sharepoint.com
SHAREPOINT_SITE_PATH=/sites/YourSite
MASTER_REVENUE_PATH=/Finance/Master Royalty.xlsx
```

### Use

```bash
npm run revenue:sync -- --check        # prove credentials + site access
npm run revenue:sync -- --list         # list files, to find the right path
npm run revenue:sync -- --list=/Finance
npm run revenue:sync -- --dry-run      # download + parse, write nothing
npm run revenue:sync                   # download + import
```

`--check` reports the specific Azure failure rather than a generic 401:
`AADSTS7000215` is a wrong secret, `AADSTS700016` a wrong client id, and a 403
on `/sites` means consent was not granted.

Every download is kept under `server/snapshots/sharepoint/`, so the importer can
be adjusted against the exact file that was fetched without re-downloading.

Rows are keyed on platform + course + period and **upserted**, so re-importing a
corrected sheet fixes figures in place, and periods the file omits are left
alone rather than deleted.

### Title mapping — which title is shown, which title joins

Two different jobs, two different columns:

| | Column in the sheet | Used for |
|---|---|---|
| **Display** | `Title on <Platform>` | What the dashboard prints for that platform |
| **Mapping** | `Original Title` | The key that joins the same course across platforms |

The parent title is what makes "Colaboración Fluida Entre Equipos" on Go1 and
"Cross-Team Collaboration Strategies" on FutureLearn add up to one course. No
fuzzy matcher would ever pair those, and none is used — the join is exact on the
parent, normalised only for case, accents, punctuation, `&` vs `and`, trailing
years and marketing words. A near-miss stays a separate row rather than silently
merging two courses and reporting one wrong total.

`courseMappingKey()` in `server/db.js` is the single definition of that
normalisation, and `writeRevenueMaster()` derives the key itself rather than
trusting the caller, so no importer can key the same course differently.

**Coursera is nearly, but not quite, the single-title case.** Its listing name
usually *is* the parent title — of 6,634 rows on `By Product`, 5,941 match
exactly. The remaining 693 do not, in two distinct ways:

- **366 genuine renames.** Coursera publishes "Digital Literacy: Introduction to
  Mobile Phone Basics" where the parent is "Introduction to Mobile Phone Basics".
  Handled normally: display the Coursera name, map on the parent.
- **327 bundles** (Specializations and Professional Certificates). Here
  `Starweaver Name` holds a comma-joined **list of member courses**, not one
  title. Mapping on it would invent a course that does not exist, so these map
  on the Coursera name and the membership is kept in the row's note.

**Duplicate rows are summed, not overwritten.** A sheet routinely carries several
rows for one course and quarter — Coursera splits each across `Course`,
`Coursera Plus` and `Specialization` product types. `writeRevenueMaster()`
aggregates before writing; without it only the last product type survived and
Coursera Q2'24–Q2'26 read $5,739 instead of $239,398.

**Udemy sheet rows are imported but never counted.** Every revenue reader filters
`platform <> 'Udemy'`, because Udemy's figures come from the live scrape. The
rows are imported anyway for their `Original Title` ↔ `Title on Udemy` pairs,
which are the only way to attach scraped Udemy revenue to a parent course.

### The title map — for platforms whose titles drift

An `Original Title` in the sheet joins the sheet-fed platforms to each other.
It does **not** join Udemy, because Udemy's revenue comes from the live scrape
and its titles get edited for marketing. A sheet written last quarter says
*"Credit Risk Essentials: Analytics, AI & Underwriting"*; the course now lists as
*"Credit Risk Analysis & AI-Powered Underwriting 2026"*. Only 5 of 31 pairs still
reached a live title, so nearly all of Udemy's revenue sat unmapped.

Four sources already carry the answer, and `importTitleMap.js` reads them all
into `course_title_map` — every known spelling pointing at one parent:

```bash
node importTitleMap.js            # every source found
```

| Source | Refresh | Adds |
|---|---|---|
| `~/marketing-tool/data/data.json` | **daily, 08:30 launchd** | 157 |
| `~/Downloads/SWO-Distribution-Matrix.xlsx` | manual | 552 |
| `~/Downloads/SWO-Batches-Distribution.xlsx` | manual | 2 |
| `~/Downloads/Udemy title Mapping.xlsx` | manual | 3 |

The **marketing dashboard is read first and wins ties**, because it is the only
source that re-fetches the live catalogues on its own — the others are manual
downloads that go stale the moment a platform renames something.

Together: Udemy goes from 5 to **138 of 141 scraped courses resolved, 98.7% of
its revenue**. The writer upserts, so an alias learnt once is never dropped.

Two guards, because these files mix statuses in with titles:

- **Placeholders are skipped.** The matrix writes `Udemy Exclusive` (31 rows) and
  `Coursera Exclusive Batch` (59 rows) to mean "no separate child title here".
  Read literally, each becomes one alias pointing at whichever parent was read
  first, misattributing every course behind it.
- **A title claimed by 3+ parents is dropped**, not attached to one at random —
  a structural catch for any label the pattern above misses. Exactly two is a
  real disagreement: the first source wins and the run prints both.

Resolution order in `readCourseRevenueAcrossPlatforms()`: the title map first
(maintained against the live catalogue), then the sheet's own pairing, then the
title as-is.

### Why so few courses show as multi-platform

Currently 39 of 508. That is mostly real, not a matching failure — the royalty
sheets cover **different batches**:

| Sheet | Batches |
|---|---|
| Coursera (`Revenue Share By Product … ALEX.V2`) | 6 – 10 |
| Go1, FutureLearn, Udemy | 1 – 3 |

So Coursera's 366 earning courses and the other platforms' 73 are disjoint sets
of courses, and 0 overlap between them is the correct answer for this data, not
a bug. Confirm it the same way if the number looks wrong again: compare the
`Batch` column across the sheets before suspecting the matcher.


### Rule: Coursera CIN is exclusive

Coursera CIN never shares a course with another platform. It is a separate
catalogue, not a second channel for the same courses:

- 324 parent courses, **0 in common** with Udemy, FutureLearn, Go1 or LinkedIn
  (and 1 title coinciding with Starweaver Coursera — *Procurement for
  Governments* — which is a coincidence of wording, not the same course).
- Its own batch series, **6–10**, numbered independently of Starweaver's 1–7.
  The two overlap at 6 and 7 and mean different things, so CIN's are shown as
  `CIN Batch 6` … `CIN Batch 10`.

`EXCLUSIVE_PLATFORMS` in `server/db.js` enforces this rather than leaving it to
the data: a CIN title is never resolved through the shared title map, and CIN
groups are namespaced by platform. A future coincidence of wording therefore
cannot merge a CIN course into a Starweaver one and report the pair as a single
cross-platform course.

Add a platform to that set if it is ever licensed the same way.

### The master record — `server/titleMapOverrides.json`

Hand-curated, authoritative, and applied **after** every source, so nothing a
workbook says can overwrite it. Four sections:

| Section | Holds | Why it can't live in a sheet |
|---|---|---|
| `parentBatches` | the confirmed parents of a batch | the matrix's per-platform sheets have a ragged `Program`/`Batch` column, so the importer infers a batch that is sometimes wrong |
| `batches` | corrections to an inferred batch | same |
| `parents` | a renamed title → its real parent | no sheet records that two parent titles are the same course |
| `smes` | the SME assigned to each parent | — |

**Adding a batch:** paste the parent titles and SMEs into `parentBatches` and
`smes`, then `node importTitleMap.js`.

**Keep the SME column.** It is the identifier of last resort. Four of SWO Batch 1's
18 parents had been renamed on Coursera past anything a normaliser could match,
and were found only because the assigned SME matched on both sides:

| Parent | Coursera title | Found via |
|---|---|---|
| AI-Driven Sales Forecasting and Market Analysis | Gen AI Sales Forecasting and Marketing Analysis | Christopher Klaus |
| ChatGPT for Product Management & Innovation | ChatGPT (and other AI) for Product Management & Innovation | Vipesh Singla |
| GenAI CEO Playbook: Amplifying Visionary Leadership | CEO Playbook: Generative AI | Julian Jenkins |
| Unlock B2B and B2C Sales with Data | Master Data Storytelling for B2B & B2C Sales | João Freitas |

Guessing from wording would have been wrong in every one of those cases, and
fuzzy matching is deliberately not used anywhere — a near-miss stays a separate
course rather than silently merging two.

**SWO Batch 1 as it stands:** 18 parents, all 18 live on Coursera as 27 courses
(3 academies split 4 ways each). The 13 Udemy-only titles that were being
inferred into Batch 1 are a separate cohort, `SWO Batch 1 Specialization`.

## 13. The reconciliation pipeline

How a figure earns its place on the dashboard. `server/reconcile.js` runs it.

```
  1. SCRAPE        live course titles from each platform
  2. RESOLVE       live title -> parent, via course_title_map
  3. LOAD          that platform's financial rows (SharePoint sheet, or the
                   Udemy scrape — see REVENUE_SOURCE)
  4. RECONCILE     live title  <->  parent  <->  financial row
  5. CORROBORATE   batch and SME must agree on both sides
  6. PUBLISH       only what reconciles
```

**Three independent things have to agree** before a number is trusted: the
platform says the course is live, the master record says which parent it is, and
the sheet says what it earned. Batch and SME are the corroboration — they are
not join keys, they are how you catch a join that is wrong.

Each live title is graded by the evidence behind it:

| Grade | Meaning |
|---|---|
| `confirmed` | a tracker names this exact title as a child of a parent in a confirmed batch |
| `mapped` | it resolves to a parent, but no tracker names it for this platform |
| `unmapped` | nothing knows what this course is |

### The rule that matters

**Money is never discarded to make a report balance.** A financial row that
resolves to no parent is not skipped — it goes to an unmatched bucket, and

```
    in scope  +  other batches  +  no parent  ==  source total
```

must hold to the cent, per platform. `reconcile.js` prints that check and says
`NO — SOME REVENUE IS UNACCOUNTED FOR` when it fails. A reconciliation that
balances by ignoring rows is worse than no reconciliation, because it looks
right. The large "no parent" figures are not errors: Udemy's $575k is the older
catalogue, outside the confirmed batches. They are shown precisely so nobody
mistakes the in-scope figure for the platform total.

### Getting a platform to `confirmed`

A platform reaches `confirmed` only once a children tracker is loaded into
`titleMapOverrides.platformChildren`. Udemy and Go1 have one; Coursera's mapping
came from the distribution workbooks, which is why its live titles grade as
`mapped` rather than `confirmed` despite all 54 parents resolving.
