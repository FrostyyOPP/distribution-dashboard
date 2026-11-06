// THE CLOUD COPY (Supabase), added 2026-10-26 at the user's request: "upload
// everything to Database and delete it from my local storage".
//
//   Postgres  — every table of dashboard.db, mirrored nightly by syncCloud.js
//   Storage   — the nightly backups (backupDb.js) and one-off reports, in a
//               PRIVATE bucket; the local copies are deleted once uploaded
//
// dashboard.db itself stays on this Mac: the dashboard serves from it and the
// scrapers write to it. The cloud holds the copy that survives this Mac.
//
// Configured in server/.env (never committed — this repo is public):
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_SECRET_KEY=<the project's secret / service_role key>
//   SUPABASE_DB_URL=<Session pooler connection string, with the password>
// The SESSION POOLER string, not "Direct connection": the direct host is
// IPv6-only, and this Mac's IPv6 DNS hangs.
import 'dotenv/config';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

export const BUCKET = 'dashboard-backups';
const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_DB_URL } = process.env;

export const storageConfigured = () => Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
export const dbConfigured = () => Boolean(SUPABASE_DB_URL);

async function storage(method, path, body, headers = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}`, ...headers },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase storage ${res.status} on ${method} ${path.split('?')[0]}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Private bucket, created on first use.
export async function ensureBucket(id = BUCKET) {
  try { await storage('GET', `bucket/${id}`); }
  catch (e) {
    if (e.status !== 400 && e.status !== 404) throw e;
    await storage('POST', 'bucket', JSON.stringify({ id, name: id, public: false }), { 'Content-Type': 'application/json' });
  }
}

// Upload, then download it again and compare byte for byte — a file is only
// deleted locally once the cloud copy is proven identical.
export async function uploadVerified(name, buf, contentType = 'application/octet-stream', bucket = BUCKET) {
  const key = name.split('/').map(encodeURIComponent).join('/');
  await storage('POST', `object/${bucket}/${key}`, buf, { 'Content-Type': contentType, 'x-upsert': 'true' });
  const back = Buffer.from(await (await storage('GET', `object/authenticated/${bucket}/${key}`)).arrayBuffer());
  if (!back.equals(buf)) throw new Error(`${name}: the uploaded copy does not match — local file kept`);
  return back.length;
}

export async function listObjects(prefix = '', bucket = BUCKET) {
  const res = await storage('POST', `object/list/${bucket}`,
    JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }), { 'Content-Type': 'application/json' });
  return (await res.json()).filter((o) => o.id); // folders come back without an id
}

export async function removeObjects(names, bucket = BUCKET) {
  if (!names.length) return;
  await storage('DELETE', `object/${bucket}`, JSON.stringify({ prefixes: names }), { 'Content-Type': 'application/json' });
}

export async function pgClient() {
  const { default: pg } = await import('pg');
  // Supabase's pooler presents a certificate chain Node does not ship the root
  // for; the connection is still TLS-encrypted.
  // SUPABASE_DB_SSL=off only for testing against a local Postgres.
  const ssl = process.env.SUPABASE_DB_SSL === 'off' ? false : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: SUPABASE_DB_URL, ssl });
  await client.connect();
  return client;
}
