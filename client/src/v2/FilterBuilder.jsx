// A FILTER OF SEVERAL CONDITIONS AT ONCE — "enrollments over 2000 AND rating
// below 4.3".
//
// Every column on the table it is given can be filtered, and the operators
// offered depend on what the column holds: a quantity gets "more than", a short
// fixed list gets a dropdown of the values actually present, a tick gets yes/no.
// It builds the same {conditions, combinator} object applyFilter() already
// takes, so the typed search box and this produce one kind of thing.
//
// A CONDITION BEING BUILT DOES NOT FILTER ANYTHING YET. A half-typed number
// would otherwise blank the table on the way to a real answer, which reads as
// "no results" rather than "still typing".
import { useState, useRef, useEffect, useMemo } from 'react';
import { OPS_FOR, valuesFor } from './data.js';

const NEEDS_NO_VALUE = new Set(['blank', 'notblank', 'true', 'false']);

export const isComplete = (c, fields) => {
  const f = fields.find((x) => x.key === c.field);
  if (!f || !c.op) return false;
  if (NEEDS_NO_VALUE.has(c.op)) return true;
  return c.value !== '' && c.value != null;
};

export const specOf = (conditions, combinator, fields) => {
  const live = conditions.filter((c) => isComplete(c, fields));
  return live.length ? { conditions: live, combinator } : null;
};

const opLabel = (type, op) => (OPS_FOR[type] || []).find(([v]) => v === op)?.[1] || op;

export function describe(conditions, combinator, fields) {
  return conditions
    .filter((c) => isComplete(c, fields))
    .map((c) => {
      const f = fields.find((x) => x.key === c.field);
      const v = NEEDS_NO_VALUE.has(c.op) ? '' : ` ${c.value}`;
      return `${f.label} ${opLabel(f.type, c.op)}${v}`;
    })
    .join(combinator === 'OR' ? '  or  ' : '  and  ');
}

export default function FilterBuilder({ fields, rows, conditions, setConditions, combinator, setCombinator }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const byKey = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f])), [fields]);
  const live = conditions.filter((c) => isComplete(c, fields)).length;

  const add = () => setConditions((cs) => [...cs, { field: fields[0].key, op: OPS_FOR[fields[0].type][0][0], value: '' }]);
  const drop = (i) => setConditions((cs) => cs.filter((_, n) => n !== i));
  const set = (i, patch) => setConditions((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  // Changing the column has to reset the operator: "contains" makes no sense
  // once the column became a number, and leaving it there silently matches
  // nothing.
  const setField = (i, key) => set(i, { field: key, op: OPS_FOR[byKey[key].type][0][0], value: '' });

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={live ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => { if (!conditions.length) add(); setOpen((o) => !o); }}>
        ⛃ Filter{live ? ` · ${live}` : ''}
      </button>
      {open && (
        <div className="filter-menu">
          <div className="filter-head">
            <span>Show courses where</span>
            <select className="filter-comb" value={combinator} onChange={(e) => setCombinator(e.target.value)}>
              <option value="AND">all conditions match</option>
              <option value="OR">any condition matches</option>
            </select>
          </div>

          {conditions.length === 0 && <div className="filter-empty">No conditions yet.</div>}

          {conditions.map((c, i) => {
            const f = byKey[c.field] || fields[0];
            const needsValue = !NEEDS_NO_VALUE.has(c.op);
            return (
              <div key={i} className="filter-row">
                <span className="filter-join">{i === 0 ? 'where' : (combinator === 'OR' ? 'or' : 'and')}</span>
                <select value={c.field} onChange={(e) => setField(i, e.target.value)}>
                  {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select value={c.op} onChange={(e) => set(i, { op: e.target.value })}>
                  {(OPS_FOR[f.type] || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {needsValue && (f.type === 'enum'
                  ? (
                    <select value={c.value} onChange={(e) => set(i, { value: e.target.value })}>
                      <option value="">— pick —</option>
                      {valuesFor(rows, f).map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                    </select>
                  ) : (
                    <input
                      type={f.type === 'num' ? 'number' : 'text'}
                      value={c.value}
                      placeholder={f.type === 'num' ? '0' : 'text…'}
                      onChange={(e) => set(i, { value: e.target.value })}
                    />
                  ))}
                <button className="filter-x" title="Remove this condition" onClick={() => drop(i)}>✕</button>
              </div>
            );
          })}

          <div className="filter-foot">
            <button className="btn btn-secondary" onClick={add}>+ Add condition</button>
            <button className="btn btn-secondary" onClick={() => setConditions([])} disabled={!conditions.length}>Clear all</button>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {live ? `${live} applied` : 'nothing applied yet'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
