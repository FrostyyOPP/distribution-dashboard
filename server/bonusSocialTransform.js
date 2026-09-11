// Pure transform + guards for stripping X / Facebook / Instagram out of the
// "Stay Connected" block of a bonus-lecture article body. No side effects, so
// it can be imported by the runner, by tests, or from inside page.evaluate.
//
// Layout note (why this isn't a simple line delete): Facebook does NOT have its
// own paragraph — it shares one with Website, joined by <br>. Instagram, X and
// LinkedIn each have their own <p>. So Facebook is cut out of the middle of a
// paragraph, Instagram/X are dropped whole, and LinkedIn is then pulled up next
// to Website so the two survivors render as one tight block instead of two
// paragraphs with a margin between them.

export function transform(before) {
  let s = before;
  // 1) Facebook lives inside the Website paragraph, after a <br>.
  s = s.replace(/\s*<br\s*\/?>\s*Facebook\s*-\s*<a\b[^>]*facebook\.com[^>]*>.*?<\/a>/gis, '');
  // 2) Instagram and X each own a whole paragraph.
  s = s.replace(/<p>\s*Instagram\s*-\s*<a\b[^>]*instagram\.com[^>]*>.*?<\/a>\s*<\/p>/gis, '');
  s = s.replace(/<p>\s*X\s*-\s*<a\b[^>]*\/\/x\.com[^>]*>.*?<\/a>\s*<\/p>/gis, '');
  // 3) Pull LinkedIn up beside Website; normalise "LinkedIn-" to "LinkedIn - ".
  s = s.replace(
    /(<p>Website\s*-\s*<a\b[^>]*>.*?<\/a>)\s*(?:<br\s*\/?>\s*)?<\/p>\s*<p>\s*LinkedIn\s*-\s*(<a\b[^>]*>.*?<\/a>)\s*<\/p>/is,
    '$1<br>LinkedIn - $2</p>',
  );
  // 4) Tidy: no trailing space before a close, no empty or doubled paragraphs.
  s = s.replace(/\s+<\/p>/gi, '</p>');
  s = s.replace(/<p>\s*<\/p>/gi, '');
  s = s.replace(/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/gi, '<p><br></p>');
  return s;
}

// Returns a list of reasons the result must NOT be written. Empty = safe.
// Self-contained on purpose: no module-scope helpers, so this stays correct if
// it is ever stringified and evaluated somewhere else. (An earlier version
// referenced a module-scope countRecs and threw ReferenceError inside the page.)
export function check(before, after) {
  const countRecs = (s) => (s.match(/https:\/\/www\.udemy\.com\/course\//g) || []).length;
  const bad = [];
  if (/facebook\.com/i.test(after)) bad.push('facebook link survived');
  if (/instagram\.com/i.test(after)) bad.push('instagram link survived');
  if (/\/\/x\.com/i.test(after)) bad.push('x.com link survived');
  if (/linkedin\.com/i.test(before) && !/linkedin\.com/i.test(after)) bad.push('LOST linkedin');
  if (/starweaver\.com/i.test(before) && !/starweaver\.com/i.test(after)) bad.push('LOST website');
  if (/paulsiegel2/i.test(before) && !/paulsiegel2/i.test(after)) bad.push('LOST udemy profile');
  if (countRecs(before) !== countRecs(after)) bad.push(`rec-link count ${countRecs(before)} -> ${countRecs(after)}`);
  if (/<p>\s*<\/p>/i.test(after)) bad.push('empty paragraph left');
  if (/(<p>\s*<br\s*\/?>\s*<\/p>\s*){2,}/i.test(after)) bad.push('double blank line');
  if (/\s+<\/p>/i.test(after)) bad.push('trailing space before </p>');
  if (after.length >= before.length) bad.push('body did not shrink');
  return bad;
}

// A <br> just before </p> is only a defect when the paragraph has other content.
// A paragraph that is ONLY <br> is the template's blank-line spacer and is
// intentional — matching it naively flags every course.
export function danglingBreaks(body) {
  return [...String(body).matchAll(/<p>((?:(?!<\/p>)[\s\S])*)<\/p>/gi)]
    .map((m) => m[1])
    .filter((c) => !/^\s*<br\s*\/?>\s*$/i.test(c) && /<br\s*\/?>\s*$/i.test(c));
}
