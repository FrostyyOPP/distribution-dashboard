# Distribution Dashboard

A self-hosted dashboard for Starweaver's course distribution across **Udemy,
Coursera (Starweaver and CIN partner sides), FutureLearn, LinkedIn Learning and
Go1** — courses, enrollment, revenue, minutes, captions and coupons in one
place, with search, sort and CSV export.

Almost none of this is available through an API. It is built around what each
platform actually exposes, with documented workarounds for the rest.

### Start here

| Document | |
|---|---|
| **[SETUP.md](SETUP.md)** | installing and running this on a new machine — macOS or Windows |
| [server/SCRAPING.md](server/SCRAPING.md) | how the scrapers work, and the traps that have bitten us |
| [UI_UX.md](UI_UX.md) | what the interface contains, for anyone redesigning it |

- **Express** backend that proxies the Udemy Instructor API (your key stays server-side)
- **React + Vite** frontend: searchable/sortable table, per-course detail drawer, CSV export
- **Playwright** scrapers for the data the API doesn't expose (enrollment, revenue, coupons)
- One-command **Render** deploy, gated by HTTP basic auth

---

## What the Udemy API does and doesn't give you

This was the hard-won part. Verified against the live API:

| Data | Available? | Source used here |
|------|-----------|------------------|
| Courses, ratings, review counts, published state | ✅ API | `GET /instructor-api/v1/taught-courses/courses/` (`fields[course]=@all`) |
| Reviews (rating + text) | ✅ API | `/taught-courses/reviews/?course=<id>` |
| Q&A | ✅ API | `/taught-courses/questions/?course=<id>` |
| **Student count / enrollment** | ❌ Not in API | Scraped from public course pages (Playwright) |
| **Revenue** | ❌ Not in API, not public | Authenticated scrape (your session) |
| **Coupons** | ❌ Not in API | Authenticated scrape / browser automation |
| **Caption / subtitle languages** | ❌ Not in API, not public | Authenticated scrape of `caption_locales` (your session) |

Notes for anyone building on the Udemy API:
- Auth is a **single key sent as `Authorization: Bearer <key>`** — *not* Basic auth / client-id+secret.
- The **Affiliate API was discontinued Jan 2025**; the Instructor API is in maintenance mode.
- Course IDs are opaque strings ending in `==` — pass them as query params, don't URL-encode into a path.

## Documentation

- **[SETUP.md](SETUP.md)** — full setup & operations guide (env vars, connect
  flows, scrapers, keeping it always-on). **Start here to run it on a new machine.**
- **[docs/UDEMY-INTERNAL-API.md](docs/UDEMY-INTERNAL-API.md)** — reverse-engineered
  `api-2.0` endpoints for the data + authoring the official API can't do
  (enrollment, revenue, coupons, captions, and full course/quiz/role-play creation).
- **[ROADMAP.md](ROADMAP.md)** — capabilities inventory + what's next.

## Quick start

### 1. Get an API key
Udemy instructor account → API key. Put it in `server/.env` (copy from `.env.example`):

```
UDEMY_API_KEY=your_key_here
```

### 2. Run it
```bash
# backend
cd server && npm install && npm run test:auth && npm run dev   # http://localhost:5055

# frontend (separate terminal)
cd client && npm install && npm run dev                        # http://localhost:5173
```

## API (backend)
| Route | Description |
|-------|-------------|
| `GET /api/health` | Is the key configured? |
| `GET /api/courses` | All taught courses (+ merged enrollment/revenue if scraped) |
| `GET /api/reviews?course=<id>` | Reviews for a course |
| `GET /api/questions?course=<id>` | Q&A for a course |
| `GET /api/udemy/*` | Generic passthrough to any instructor endpoint |

## Enrollment scraping (optional)
The API doesn't expose student counts, so they're scraped from public course pages:

```bash
cd server
npx playwright install chromium   # one-time
npm run scrape:enrollment         # caches to server/enrollment-cache.json
```

Udemy is behind Cloudflare, which rate-limits rapid same-session requests — so the
scraper uses a **fresh browser context per course** + a short delay (≈100% coverage,
intentionally slow). Re-runs **skip already-cached courses**; `--force` refreshes all.
The dashboard merges the cache automatically.

## Revenue & coupons (optional, authenticated)
These live only behind your Udemy login. Udemy blocks automated *logins*, so the
reliable path is to reuse your existing session via a cookie export:

1. Install the **Cookie-Editor** browser extension, open udemy.com logged in.
2. Export udemy.com cookies as JSON → save to `server/udemy-cookies.json`.
3. `npm run import:cookies` → writes a gitignored `udemy-auth.json` session.
4. `npm run discover` → captures the authenticated page structure to build parsers.

All session/financial files (`udemy-auth.json`, `udemy-cookies.json`,
`revenue-cache.json`, browser profiles) are **gitignored** and never deployed.

## Deploy (Render)
A single web service serves the API + built frontend, protected by HTTP basic auth.

1. Push to your own GitHub repo.
2. Render → **New + → Blueprint** → connect the repo (it reads `render.yaml`).
3. Set env vars: `UDEMY_API_KEY`, `DASHBOARD_PASSWORD` (and optionally `DASHBOARD_USER`, default `admin`).
4. Deploy → browser prompts for the password on first load.

> The deploy serves live API data in real time. Scraped data (enrollment/revenue)
> comes from cache files, which are gitignored — populate them locally and supply
> via a Render disk, or run the scrapers on a private always-on host.

## Security
- The API key lives only in `server/.env` / host secrets — never in the repo or the browser.
- The dashboard exposes private course data; always deploy it **password-protected**.
- Authenticated scraping reuses your Udemy session — keep `udemy-auth.json` private.

## Tech
React 18 + Vite · Node/Express · Playwright · deployed on Render.

## License
[MIT](LICENSE)
