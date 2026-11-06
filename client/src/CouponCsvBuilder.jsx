import { useMemo, useState } from 'react';

// Builds the CSV for Udemy's bulk coupon upload from a course sheet — normally
// Udemy's own "eligible courses" export. Every course in the sheet goes in, all
// with the same code. Creating the coupons is still done by uploading the CSV
// on Udemy; this never writes to the account.
//
// A .csv is read in the browser. An .xlsx is sent to this dashboard's server
// only to be read (/api/coupons/read-sheet) and is not stored.
//
// The output matches Udemy's Instructor Bulk Coupon CSV Template:
//   course_id,coupon_type,coupon_code,start_date,start_time,custom_price

// How long each type runs, as observed on this account — Udemy sets it, the
// CSV cannot. best_price: 5 days (OCT_BESTPRICE, 2026-10-06 → 10-11).
// custom_price and free_targeted: 31 days (SEPT_BESTPRICE, SEP2026-FREE).
const TYPES = [
  { id: 'best_price', label: 'Best price', note: "Each course's lowest allowed price. Runs 5 days." },
  { id: 'custom_price', label: 'Custom price', note: 'Price taken from the sheet. Runs 31 days.' },
  { id: 'free_targeted', label: 'Free — targeted', note: 'Free, limited redemptions. Runs 31 days.' },
  { id: 'free_open', label: 'Free — open', note: 'Free for anyone with the link. Udemy sets the duration and cap.' },
];
// The custom price comes from the sheet: a custom_price (or price) column if it
// has one, otherwise min_custom_price — each course's lowest allowed custom
// price, which Udemy's eligible-courses export always carries.
const PRICE_COLUMNS = ['custom_price', 'price', 'min_custom_price'];
// Udemy's rule for codes: 6–20 characters of A–Z, 0–9, '.', '-', '_'.
const CODE_RE = /^[A-Z0-9._-]{6,20}$/;
const PT = 'America/Los_Angeles';

// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

async function readSheet(file) {
  const bytes = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isXlsx = /\.xlsx?$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b); // "PK" = zip
  if (!isXlsx) return parseCsv(await file.text());
  const res = await fetch('/api/coupons/read-sheet', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.rows;
}

// Udemy reads start_date / start_time as Pacific time. Defaults to the next
// half hour in PT, so an upload made straight away is not already in the past.
function nextHalfHourPT() {
  const now = new Date(Date.now() + 30 * 60e3);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const m = Number(parts.minute) < 30 ? '30' : '00';
  let h = Number(parts.hour) + (m === '00' ? 1 : 0);
  // Rolling past midnight is left to the user; it only happens close to 23:30 PT.
  if (h > 23) h = 23;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(h).padStart(2, '0')}:${m}` };
}

// The same moment in the viewer's own time zone, so "05:00" is not misread.
function localEquivalent(date, time) {
  if (!date || !/^\d{2}:\d{2}$/.test(time)) return '';
  // Find the UTC instant whose Pacific wall-clock reads date+time: read the
  // Pacific wall-clock of a first guess, and shift by the difference.
  const guess = new Date(`${date}T${time}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(guess).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const instant = new Date(guess.getTime() - (wallAsUtc - guess.getTime()));
  return instant.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

export default function CouponCsvBuilder() {
  const start = useMemo(nextHalfHourPT, []);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [sheet, setSheet] = useState(null); // { courses, priceColumn }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState('best_price');
  const [code, setCode] = useState('');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    setSheet(null);
    setFileName(f.name);
    setBusy(true);
    try {
      const rows = await readSheet(f);
      if (!rows?.length) throw new Error('The file is empty.');
      const head = rows[0].map((h) => String(h).trim().toLowerCase());
      const at = (name) => head.indexOf(name);
      if (at('course_id') < 0) throw new Error('The sheet needs a course_id column (Udemy’s numeric course ID).');
      const priceColumn = PRICE_COLUMNS.find((c) => at(c) >= 0) || null;
      const cell = (r, name) => (at(name) >= 0 ? String(r[at(name)] ?? '').trim() : '');
      const num = (v) => (v === '' ? null : Number(v));
      const courses = rows.slice(1).map((r) => ({
        id: cell(r, 'course_id').replace(/\.0+$/, ''),
        name: cell(r, 'course_name'),
        currency: cell(r, 'currency'),
        price: priceColumn ? num(cell(r, priceColumn)) : null,
        min: num(cell(r, 'min_custom_price')),
        max: num(cell(r, 'max_custom_price')),
        left: num(cell(r, 'coupons_remaining')),
      })).filter((c) => c.id);
      if (!courses.length) throw new Error('No courses found in that file.');
      setSheet({ courses, priceColumn });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const t = TYPES.find((x) => x.id === type);
  const codeOk = CODE_RE.test(code);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);

  // Every course in the sheet, unless Udemy would reject its row.
  const plan = useMemo(() => (sheet?.courses || []).map((c) => {
    let skip = null;
    let customPrice = '';
    if (!/^\d+$/.test(c.id)) skip = `course_id "${c.id}" is not a number`;
    else if (c.left === 0) skip = 'no coupons left this month';
    else if (type === 'custom_price') {
      if (!(c.price > 0)) skip = `no price in ${sheet.priceColumn || 'the sheet'}`;
      else if (c.min != null && c.price < c.min) skip = `price ${c.price} is below this course's minimum (${c.min})`;
      else if (c.max != null && c.price > c.max) skip = `price ${c.price} is above this course's maximum (${c.max})`;
      else customPrice = c.price.toFixed(2);
    }
    return { ...c, skip, customPrice };
  }), [sheet, type]);

  const ready = plan.filter((r) => !r.skip);
  const skipped = plan.filter((r) => r.skip);
  const canDownload = ready.length > 0 && codeOk && timeOk && dateOk;
  const line = (r) => [r.id, type, code, date, time, r.customPrice].join(',');

  function download() {
    const lines = ['course_id,coupon_type,coupon_code,start_date,start_time,custom_price', ...ready.map(line)];
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `udemy_bulk_coupons_${code}_${type}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <button className="ghost" onClick={() => setOpen(true)}>🧾 Build import CSV</button>
      {open && (
        <div className="drawer-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" style={{ width: 'min(760px, 96vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Build a bulk coupon CSV</h2>
              <button className="close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 12, maxHeight: '80vh', overflowY: 'auto' }}>
              <div className="banner" style={{ margin: 0, borderColor: 'var(--border)' }}>
                Upload the course sheet — Udemy's <b>eligible courses</b> export, CSV or Excel. Every course in it
                goes into the file with the same code. This only makes the file: upload it on Udemy to create the coupons.
              </div>

              <label className="fld">1 · Course sheet (.csv or .xlsx)
                <input type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={onFile} />
              </label>
              {busy && <div className="muted small">Reading {fileName}…</div>}
              {error && <div className="banner err" style={{ margin: 0 }}>❌ {error}</div>}
              {sheet && (
                <div className="muted small">
                  {fileName} · {sheet.courses.length} courses
                  {sheet.priceColumn ? ` · custom price from the "${sheet.priceColumn}" column` : ' · no price column (custom price unavailable)'}
                </div>
              )}

              <div className="row2">
                <label className="fld">2 · Coupon type
                  <select value={type} onChange={(e) => setType(e.target.value)}>
                    {TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                  <span className="muted small">{t.note}</span>
                </label>
                <label className="fld">3 · Coupon code (same for every course)
                  <input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="e.g. NOV_BESTPRICE" />
                  <span className="small" style={code && !codeOk ? { color: '#dc2626' } : { color: 'var(--muted)' }}>6–20 characters: A–Z, 0–9, . - _</span>
                </label>
              </div>

              <div className="row2">
                <label className="fld">4 · Start date (Pacific time)
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <label className="fld">Start time (Pacific time, 24h)
                  <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="05:00" />
                  <span className="muted small">{timeOk && dateOk ? `= ${localEquivalent(date, time)}` : 'HH:MM'}</span>
                </label>
              </div>

              {sheet && (
                <div className="banner" style={{ margin: 0, borderColor: 'var(--border)' }}>
                  <b>{ready.length}</b> of {plan.length} course{plan.length === 1 ? '' : 's'} go in the file
                  {skipped.length > 0 && <> · <span style={{ color: '#dc2626' }}>{skipped.length} left out</span>
                    <div className="small" style={{ marginTop: 6 }}>
                      {skipped.slice(0, 8).map((r) => <div key={r.id}>{r.name || r.id} — {r.skip}</div>)}
                      {skipped.length > 8 && <div className="muted">…and {skipped.length - 8} more</div>}
                    </div></>}
                  {codeOk && ready.length > 0 && (
                    <div className="mono small" style={{ marginTop: 8, whiteSpace: 'pre', overflowX: 'auto' }}>
                      {['course_id,coupon_type,coupon_code,start_date,start_time,custom_price', ...ready.slice(0, 4).map(line), ready.length > 4 ? `… ${ready.length - 4} more` : ''].filter(Boolean).join('\n')}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={download} disabled={!canDownload}>⬇ Download CSV{sheet ? ` (${ready.length})` : ''}</button>
                {sheet && !codeOk && <span className="small muted">Enter a coupon code to download</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
