// MIRROR dashboard.db INTO THE CLOUD DATABASE (Supabase Postgres). Runs after
// the nightly update; safe to run by hand at any time:  node syncCloud.js
//
// Every table, every row. Each table is created in Postgres with the same
// columns and primary key, then replaced inside one transaction — a failed
// table leaves its previous cloud copy untouched. New tables and new columns
// are picked up automatically, so nothing has to be listed here.
//
// Guard: a table that has shrunk to under half its cloud row count is NOT
// replaced (same rule the scrapers use) — a damaged or emptied local table must
// not wipe the good copy in the cloud. History beyond the latest figures is in
// the dated backups (backupDb.js), which live in cloud storage.
import { db, logScrapeRun } from './db.js';
import { dbConfigured, pgClient } from './cloud.js';

if (!dbConfigured()) {
  console.log('⏭  Cloud database not set up (SUPABASE_DB_URL missing in .env) — nothing uploaded.');
  process.exit(0);
}

const startedAt = new Date().toISOString();
const q = (name) => `"${name.replace(/"/g, '""')}"`;
const pgType = (t) => {
  const u = (t || '').toUpperCase();
  if (u.includes('INT')) return 'bigint';
  if (u.includes('REAL') || u.includes('FLOA') || u.includes('DOUB') || u.includes('NUM')) return 'double precision';
  if (u.includes('BLOB')) return 'bytea';
  return 'text';
};

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);

const pg = await pgClient();
const summary = [];
let failed = 0;
try {
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all();
    const pk = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => q(c.name));
    try {
      await pg.query(`CREATE TABLE IF NOT EXISTS ${q(t)} (${cols.map((c) => `${q(c.name)} ${pgType(c.type)}`).join(', ')}${pk.length ? `, PRIMARY KEY (${pk.join(', ')})` : ''})`);
      for (const c of cols) await pg.query(`ALTER TABLE ${q(t)} ADD COLUMN IF NOT EXISTS ${q(c.name)} ${pgType(c.type)}`);

      const rows = db.prepare(`SELECT * FROM ${q(t)}`).raw().all();
      const cloudCount = Number((await pg.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
      if (cloudCount > 20 && rows.length < cloudCount * 0.5) {
        summary.push(`  ⚠️  ${t}: ${rows.length} rows here vs ${cloudCount} in the cloud — not replaced`);
        failed++;
        continue;
      }

      await pg.query('BEGIN');
      await pg.query(`DELETE FROM ${q(t)}`);
      // Batched so no statement passes Postgres' 65,535-parameter limit.
      const per = Math.max(1, Math.floor(60000 / cols.length));
      const batch = Math.min(500, per);
      const names = cols.map((c) => q(c.name)).join(', ');
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const params = [];
        const tuples = chunk.map((r) => `(${r.map((v) => { params.push(typeof v === 'bigint' ? v.toString() : v); return `$${params.length}`; }).join(', ')})`);
        await pg.query(`INSERT INTO ${q(t)} (${names}) VALUES ${tuples.join(', ')}`, params);
      }
      await pg.query('COMMIT');
      summary.push(`  ✅ ${t}: ${rows.length.toLocaleString()} rows`);
    } catch (e) {
      await pg.query('ROLLBACK').catch(() => {});
      summary.push(`  ❌ ${t}: ${e.message.slice(0, 160)}`);
      failed++;
    }
  }
  await pg.query(`CREATE TABLE IF NOT EXISTS _sync_log (synced_at timestamptz PRIMARY KEY, tables integer, failed integer)`);
  await pg.query('INSERT INTO _sync_log VALUES (now(), $1, $2)', [tables.length, failed]);
} finally {
  await pg.end();
}

console.log(summary.join('\n'));
const ok = failed === 0;
logScrapeRun({ job: 'cloud-sync', ok, rows: tables.length, error: ok ? null : `${failed} table(s) not uploaded`, startedAt });
console.log(`${ok ? '✅' : '❌'} ${tables.length - failed} of ${tables.length} tables uploaded to the cloud database`);
process.exit(ok ? 0 : 1);
