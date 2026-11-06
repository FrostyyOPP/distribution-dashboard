// ARE THE SAVED LOGINS STILL SIGNED IN? Opens one page per platform with its
// saved session and reads where it lands. Run first in every nightly update
// (update-all.js), and on its own any time:  node checkSessions.js
//
// Why: the logins last about a week, and an expired one fails quietly — each
// step refuses to write, the dashboard keeps showing old figures, and nobody
// notices for days (Udemy and Go1 on 2026-10-20 → 22). This turns that into a
// same-day warning: a macOS notification naming what to reconnect, and
// session-status.json, which the dashboard reads to show a red banner.
//
// Each platform ends up as:
//   ok             signed in
//   expired        the page redirected to a sign-in page — reconnect it
//   not connected  no saved login at all
//   unknown        the page did not load either way (network, slow page) —
//                  not treated as expired, so a slow morning raises no alarm
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// AUTH_DIR / STATUS_FILE / NO_NOTIFY exist for testing the expired path against
// empty login files without touching the real ones or alerting anybody.
const AUTH_DIR = process.env.AUTH_DIR || __dirname;
const OUT = process.env.STATUS_FILE || join(__dirname, 'session-status.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same signals the scrapers use to say "session expired".
const PLATFORMS = [
  { id: 'udemy', label: 'Udemy', file: 'udemy-auth.json', url: 'https://www.udemy.com/instructor/courses/',
    signedIn: (u) => /udemy\.com\/instructor\//.test(u), signedOut: (u) => /\/join\/|\/login/.test(u) },
  { id: 'coursera', label: 'Coursera', file: 'coursera-auth.json', url: 'https://www.coursera.org/admin/starweaver/home/courses',
    signedIn: (u) => /\/admin\/starweaver\//.test(u), signedOut: (u) => /coursera\.org\/?(\?|$)|\/login/.test(u) },
  { id: 'futurelearn', label: 'FutureLearn', file: 'futurelearn-auth.json', url: 'https://www.futurelearn.com/admin/organisations/starweaver/courses-all',
    signedIn: (u) => /\/admin\/organisations\/starweaver/.test(u), signedOut: (u) => /\/sign-in|\/login/i.test(u) },
  { id: 'go1', label: 'Go1', file: 'go1-auth.json', url: 'https://starweaver.mygo1.com/p/#/app/search?keyword=starweaver',
    // A signed-in portal session hands over to Go1 Learn (learn.go1.com/overview).
    signedIn: (u) => /mygo1\.com\/p\/|learn\.go1\.com\//.test(u) && !/\/login\b/.test(u), signedOut: (u) => /\/login\b/.test(u) },
  { id: 'linkedin', label: 'LinkedIn', file: 'linkedin-auth.json', url: 'https://www.linkedin.com/learning/instructor-portal/analytics',
    signedIn: (u, t) => /instructor-portal/.test(u) && !/page doesn.?t exist|Page not found|Join now\s+Sign in/i.test(t),
    signedOut: (u, t) => /\/login|\/uas\/login|authwall/.test(u) || /page doesn.?t exist|Page not found|Join now\s+Sign in/i.test(t) },
];

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { platforms: {} };
const now = new Date().toISOString();
const status = {};

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
for (const p of PLATFORMS) {
  const authPath = join(AUTH_DIR, p.file);
  if (!existsSync(authPath)) { status[p.id] = { label: p.label, status: 'not connected' }; continue; }
  const ctx = await browser.newContext({ storageState: authPath, userAgent: UA });
  const page = await ctx.newPage();
  await parkWindow(ctx, page);
  await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // Poll rather than read once: a slow page is judged on what it finally shows.
  let verdict = 'unknown', landed = '';
  for (let i = 0; i < 12 && verdict === 'unknown'; i++) {
    await sleep(1500);
    landed = page.url();
    const text = await page.evaluate(() => document.body?.innerText.slice(0, 1500) || '').catch(() => '');
    if (p.signedOut(landed, text)) verdict = 'expired';
    else if (p.signedIn(landed, text) && text.length > 200) verdict = 'ok';
  }
  const was = previous.platforms?.[p.id];
  status[p.id] = {
    label: p.label, status: verdict, landed: landed.slice(0, 120), checkedAt: now,
    // When it first went bad, so the banner can say "since …".
    ...(verdict === 'expired' ? { expiredSince: was?.status === 'expired' && was.expiredSince ? was.expiredSince : now } : {}),
  };
  await ctx.close();
}
await browser.close();

writeFileSync(OUT, JSON.stringify({ checkedAt: now, platforms: status }, null, 2));
const expired = Object.values(status).filter((s) => s.status === 'expired').map((s) => s.label);
for (const s of Object.values(status)) console.log(`  ${s.status === 'ok' ? '✅' : s.status === 'expired' ? '❌' : '⚪'} ${s.label.padEnd(12)} ${s.status}`);

if (expired.length && !process.env.NO_NOTIFY) {
  const msg = `Reconnect ${expired.join(', ')} in the dashboard (Settings).`;
  console.log(`\n⚠️  Login expired: ${expired.join(', ')}. ${msg}`);
  // A notification on this Mac, so it is seen the same day rather than days later.
  const script = `display notification ${JSON.stringify(msg)} with title "Distribution Dashboard" subtitle ${JSON.stringify(`Login expired: ${expired.join(', ')}`)} sound name "Basso"`;
  await new Promise((r) => execFile('/usr/bin/osascript', ['-e', script], () => r()));
}
