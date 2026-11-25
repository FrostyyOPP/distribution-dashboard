// The IBM tab's Excel export (GET /api/coursera-ibm/export.xlsx), in the layout of the team's
// IBM report: one row per course of the IBM Professional Certificates, banded by certificate,
// low-rated courses in red, the three Progress Funnel columns under a light-blue header.
// Added 2026-11-18 at the user's request ("in that format also in the export excel").
import ExcelJS from 'exceljs';

const BAND = {   // row colour per certificate, as in the team's sheet
  'ibm-management-consultant': 'FFF2DCDB',
  'ibm-sales-representative': 'FFC5D9F1',
  'ibm-business-process-automation-with-ai-assistants': 'FFEBF1DE',
  'ibm-building-and-managing-agentic-teams': 'FF95B3D7',
};
const NAVY = 'FF1F2A44', SKY = 'FF5DADE2';
const monthName = (ym) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const ist = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 36e5) : null);   // shown as IST wall time

// For a course run in sessions, Coursera's default (eligible-learner) funnel counts only the
// learners who already finished — 100% / 0% / 0% — so the report shows the all-learners figures.
export const funnelShown = (c) => (c.sessionCourse
  ? { rate: c.allCompletionRate, before: c.allDropBeforeM1, after: c.allDropAfterM1, all: true }
  : { rate: c.funnelCompletionRate, before: c.dropBeforeM1, after: c.dropAfterM1, all: false });

export async function buildIbmWorkbook(data, { certificate } = {}) {
  const rows = (data.courses || []).filter((c) => !certificate || c.certificate === certificate);
  const now = monthName(data.thisMonth), prev = monthName(data.lastMonth);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Distribution Dashboard';
  wb.created = new Date();
  const font = { name: 'Arial', size: 10 };

  // ---- 1. the report ----
  const ws = wb.addWorksheet('IBM courses', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Professional Certificate', key: 'cert', width: 44 },
    { header: 'Course No.', key: 'no', width: 10 },
    { header: 'Course title', key: 'title', width: 60 },
    { header: 'Course Owner', key: 'owner', width: 13 },
    { header: `Enrollments ${now}`, key: 'enr', width: 14, style: { numFmt: '#,##0' } },
    { header: `Enrollments ${prev}`, key: 'enrPrev', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Change vs last month', key: 'chg', width: 13, style: { numFmt: '#,##0' } },
    { header: 'Rating', key: 'rating', width: 9, style: { numFmt: '0.00' } },
    { header: 'Completion Rate', key: 'rate', width: 13, style: { numFmt: '0.0%' } },
    { header: 'Learner Drop-off Before Module 1', key: 'before', width: 15, style: { numFmt: '0.0%' } },
    { header: 'Learner Drop-off After Module 1', key: 'after', width: 15, style: { numFmt: '0.0%' } },
  ];
  const head = ws.getRow(1);
  head.height = 44;
  head.eachCell((cell, col) => {
    const sky = col >= 9;
    cell.font = { ...font, bold: true, color: { argb: sky ? NAVY : 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sky ? SKY : NAVY } };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: col <= 4 ? 'left' : 'center' };
  });
  let notes = 0;
  for (const c of rows) {
    const fs = funnelShown(c);
    const row = ws.addRow({
      cert: c.certificate, no: c.courseNo ? `C${c.courseNo}` : '',
      title: { text: c.name, hyperlink: c.url },
      owner: c.owner,
      enr: c.enrollments ?? null, enrPrev: c.enrolledEndLastMonth ?? null,
      chg: c.enrollments != null && c.enrolledEndLastMonth != null ? c.enrollments - c.enrolledEndLastMonth : null,
      rating: c.ratings ? Math.round(c.rating * 100) / 100 : null,
      rate: fs.rate, before: fs.before, after: fs.after,
    });
    const red = c.rating != null && c.ratings && c.rating < 4;      // low-rated courses stand out, as in the team's sheet
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { ...font, color: { argb: red ? 'FFFF0000' : 'FF000000' }, underline: col === 3 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND[c.certSlug] || 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: col <= 4 ? 'left' : 'right' };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFBFBFBF' } } };
    });
    if (c.funnelNoAccess) {
      row.getCell('rate').value = 'no access';
      row.getCell('rate').note = 'Our Coursera login has no Analytics access to this course.';
    } else if (fs.all) {
      notes++;
      for (const k of ['rate', 'before', 'after']) row.getCell(k).font = { ...font, italic: true, color: { argb: red ? 'FFFF0000' : 'FF000000' } };
      row.getCell('rate').note = `All learners. Most learners are still in a live session, so Coursera's default (eligible-learner) view counts only the ${c.funnelEnrolled ?? ''} who finished and shows ${Math.round((c.funnelCompletionRate ?? 1) * 100)}%.`;
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: 11 } };
  const foot = ws.addRow([]);
  const f1 = ws.addRow([`Enrollments: each course's Coursera Analytics › Summary page (all time, all course versions); "${prev}" = at the end of that month. Completion and drop-off: Analytics › Progress Funnel.`]);
  f1.getCell(1).font = { ...font, italic: true, color: { argb: 'FF595959' } };
  if (notes) {
    const f2 = ws.addRow([`Italic = all learners: ${notes} newer course(s) run in sessions, where Coursera's default eligible-learner view counts only learners who already finished (100%). Hover the cell for details.`]);
    f2.getCell(1).font = { ...font, italic: true, color: { argb: 'FF595959' } };
  }
  void foot;

  // ---- 2. every figure ----
  const ws2 = wb.addWorksheet('All figures', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
  const cols = [
    ['Professional Certificate', 40, (c) => c.certificate], ['Course No.', 9, (c) => (c.courseNo ? `C${c.courseNo}` : '')],
    ['Course title', 52, (c) => c.name], ['Course Owner', 11, (c) => c.owner], ['On the IBM list', 10, (c) => (c.inList ? 'Yes' : 'No')], ['IBM list title', 40, (c) => c.listTitle || ''],
    ['Batch', 14, (c) => c.batch || ''],
    ['Unique visitors', 12, (c) => c.visitors, '#,##0'], ['Enrolled (all time)', 12, (c) => c.enrollments, '#,##0'],
    ['Started (all time)', 12, (c) => c.starters, '#,##0'], ['Completed (all time)', 12, (c) => c.completions, '#,##0'],
    ['Completion rate (all time)', 12, (c) => c.completionRate, '0.0%'],
    [`Enrolled in ${now}`, 11, (c) => c.enrolledThisMonth, '#,##0'], [`Enrolled in ${prev}`, 11, (c) => c.enrolledLastMonth, '#,##0'],
    ['Rating', 8, (c) => (c.ratings ? c.rating : null), '0.00'], ['Ratings', 9, (c) => c.ratings, '#,##0'], ['Written reviews', 9, (c) => c.reviews, '#,##0'],
    ['Funnel: eligible enrolled', 11, (c) => c.funnelEnrolled, '#,##0'], ['Funnel: eligible completed', 11, (c) => c.funnelCompleted, '#,##0'],
    ['Funnel: completion rate (eligible)', 12, (c) => c.funnelCompletionRate, '0.0%'],
    ['Funnel: drop-off before Module 1 (eligible)', 13, (c) => c.dropBeforeM1, '0.0%'], ['Funnel: drop-off after Module 1 (eligible)', 13, (c) => c.dropAfterM1, '0.0%'],
    ['Funnel: all learners enrolled', 11, (c) => c.allFunnelEnrolled, '#,##0'],
    ['Funnel: completion rate (all learners)', 12, (c) => c.allCompletionRate, '0.0%'],
    ['Funnel: drop-off before Module 1 (all learners)', 13, (c) => c.allDropBeforeM1, '0.0%'], ['Funnel: drop-off after Module 1 (all learners)', 13, (c) => c.allDropAfterM1, '0.0%'],
    ['Run in sessions', 9, (c) => (c.sessionCourse ? 'Yes' : '')],
    ['Summary read (IST)', 16, (c) => ist(c.readAt), 'dd mmm yyyy hh:mm'], ['Funnel read (IST)', 16, (c) => ist(c.funnelReadAt), 'dd mmm yyyy hh:mm'],
    ['Course page', 30, (c) => ({ text: 'Open', hyperlink: c.url })], ['Summary page', 14, (c) => ({ text: 'Open', hyperlink: c.summaryUrl })],
    ['Progress Funnel page', 14, (c) => ({ text: 'Open', hyperlink: c.funnelUrl })],
  ];
  ws2.columns = cols.map(([header, width]) => ({ header, width }));
  ws2.getRow(1).height = 56;
  ws2.getRow(1).eachCell((cell) => {
    cell.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  for (const c of rows) {
    const row = ws2.addRow(cols.map(([, , get]) => get(c) ?? null));
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { ...font, ...(typeof cell.value === 'object' && cell.value?.hyperlink ? { color: { argb: 'FF0563C1' }, underline: true } : {}) };
      if (cols[col - 1][3]) cell.numFmt = cols[col - 1][3];
    });
  }
  ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: cols.length } };

  // ---- 3. about ----
  const ws3 = wb.addWorksheet('About');
  ws3.getColumn(1).width = 150;
  const lines = [
    ['IBM courses on Coursera', { bold: true, size: 13 }],
    [`Exported ${ist(new Date().toISOString()).toISOString().slice(0, 16).replace('T', ' ')} IST from the Distribution Dashboard (IBM tab). ${rows.length} courses: every course of the IBM Professional Certificates, in certificate order.`],
    [''],
    ['Enrollments, rating: each course\'s Coursera Analytics › Summary page — all time, all course versions (read nightly).'],
    [`"Enrollments ${prev}" = enrolled at the end of ${prev} (all time now minus this month's new enrolments). Change = new enrolments this month.`],
    ['Completion Rate: Analytics › Progress Funnel › Course Level Metrics (Completed ÷ Enrollment) — Coursera\'s default view: eligible learners, last 1 year.'],
    ['Learner Drop-off Before Module 1: the funnel\'s drop rate at "Module 01 Started Item" — enrolled learners who never started Module 1.'],
    ['Learner Drop-off After Module 1: of the learners who completed Module 1, the share who have not completed the course (from the funnel\'s checkpoint drop rates).'],
    ['Courses run in sessions (italic): most learners are still in a live session and Coursera\'s eligible view counts only those who finished, so the all-learners figures are shown.'],
    ['Course Owner: Starweaver for the courses on our IBM list (built by Starweaver), IBM for the certificates\' other courses.'],
    ['Red rows: rating below 4. "no access": our Coursera login has no Analytics access to that course.'],
  ];
  for (const [t, f] of lines) { const r = ws3.addRow([t]); r.getCell(1).font = { ...font, ...(f || {}), color: { argb: f ? 'FF000000' : 'FF404040' } }; r.getCell(1).alignment = { wrapText: true }; }

  return wb.xlsx.writeBuffer();
}
