// Shared data logic ported verbatim from the live App.jsx so the redesign is an
// exact superset (same Domain classification, instructor flags, CSV export).

export const DOMAIN_RULES = [
  { domain: 'Finance & Capital Markets', keywords: [
    'capital market','financial market','bond market','fixed income','yield curve',
    'interest rate swap','equity swap','credit risk','credit analysis','credit portfolio',
    'commercial credit','mortgage backed','mortgage business','securities trade',
    'professional futures','stock market','equity market','blockchain for finance',
    'financial math','financial modeling','financial modelling','financial model',
    'financial analyst','credit underwriting','accounting to valuation',
    'startup accounting','data to insight: storytelling for finance',
    'análisis y suscripción','análisis de crédito','fundamentos del análisis de crédito',
    'narrativa de datos para inversionistas',
  ]},
  { domain: 'AI / Generative AI', keywords: [
    'generative ai','genai','gen ai','chatgpt','llm','large language model',
    'prompt engineering','rag systems','langchain','ai engineer','ai model engineering',
    'ai for non-technical','ai-powered','ai for entrepreneurs','ai for leaders',
    'ai for hr','ai for marketing','ai for finance','ai for product','ai for legal',
    'ai for healthcare','ai in healthcare','ai video production',
    'autonomous ai','ai strategy','enterprise ai','ai leadership',
    'ai-driven','ai & digital','generative ai in','intelligent',
    'copilot','claude & gemini',
  ]},
  { domain: 'Cybersecurity', keywords: [
    'cybersecurity','cyber security','cyber threat','threat hunting','threat intelligence',
    'penetration testing','ethical hacking','incident response','cyber defense',
    'cyber investigation','forensics','digital forensics','application security',
    'endpoint security','network defense','cloud security','offensive cyber',
    'cyber espionage','counterintelligence','nist','iso cybersecurity',
    'cyber deterrence','cyber effects','cyber risk','soc operations',
    'vulnerability','malware','security operations','security governance',
  ]},
  { domain: 'Healthcare & Life Sciences', keywords: [
    'healthcare','clinical','ehr','electronic health','telemedicine','virtual care',
    'pharmaceutical','health data','digital health','life sciences','medical',
    'clinical decision','patient','nursing','biomedical','hospital',
    'health informatics','health governance','health security',
  ]},
  { domain: 'Data & Analytics', keywords: [
    'data science','machine learning','data analytics','data visualization',
    'power bi','statistics for business','big data','python for data',
    'data storytelling','analytics','data pipeline','data modeling',
    'data insight','master statistics','advanced ai for data',
  ]},
  { domain: 'Cloud & DevOps', keywords: [
    'aws','azure','google cloud','cloud security','devops','devsecops',
    'ansible','infrastructure','kubernetes','docker','ci/cd',
    'cloud operations','cloud protection','cloud immersion',
  ]},
  { domain: 'Business & Leadership', keywords: [
    'leadership','executive','ceo','change management','business transformation',
    'digital transformation','business operations','business strategy','business process',
    'business analysis','iiba','cbap','management','entrepreneurial','strategy for business',
    'ai roadmap for leaders','lead smarter','ai for enterprise',
  ]},
  { domain: 'Sales & Marketing', keywords: [
    'sales','marketing','social media marketing','facebook ads','shopify','dropshipping',
    'seo','customer service','customer journey','relationship management',
    'sales leadership','client & sales','beyond the transaction',
  ]},
  { domain: 'Communication & Writing', keywords: [
    'writing','communication','listening','presentation','storytelling for',
    'business writing','technical writing','data storytelling',
    'global business communication','active listening','narrativa de datos',
    'redacción','escritura','comunicación','escucha activa',
  ]},
  { domain: 'Product Management', keywords: [
    'product management','product innovation','product manager',
    'ai product','product strategy',
  ]},
  { domain: 'HR & People', keywords: [
    'hr management','human resources','talent','people management',
    'emotional intelligence','team dynamics','supervision',
    'from peer to leader','workplace',
  ]},
  { domain: 'Hospitality', keywords: [
    'hotel','hospitality','food & beverage','guest experience',
  ]},
];

export function classifyDomain(title = '') {
  const t = title.toLowerCase();
  for (const { domain, keywords } of DOMAIN_RULES) if (keywords.some((kw) => t.includes(kw))) return domain;
  return 'Other';
}

export const FINANCE_DOMAINS = new Set(['Finance & Capital Markets']);

export const DOMAIN_COLOR = {
  'Finance & Capital Markets': '#0066cc', 'AI / Generative AI': '#a435f0', 'Cybersecurity': '#ef4444',
  'Healthcare & Life Sciences': '#10b981', 'Data & Analytics': '#06b6d4', 'Cloud & DevOps': '#f59e0b',
  'Business & Leadership': '#8b5cf6', 'Sales & Marketing': '#ec4899', 'Communication & Writing': '#14b8a6',
  'Product Management': '#6366f1', 'HR & People': '#f43f5e', 'Hospitality': '#84cc16', 'Other': '#9ca3af',
};

export function instructorInfo(course) {
  const names = (course.visible_instructors || []).map((i) => i.title || i.name || '');
  const hasPaul = names.some((n) => n.includes('Paul Siegel'));
  const hasGlobecon = names.some((n) => n.includes('Globecon'));
  const sme = names.filter((n) => !n.includes('Starweaver') && !n.includes('Paul Siegel') && !n.includes('Globecon'));
  return { hasPaul, hasGlobecon, sme };
}

export const capNames = (list) =>
  !Array.isArray(list) ? [] : list.map((x) => (typeof x === 'string' ? x : x?.title || x?.locale || '')).filter(Boolean);

export const usd = (n) =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// enrich a raw Udemy course with the derived fields the live table shows
export function enrich(c) {
  const domain = classifyDomain(c.title);
  const isFinance = FINANCE_DOMAINS.has(domain);
  const { hasPaul, hasGlobecon, sme } = instructorInfo(c);
  const above2k = c.num_subscribers == null ? 'N/A' : c.num_subscribers > 2000 ? 'Yes' : 'No';
  return { ...c, domain, isFinance, hasPaul, hasGlobecon, sme, above2k };
}

// Smart search: applies the structured filter returned by POST /api/search/parse.
const FIELD_GETTERS = {
  rating: (c) => (c.rating != null ? Number(c.rating) : null),
  num_reviews: (c) => Number(c.num_reviews) || 0,
  num_subscribers: (c) => c.num_subscribers,
  revenue: (c) => c.revenue,
  captions_count: (c) => capNames(c.caption_locales).length,
  coupons_count: (c) => (Array.isArray(c.coupons) ? c.coupons.length : 0),
  is_published: (c) => !!c.is_published,
  domain: (c) => c.domain || '',
  title: (c) => c.title || '',
};

function evalCondition(course, { field, op, value }) {
  const getter = FIELD_GETTERS[field];
  if (!getter) return true;
  const v = getter(course);
  if (op === 'contains') return String(v).toLowerCase().includes(String(value).toLowerCase());
  if (v == null) return false; // unknown value never matches a numeric/boolean comparison
  const nv = typeof value === 'boolean' ? value : (isNaN(Number(value)) ? value : Number(value));
  switch (op) {
    case '<': return v < nv;
    case '<=': return v <= nv;
    case '>': return v > nv;
    case '>=': return v >= nv;
    case '=': return v === nv;
    case '!=': return v !== nv;
    default: return true;
  }
}

export function applyFilter(rows, spec) {
  if (!spec || !Array.isArray(spec.conditions) || !spec.conditions.length) return rows;
  const combine = spec.combinator === 'OR' ? 'some' : 'every';
  return rows.filter((c) => spec.conditions[combine]((cond) => evalCondition(c, cond)));
}

// Parses a typed phrase like "rating below 4.3" or "no coupons" into the same
// {conditions, combinator} shape applyFilter() expects — no network call, so
// it can run on every keystroke. Falls back to a plain title-contains search
// when no metric/operator is recognized.
const FIELD_LABELS = {
  rating: 'rating', num_reviews: 'review count', num_subscribers: 'students', revenue: 'revenue',
  captions_count: 'captions', coupons_count: 'coupons', is_published: 'published',
};
const OP_LABELS = { '<': 'below', '<=': 'at most', '>': 'above', '>=': 'at least', '=': '=', '!=': '≠' };
const FIELD_PATTERNS = [
  ['captions_count', /captions?|subtitles?/i],
  ['coupons_count', /coupons?/i],
  ['num_subscribers', /students?|enroll\w*|subscribers?/i],
  ['num_reviews', /reviews?|ratings?\s*count|number of ratings|total ratings/i],
  ['revenue', /revenue|earnings?|income/i],
  ['rating', /ratings?|stars?/i],
];
const OPERATOR_PATTERNS = [
  [/(<=|≤|at most|no more than|maximum|max)/i, '<='],
  [/(>=|≥|at least|minimum|min)/i, '>='],
  [/(<|below|under|less than|fewer than|lower than)/i, '<'],
  [/(>|above|over|more than|greater than|higher than)/i, '>'],
  [/(!=|not equal)/i, '!='],
  [/(=|exactly|equal to|equals)/i, '='],
];
const matchField = (text) => (FIELD_PATTERNS.find(([, re]) => re.test(text)) || [])[0] || null;

function parseClause(raw) {
  const clause = raw.trim();
  if (!clause) return null;
  if (/\bunpublished\b|\bnot published\b|\bdraft\b/i.test(clause)) return { field: 'is_published', op: '=', value: false, explanation: 'unpublished' };
  if (/\bpublished\b/i.test(clause)) return { field: 'is_published', op: '=', value: true, explanation: 'published' };
  const noMatch = clause.match(/\b(?:no|missing|zero|without)\s+(\w+)/i);
  if (noMatch) {
    const field = matchField(noMatch[1]);
    if (field) return { field, op: '=', value: 0, explanation: `no ${FIELD_LABELS[field]}` };
  }
  const field = matchField(clause);
  const numMatch = clause.match(/-?\d+(?:\.\d+)?/);
  if (field && numMatch) {
    const opEntry = OPERATOR_PATTERNS.find(([re]) => re.test(clause));
    if (opEntry) {
      const op = opEntry[1];
      const value = Number(numMatch[0]);
      return { field, op, value, explanation: `${FIELD_LABELS[field]} ${OP_LABELS[op]} ${value}` };
    }
  }
  return null;
}

export function parseSmartQuery(query) {
  const q = query.trim();
  if (!q) return null;
  const clauses = q.split(/\s+and\s+|,\s*/i).map(parseClause).filter(Boolean);
  if (clauses.length) {
    return {
      conditions: clauses.map(({ field, op, value }) => ({ field, op, value })),
      combinator: 'AND',
      explanation: clauses.map((c) => c.explanation).join(' and '),
    };
  }
  return { conditions: [{ field: 'title', op: 'contains', value: q }], combinator: 'AND', explanation: `title contains "${q}"` };
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportCsv(rows) {
  const headers = ['Title','Domain','Total Ratings','Total Enrollments','Enroll > 2k','Avg Rating','Revenue','Captions','Coupons Active','Coupons Left','Paul','Globecon','SME','URL'];
  const data = rows.map((c) => [
    c.title, c.domain, c.num_reviews ?? 0, c.num_subscribers ?? '', c.above2k,
    c.rating ? Number(c.rating).toFixed(2) : '', c.revenue ?? '',
    capNames(c.caption_locales).join('; '),
    Array.isArray(c.coupons) ? c.coupons.length : '',
    c.remaining_coupon_count ?? '',
    c.hasPaul ? 'Yes' : 'No', c.isFinance ? (c.hasGlobecon ? 'Yes' : 'No') : 'N/A', c.sme?.join('; ') || '',
    c.url ? `https://www.udemy.com${c.url}` : '',
  ]);
  const csv = [headers, ...data].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `courses-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// rows: course objects with `recentMonths` = [{month:'2026-07-01', minutes}, ...] descending
// (this month, last month, 2 months ago) — matches the Minutes Report table's columns.
export function exportMinutesCsv(rows) {
  const monthLabel = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
  const labels = rows[0]?.recent_months?.map((m) => monthLabel(m.month)) || ['This Month', 'Last Month', '2 Months Ago'];
  const headers = ['Course', 'Live Date', ...labels];
  const data = rows.map((c) => [
    c.title,
    (c.published_time || c.created) ? new Date(c.published_time || c.created).toISOString().slice(0, 10) : '',
    ...(c.recent_months || []).map((m) => m.minutes != null ? Math.round(m.minutes) : ''),
  ]);
  const csv = [headers, ...data].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `minutes-consumed-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function exportCourseraCsv(rows) {
  const headers = ['Course', 'Domain', 'Enrollments', 'Completions', 'Compl. Rate', 'Rating', 'Instructor', 'Instructor Names'];
  const data = rows.map((c) => [
    c.name, c.domain || '', c.enrollments ?? '', c.completions ?? '',
    c.completionRate != null ? (c.completionRate <= 1 ? Math.round(c.completionRate * 100) : Math.round(c.completionRate)) + '%' : '',
    c.rating ? Number(c.rating).toFixed(2) : '',
    c.hasStarweaverInstructor ? 'Yes' : 'No',
    c.instructorNames?.length ? c.instructorNames.join('; ') : '',
  ]);
  downloadCsv(`coursera-courses-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
}

export function exportFutureLearnCsv(rows) {
  const headers = ['Course', 'Code', 'Category', 'Status', 'Start Date', 'Wishlist', 'Enrollment'];
  const data = rows.map((c) => [
    c.title, c.code || '', c.category || '', c.status || '', c.startDate || '',
    c.wishlistCount ?? '', c.enrollment ?? '',
  ]);
  downloadCsv(`futurelearn-courses-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
}

export function exportLinkedInCsv(rows) {
  const headers = ['Course', 'Language', 'Learners', 'Shares', 'Likes', 'Last Updated'];
  const data = rows.map((c) => [
    c.title, c.language || '', c.learners ?? '', c.shares ?? '', c.likes ?? '', c.lastUpdated || '',
  ]);
  downloadCsv(`linkedin-learning-courses-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
}

export function exportGo1Csv(rows) {
  const headers = ['Course', 'Enrolments', 'Completions', 'Total Minutes', 'Avg Session'];
  const data = rows.map((c) => [
    c.name, c.enrolments ?? '', c.completions ?? '', c.totalMinutes ?? '', c.avgSessionMinutes ?? '',
  ]);
  downloadCsv(`go1-courses-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
}

// Watchlist spans every platform, and the platforms don't share a metric set —
// so this is one flat sheet with a Platform column and a blank wherever a
// metric doesn't exist for that platform (rather than pretending it's zero).
// `rows` are the normalised objects built by the Watchlist view.
export function exportWatchlistCsv(rows) {
  // Coursera's imported revenue carries full float precision — round money to
  // 2dp and minutes to whole numbers so the sheet is readable.
  const money = (v) => (v == null ? '' : Number(v).toFixed(2));
  const whole = (v) => (v == null ? '' : Math.round(Number(v)));
  const headers = ['Platform', 'Course', 'Status', 'Enrollments', 'Rating', 'Reviews',
                   'Completions', 'Revenue', 'Minutes Watched', 'Course Link', 'Bookmarked On'];
  const data = rows.map((r) => [
    r.platform, r.course, r.status ?? '', r.enrollments ?? '', r.rating ?? '', r.reviews ?? '',
    r.completions ?? '', money(r.revenue), whole(r.minutes), r.link ?? '', r.addedAt ?? '',
  ]);
  downloadCsv(`watchlist-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
}
