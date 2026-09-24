// THE GO1 CATALOGUE ITSELF — every Starweaver course on Go1, with the language
// Go1 records for it. Run: npm run go1:catalog
//
// WHY THIS EXISTS. The other two Go1 scrapers read the Insights "Learning
// Content" table, which lists only courses that have had learners in a given
// month. Used as the catalogue, that missed every course nobody had started:
// on 2026-09-24 it held 145 courses against 182 live, including all 7 French
// ones. And it carried no language at all, so language was guessed from titles.
//
// Go1 Learn reads its library from gateway.go1.com/learning-objects, where each
// course carries relevance.language and lifecycle.state. That is the catalogue.
//
// The API wants the bearer token and headers the Go1 Learn app sends. Rather
// than handle a token, this lets the app make its own library request and
// repeats it with the same headers, from inside the page, for the pages it
// needs. The token stays in memory in the browser; nothing is logged or saved.
//
// Links: Go1 has no public course page. /play/<id> on the Starweaver portal
// opens the course for anyone signed in to Go1 — checked on 2026-09-24.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { writeGo1Catalog } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'go1-auth.json');
const PORTAL = 'https://starweaver.mygo1.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Go1 not connected. Use "Connect Go1" in the dashboard first.');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA, viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
// Parked, not minimized: the Go1 Learn app only fires its library request once
// it has rendered the search page.
await parkWindow(ctx, page);

let headers = null;
page.on('request', (r) => {
  if (!headers && /gateway\.go1\.com\/learning-objects\?/.test(r.url())) {
    headers = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => !/^(host|cookie|content-length|:)/i.test(k)));
  }
});

console.log('Opening Go1 through the Starweaver portal…');
// The saved login belongs to the portal; Go1 Learn picks it up by redirect.
await page.goto(`${PORTAL}/p/#/app/search?keyword=starweaver`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(8000);
if (/\/login\b/.test(page.url())) {
  console.error('❌ Go1 session expired — the saved login lands on the Go1 sign-in page.');
  console.error('   Reconnect Go1 from the dashboard (Settings → Connect Go1), then re-run. Nothing written.');
  await browser.close();
  process.exit(1);
}
await page.goto('https://learn.go1.com/search/items?q=starweaver', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
for (let i = 0; i < 25 && !headers; i++) await sleep(1000);
if (!headers) {
  console.error('❌ Go1 Learn never made its library request, so there was nothing to repeat. Nothing written.');
  await browser.close();
  process.exit(1);
}

const get = (path) => page.evaluate(async ([p, h]) => {
  const r = await fetch('https://gateway.go1.com' + p, { headers: h });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, headers]);

const INCLUDE = ['core', 'relevance', 'provider', 'lifecycle', 'quality'].map((x) => `include%5B%5D=${x}`).join('&');
const first = await get('/learning-objects?limit=0');
const total = first.json?.total;
if (first.status !== 200 || !total) {
  console.error(`❌ The library request came back ${first.status} with no total. Nothing written.`);
  await browser.close();
  process.exit(1);
}

const items = [];
for (let offset = 0; offset < total; offset += 50) {
  const res = await get(`/learning-objects?limit=50&offset=${offset}&${INCLUDE}`);
  if (res.status !== 200) {
    console.error(`❌ Page at offset ${offset} came back ${res.status}. Nothing written — a partial list is not a catalogue.`);
    await browser.close();
    process.exit(1);
  }
  for (const h of res.json?.hits || []) {
    items.push({
      loId: String(h.lo_id || ''),
      title: (h.core?.title || '').trim(),
      type: h.core?.type || null,
      language: h.relevance?.language || null,
      state: h.lifecycle?.state || null,
      provider: h.provider?.name || null,
      rating: h.quality?.user_rating?.five_star_rating ?? null,
      ratingsCount: h.quality?.user_rating?.ratings_count ?? null,
      durationMinutes: h.relevance?.duration ?? null,
      url: h.lo_id ? `${PORTAL}/play/${h.lo_id}` : null,
    });
  }
  process.stdout.write(`\r  ${items.length}/${total}`);
  await sleep(400);
}
process.stdout.write('\n');
await browser.close();

if (items.length !== total) {
  console.error(`❌ Listed ${items.length} of the ${total} Go1 reports. Nothing written.`);
  process.exit(1);
}
const result = writeGo1Catalog(items.filter((i) => i.loId && i.title));
if (result.guarded) {
  console.error(`⚠️ Refused to write — ${items.length} items is far fewer than last time. Kept existing data.`);
  process.exit(1);
}
const count = (k) => items.reduce((a, i) => ((a[i[k] ?? '?'] = (a[i[k] ?? '?'] || 0) + 1), a), {});
console.log(`✅ ${items.length} Go1 items → dashboard.db · by type ${JSON.stringify(count('type'))} · by language ${JSON.stringify(count('language'))}`);
