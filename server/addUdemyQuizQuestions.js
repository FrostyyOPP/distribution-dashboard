// Add multiple-choice questions to an existing Udemy quiz, each linked to the
// lecture it tests. Refuses to add to a quiz that already has questions.
//
// Questions carry a tag like "M1L3V2" (module 1, lesson 3, video 2). The tag is
// resolved from the curriculum's shape: a module starts at the section whose
// first lecture is a "Module Introduction"; its lessons are that section and
// the ones after it; a lesson's videos are its non-article lectures, excluding
// the module introduction. Where the lecture's uploaded file name carries a tag
// (the production team names them "M1L3V2 - …"), the two must agree.
//
// Input: JSON array of { n, tag, prompt, answers: [{ text, correct, feedback }] }
// Run:  node addUdemyQuizQuestions.js <courseId> <quizId> <questions.json> [--dry-run]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { parkWindow } from './browserWindow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const [cid, qid, file] = process.argv.slice(2);
const DRY = process.argv.includes('--dry-run');
const Q = JSON.parse(readFileSync(file, 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (s) => `<p>${esc(s)}</p>`;

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const ctx = await browser.newContext({ storageState: join(__dirname, 'udemy-auth.json'), userAgent: UA });
const page = await ctx.newPage();
await parkWindow(ctx, page);
const stop = async (m) => { console.error('❌ ' + m); await browser.close(); process.exit(1); };
const api = (m, u, b) => page.evaluate(async ([m, u, b]) => {
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  const r = await fetch('https://www.udemy.com' + u, { method: m, credentials: 'include',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
    body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, [m, u, b]);

await page.goto(`https://www.udemy.com/instructor/course/${cid}/manage/curriculum/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForFunction(() => /csrftoken=/.test(document.cookie), { timeout: 25000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
if (/join\/passwordless|\/login/.test(page.url())) await stop('Udemy session lost — reconnect Udemy.');

const cur = (await api('GET', `/api-2.0/courses/${cid}/instructor-curriculum-items/?page_size=300&fields[chapter]=title&fields[lecture]=title,asset&fields[asset]=asset_type,title&fields[quiz]=title,type`)).json?.results;
if (!cur) await stop('Could not read the curriculum.');
const quiz = cur.find((x) => x._class === 'quiz' && String(x.id) === String(qid));
if (!quiz) await stop(`Quiz ${qid} is not in course ${cid}.`);
const before = (await api('GET', `/api-2.0/quizzes/${qid}/assessments/?page_size=200&fields[assessment]=id`)).json;
if (before?.count) await stop(`Quiz "${quiz.title}" already has ${before.count} question(s). Nothing added.`);

// sections → modules → lessons → videos
const sections = [];
for (const x of cur) {
  if (x._class === 'chapter') sections.push({ title: x.title, lectures: [] });
  else if (x._class === 'lecture' && sections.length) sections.at(-1).lectures.push(x);
}
const isIntro = (l) => /^Module Introduction/i.test(l.title);
const tagMap = new Map();
let m = 0, lesson = 0;
for (const s of sections) {
  if (s.lectures[0] && isIntro(s.lectures[0])) { m++; lesson = 0; }
  if (!m) continue;
  lesson++;
  s.lectures.filter((l) => l.asset?.asset_type !== 'Article' && !isIntro(l))
    .forEach((l, i) => tagMap.set(`M${m}L${lesson}V${i + 1}`, l));
}
const problems = [];
for (const [tag, l] of tagMap) {
  const fileTag = (l.asset?.title || '').match(/^M(\d)\s*L(\d)\s*V(\d)/i);
  if (fileTag && `M${fileTag[1]}L${fileTag[2]}V${fileTag[3]}` !== tag) problems.push(`${tag} resolves to "${l.title}", whose video file is tagged ${fileTag[0]}`);
}
for (const q of Q) {
  if (!tagMap.has(q.tag.toUpperCase())) problems.push(`Q${q.n}: no lecture for ${q.tag}`);
  if (q.answers.length < 2 || q.answers.filter((a) => a.correct).length !== 1) problems.push(`Q${q.n}: needs exactly one correct answer`);
}
if (problems.length) await stop('Not adding anything:\n  ' + problems.join('\n  '));
console.log(`quiz "${quiz.title}" · ${Q.length} questions · lecture links:`);
for (const q of Q) console.log(`  Q${String(q.n).padStart(2)} ${q.tag} → ${tagMap.get(q.tag.toUpperCase()).title}`);
if (DRY) { await browser.close(); process.exit(0); }

const letters = 'abcdefgh';
const body = (q) => ({
  assessment_type: 'multiple-choice',
  prompt: {
    question: html(q.prompt),
    answers: q.answers.map((a) => html(a.text)),
    feedbacks: q.answers.map((a) => html(a.feedback)),
    relatedLectureIds: [String(tagMap.get(q.tag.toUpperCase()).id)],
  },
  correct_response: [letters[q.answers.findIndex((a) => a.correct)]],
  section: '',
});
for (const q of Q) {
  const r = await api('POST', `/api-2.0/quizzes/${qid}/assessments/`, body(q));
  if (r.status !== 201) await stop(`Q${q.n} → ${r.status} ${r.text}\n   (${Q.indexOf(q)} added before this; re-run will refuse — remove them or finish by hand)`);
  // Udemy lists a quiz's questions by creation time, to the second, and orders
  // same-second ties arbitrarily — at 300 ms apart Q12 and Q13 came back swapped.
  await new Promise((x) => setTimeout(x, 1200));
}

// read back and compare every question
const got = (await api('GET', `/api-2.0/quizzes/${qid}/assessments/?page_size=200&fields[assessment]=prompt,correct_response,question_plain,assessment_type`)).json?.results || [];
const bad = [];
Q.forEach((q, i) => {
  const g = got[i], w = body(q);
  if (!g) return bad.push(`Q${q.n} missing`);
  if (g.prompt.question !== w.prompt.question) bad.push(`Q${q.n} question text/order`);
  if (JSON.stringify(g.prompt.answers) !== JSON.stringify(w.prompt.answers)) bad.push(`Q${q.n} answers`);
  if (JSON.stringify(g.prompt.feedbacks) !== JSON.stringify(w.prompt.feedbacks)) bad.push(`Q${q.n} feedback`);
  if (JSON.stringify(g.correct_response) !== JSON.stringify(w.correct_response)) bad.push(`Q${q.n} correct answer`);
  if (JSON.stringify((g.prompt.relatedLectureIds || []).map(String)) !== JSON.stringify(w.prompt.relatedLectureIds)) bad.push(`Q${q.n} related lecture`);
});
console.log(bad.length ? `⚠️ ${got.length} on Udemy, mismatches: ${bad.join(', ')}` : `✅ ${got.length} questions added and verified — text, answers, feedback, correct answer and related lecture`);
await browser.close();
