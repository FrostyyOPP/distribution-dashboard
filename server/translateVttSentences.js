// Sentence-aware .vtt translation.
//
// WHY THIS EXISTS: translateVtt.js translates each cue independently, but 56%
// of cues end mid-sentence. Translating half a sentence blind loses meaning —
// on the Spanish pilot the negation sat in the next cue, so
//   "...que la mayoría de las juntas directivas y líderes técnicos no /
//    pueden responder con suficiente rapidez"
// came back as "...don't know." / "They can respond quickly enough.", i.e. the
// opposite of the source. That is unacceptable for a primary caption.
//
// This groups consecutive cues into whole sentences, translates the sentence,
// then redistributes the translation back over the original cues in proportion
// to their source length. Timestamps are never touched — only cue TEXT changes,
// and the cue count is identical in and out.
//
// Env:
//   SOURCE_LANG   source code (default es)
//   TARGET_LANGS  comma list, names or codes (default English)
//   SRC_DIR       source folder (default caption-files-src-<SOURCE_LANG>)
//   COURSE        only this course slug
//   MAX_FILES     cap files per language
//   CONCURRENCY   parallel sentence requests (default 5)
//
// Run: SOURCE_LANG=es TARGET_LANGS=English COURSE=<slug> node translateVttSentences.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_LANG = (process.env.SOURCE_LANG || 'es').toLowerCase();
const SRC_DIR = join(__dirname, process.env.SRC_DIR || `caption-files-src-${SOURCE_LANG}`);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
// COURSE accepts one slug or a comma-separated list.
const ONLY_COURSE = (process.env.COURSE || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_FILES = process.env.MAX_FILES ? Number(process.env.MAX_FILES) : Infinity;
const CODES = { english: 'en', spanish: 'es', french: 'fr', german: 'de', arabic: 'ar',
  portuguese: 'pt', italian: 'it', hindi: 'hi' };
const toCode = (l) => (/^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(l) ? l : (CODES[l.toLowerCase()] || null));
const LANGS = (process.env.TARGET_LANGS || 'English').split(',').map((s) => s.trim()).filter(Boolean)
  .map((name) => { const c = toCode(name); if (!c) { console.error(`❌ unknown language "${name}"`); process.exit(1); } return { name, code: c }; });
if (!existsSync(SRC_DIR)) { console.error(`❌ no ${SRC_DIR} — run captions:files with SRC_LOCALE first.`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- vtt ----------
// A cue is: optional id line, a "start --> end" line, then one or more text lines.
function parseVtt(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const header = blocks.shift();
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.length);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    cues.push({ id: lines.slice(0, ti).join('\n'), time: lines[ti], text: lines.slice(ti + 1).join(' ').trim() });
  }
  return { header, cues };
}
const buildVtt = ({ header, cues }) =>
  [header, ...cues.map((c) => [c.id, c.time, c.text].filter(Boolean).join('\n'))].join('\n\n') + '\n';

// A sentence ends at . ! ? … or closing punctuation after them. Cues that do
// not end a sentence are carried into the next group.
const ENDS = /[.!?…]["'”’)\]]?\s*$/;
function groupSentences(cues) {
  const groups = [];
  let cur = [];
  cues.forEach((c, i) => {
    if (!c.text) { if (cur.length) { groups.push(cur); cur = []; } groups.push([i]); return; }
    cur.push(i);
    if (ENDS.test(c.text)) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

// Spread a translated sentence back over its cues, weighted by how much of the
// SOURCE each cue held. Word-boundary safe; the last cue absorbs any remainder
// so no word is dropped.
function redistribute(translated, cues, idxs) {
  if (idxs.length === 1) return { [idxs[0]]: translated };
  const words = translated.split(/\s+/).filter(Boolean);
  const lens = idxs.map((i) => cues[i].text.length);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const out = {};
  let pos = 0;
  idxs.forEach((i, k) => {
    const remainingCues = idxs.length - k - 1;
    // English is often much shorter than the Spanish source, so a purely
    // proportional split can hand all the words to the early cues and leave
    // later ones EMPTY — that silently drops content. Never take so many that
    // a following cue would be starved: reserve one word for each cue left.
    const available = words.length - pos - remainingCues;
    if (k === idxs.length - 1) { out[i] = words.slice(pos).join(' '); return; }
    const want = Math.round(words.length * (lens[k] / total));
    const take = Math.max(1, Math.min(want, Math.max(1, available)));
    out[i] = words.slice(pos, pos + take).join(' ');
    pos += take;
  });
  return out;
}

// ---------- translation ----------
// Google enforces a volume quota per endpoint, and translate.googleapis.com
// stays blocked for hours once it trips. These are independent routes with
// separate buckets, tried in order — so one exhausted quota no longer stops
// the run. All were checked to return the same text, negation intact.
const PROVIDERS = [
  {
    name: 'gtx',
    url: (q, tl) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${SOURCE_LANG}&tl=${tl}&dt=t&q=${encodeURIComponent(q)}`,
    parse: (d) => (d[0] || []).map((s) => s[0]).join(''),
  },
  {
    name: 'clients5',
    url: (q, tl) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${SOURCE_LANG}&tl=${tl}&q=${encodeURIComponent(q)}`,
    // returns either ["text"] or [["text","src"]]
    parse: (d) => (Array.isArray(d[0]) ? d[0][0] : d[0]),
  },
  {
    name: 'mymemory',
    url: (q, tl) => `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${SOURCE_LANG}|${tl}`,
    parse: (d) => d?.responseData?.translatedText,
  },
];
const provStats = {};
async function googleOne(text, tl) {
  if (!text.trim()) return text;
  for (let a = 0; a < 3; a++) {
    for (const p of PROVIDERS) {
      try {
        const r = await fetch(p.url(text, tl), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.status === 429 || r.status === 403) continue;      // this bucket is spent, try the next
        if (!r.ok) continue;
        const out = p.parse(await r.json());
        if (out && String(out).trim()) { provStats[p.name] = (provStats[p.name] || 0) + 1; return String(out); }
      } catch (e) { /* try the next provider */ }
    }
    await sleep(1200 * (a + 1));                                  // every route was busy — pause, then retry
  }
  // Every provider failed three times over. Returning undefined here is what
  // let a fully blocked run write 594 empty cues and report success — a
  // translation that did not happen must never look like an empty one.
  throw new Error(`all providers failed (${SOURCE_LANG}->${tl})`);
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- run ----------
const courses = readdirSync(SRC_DIR).filter((d) => statSync(join(SRC_DIR, d)).isDirectory())
  .filter((d) => !ONLY_COURSE.length || ONLY_COURSE.includes(d));
console.log(`source ${SOURCE_LANG} → ${LANGS.map((l) => l.name).join(', ')} · ${courses.length} course(s)\n`);

for (const lang of LANGS) {
  const outRoot = join(__dirname, `caption-files-${lang.code}`);
  let made = 0, skipped = 0, cuesOut = 0, groupsOut = 0;
  for (const course of courses) {
    const srcDir = join(SRC_DIR, course), outDir = join(outRoot, course);
    mkdirSync(outDir, { recursive: true });
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.vtt'))) {
      if (made >= MAX_FILES) break;
      const dest = join(outDir, f);
      if (existsSync(dest)) { skipped++; continue; }
      const parsed = parseVtt(readFileSync(join(srcDir, f), 'utf8'));
      const groups = groupSentences(parsed.cues);
      const sentences = groups.map((g) => g.map((i) => parsed.cues[i].text).filter(Boolean).join(' ').trim());
      const translated = await pool(sentences, CONCURRENCY, (s) => (s ? googleOne(s, lang.code) : ''));
      // A sentence that had source text but came back empty is lost content.
      const lost = sentences.filter((s, k) => s && !String(translated[k] || '').trim()).length;
      if (lost) throw new Error(`${f}: ${lost}/${sentences.filter(Boolean).length} sentences failed to translate — refusing to write a file with dropped content`);
      const next = parsed.cues.map((c) => ({ ...c }));
      groups.forEach((g, gi) => {
        const t = (translated[gi] || '').trim();
        if (!t) { g.forEach((i) => { next[i].text = parsed.cues[i].text ? '' : next[i].text; }); return; }
        const spread = redistribute(t, parsed.cues, g);
        for (const [i, v] of Object.entries(spread)) next[i].text = v;
      });
      // cue count must be identical — timings are never touched
      if (next.length !== parsed.cues.length) { console.error(`  ⚠️  cue count changed for ${f} — skipped`); continue; }
      const blanked = next.filter((c, i) => parsed.cues[i].text.trim() && !c.text.trim()).length;
      if (blanked) throw new Error(`${f}: ${blanked}/${next.length} cues have source text but no translation — refusing to write`);
      writeFileSync(dest, buildVtt({ header: parsed.header, cues: next }));
      made++; cuesOut += next.length; groupsOut += groups.length;
    }
  }
  console.log(`✅ ${lang.name}: ${made} new, ${skipped} pre-existing → caption-files-${lang.code}/`);
  console.log(`   providers used: ${JSON.stringify(provStats)}`);
  if (made) console.log(`   ${cuesOut} cues from ${groupsOut} sentence groups (${(cuesOut / groupsOut).toFixed(2)} cues per sentence)`);
}
