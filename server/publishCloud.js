// PUBLISHES THE DATA FOR THE ONLINE (VERCEL) COPY OF THE DASHBOARD. Runs at the
// end of update-all.js, after the database backup.
//
// The scrapers only run on this Mac; the online dashboard (api/index.js) is
// read-only and has no database of its own. It loads what this uploads to the
// private Supabase bucket under live/:
//   live/dashboard.db.gz      a consistent copy of dashboard.db (SQLite backup)
//   live/last-update.json     the last update run's step-by-step result
//   live/session-status.json  which platform logins are working
//   live/marketing/…          the Marketing Dashboard page (~/marketing-tool/dist)
// Each is overwritten in place, so the online copy always finds today's data at
// the same names. Uploads are read back and compared before they count.
//   node publishCloud.js              everything (end of every update)
//   node publishCloud.js --marketing  only the Marketing page (after its 08:30 rebuild)
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, logScrapeRun } from './db.js';
import { storageConfigured, ensureBucket, uploadVerified } from './cloud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
const MARKETING_ONLY = process.argv.includes('--marketing');

if (!storageConfigured()) { console.log('Supabase storage not set up — nothing to publish.'); process.exit(0); }

try {
  await ensureBucket();
  let gz = null;
  if (!MARKETING_ONLY) {
    const tmp = join(tmpdir(), `dashboard-publish-${process.pid}.db`);
    await db.backup(tmp);
    gz = gzipSync(readFileSync(tmp), { level: 9 });
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    await uploadVerified('live/dashboard.db.gz', gz, 'application/gzip');
    for (const name of ['last-update.json', 'session-status.json']) {
      const f = join(__dirname, name);
      if (existsSync(f)) await uploadVerified(`live/${name}`, readFileSync(f), 'application/json');
    }
  }
  const marketing = process.env.MARKETING_DIST || join(homedir(), 'marketing-tool', 'dist');
  for (const [name, type] of [['catalog.html', 'text/html'], ['unmatched-courses.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    if (existsSync(join(marketing, name))) await uploadVerified(`live/marketing/${name}`, readFileSync(join(marketing, name)), type);
  }
  console.log(gz ? `✅ Published for the online dashboard (${(gz.length / 1e6).toFixed(1)} MB)` : '✅ Published the Marketing page for the online dashboard');
  logScrapeRun({ job: MARKETING_ONLY ? 'publish-cloud-marketing' : 'publish-cloud', ok: true, startedAt });
} catch (e) {
  logScrapeRun({ job: MARKETING_ONLY ? 'publish-cloud-marketing' : 'publish-cloud', ok: false, error: e.message, startedAt });
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
