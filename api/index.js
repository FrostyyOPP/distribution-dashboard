// THE ONLINE COPY OF THE DASHBOARD (Vercel). The scrapers run only on the office
// Mac, which publishes its database to the private Supabase bucket after every
// update (server/publishCloud.js). This function downloads that copy into /tmp
// on a cold start, then runs the normal dashboard server over it, read-only — so
// the dashboard stays up while the Mac is off.
//
// Vercel environment variables (set in the Vercel project, never committed):
//   SUPABASE_URL, SUPABASE_SECRET_KEY   to read the bucket
//   DASHBOARD_PASSWORD                  the same login as the Mac's dashboard
//   UDEMY_API_KEY                       the Udemy course list is read live
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIR = '/tmp/dashboard';
const BUCKET = 'dashboard-backups';
const RECHECK_MS = 10 * 60 * 1000;   // look for newer data at most every 10 minutes

async function storage(method, path, body) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/${path}`;
  const key = process.env.SUPABASE_SECRET_KEY;
  const res = await fetch(url, { method, body, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!res.ok) throw new Error(`Supabase storage ${res.status} on ${path.split('?')[0]}`);
  return res;
}
// When the published database was last replaced (its object's updated_at).
async function publishedAt() {
  const list = await (await storage('POST', `object/list/${BUCKET}`, JSON.stringify({ prefix: 'live/', limit: 100 }))).json();
  return list.find((o) => o.name === 'dashboard.db.gz')?.updated_at || null;
}
async function download() {
  mkdirSync(DIR, { recursive: true });
  const stamp = await publishedAt();
  const gz = Buffer.from(await (await storage('GET', `object/authenticated/${BUCKET}/live/dashboard.db.gz`)).arrayBuffer());
  writeFileSync(join(DIR, 'dashboard.db'), gunzipSync(gz));
  mkdirSync(join(DIR, 'marketing'), { recursive: true });
  for (const name of ['last-update.json', 'session-status.json', 'marketing/catalog.html', 'marketing/unmatched-courses.xlsx']) {
    try { writeFileSync(join(DIR, name), Buffer.from(await (await storage('GET', `object/authenticated/${BUCKET}/live/${name}`)).arrayBuffer())); } catch {}
  }
  return stamp;
}

let app = null, loadedStamp = null, lastCheck = 0, newerWaiting = false;
async function getApp() {
  if (app) return app;
  if (!existsSync(join(DIR, 'dashboard.db'))) loadedStamp = await download();
  process.env.DASHBOARD_DB_FILE = join(DIR, 'dashboard.db');
  process.env.DASHBOARD_STATE_DIR = DIR;
  process.env.DASHBOARD_READ_ONLY = '1';
  process.env.MARKETING_DIST = join(DIR, 'marketing');
  process.env.CATALOG_FILE = join(DIR, 'marketing', 'catalog.html');
  if (loadedStamp) process.env.DASHBOARD_DATA_AS_OF = loadedStamp;
  lastCheck = Date.now();
  app = (await import('../server/index.js')).default;
  return app;
}

export default async function handler(req, res) {
  let a;
  try { a = await getApp(); }
  catch (e) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(`The online dashboard could not load its data (${e.message}). Try again in a minute.`);
  }
  // The database is opened once per instance, so newer data means a fresh
  // instance: once a newer copy is published, this instance answers this request
  // and then exits; the next request starts clean and downloads the new copy.
  if (!newerWaiting && Date.now() - lastCheck > RECHECK_MS) {
    lastCheck = Date.now();
    try { const s = await publishedAt(); if (s && loadedStamp && s !== loadedStamp) newerWaiting = true; } catch {}
  }
  if (newerWaiting) res.on('finish', () => setTimeout(() => process.exit(0), 50));
  return a(req, res);
}
