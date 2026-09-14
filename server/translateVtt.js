// Translates the English .vtt caption files (from caption-files/) into one or
// more target languages, preserving all timestamps.
// Output: caption-files-<code>/<course-slug>/<same-filename>.vtt   (resumable)
//
// ENGINES (env ENGINE=...):
//   google  (default) — free, no API key, Google's public endpoint. Fast, good quality.
//   libre             — self-hosted LibreTranslate (open source). Set LIBRE_URL, optional LIBRE_KEY.
//   claude            — Anthropic API (best quality, paid). Set ANTHROPIC_API_KEY, TRANSLATE_MODEL.
//
// Config via env:
//   TARGET_LANGS   comma list, names or codes: "Hindi,Spanish" or "hi,es"   (required)
//   COURSE         only translate this course slug (default: all)
//   MAX_FILES      cap files per language (quick test run)
//   CONCURRENCY    parallel requests (default 5)
//
// Run: TARGET_LANGS="Hindi,Spanish" npm run translate
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Source language for the translation. Defaults to English; set SOURCE_LANG=es
// (with SRC_DIR pointing at the Spanish downloads) to go Spanish -> English.
const SOURCE_LANG = (process.env.SOURCE_LANG || 'en').toLowerCase();
const SRC_DIR = process.env.SRC_DIR
  ? join(__dirname, process.env.SRC_DIR)
  : join(__dirname, SOURCE_LANG === 'en' ? 'caption-files' : `caption-files-src-${SOURCE_LANG}`);
const ENGINE = (process.env.ENGINE || 'google').toLowerCase();
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const ONLY_COURSE = process.env.COURSE || null;
const MAX_FILES = process.env.MAX_FILES ? Number(process.env.MAX_FILES) : Infinity;
const RAW_LANGS = (process.env.TARGET_LANGS || '').split(',').map((s) => s.trim()).filter(Boolean);

// language name -> ISO code (extend as needed); pass a code directly to skip the map
const CODES = {
  // English was only ever the SOURCE, so it was never in this map — needed now
  // that Spanish-language courses are translated the other way.
  english: 'en',
  hindi: 'hi', spanish: 'es', french: 'fr', german: 'de', arabic: 'ar', portuguese: 'pt',
  italian: 'it', russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh-CN',
  'simplified chinese': 'zh-CN', 'traditional chinese': 'zh-TW', dutch: 'nl', turkish: 'tr',
  polish: 'pl', indonesian: 'id', vietnamese: 'vi', thai: 'th', ukrainian: 'uk',
  hebrew: 'he', greek: 'el', swedish: 'sv', romanian: 'ro', bengali: 'bn', tamil: 'ta',
  telugu: 'te', marathi: 'mr', urdu: 'ur', gujarati: 'gu', punjabi: 'pa',
};
const toCode = (l) => (/^[a-z]{2}(-[a-zA-Z]{2,4})?$/.test(l) ? l : (CODES[l.toLowerCase()] || null));
const slug = (l) => toCode(l).toLowerCase().replace(/[^a-z0-9]+/g, '-');

if (!RAW_LANGS.length) { console.error('❌ Set TARGET_LANGS, e.g. TARGET_LANGS="Hindi,Spanish"'); process.exit(1); }
const LANGS = RAW_LANGS.map((name) => {
  const c = toCode(name);
  if (!c) { console.error(`❌ Unknown language "${name}" — pass an ISO code (e.g. "hi") or add it to CODES.`); process.exit(1); }
  return { name, code: c };
});
if (!existsSync(SRC_DIR)) { console.error('❌ No ${SRC_DIR} yet — run captions:files (with SRC_LOCALE set) first.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- engines: each exposes translateMany(texts, langName, langCode) -> string[] ----------
async function googleOne(text, tl) {
  if (!text.trim()) return text;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${SOURCE_LANG}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      return (data[0] || []).map((seg) => seg[0]).join('');
    } catch (e) { if (a === 3) throw e; await sleep(800 * (a + 1)); }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
const googleEngine = { translateMany: (texts, _n, tl) => pool(texts, CONCURRENCY, (t) => googleOne(t, tl)) };

async function libreMany(texts, _n, code) {
  const url = (process.env.LIBRE_URL || 'http://localhost:5000').replace(/\/$/, '') + '/translate';
  const body = { q: texts, source: SOURCE_LANG, target: code, format: 'text' };
  if (process.env.LIBRE_KEY) body.api_key = process.env.LIBRE_KEY;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('LibreTranslate http ' + r.status + ' — is the server running at ' + url + '?');
  const d = await r.json();
  return Array.isArray(d.translatedText) ? d.translatedText : [d.translatedText];
}
const libreEngine = { translateMany: libreMany };

let claudeEngine = null;
if (ENGINE === 'claude') {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  if (!process.env.ANTHROPIC_API_KEY) { console.error('❌ ENGINE=claude needs ANTHROPIC_API_KEY.'); process.exit(1); }
  const client = new Anthropic();
  const MODEL = process.env.TRANSLATE_MODEL || 'claude-opus-4-8';
  const batch = async (arr, name) => {
    const sys = `You are a professional subtitle translator. Translate each English subtitle segment into ${name}. Preserve meaning, tone, and course terminology; keep it concise for on-screen reading. Do not merge or split segments. Return ONLY a JSON array of strings, same order and exact count. No commentary.`;
    for (let a = 0; a < 2; a++) {
      const resp = await client.messages.create({ model: MODEL, max_tokens: 8000, system: sys, messages: [{ role: 'user', content: JSON.stringify(arr) }] });
      const b = resp.content.find((x) => x.type === 'text');
      let out = null; try { out = JSON.parse((b?.text || '').replace(/^```json?\s*|\s*```$/g, '').trim()); } catch {}
      if (Array.isArray(out) && out.length === arr.length) return out.map(String);
    }
    return null;
  };
  claudeEngine = { translateMany: async (texts, name) => {
    const res = new Array(texts.length);
    for (let i = 0; i < texts.length; i += 40) {
      const s = texts.slice(i, i + 40); let r = await batch(s, name);
      if (!r) { r = []; for (const t of s) { const one = await batch([t], name); r.push(one ? one[0] : t); } }
      for (let k = 0; k < s.length; k++) res[i + k] = r[k];
    }
    return res;
  } };
}
const engine = ENGINE === 'libre' ? libreEngine : ENGINE === 'claude' ? claudeEngine : googleEngine;

// ---------- VTT parse/rebuild (keeps header + every timestamp) ----------
function parseVtt(text) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  const header = blocks.shift();
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;
    cues.push({ pre: lines.slice(0, tsIdx + 1).join('\n'), text: lines.slice(tsIdx + 1).join('\n').trim() });
  }
  return { header, cues };
}
const buildVtt = (header, cues) => [header, ...cues.map((c) => `${c.pre}\n${c.text}`)].join('\n\n') + '\n';

async function translateFile(srcPath, lang) {
  const { header, cues } = parseVtt(readFileSync(srcPath, 'utf8'));
  const out = await engine.translateMany(cues.map((c) => c.text), lang.name, lang.code);
  cues.forEach((c, i) => { c.text = out[i] ?? c.text; });
  return buildVtt(header, cues);
}

// ---------- run ----------
const courses = readdirSync(SRC_DIR).filter((d) => statSync(join(SRC_DIR, d)).isDirectory());
console.log(`Engine: ${ENGINE} | languages: ${LANGS.map((l) => `${l.name}(${l.code})`).join(', ')}`);
for (const lang of LANGS) {
  const outRoot = join(__dirname, `caption-files-${slug(lang.name)}`);
  if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true });
  let done = 0, skipped = 0;
  console.log(`\n=== → ${lang.name} (${lang.code}) ===`);
  for (const course of courses) {
    if (ONLY_COURSE && course !== ONLY_COURSE) continue;
    const srcDir = join(SRC_DIR, course), outDir = join(outRoot, course);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.vtt'))) {
      if (done >= MAX_FILES) break;
      const outPath = join(outDir, file);
      if (existsSync(outPath)) { skipped++; continue; }
      try { writeFileSync(outPath, await translateFile(join(srcDir, file), lang)); done++;
        if (done % 10 === 0) console.log(`  ${lang.name}: ${done} translated (${skipped} pre-existing)`);
      } catch (e) { console.error(`  ✗ ${course}/${file}: ${e.message}`); }
    }
    if (done >= MAX_FILES) break;
  }
  console.log(`✅ ${lang.name}: ${done} new, ${skipped} pre-existing → caption-files-${slug(lang.name)}/`);
}
console.log('\nDone.');
