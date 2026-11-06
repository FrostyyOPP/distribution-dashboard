// NIGHTLY BACKUP OF dashboard.db. Runs as the last step of update-all.js.
//
// Why: the database was a single file with no copy anywhere, on a Mac known to
// lose and corrupt files. Most tables are replaced each night, so a backup per
// day is also the only record of what any figure was on a given date.
//
// Writes ~/dashboard-backups/dashboard-YYYY-MM-DD.db.gz (outside the public repo),
// then — once Supabase is set up (cloud.js) — uploads it to private cloud
// storage and deletes the local copy. A failed upload leaves the file here and
// it is uploaded the next night.
// SQLite's own online backup, so it is consistent even while the server writes.
// The copy is integrity-checked before it is kept. Retention (in the cloud, or
// here if there is no cloud): the last 30 days, plus the first of each month for good.
//   node backupDb.js
//   BACKUP_DIR=/elsewhere node backupDb.js
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { db, logScrapeRun } from './db.js';
import { storageConfigured, ensureBucket, uploadVerified, listObjects, removeObjects, BUCKET } from './cloud.js';

const DIR = process.env.BACKUP_DIR || join(homedir(), 'dashboard-backups');
const KEEP_DAYS = 30;
const startedAt = new Date().toISOString();
const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

try {
  mkdirSync(DIR, { recursive: true });
  const tmp = join(DIR, `.dashboard-${today}.db`);
  await db.backup(tmp);

  const copy = new DatabaseCtor(tmp, { readonly: true });
  const check = copy.pragma('quick_check', { simple: true });
  const tables = copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
  copy.close();
  if (check !== 'ok') throw new Error(`backup failed its integrity check (${check}) — previous backups kept`);

  const raw = readFileSync(tmp);
  const gz = gzipSync(raw, { level: 9 });
  const out = join(DIR, `dashboard-${today}.db.gz`);
  writeFileSync(out, gz);
  // Opening the copy for the check leaves its -wal/-shm side files behind.
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  // Read it back and unzip it: this Mac has silently lost written files before.
  if (gunzipSync(readFileSync(out)).length !== raw.length) throw new Error('backup did not read back intact');

  // Retention: last 30 days, plus the earliest backup of every month forever.
  const prune = (names) => {
    const firstOfMonth = new Map(); // 'YYYY-MM' -> earliest file that month
    for (const f of [...names].sort()) if (!firstOfMonth.has(f.slice(10, 17))) firstOfMonth.set(f.slice(10, 17), f);
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    return names.filter((f) => f.slice(10, 20) < cutoff && firstOfMonth.get(f.slice(10, 17)) !== f);
  };
  const isBackup = (f) => /^dashboard-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f);
  console.log(`✅ Backed up dashboard.db (${tables} tables, ${(gz.length / 1e6).toFixed(1)} MB)`);

  if (storageConfigured()) {
    // INTO THE CLOUD, then off this Mac. Every local backup is uploaded —
    // including any left from a night the upload failed — and deleted only once
    // the cloud copy has been downloaded again and matched byte for byte.
    await ensureBucket();
    let uploaded = 0;
    for (const f of readdirSync(DIR).filter(isBackup).sort()) {
      await uploadVerified(f, readFileSync(join(DIR, f)), 'application/gzip');
      unlinkSync(join(DIR, f));
      uploaded++;
    }
    const inCloud = (await listObjects()).map((o) => o.name).filter(isBackup);
    const old = prune(inCloud);
    await removeObjects(old);
    console.log(`   ☁️  uploaded ${uploaded} to cloud storage (bucket "${BUCKET}") and deleted locally · ${inCloud.length - old.length} kept in the cloud${old.length ? ` · ${old.length} older than ${KEEP_DAYS} days removed` : ''}`);
  } else {
    const files = readdirSync(DIR).filter(isBackup);
    const old = prune(files);
    for (const f of old) unlinkSync(join(DIR, f));
    console.log(`   cloud storage not set up — kept on this Mac: ${out} (${files.length - old.length} backup(s))`);
  }
  logScrapeRun({ job: 'db-backup', ok: true, rows: tables, startedAt });
} catch (e) {
  logScrapeRun({ job: 'db-backup', ok: false, error: e.message, startedAt });
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
