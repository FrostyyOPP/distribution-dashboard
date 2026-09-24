# How scraping works (Udemy + Coursera)

Everything here reads data we already own from platforms that offer no usable
export. There is no public API for most of it, so we drive the same endpoints
the web UI calls, using a real logged-in session.

---

## 1. The one thing to know first

**Almost nothing here uses an official API.**

| Platform | What is official | What we actually use |
|---|---|---|
| Udemy | `instructor-api/v1` — a Bearer API key (`UDEMY_API_KEY` in `.env`). Course list and basic fields only. | `api-2.0/…` — the internal endpoints the Udemy website itself calls. Revenue, coupons, captions, curriculum, thumbnails. Session cookies, not the API key. |
| Coursera | none for partners | `coursera.org/api/…` plus the partner console and its Looker analytics dashboard. |

The internal endpoints carry everything that matters, and they only accept a
browser session — hence the design below.

---

## 2. Why a visible browser window opens

Both platforms sit behind Cloudflare, which **blocks headless browsers**. So the
scrapers launch Playwright in *headed* mode (a real window), load the saved
session, and make the API calls **from inside the page** with `page.evaluate`.

That way every request inherits the cookies, the CSRF token, and the right
`Origin` — exactly as if you had clicked it yourself.

The window is minimised automatically (`browserWindow.js`). Leave it alone while
a scrape runs; closing it kills the scrape.

### Sessions

    server/udemy-auth.json      <- Udemy cookies
    server/coursera-auth.json   <- Coursera cookies

Both are **gitignored** — they are live credentials. Refresh them from the
dashboard's *Connect* buttons, or `npm run auth:udemy`.

Sessions lapse every couple of weeks. When one does, scrapers stop with
"session lost — reconnect", they do **not** write partial data.

---

## 3. The safety rule that matters most

A scrape that half-works is more dangerous than one that fails, because it
silently replaces good data with less data.

So every write goes through **`guardedReplaceAll`** in `db.js`, which **refuses**
the write when the new run is empty, or returns fewer than **50%** of the rows
already stored. It reports an error instead of wiping the table.

Where a source is legitimately partial (per-course revenue, enrollment), we use
**`upsertMerge`** instead: it updates and adds, and never deletes.

> This guard is not theoretical. Coursera's Looker dashboard has twice returned
> a short enrollment list that would have cut ~125,000 enrollments from the
> record. See "Known traps".

---

## 4. Udemy

### What runs

    npm run scrape:revenue      earnings: lifetime, monthly, per course
    npm run scrape:coupons      active coupons per course
    npm run scrape:captions     which caption languages each course has
    npm run scrape:engagement   minutes taught, active students
    npm run scrape:enrollment   per-course enrollment (slow, public pages)

### Useful endpoints

    /api-2.0/users/me/taught-courses/              course list (id + slug)
    /api-2.0/courses/{id}/coupons-v2/?invalid=false active coupons
    /api-2.0/courses/{id}/subscriber-curriculum-items/  lectures + asset ids
    /api-2.0/courses/{id}/assets/{aid}/captions/   captions on one lecture
    /api-2.0/share-holders/v2.0/{id}/total/        revenue share

### Captions pipeline (its own flow)

    scrapeCaptionFiles.js   download .vtt          -> caption-files-<lang>/<slug>/
    translateVttSentences.js translate             -> caption-files-<code>/<slug>/
    uploadCaptions.js       upload + publish       -> Udemy

Upload is four steps, reverse-engineered from Udemy Studio: request an S3
signature, PUT the file to S3, create a draft caption, then poll until Udemy
publishes it.

**Udemy scraping is currently switched OFF** in the daily job (`update-all.js`,
turned off 2026-08-13 at the owner's request). Run with `UDEMY_SCRAPING=on` to
re-enable. Scripts run directly are unaffected.

---

## 5. Coursera

Four partner accounts, addressed by numeric id:

| Partner | id |
|---|---|
| Starweaver | 1510 |
| IBM Skills Network | 348 |
| Coursera (CIN / house brand) | 1342 |
| Wiley | 4357 |

### What runs

    npm run coursera:courses          course list for the connected partner
    npm run coursera:metrics          enrollments, completions, ratings (Looker)
    npm run coursera:overview         top-line KPIs
    npm run coursera:status-reviews   launch status + reviews
    npm run coursera-cin:courses      CIN catalogue
    npm run coursera-cin:metrics      CIN per-course (slow: visits every page)

### Three different sources, by necessity

1. **Public APIs — no login.** `partners.v1`, `onDemandCourses.v1`,
   `onDemandSpecializations.v1`, `instructors.v1`. Best source when it suffices:
   `refreshCourseraCatalogue.js` rebuilds the course list with no session at all.
2. **Partner console + Looker.** The analytics dashboard renders tiles from
   `/querymanager/queries`; we capture that JSON as it flies past.
3. **Per-course pages.** The CIN account has no org-wide analytics, so its
   enrollment is read from each course's own overview page — ~467 pages, 30–50
   minutes. It runs last so nothing else is blocked behind it.

### Writing back

`updateCourseraInstructorLinks.js` is the only script that *changes* Coursera.
It PUTs to `instructorProfiles.v1`, alters **only** `social.websites`, re-sends
every other field verbatim, then re-reads and fails loudly if anything but
`social` differs. Originals are backed up first.

Note: the public read API lags a write by minutes. Verifying instantly looks
like a failure when it isn't.

---

## 6. Daily job

`update-all.js` runs every step in sequence, and one failure never stops the
rest. Results go to `last-update.json`.

Scheduled by launchd at 5am:

    ~/Library/LaunchAgents/com.starweaver.dashboard-update.plist

Steps whose session file is missing are skipped rather than failed.

---

## 7. Known traps

- **Node 24 only.** `better-sqlite3` will not load on the default Node 26
  (`ERR_DLOPEN_FAILED`). Use `~/.nvm/versions/node/v24.15.0/bin/node`.
- **Looker under-reports enrollment.** It has twice written a total ~125k low.
  `scrapeCourseraEnrollment.js` + `fixCourseraEnrollment.js` correct it — they
  are **not** chained to the metrics scrape yet, so check after a metrics run.
- **Coursera instructor URLs** must be `/instructor/~{id}`. The name-slug form
  404s.
- **starweaver.com channel links cannot be checked with curl** — the pages are
  client-rendered and return byte-identical HTML for real and invented slugs.
  Render them.
- **Udemy's money-reference validator** rejects the whole course-basics form if
  the title mentions money, even when you are only changing an image. Re-issue
  the same PATCH with `ignore_warnings: true`.
- **Google Translate quotas are per endpoint.** `translate.googleapis.com` gets
  blocked for hours under load; `clients5.google.com` has a separate bucket.
  `translateVttSentences.js` falls through three providers for this reason.
- **Course-level `caption_locales` only lists a language when it covers EVERY
  lecture.** A partly-captioned course reports an empty list, so the dashboard's
  Captions column shows "none" even when captions exist. Check per-asset
  (`/courses/{id}/assets/{aid}/captions/`) before believing it.
- **The learner endpoint hides unpublished captions.** `scrapeCaptionFiles.js`
  reads `users/me/subscribed-courses/…`, which only returns *published* captions.
  Drafts (`status: -1`, typically Udemy's own auto-generated ones) are invisible
  there. It now falls back to the instructor endpoint, which lists them — but
  their signed CDN URLs return **AccessDenied**, so a draft caption can be seen
  and not downloaded. Publishing it first is the only way to fetch it.
- **A 500-row Coursera export is truncated**, not complete. The importer warns.

---

## 8. Never commit

`udemy-auth.json`, `coursera-auth.json`, `dashboard.db`, `exports/`,
`coursera-instructor-backups.json`, `udemy-thumbnail-backups.json`,
`caption-files*/`.

They hold live sessions, instructor emails, and licensed content. This repo has
leaked twice; both times the history had to be rewritten.
