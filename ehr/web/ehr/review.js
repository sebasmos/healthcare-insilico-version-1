// History tables: one sortable table per section, grouped by age, with the same six columns, the same
// filters, a preview pane and "Load more" paging for large charts. Rows are plain objects built from FHIR
// records by the chart; nothing is fetched here.
//   row: { id, when, type, with, description, complaint, discharge, tags: ['me', 'admission', 'tele', 'visit', 'ancillary'], preview: () => Node }
import { h, btn, badge, fmtDate } from '/shared/ui.js';

export const PAGE = 50;
const FILTERS = [['me', 'Me'], ['admission', 'Admissions'], ['tele', 'Tel/Email'], ['visit', 'Visits'], ['ancillary', 'Ancillary']];
const COLUMNS = [['when', 'When'], ['type', 'Type'], ['with', 'With'], ['description', 'Description'], ['complaint', 'Chief Complaint'], ['discharge', 'Discharge Date']];
const states = new Map();
/** What the person chose for one section of one chart; kept while the page is open. */
export function reviewState(key) { if (!states.has(key)) states.set(key, { sort: 'when', dir: -1, filters: new Set(), selected: null, previewing: false, shown: PAGE }); return states.get(key); }

/** "6 Months Ago", "1 Year Ago", "2 Years Ago": how long ago, in plain steps. */
export function ageGroup(iso, now = new Date()) {
  if (!iso) return 'No Date';
  const days = (now - new Date(iso)) / 86400000;
  if (days < 0) return 'Upcoming';
  if (days < 183) return 'Last 6 Months';
  if (days < 365) return '6 Months Ago';
  const years = Math.floor(days / 365);
  return years === 1 ? '1 Year Ago' : `${years} Years Ago`;
}
const text = (v) => (v == null ? '' : String(v));

export function reviewTable({ testid, rows, state, redraw, toolbar = [], empty = 'No data to display' }) {
  // Filters narrow the list to rows carrying any ticked tag.
  const filtered = state.filters.size ? rows.filter((r) => (r.tags || []).some((t) => state.filters.has(t))) : rows;
  const sorted = [...filtered].sort((a, b) => state.dir * text(a[state.sort]).localeCompare(text(b[state.sort])) || text(b.when).localeCompare(text(a.when)));
  const shown = sorted.slice(0, state.shown);
  if (state.selected && !sorted.some((r) => r.id === state.selected)) { state.selected = null; state.previewing = false; }
  const selected = sorted.find((r) => r.id === state.selected) || null;
  const sortBy = (key) => { if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'when' ? -1 : 1; } redraw(); };
  const head = h('tr', {}, COLUMNS.map(([key, label]) => h('th', { 'aria-sort': state.sort === key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none' },
    h('button', { type: 'button', class: 'link sorth', testid: `${testid}-sort-${key}`, 'aria-label': `Sort by ${label}`, onClick: () => sortBy(key) }, label, state.sort === key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''))));
  const body = h('tbody', {});
  let last = null;
  for (const r of shown) {
    // Grouping by age only makes sense while the list is in date order.
    const g = state.sort === 'when' ? ageGroup(r.when) : null;
    if (g && g !== last) { last = g; body.append(h('tr', { class: 'group' }, h('td', { colspan: COLUMNS.length, testid: `${testid}-group` }, g))); }
    body.append(h('tr', { class: `clickable${r.id === state.selected ? ' selected' : ''}`, testid: `${testid}-row-${r.id}`, tabindex: 0, 'aria-selected': String(r.id === state.selected),
      onClick: (e) => { if (e.target.closest('button, a, input, select')) return; state.selected = r.id; redraw(); },
      onDblclick: () => { state.selected = r.id; state.previewing = true; redraw(); },
      onKeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { state.selected = r.id; state.previewing = true; redraw(); } } },
    h('td', {}, r.when ? fmtDate(r.when) : ''), h('td', {}, r.type || ''), h('td', {}, r.with || ''), h('td', {}, r.description || '', r.badge ? [' ', r.badge] : null), h('td', {}, r.complaint || ''), h('td', {}, r.discharge ? fmtDate(r.discharge) : '')));
  }
  if (!shown.length) body.append(h('tr', {}, h('td', { colspan: COLUMNS.length, class: 'empty', testid: `${testid}-empty` }, rows.length ? 'No rows match the filters' : empty)));
  const more = sorted.length > shown.length ? h('div', { class: 'banner info loadmore', testid: `${testid}-more-note`, role: 'status' }, `Showing ${shown.length} of ${sorted.length}. Not all records are loaded. `,
    btn('Load more', { small: true, testid: `${testid}-more`, onClick: () => { state.shown += PAGE; redraw(); } })) : null;
  const filters = h('div', { class: 'toolbar rfilters', role: 'group', 'aria-label': 'Filters' },
    btn('Preview', { small: true, kind: state.previewing ? 'primary' : '', testid: `${testid}-preview`, disabled: !selected, onClick: () => { state.previewing = !state.previewing; redraw(); } }),
    ...toolbar,
    ...FILTERS.map(([id, label]) => h('label', { class: 'rfilter' }, h('input', { type: 'checkbox', checked: state.filters.has(id), testid: `${testid}-filter-${id}`, 'aria-label': `Filter: ${label}`, onChange: (e) => { if (e.target.checked) state.filters.add(id); else state.filters.delete(id); state.shown = PAGE; redraw(); } }), ` ${label}`)),
    btn('Clear Filters', { small: true, testid: `${testid}-clear`, disabled: !state.filters.size, onClick: () => { state.filters.clear(); redraw(); } }),
    h('span', { class: 'muted small', testid: `${testid}-count` }, `${sorted.length} of ${rows.length}`));
  const list = h('div', {}, filters, more, h('div', { class: 'tablewrap' }, h('table', { testid, class: 'review' }, h('thead', {}, head), body)));
  if (!state.previewing || !selected) return list;
  return h('div', { class: 'split review-split' }, list, h('div', { class: 'card preview-pane', testid: `${testid}-pane`, 'aria-label': 'Preview' },
    h('div', { class: 'toolbar', style: 'margin:0 0 0.5rem' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Preview'), btn('Close', { small: true, testid: `${testid}-pane-close`, onClick: () => { state.previewing = false; redraw(); } })),
    selected.preview ? selected.preview() : h('p', { class: 'muted' }, 'No data to display')));
}
export const statusChip = (s) => (s ? badge(String(s).replace(/-/g, ' '), ['active', 'completed', 'final', 'finished', 'approved'].includes(s) ? 'ok' : ['cancelled', 'revoked', 'rejected', 'entered-in-error', 'noshow'].includes(s) ? 'danger' : 'warn') : null);
