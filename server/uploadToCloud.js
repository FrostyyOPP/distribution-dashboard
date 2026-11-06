// Move a file into the cloud: upload it to the private Supabase bucket under
// reports/, check the cloud copy byte for byte, then delete it from this Mac.
//   node uploadToCloud.js "<file>" [more files…]
//   KEEP_LOCAL=1 node uploadToCloud.js "<file>"     (upload only)
import { readFileSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { storageConfigured, ensureBucket, uploadVerified, BUCKET } from './cloud.js';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node uploadToCloud.js <file> [more files…]'); process.exit(1); }
if (!storageConfigured()) { console.error('❌ Cloud storage not set up (SUPABASE_URL / SUPABASE_SECRET_KEY in .env) — nothing moved.'); process.exit(1); }

await ensureBucket();
let failed = 0;
for (const f of files) {
  try {
    const name = `reports/${basename(f)}`;
    const bytes = await uploadVerified(name, readFileSync(f));
    if (!process.env.KEEP_LOCAL) unlinkSync(f);
    console.log(`✅ ${basename(f)} → ${BUCKET}/${name} (${(bytes / 1e3).toFixed(0)} KB)${process.env.KEEP_LOCAL ? '' : ' · deleted locally'}`);
  } catch (e) {
    console.error(`❌ ${basename(f)}: ${e.message} — kept locally`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
