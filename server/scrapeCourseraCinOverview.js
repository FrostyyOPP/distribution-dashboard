// Reads the Coursera partner "Institution Overview" Looker dashboard KPI tiles
// (launched courses/specializations/etc.) via session + headed browser.
// Detailed enrollment/revenue live in Looker interactive charts (not text-scrapable);
// use Looker's "Download data" for those. Writes to dashboard.db via db.js's
// guarded writer. Run: npm run coursera-cin:overview
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';
import { writeCourseraCinOverview } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(__dirname, 'coursera-auth.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(AUTH_FILE)) {
  console.error('❌ Coursera not connected.');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ storageState: AUTH_FILE, userAgent: UA });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();

await parkWindow(ctx, page); // out of sight, but rendering — Looker skips tiles it thinks are hidden
console.log('Opening the partner analytics (Looker) dashboard…');
await page.goto('https://www.coursera.org/admin/coursera/analytics/monitor', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await sleep(14000); // Looker render

const kpis = {};
for (const f of page.frames()) {
  if (!/looker/.test(f.url())) continue;
  const txt = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
  const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
  // "<number>" followed by "Launched <X>" label
  for (let i = 0; i < lines.length - 1; i++) {
    const n = lines[i].replace(/,/g, '');
    if (/^\d+$/.test(n) && /^Launched /.test(lines[i + 1])) {
      kpis[lines[i + 1]] = Number(n);
    }
  }
}
await browser.close();

// NOTHING PARSED IS A FAILURE, NOT A SUCCESS. The write guard only protects rows
// that already exist, so into an empty table an empty result passed as "✅ {}"
// — which is all the CIN overview ever produced, from July to September.
if (!Object.keys(kpis || {}).length) {
  console.error('❌ No KPIs found on the page. Nothing written.');
  process.exit(1);
}
const result = writeCourseraCinOverview(kpis);
if (result.guarded) {
  console.error('⚠️ Refused to write — KPIs parsed looks like a partial/failed run. Kept existing data. Re-run after reconnecting.');
  process.exit(1);
}
console.log('✅ Overview KPIs:', JSON.stringify(kpis));
console.log('   Saved to dashboard.db. (Detailed enrollment/revenue need Looker CSV export.)');
