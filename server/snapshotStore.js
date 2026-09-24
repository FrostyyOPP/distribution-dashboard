// Raw-page cache, so a page is fetched once and parsed any number of times.
//
// Why this exists: building a parser means running it over and over. Doing that
// against the live site is what got LinkedIn to stop responding on 2026-09-15 —
// five loads of the statements page in a few minutes, and the whole portal went
// quiet. The page content had not changed once in those five loads.
//
// So: fetch once, write the HTML here, and develop against the saved copy.
//
//   saveSnapshot('linkedin', 'statements-2026-08', html)
//   loadSnapshot('linkedin', 'statements-2026-08')      -> newest matching copy
//   listSnapshots('linkedin')
//
// Snapshots are timestamped and never overwritten, so an older copy stays
// available when a site changes shape and the new parse needs comparing.
// The directory is gitignored — these are full authenticated pages.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SNAP_DIR = join(__dirname, 'snapshots');

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function saveSnapshot(source, name, content, meta = {}) {
  const dir = join(SNAP_DIR, safe(source));
  mkdirSync(dir, { recursive: true });
  const base = `${safe(name)}__${stamp()}`;
  const file = join(dir, `${base}.html`);
  writeFileSync(file, content);
  writeFileSync(join(dir, `${base}.json`), JSON.stringify({
    source, name, savedAt: new Date().toISOString(), bytes: content.length, ...meta,
  }, null, 2));
  return file;
}

// Newest snapshot whose name matches. `name` may be a prefix.
export function loadSnapshot(source, name) {
  const dir = join(SNAP_DIR, safe(source));
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith('.html') && f.startsWith(safe(name)))
    .sort();
  if (!hits.length) return null;
  const file = join(dir, hits[hits.length - 1]);
  return { file, savedAt: statSync(file).mtime.toISOString(), html: readFileSync(file, 'utf8') };
}

export function listSnapshots(source) {
  const dir = source ? join(SNAP_DIR, safe(source)) : SNAP_DIR;
  if (!existsSync(dir)) return [];
  if (source) {
    return readdirSync(dir).filter((f) => f.endsWith('.html')).sort().map((f) => {
      const p = join(dir, f);
      return { name: f, bytes: statSync(p).size, savedAt: statSync(p).mtime.toISOString() };
    });
  }
  return readdirSync(dir).flatMap((s) => listSnapshots(s).map((x) => ({ source: s, ...x })));
}
