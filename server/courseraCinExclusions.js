// Coursera CIN courses from the client's completed-requirements list
// (Coursera_Completed_Batch_2_4_11.xlsx, 143 titles; 142 resolved to a real CIN
// course — 120 exact title matches, 22 near-duplicate wordings such as
// "SystemVerilog Basics" vs "SystemVerilog Tutorials"; "Cinematic Storytelling
// Simplified Mastering Lumen5 AI" had no confident match and was left out).
//
// Until 2026-11-20 these were EXCLUDED from the dashboard entirely. They are live
// Starweaver courses on Coursera, so they are now shown like every other CIN course
// but TAGGED "Batch 2/4/11" (user's decision, 2026-11-20): the CIN tab marks them
// and can hide them from its table and totals.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'coursera_cin_excluded_slugs.json');   // file name kept for history

export const CIN_CLIENT_BATCH_LABEL = 'Batch 2/4/11';
export const CIN_CLIENT_BATCH_SLUGS = new Set(JSON.parse(readFileSync(FILE, 'utf8')));
export const cinBatchOf = (slug) => (CIN_CLIENT_BATCH_SLUGS.has(slug) ? CIN_CLIENT_BATCH_LABEL : null);
