// Pathology: case worklist, accessioning, the deep-zoom slide viewer and
// sign-out. Same store, same log and same patient context as every
// other app. Reports go through the FHIR API, so the DiagnosticReport
// lifecycle, the Inbox notice and the portal release apply unchanged.
import { findingPanel } from '/shared/finding-panel.js';
import { toGeoJSON, fromGeoJSON, measure } from '/pathology/qupath.js';
import { createAnalysisPanel } from '/pathology/analysis-panel.js';
import { h, clear, btn, badge, toast, table, kv, field, formDialog, confirmDialog, openDialog, initApp, timeStrip, fmtDate, fmtDateTime, fmtTime, age, showError, slug } from '/shared/ui.js';
import { fhir, api, view, identity, flagged, ext } from '/shared/fhir.js';
import { canWrite as roleMay, readOnlyHere } from '/shared/roles.js';
import { capture } from '/shared/capture.js';
import { patientContext } from '/shared/context.js';
import { createSlidePane, TOOLS, OBJECTIVES, fmtLength, fmtArea } from '/pathology/viewer.js';
import { maskObservation } from '/shared/masks.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'pathology', crumbs: { app: 'Pathology', home: 'worklist', names: { worklist: 'Worklist', upload: 'Upload slides', case: 'Case', slide: 'Slide' }, resolve: (segments) => (['case', 'slide'].includes(segments[0]) ? [['Worklist', '#/worklist'], [segments[0] === 'case' ? (document.querySelector('[data-testid="report-pane"] h2')?.textContent?.trim() || 'Case') : 'Slide', location.hash.split('?')[0]]] : null) } });
const U = { clinical: 'urn:hospital-desktop:report-clinical', gross: 'urn:hospital-desktop:report-gross', micro: 'urn:hospital-desktop:report-micro', comment: 'urn:hospital-desktop:report-comment', synoptic: 'urn:hospital-desktop:report-synoptic', critical: 'urn:hospital-desktop:report-critical', told: 'urn:hospital-desktop:critical-communicated', findings: 'urn:hospital-desktop:report-findings', addendumOf: 'urn:hospital-desktop:addendum-of' };
const ui = { queue: 'my', type: 'All', stain: 'All', selected: null, filter: '' };
let cleanup = () => {};
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const me = () => identity.user || identity.role;
const initials = (name) => String(name).split(/[\s-]+/).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
const minutes = (m) => (m == null ? '—' : m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${(m / 1440).toFixed(1)} d`);
// Embedded in the labelling workbench (?embed=1): the viewer only. No case lock, nothing written; in region mode the drawn boxes go to the parent window.
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.dataset.embed = '1';
const record = (action, ref, extra = {}) => shell.recorder.record('viewer', { viewer: { action, app: 'pathology', ...extra }, resources: ref ? [{ ref }] : undefined, route: location.hash.split('?')[0].slice(0, 100) });
const stainBadge = (s) => (s.stain ? h('span', { class: `stain ${s.stainKind || 'routine'}` }, s.stain) : null);
const prio = (r) => h('span', { title: r.priority.toUpperCase() }, h('span', { class: `prio ${r.priority}`, 'aria-label': `Priority ${r.priority}` }), r.lock ? h('span', { class: 'reader', testid: `lock-${r.id}`, title: `Being read by ${r.lock.by}` }, initials(r.lock.by)) : null);
const statusBadge = (r) => badge(r.status === 'read' ? 'Signed out' : r.status === 'draft' ? 'Draft report' : 'Unread', r.status === 'read' ? 'ok' : r.status === 'draft' ? 'info' : 'warn', `status-${r.id}`);

function topbar(active) {
  const search = h('input', { class: 'search', type: 'search', value: ui.filter, placeholder: 'Filter: name, MRN or accession', testid: 'path-search', 'aria-label': 'Filter worklist by name, MRN or accession', onInput: (e) => { ui.filter = e.target.value; if (active === 'worklist') drawWorklist(); } });
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Pathology'), h('span', { class: 'dot' }, '·'), search,
    h('nav', { 'aria-label': 'Pathology sections' }, [['worklist', '≡ Worklist'], ['upload', '⇪ Upload slides']].map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': active === id ? 'page' : undefined }, label))),
    shell.themeToggle, shell.roleSelect);
}
const patientStrip = (p) => h('div', { class: 'pstrip', testid: 'patient-strip' }, p ? [h('strong', {}, p.name), h('span', { class: 'mono' }, p.mrn), h('span', {}, `${p.birthDate ? age(p.birthDate) : ''} ${p.gender || ''}`)] : h('span', { class: 'muted' }, 'No patient linked'));

// ---------- Accessioning ----------
function accessionDialog(order, patientId, onDone) {
  const stainOptions = (window.__stains || []).map((s) => [s.code, s.display]);
  formDialog({ title: order ? `Accession: ${order.code} for ${order.patient?.name || ''}` : 'Accession a case', testid: 'accession-form', submitLabel: 'Accession', wide: true,
    intro: order ? `Order reason: ${order.reason || 'not given'}. Parts are lettered A, B, C; blocks are numbered within a part; a slide is made per stain.` : 'A case without an order. Parts are lettered A, B, C; blocks numbered within a part; one slide per stain.',
    fields: [
      { name: 'type', label: 'Specimen type', type: 'select', options: (window.__types || ['Biopsy']).map((t) => [t, t]), testid: 'acc-type' },
      { name: 'parts', label: 'Parts (one per line: description)', type: 'textarea', rows: 3, value: order?.reason ? order.reason.slice(0, 80) : 'Specimen', testid: 'acc-parts', wide: true },
      { name: 'blocks', label: 'Blocks per part', type: 'number', value: 1, min: 1, max: 20, testid: 'acc-blocks' },
      { name: 'stains', label: 'Stains per block (codes, comma separated)', value: 'HE', placeholder: stainOptions.slice(0, 4).map((s) => s[0]).join(', '), testid: 'acc-stains' },
      { name: 'priority', label: 'Priority', type: 'select', options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['stat', 'STAT']], value: order?.priority || 'routine', testid: 'acc-priority' },
      { name: 'gross', label: 'Gross description', type: 'textarea', rows: 4, dictate: true, testid: 'acc-gross', wide: true },
    ],
    onSubmit: async (v) => {
      const stains = String(v.stains || 'HE').split(/[,\s]+/).filter(Boolean);
      const parts = String(v.parts || '').split('\n').map((s) => s.trim()).filter(Boolean).map((description) => ({ description, blocks: Array.from({ length: Math.max(1, Number(v.blocks) || 1) }, () => ({ slides: stains })) }));
      const made = await api.post('/api/pathology/cases', { ...(order ? { order: order.id } : { patient: patientId }), type: v.type, parts: parts.length ? parts : [{}], gross: v.gross, priority: v.priority });
      toast(`Accessioned as ${made.accession}`);
      record('accession', `Specimen/${made.id}`, { parts: parts.length });
      onDone?.(made);
    } });
}

// ---------- Worklist ----------
let drawWorklist = () => {};
async function worklist() {
  const tree = h('div', { class: 'tree', testid: 'queue-tree' });
  const centre = h('div', { class: 'centre' });
  const info = h('aside', { class: 'info', testid: 'case-info' });
  const strip = h('div', { class: 'pstrip', testid: 'patient-filter', hidden: true });
  let data = null;
  async function loadData() {
    data = await api.get('/api/pathology/worklist', { queue: ui.queue, type: ui.type, stain: ui.stain });
    window.__stains = data.stains; window.__types = data.types;
  }
  // Every patient by default. "This patient only" narrows the list (and the slides without a case) to the patient selected in the EHR; the choice is remembered in this browser.
  const ONLY_KEY = 'hd.pathology.thisPatientOnly'; const selected = patientContext.get();
  let only = false; try { only = localStorage.getItem(ONLY_KEY) === '1'; } catch { /* no storage: start with every patient */ }
  let pf = selected && only ? selected : null;
  if (selected) { strip.hidden = false; const box = h('input', { type: 'checkbox', testid: 'patient-filter-toggle', 'aria-label': 'This patient only', checked: only, onChange: (e) => { only = e.target.checked; try { localStorage.setItem(ONLY_KEY, only ? '1' : '0'); } catch { /* not remembered */ } pf = only ? selected : null; note.textContent = only ? 'Showing the patient selected in the EHR' : 'Showing all patients'; drawWorklist(); } }); const note = h('span', { testid: 'patient-filter-note' }, only ? 'Showing the patient selected in the EHR' : 'Showing all patients'); strip.append(h('label', { style: 'display:inline-flex;align-items:center;gap:0.375rem;margin:0' }, box, 'This patient only'), note); }
  drawWorklist = () => {
    if (!data) return;
    const q = ui.filter.trim().toLowerCase();
    const rows = data.rows.filter((r) => (!pf || r.patient?.id === pf) && (!q || `${r.patient?.name || ''} ${r.patient?.mrn || ''} ${r.accession}`.toLowerCase().includes(q)));
    clear(tree).append(h('h3', {}, 'Queue'), ...[['my', `My cases (${data.counts.my})`], ['all', `All cases (${data.counts.all})`]].map(([id, label]) => h('button', { type: 'button', testid: `tree-${id}`, 'aria-pressed': String(ui.queue === id), 'aria-label': label, onClick: async () => { ui.queue = id; await loadData(); drawWorklist(); } }, label)),
      h('h3', {}, 'Specimen type'), ...['All', ...data.types].map((t) => h('button', { type: 'button', testid: `type-${slug(t)}`, 'aria-pressed': String(ui.type === t), 'aria-label': `Specimen type ${t}`, onClick: async () => { ui.type = t; await loadData(); drawWorklist(); } }, t)),
      h('h3', {}, 'Stain'), ...['All', ...new Set(data.rows.flatMap((r) => r.stains))].map((s) => h('button', { type: 'button', testid: `stain-${slug(s)}`, 'aria-pressed': String(ui.stain === s), 'aria-label': `Stain ${s}`, onClick: async () => { ui.stain = s; await loadData(); drawWorklist(); } }, s)));
    const m = data.metrics;
    const metrics = h('div', { class: 'metrics', testid: 'metrics' }, h('span', {}, 'Unread ', h('b', { testid: 'metric-unread' }, String(m.unread))), h('span', {}, 'Drafts ', h('b', {}, String(m.draft))), h('span', {}, 'Signed out today ', h('b', { testid: 'metric-signed' }, String(m.signedToday))), h('span', {}, 'Median received → signed ', h('b', { testid: 'metric-tat' }, minutes(m.medianTurnaroundMinutes))), h('span', {}, 'Over target ', h('b', { class: m.overTarget ? 'pending-stain' : '' }, String(m.overTarget))), h('span', { class: 'muted small' }, `Targets: STAT ${minutes(m.targets.stat)}, urgent ${minutes(m.targets.urgent)}, routine ${minutes(m.targets.routine)} (unverified starter targets)`));
    const pending = data.pendingOrders.filter((o) => !pf || o.patient?.id === pf);
    const pendingCard = h('section', { class: 'card', testid: 'pending-orders' }, h('h3', {}, `Orders awaiting accessioning (${pending.length})`), table({ testid: 'pending-orders-table', rows: pending, empty: 'No pathology orders waiting', columns: [
      { label: 'Priority', render: (o) => h('span', { class: `prio ${o.priority}`, 'aria-label': `Priority ${o.priority}` }) }, { label: 'Patient', render: (o) => o.patient ? `${o.patient.name} · ${o.patient.mrn}` : '—' }, { label: 'Order', render: (o) => o.code }, { label: 'Reason', render: (o) => o.reason }, { label: 'Ordered', cls: 'num', render: (o) => fmtDateTime(o.authoredOn) },
      { label: '', cls: 'actions', render: (o) => btn('Accession', { small: true, kind: 'primary', write: true, perm: ['Specimen', 'create'], testid: `accession-${o.id}`, onClick: () => accessionDialog(o, null, async () => { await loadData(); drawWorklist(); }) }) }] }));
    const cases = table({ testid: 'worklist-table', rows, empty: ui.queue === 'my' ? 'Nothing waiting for you' : 'No cases yet', rowId: (r) => r.id, onRow: (r) => { ui.selected = r.id; drawWorklist(); }, columns: [
      { label: '', render: prio }, { label: 'Accession', cls: 'mono', render: (r) => r.accession }, { label: 'Patient', render: (r) => r.patient ? h('span', {}, r.patient.name, h('span', { class: 'muted' }, ` · ${r.patient.mrn}`)) : '—' }, { label: 'Type', render: (r) => r.type },
      { label: 'Received', cls: 'num', render: (r) => fmtDateTime(r.receivedAt) }, { label: 'Received → now', cls: 'num', render: (r) => h('span', { class: `elapsed${r.overTarget && r.status !== 'read' ? ' late' : ''}`, testid: `tat-${r.id}` }, minutes(r.turnaroundMinutes)) },
      { label: 'Stains', render: (r) => h('span', {}, ...r.stains.map((s) => h('span', { class: 'stain routine', style: 'margin-right:0.25rem' }, s)), r.pendingWork.length ? h('span', { class: 'pending-stain', testid: `pending-${r.id}`, title: r.pendingWork.map((t) => t.text).join(', ') }, ` ◐ ${r.pendingWork.length} pending`) : null) },
      { label: 'Slides', cls: 'num', render: (r) => `${r.slidesWithImages}/${r.slideCount}` }, { label: 'Status', render: statusBadge },
      { label: '', cls: 'actions', render: (r) => btn('Open', { small: true, testid: `open-${r.id}`, onClick: () => go(`#/case/${r.id}`) }) }] });
    const loose = (data.looseSlides || []).filter((s) => !pf || s.patient?.id === pf);
    const looseCard = loose.length ? h('section', { class: 'card', testid: 'loose-slides' }, h('h3', {}, `Slides without a case (${loose.length})`), table({ testid: 'loose-slides-table', rows: loose, onRow: (s) => go(`#/slide/${s.id}`), columns: [{ label: 'Patient', render: (s) => (s.patient ? `${s.patient.name} · ${s.patient.mrn}` : '—') }, { label: 'Slide', render: (s) => s.name }, { label: 'Size', cls: 'num', render: (s) => (s.width ? `${s.width} × ${s.height} px` : '') }, { label: 'Received', cls: 'num', render: (s) => fmtDateTime(s.receivedAt) }, { label: '', cls: 'actions', render: (s) => btn('Open', { small: true, kind: 'primary', testid: `open-slide-${s.id}`, title: `Open the slide ${s.name}`, onClick: () => go(`#/slide/${s.id}`) }) }] })) : null;
    clear(centre).append(metrics, pendingCard, h('section', { class: 'card' }, h('h3', {}, `${ui.queue === 'my' ? 'My cases' : 'All cases'} (${rows.length})`), cases), looseCard);
    const sel = rows.find((r) => r.id === ui.selected) || rows[0];
    clear(info).append(...(sel ? [h('h3', {}, sel.accession), kv([['Patient', sel.patient ? `${sel.patient.name} · ${sel.patient.mrn}` : '—'], ['Type', sel.type], ['Priority', sel.priority], ['State', sel.state], ['Ordered by', sel.order?.requester || '—'], ['Reason', sel.order?.reason || '—'], ['Received', fmtDateTime(sel.receivedAt)], ['Signed out', sel.signedAt ? fmtDateTime(sel.signedAt) : '—']]),
      h('section', {}, h('h3', {}, 'Gross'), h('p', { class: 'history' }, sel.gross || 'Not entered yet')),
      h('section', {}, h('h3', {}, 'Slides'), h('ul', { class: 'history' }, ...sel.parts.flatMap((p) => p.blocks.flatMap((b) => b.slides.map((s) => h('li', {}, `${s.label} · ${s.stain || '?'}${s.study ? '' : ' (no image yet)'}`)))))),
      h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn('Open case', { kind: 'primary', testid: 'info-open', onClick: () => go(`#/case/${sel.id}`) }))] : [h('p', { class: 'muted' }, 'Select a case')]));
  };
  await loadData();
  drawWorklist();
  const timer = setInterval(async () => { if (document.hidden) return; try { await loadData(); drawWorklist(); } catch { /* keep the old view */ } }, 15000);
  cleanup = () => clearInterval(timer);
  clear(root).append(topbar('worklist'), timeStrip(), strip, h('div', { class: 'wl' }, tree, centre, info));
}

// ---------- Case page and slide viewer ----------
async function casePage(id, query, { slideOnly = false } = {}) {
  let detail = null; let c = null;
  if (!slideOnly) { detail = await api.get(`/api/pathology/cases/${id}`); c = detail.case; if (c.patient && !EMBED) patientContext.set(c.patient.id); }
  let lock = { by: null }; let lockedByOther = null;
  if (!slideOnly && !view.readOnly && !EMBED && !readOnlyHere()) {
    try { lock = (await api.post(`/api/pathology/cases/${id}/open`, {})).lock; } catch (err) { if (err.status !== 423) throw err; lockedByOther = (await api.get(`/api/pathology/cases/${id}`)).case.lock; }
  }
  if (c) record('open-case', `Specimen/${c.id}`);
  const stage = h('div', { class: 'stage', testid: 'stage' });
  const tray = h('div', { class: 'tray', testid: 'slide-tray' });
  const status = h('span', { class: 'muted small', testid: 'viewer-status' });
  const REGION = query.get('region') === '1';
  let panes = []; let active = null; let sideBySide = false; let linked = true; let syncing = false; let tool = REGION ? 'region' : 'none';
  const slides = c ? c.parts.flatMap((p) => p.blocks.flatMap((b) => b.slides.map((s) => ({ ...s, part: p.label, block: b.label, blockId: b.id })))) : [];
  const mayAnnotate = () => !view.readOnly && !EMBED && !readOnlyHere() && roleMay('Observation', 'create');
  let saved = [];
  const measureCount = h('span', { class: 'muted small', testid: 'measure-count' });
  const countSaved = () => { measureCount.textContent = saved.length ? `${saved.length} saved annotation${saved.length === 1 ? '' : 's'}` : ''; };

  /** Saves a shape. extra carries the method and parameters of an analysis result, or where an imported shape came from; show draws a shape that was not drawn by hand. */
  async function persist(pane, a, extra = {}, show = false) {
    if (!mayAnnotate() || !pane.state.info) return;
    try { const made = await api.post(`/api/pathology/slides/${pane.state.info.id}/annotations`, { kind: a.kind, points: a.points, microns: a.microns, areaUm2: a.areaUm2, count: a.count, text: a.text, label: a.label, class: a.class, colour: a.colour, ...extra }); a.id = made.id; saved.push({ ...made, slide: pane.state.info.id }); if (show) pane.restore({ ...a, id: made.id }); countSaved(); } catch (err) { showError(err); }
  }
  async function restoreFor(pane) {
    if (EMBED || !pane.state.info) return;
    try { const list = (await api.get(`/api/pathology/slides/${pane.state.info.id}/annotations`)).annotations; for (const a of list) pane.restore({ ...a, closed: a.kind === 'line' ? false : undefined, microns: ['ruler', 'line'].includes(a.kind) ? a.value : null, areaUm2: ['area', 'rect', 'freehand', 'ellipse', 'polygon'].includes(a.kind) ? a.value : null, count: a.kind === 'count' ? a.value : null }); saved = [...saved.filter((x) => x.slide !== pane.state.info.id), ...list.map((a) => ({ ...a, slide: pane.state.info.id }))]; } catch { /* none */ }
    countSaved();
  }
  // QuPath GeoJSON: export the slide's annotations, import annotations made in QuPath (full-resolution pixel coordinates).
  const geoFile = h('input', { type: 'file', accept: '.geojson,.json,application/geo+json,application/json', hidden: true, testid: 'geojson-file', 'aria-label': 'GeoJSON file to import', onChange: async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || !active?.state.info) return;
    try {
      const text0 = await file.text();
      const { annotations: list, skipped } = fromGeoJSON(JSON.parse(text0));
      // Imported shapes are marked as imported, with who and when (the server adds those).
      for (const a of list) { const m = { ...measure(a, active.state.mpp), ...(a.label ? { class: a.label } : {}) }; if (m.kind === 'ellipse' && active.state.mpp) m.areaUm2 = Math.PI * (Math.abs(m.points[1][0] - m.points[0][0]) / 2) * (Math.abs(m.points[1][1] - m.points[0][1]) / 2) * active.state.mpp ** 2; await persist(active, m, { imported: { source: Array.isArray(JSON.parse(text0)) || JSON.parse(text0).features?.some((x) => x.properties?.objectType) ? 'QuPath GeoJSON' : 'GeoJSON', file: file.name } }, true); }
      toast(`Imported ${list.length} annotation${list.length === 1 ? '' : 's'}${skipped ? `; ${skipped} shape${skipped === 1 ? '' : 's'} QuPath has that this viewer cannot show were left out` : ''}`);
      record('geojson-import', activeRef(), { count: list.length, skipped });
    } catch (err) { toast(`Could not import: ${err.message}`, { error: true }); }
  } });
  const geoImport = btn('Import GeoJSON', { testid: 'tool-geojson-import', title: 'Add annotations from a QuPath GeoJSON file to this slide', write: true, onClick: () => { if (!active?.state.info) { toast('Open a slide first', { error: true }); return; } geoFile.click(); } });
  const geoExport = btn('Export GeoJSON', { testid: 'tool-geojson-export', title: 'Save this slide\'s annotations as GeoJSON for QuPath', onClick: () => {
    if (!active?.state.info) { toast('Open a slide first', { error: true }); return; }
    const blob = new Blob([JSON.stringify(toGeoJSON(active.annotations), null, 1)], { type: 'application/geo+json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(active.state.info.description || 'slide').replace(/[^A-Za-z0-9-]+/g, '-')}-annotations.geojson` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    record('geojson-export', activeRef(), { count: active.annotations.length });
  } });
  const geoPlain = btn('Export plain GeoJSON', { testid: 'tool-geojson-plain', title: 'Save this slide\'s annotations as plain GeoJSON', onClick: () => {
    if (!active?.state.info) { toast('Open a slide first', { error: true }); return; }
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(toGeoJSON(active.annotations, { flavour: 'plain' }), null, 1)], { type: 'application/geo+json' })), download: `${(active.state.info.description || 'slide').replace(/[^A-Za-z0-9-]+/g, '-')}-annotations-plain.geojson` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    record('geojson-export', activeRef(), { count: active.annotations.length, plain: true });
  } });
  const analysisPanel = createAnalysisPanel({ getActive: () => active, getPanes: () => panes, getCase: () => c, record: (a, ref, x) => record(a, ref || activeRef(), x), persist, canEdit: !EMBED && mayAnnotate(),
    setTool: (t2) => { tool = t2; panes.forEach((p) => p.command('tool', t2)); syncToolbar(); },
    removeSaved: (id2) => { saved = saved.filter((x) => x.id !== id2); countSaved(); },
    replaceSaved: (a, isNew) => { const slide = active?.state.info?.id; saved = isNew ? [...saved, { ...a, slide }] : saved.map((x) => (x.id === a.id ? { ...x, ...a } : x)); countSaved(); } });
  async function clearAll() {
    for (const p of panes) { p.clear(); const mine = saved.filter((x) => x.slide === p.state.info?.id); for (const a of mine) { try { await api.del(`/api/pathology/slides/${a.slide}/annotations/${a.id}`); } catch { /* gone */ } } saved = saved.filter((x) => x.slide !== p.state.info?.id); }
    countSaved();
  }
  function setActive(p) { active = p; for (const x of panes) x.el.classList.toggle('active', x === p); syncToolbar(); }
  const toolButtons = TOOLS.filter(([t]) => (REGION ? t === 'none' : t !== 'region')).map(([t, label, title]) => { const b = h('button', { type: 'button', testid: `tool-${t}`, 'aria-label': title, title, 'aria-pressed': String(tool === t), onClick: () => { tool = t; panes.forEach((p) => p.command('tool', t)); syncToolbar(); record('tool', activeRef(), { tool: t }); } }, label); b.dataset.tool = t; return b; });
  const objectiveButtons = OBJECTIVES.map((o) => { const b = h('button', { type: 'button', testid: `objective-${o}x`, 'aria-label': `Objective ${o}x`, title: `${o}x objective`, onClick: () => { active?.command('objective', o); record('objective', activeRef(), { objective: o }); } }, `${o}x`); b.dataset.objective = String(o); return b; });
  const activeRef = () => (active?.state.info ? `ImagingStudy/${active.state.info.id}` : c ? `Specimen/${c.id}` : null);
  function syncToolbar() {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    const magn = active?.state.info?.magnification || 20;
    for (const b of objectiveButtons) { b.disabled = Number(b.dataset.objective) > magn; b.title = b.disabled ? `${b.dataset.objective}x is beyond the ${magn}x scan` : `${b.dataset.objective}x objective`; }
    heatBtn.setAttribute('aria-pressed', String(Boolean(active?.state.heat)));
    sideBtn.setAttribute('aria-pressed', String(sideBySide));
    linkBtn.hidden = !sideBySide;
  }
  const heatBtn = h('button', { type: 'button', testid: 'tool-heat', 'aria-label': 'Show the viewed-area overlay', title: 'Viewed areas (this session)', 'aria-pressed': 'false', onClick: () => { active?.command('heat'); syncToolbar(); } }, 'Viewed');
  const sideBtn = h('button', { type: 'button', testid: 'layout-side', 'aria-label': 'Side by side: compare two slides of the same block', title: 'Side by side with linked pan and zoom', 'aria-pressed': 'false', hidden: slideOnly, onClick: () => { sideBySide = !sideBySide; build().catch(showError); record('layout', activeRef(), { layout: sideBySide ? 'side-by-side' : 'single' }); } }, 'Side by side');
  const linkBtn = h('button', { type: 'button', testid: 'tool-link', 'aria-label': 'Link pan and zoom between the two panes', title: 'Link pan and zoom', 'aria-pressed': 'true', hidden: true, onClick: () => { linked = !linked; linkBtn.setAttribute('aria-pressed', String(linked)); } }, 'Link');

  async function makePane(paneId) {
    let pane = null;
    pane = await createSlidePane({ id: paneId, region: REGION, callbacks: {
      onActivate: () => setActive(pane),
      onOpen: (info) => { record('open-slide', `ImagingStudy/${info.id}`, { mpp: info.mpp, levels: info.levels.length, width: info.width, height: info.height }); status.textContent = `${info.width} × ${info.height} px · ${info.mpp ? `${info.mpp} µm/px` : 'no scale'} · ${info.levels.length} levels${info.metadataPatientId && c?.patient && info.metadataPatientId !== c.patient.mrn ? ' · WARNING: slide metadata names another patient' : ''}`; syncToolbar(); },
      onView: () => { if (sideBySide && linked && !syncing && pane === active) { syncing = true; try { const v = pane.view(); for (const p of panes) if (p !== pane) p.command('sync', v); } finally { syncing = false; } } },
      onMeasure: (a) => { const label = a.kind === 'ruler' ? (a.microns != null ? `Length ${fmtLength(a.microns)}` : 'No scale on this slide') : ['area', 'rect', 'freehand'].includes(a.kind) ? (a.areaUm2 != null ? `Area ${fmtArea(a.areaUm2)}` : 'No scale on this slide') : a.kind === 'count' ? `${a.count} points` : `${a.kind} added`; toast(label); record(a.kind, activeRef(), { value: a.microns ?? a.areaUm2 ?? a.count ?? -1, points: a.points.length }); persist(pane, a); },
      // One coarse event per tile-grid cell (numbers only, as the trace accepts); the longest-viewed cells first, at most 16 per view change.
      onViewed: (cells, objective) => { for (const c of [...cells].sort((x, y) => y.ms - x.ms).slice(0, 16)) record('viewed', pane.state.info ? `ImagingStudy/${pane.state.info.id}` : null, { x: c.x, y: c.y, size: c.size, ms: c.ms, objective }); },
      onWand: (p) => analysisPanel.onWand(p), onSelect: (hit, additive) => analysisPanel.onSelect(hit, additive), onEdit: (a) => analysisPanel.onEdit(a), onSplitLine: (line) => analysisPanel.onSplitLine(line), onCellPick: (i) => analysisPanel.onCellPick(i),
      onRegion: (boxes) => { if (REGION && window.parent !== window) window.parent.postMessage({ type: 'hd-region', boxes: boxes.map((b) => ({ x: b.points[0][0], y: b.points[0][1], width: b.points[1][0] - b.points[0][0], height: b.points[1][1] - b.points[0][1], label: b.label })) }, '*'); },
    } });
    pane.paneId = paneId;
    return pane;
  }
  async function showSlide(pane, slide) {
    if (!slide?.study) return;
    status.textContent = 'Loading slide…';
    const info = await api.get(`/pathology/slides/${slide.study.id}/info`);
    pane.slide = slide;
    await pane.load(info);
    pane.command('tool', tool);
    await restoreFor(pane);
    drawTray();
    setActive(pane);
  }
  let currentSlide = slides.find((s) => s.study && s.study.id === query.get('slide')) || slides.find((s) => s.study) || null;
  let compareSlide = null;
  async function build() {
    panes.forEach((p) => p.destroy()); panes = [];
    clear(stage);
    if (slideOnly) {
      const pane = await makePane('current'); panes = [pane]; stage.className = 'stage n1'; stage.append(pane.el);
      const info = await api.get(`/pathology/slides/${id}/info`);
      pane.slide = { study: { id }, stain: info.stain, label: info.description };
      await pane.load(info); pane.command('tool', tool); await restoreFor(pane); setActive(pane);
      return;
    }
    if (sideBySide) {
      const [a, b] = [await makePane('left'), await makePane('right')];
      panes = [a, b]; stage.className = 'stage n2'; stage.append(a.el, b.el);
      compareSlide = compareSlide || slides.find((s) => s.study && s !== currentSlide && s.blockId === currentSlide?.blockId) || slides.find((s) => s.study && s !== currentSlide) || null;
      if (currentSlide) await showSlide(a, currentSlide);
      if (compareSlide) await showSlide(b, compareSlide);
      setActive(a);
    } else {
      const pane = await makePane('current'); panes = [pane]; stage.className = 'stage n1'; stage.append(pane.el);
      if (currentSlide) await showSlide(pane, currentSlide); else status.textContent = 'No slide images yet: upload a scanned slide for a block';
      setActive(pane);
    }
    drawTray();
  }
  function drawTray() {
    if (!c) return;
    const item = (s) => h('button', { type: 'button', class: 'slide', testid: `slide-${s.label}`, 'aria-label': `${s.label} ${s.stain || ''}${s.study ? '' : ', no image yet'}`, 'aria-pressed': String(panes.some((p) => p.slide?.id === s.id)), disabled: !s.study, onClick: async () => { if (sideBySide && active === panes[1]) compareSlide = s; else currentSlide = s; await showSlide(active || panes[0], s); record('select-slide', `ImagingStudy/${s.study.id}`, { label: s.label }); } }, h('span', { class: 'mono' }, s.label), stainBadge(s), s.study ? null : h('span', { class: 'noimg' }, 'no image'));
    const addWork = btn('Request more work', { small: true, write: true, perm: ['Task', 'create'], testid: 'request-work', onClick: () => formDialog({ title: 'Request more histology work', testid: 'addon-form', submitLabel: 'Request', intro: 'The request goes to the laboratory as a task; the new slide arrives in the tray when it is made.',
      fields: [{ name: 'block', label: 'Block', type: 'select', options: c.parts.flatMap((p) => p.blocks.map((b) => [b.id, `${b.label} · ${p.description}`])), testid: 'addon-block' }, { name: 'kind', label: 'Work', type: 'select', options: Object.entries(detail.histologyKinds), testid: 'addon-kind' }, { name: 'stain', label: 'Stain (for an additional stain)', type: 'select', options: [['', '—'], ...detail.stains.map((s) => [s.code, `${s.display} (${s.kind})`])], testid: 'addon-stain' }, { name: 'note', label: 'Note', testid: 'addon-note' }],
      onSubmit: async (v) => { await api.post(`/api/pathology/cases/${id}/addon`, { block: v.block, kind: v.kind, stain: v.stain || undefined, note: v.note }); toast('Requested from the laboratory'); detail = await api.get(`/api/pathology/cases/${id}`); c = detail.case; drawTray(); drawReport(); } }) });
    clear(tray).append(h('h3', {}, `Slides · ${c.accession}`), ...c.parts.map((p) => h('div', { class: 'part' }, h('div', {}, h('strong', {}, `Part ${p.label}`), ' ', h('span', { class: 'muted' }, p.description)), ...p.blocks.map((b) => h('div', { class: 'block' }, h('div', {}, `Block ${b.label}`), ...b.slides.map((s) => item(slides.find((x) => x.id === s.id) || s)))))),
      c.pendingWork.length ? h('p', { class: 'pending-stain small', testid: 'tray-pending' }, `◐ ${c.pendingWork.length} pending: ${c.pendingWork.map((t) => t.text).join(', ')}`) : null, h('div', { style: 'margin-top:0.5rem' }, addWork));
  }

  // Annotation toolbar while recording (plan-master 6.6): brush with eraser and size, labels (number keys), undo and redo, save mask; boxes, outlines, points, ruler and area are the viewer's own tools.
  const labelsOf = () => { try { return (JSON.parse(localStorage.getItem('hd.annotate') || 'null')?.labels || [{ name: 'Finding', colour: '#F7313B', key: 1 }, { name: 'Normal', colour: '#1F6F86', key: 2 }]); } catch { return [{ name: 'Finding', colour: '#F7313B', key: 1 }]; } };
  let activeLabel = labelsOf()[0];
  const annot = h('div', { class: 'annot', testid: 'annotation-toolbar', role: 'toolbar', 'aria-label': 'Annotation tools', hidden: true });
  const brushSize = h('input', { type: 'range', min: 4, max: 400, value: 40, testid: 'annot-brush-size', 'aria-label': 'Brush size in slide pixels', style: 'width:5.625rem', onInput: (e) => panes.forEach((p) => p.command('brush', { size: Number(e.target.value) })) });
  const applyLabel = (l) => { activeLabel = l; panes.forEach((p) => p.command('brush', { label: l.name, colour: l.colour })); drawAnnot(); };
  const setAnnotTool = (t2) => { tool = t2; panes.forEach((p) => p.command('tool', t2)); panes.forEach((p) => p.command('brush', { erase: t2 === 'erase' })); syncToolbar(); drawAnnot(); };
  const saveMask = async () => {
    const pane = active; const m = pane?.maskLayer?.(); if (!pane?.state.info || !m) { toast('Brush a mask first', { error: true }); return; }
    const enc = m.encode(); if (!enc) { toast('The mask is empty', { error: true }); return; }
    const sc = pane.maskScale; const bbox0 = { x: Math.round(enc.bbox.x / sc), y: Math.round(enc.bbox.y / sc), width: Math.round(enc.bbox.width / sc), height: Math.round(enc.bbox.height / sc) };
    await fhir.create(maskObservation({ patientRef: pane.state.info.patient, label: activeLabel.name, image: { ref: `ImagingStudy/${pane.state.info.id}`, slide: pane.state.info.id, level: 0, width: pane.state.info.width, height: pane.state.info.height }, mask: { ...enc, bboxLevel0: bbox0 }, scale: sc, runId: capture.active?.runId || null }));
    record('mask', `ImagingStudy/${pane.state.info.id}`, { label: slug(activeLabel.name), pixels: enc.pixels }); toast(`Mask saved: ${activeLabel.name}`);
  };
  const drawAnnot = () => {
    annot.hidden = !capture.active || EMBED;
    clear(annot);
    if (annot.hidden) return;
    annot.append(h('strong', { class: 'small' }, 'Annotate'),
      // The recording toolbar: box, outline, brush segmentation, eraser, point, ruler, undo; box, outline, point and ruler are the viewer's own region and measurement tools.
      ...[['rect', 'Box', 'box'], ['freehand', 'Outline', 'outline'], ['brush', 'Brush', 'brush'], ['erase', 'Eraser', 'erase'], ['count', 'Point', 'point'], ['ruler', 'Ruler', 'ruler']].map(([t2, label, id]) => h('button', { type: 'button', class: 'small', testid: `annot-${id}`, 'aria-label': `${label} tool`, 'aria-pressed': String(tool === t2), onClick: () => setAnnotTool(t2) }, label)),
      brushSize, btn('Undo', { small: true, testid: 'annot-undo', onClick: () => active?.command('undo') }), btn('Redo', { small: true, testid: 'annot-redo', onClick: () => active?.command('redo') }),
      ...labelsOf().map((l, i) => h('button', { type: 'button', class: 'small', testid: `annot-label-${i + 1}`, 'aria-label': `Label ${l.name} (key ${i + 1})`, 'aria-pressed': String(activeLabel?.name === l.name), style: `border-left:0.25rem solid ${l.colour}`, onClick: () => applyLabel(l) }, `${i + 1} ${l.name}`)),
      btn('Save mask', { small: true, kind: 'primary', testid: 'annot-save-mask', write: true, perm: ['Observation', 'create'], onClick: () => saveMask().catch(showError) }));
  };
  capture.onChange(drawAnnot); drawAnnot();
  const onAnnotKey = (e) => { if (!capture.active || e.target.closest('input, textarea, select, dialog')) return; const n = Number(e.key); const l = labelsOf()[n - 1]; if (n >= 1 && l) { applyLabel(l); e.preventDefault(); } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { active?.command(e.shiftKey ? 'redo' : 'undo'); e.preventDefault(); } };
  document.addEventListener('keydown', onAnnotKey);
  const toolbar = h('div', { class: 'vtool', role: 'toolbar', 'aria-label': 'Slide viewer tools' },
    EMBED ? null : btn('◂ Worklist', { testid: 'back-worklist', title: 'Back to worklist', onClick: () => go('#/worklist') }), EMBED ? null : h('span', { class: 'sep' }),
    h('div', { class: 'seg' }, toolButtons), h('span', { class: 'sep' }), h('div', { class: 'seg' }, objectiveButtons), h('span', { class: 'sep' }),
    btn('+', { testid: 'zoom-in', title: 'Zoom in', onClick: () => active?.command('zoom', 1.5) }), btn('−', { testid: 'zoom-out', title: 'Zoom out', onClick: () => active?.command('zoom', 1 / 1.5) }), btn('Fit', { testid: 'tool-fit', title: 'Fit the whole slide (Home)', onClick: () => active?.command('fit') }), btn('Rotate', { testid: 'tool-rotate', title: 'Rotate 90 degrees (r)', onClick: () => active?.command('rotate', 90) }), btn('Full screen', { testid: 'tool-fullscreen', title: 'Full screen (f)', onClick: () => active?.command('fullscreen') }),
    heatBtn, btn('Clear annotations', { testid: 'tool-clear', title: 'Remove every annotation on the open slides', onClick: () => clearAll().catch(showError) }), geoExport, geoPlain, geoImport, geoFile, btn('Analysis', { testid: 'tool-analysis', title: 'Show or hide the analysis panel: stains, classes, tissue and cell detection, classifiers, measurements, batch', onClick: () => analysisPanel.toggle() }), h('span', { class: 'sep' }), sideBtn, linkBtn, h('span', { class: 'sep' }), status, measureCount);
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, dialog') || !active) return;
    const map = { ArrowLeft: ['pan', [-40, 0]], ArrowRight: ['pan', [40, 0]], ArrowUp: ['pan', [0, -40]], ArrowDown: ['pan', [0, 40]], '+': ['zoom', 1.5], '=': ['zoom', 1.5], '-': ['zoom', 1 / 1.5], Home: ['fit'], r: ['rotate', 90], f: ['fullscreen'] };
    const cmd = map[e.key]; if (!cmd) return; e.preventDefault(); active.command(...cmd);
  };
  document.addEventListener('keydown', onKey);
  // Region mode for the labelling workbench: boxes come and go through postMessage.
  const onMessage = (e) => { if (!REGION || e.data?.type !== 'hd-set-regions') return; const toRegion = (b, ghost) => ({ points: [[b.x, b.y], [b.x + b.width, b.y + b.height]], label: b.label, ghost }); for (const p of panes) { p.command('regions', [...(e.data.boxes || []).map((b) => toRegion(b, false)), ...(e.data.ghosts || []).map((b) => toRegion(b, true))]); p.command('regionLabel', e.data.label || null); } };
  window.addEventListener('message', onMessage);

  // ----- Report pane -----
  const report = h('div', { class: 'report', testid: 'report-pane' });
  let rep = detail?.report || null; let addenda = detail?.addenda || []; let dirty = false; let saving = Promise.resolve();
  const canWrite = () => !view.readOnly && !lockedByOther && !EMBED && !readOnlyHere() && roleMay('DiagnosticReport', 'update');
  const sections = {};
  let synopticTemplate = ''; let synopticValues = {}; let critical = false; let told = null;
  const savedAt = h('span', { class: 'muted small', testid: 'draft-status' });
  const body = (status2) => ({ ...(rep || { resourceType: 'DiagnosticReport', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'pathology' }] }], subject: { reference: `Patient/${c.patient.id}` }, code: { text: `Surgical pathology ${c.accession}` }, specimen: [{ reference: `Specimen/${c.id}` }], ...(c.order ? { basedOn: [{ reference: `ServiceRequest/${c.order.id}` }] } : {}), effectiveDateTime: c.receivedAt || undefined }),
    status: status2 ?? rep?.status ?? 'preliminary', conclusion: sections.diagnosis.get(),
    extension: [...((rep?.extension || []).filter((e) => !Object.values(U).includes(e.url))), ...['clinical', 'gross', 'micro', 'comment'].map((k) => ({ url: U[k], valueString: sections[k].get() })), ...(synopticTemplate ? [{ url: U.synoptic, valueString: JSON.stringify({ template: synopticTemplate, values: synopticValues }) }] : []), { url: U.critical, valueBoolean: critical }, ...(told ? [{ url: U.told, valueString: JSON.stringify(told) }] : [])] });
  async function saveDraft({ silent = false } = {}) {
    if (!canWrite() || (rep && rep.status !== 'preliminary')) return;
    saving = saving.then(async () => { rep = rep ? await fhir.update(body()) : await fhir.create(body('preliminary')); dirty = false; savedAt.textContent = `Draft saved ${fmtTime(new Date())}`; if (!silent) undefined; });
    await saving;
  }
  const autosave = setInterval(() => { if (dirty) saveDraft({ silent: true }).catch(showError); }, 30000);
  const unsavedOff = shell.unsaved(() => dirty && canWrite() && !(rep && rep.status !== 'preliminary'));
  function drawReport() {
    if (!c) return;
    clear(report).append(h('h2', {}, `Case ${c.accession}`), kv([['Specimen', `${c.type}${c.order ? ` · ${c.order.code}` : ''}`], ['Clinical history', c.order?.reason || 'Not given'], ['Ordered by', c.order?.requester || 'Not given'], ['Received', fmtDateTime(c.receivedAt)], ['State', c.state]]),
      h('details', { open: !c.gross }, h('summary', { testid: 'gross-toggle' }, 'Gross description (accessioning)'), (() => { const f = field({ name: 'gross', label: 'Gross description', type: 'textarea', rows: 3, value: c.gross || '', dictate: true, testid: 'case-gross' }); f.input.disabled = !canWrite(); return h('div', {}, f.el, btn('Save gross', { small: true, write: true, perm: ['Specimen', 'update'], testid: 'gross-save', disabled: !canWrite(), onClick: async () => { await api.put(`/api/pathology/cases/${id}/gross`, { text: f.get() }); c.gross = f.get(); undefined; if (sections.gross && !sections.gross.get()) sections.gross.set?.(f.get()); } })); })()),
      detail.priors.length ? h('details', {}, h('summary', { testid: 'priors-toggle' }, `Prior pathology (${detail.priors.length})`), ...detail.priors.map((p) => h('div', { class: 'banner info', testid: `prior-${p.id}` }, h('strong', {}, `${p.accession} · ${p.type} · ${fmtDate(p.signedAt)}`), h('div', {}, p.conclusion)))) : null,
      h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }));
    if (lockedByOther) report.append(h('div', { class: 'banner warn', testid: 'locked-banner' }, h('strong', {}, `Being signed out by ${lockedByOther.by}`), `Locked since ${fmtTime(lockedByOther.at)}. You can view the slides; reporting is disabled. `, btn('Take over', { small: true, write: true, perm: ['DiagnosticReport', 'update'], testid: 'take-over', onClick: async () => { if (!await confirmDialog({ title: 'Take over this case', message: `${lockedByOther.by} is signing out this case. Taking over moves the lock to you.`, confirmLabel: 'Take over', testid: 'take-over-confirm' })) return; lock = (await api.post(`/api/pathology/cases/${id}/open`, { force: true })).lock; lockedByOther = null; drawReport(); } })));
    const signed = rep && rep.status !== 'preliminary';
    if (!signed) {
      const editable = canWrite();
      const mk = (name, label, value, rows = 3) => { const f = field({ name, label, type: 'textarea', rows, value, dictate: editable, testid: `report-${name}` }); f.input.disabled = !editable; f.input.addEventListener('input', () => { dirty = true; savedAt.textContent = 'Unsaved changes'; }); return f; };
      sections.clinical = mk('clinical', 'Clinical information', rep ? ext(rep, U.clinical) || '' : c.order?.reason || '');
      sections.gross = mk('gross', 'Gross description', rep ? ext(rep, U.gross) || '' : c.gross || '');
      sections.micro = mk('micro', 'Microscopic description', rep ? ext(rep, U.micro) || '' : '', 4);
      sections.diagnosis = mk('diagnosis', 'Final diagnosis (required to sign)', rep?.conclusion || '', 3);
      sections.comment = mk('comment', 'Comment', rep ? ext(rep, U.comment) || '' : '');
      let syn = null; try { syn = rep ? JSON.parse(ext(rep, U.synoptic) || 'null') : null; } catch { syn = null; }
      synopticTemplate = syn?.template || ''; synopticValues = syn?.values || {};
      const synBox = h('div', { testid: 'synoptic-fields' });
      const drawSyn = () => { clear(synBox); const t = detail.synoptic[synopticTemplate]; if (!t) return; synBox.append(h('p', { class: 'muted small' }, `${t.label}: a generic checklist, unverified.`), ...t.fields.map(([k, label]) => { const f = field({ name: `syn-${k}`, label, value: synopticValues[k] || '', testid: `syn-${k}` }); f.input.disabled = !editable; f.input.addEventListener('input', () => { synopticValues[k] = f.get(); dirty = true; }); return f.el; })); };
      const synSelect = h('select', { testid: 'synoptic-template', 'aria-label': 'Synoptic checklist', disabled: !editable, onChange: (e) => { synopticTemplate = e.target.value; dirty = true; drawSyn(); } }, h('option', { value: '' }, 'No synoptic checklist'), ...Object.entries(detail.synoptic).map(([k, t]) => h('option', { value: k, selected: k === synopticTemplate }, t.label)));
      drawSyn();
      critical = Boolean(rep && ext(rep, U.critical) === true) || Boolean((rep?.extension || []).find((e) => e.url === U.critical)?.valueBoolean);
      try { told = rep ? JSON.parse(ext(rep, U.told) || 'null') : null; } catch { told = null; }
      const critBox = h('input', { type: 'checkbox', testid: 'report-critical', 'aria-label': 'Critical or unexpected diagnosis', checked: critical, disabled: !editable, onChange: (e) => { critical = e.target.checked; dirty = true; drawTold(); } });
      const toldEl = h('div', { testid: 'critical-told' });
      const drawTold = () => { clear(toldEl); if (!critical) return; toldEl.append(told ? h('p', { class: 'small', testid: 'told-summary' }, `Told to ${told.to} at ${fmtDateTime(told.at)}${told.readBack ? ' (read back)' : ''}`) : h('p', { class: 'small pending-stain' }, 'Document who was told before signing.'), btn(told ? 'Change' : 'Document call', { small: true, testid: 'told-document', disabled: !editable, onClick: () => formDialog({ title: 'Critical or unexpected diagnosis communicated', testid: 'told-form', submitLabel: 'Record', fields: [{ name: 'to', label: 'Told to (name and role)', required: true, testid: 'told-to' }, { name: 'readBack', label: 'Diagnosis read back by the recipient', type: 'checkbox', value: true, testid: 'told-readback' }], onSubmit: async (v) => { told = { to: v.to, at: new Date().toISOString(), by: me(), readBack: Boolean(v.readBack) }; dirty = true; drawTold(); } }) })); };
      drawTold();
      report.append(sections.clinical.el, sections.gross.el, sections.micro.el, sections.diagnosis.el, sections.comment.el, h('label', { class: 'field' }, h('span', {}, 'Synoptic checklist'), synSelect), synBox,
        h('label', { class: 'check', style: 'display:flex;gap:0.5rem;align-items:center;margin:0.5rem 0' }, critBox, 'Critical or unexpected diagnosis'), toldEl,
        h('div', { class: 'toolbar' }, btn('Save draft', { testid: 'report-save', write: true, perm: ['DiagnosticReport', 'create'], disabled: !editable, onClick: () => saveDraft() }),
          btn('Sign out', { kind: 'primary', testid: 'report-sign', write: true, perm: ['DiagnosticReport', 'sign'], disabled: !editable, onClick: async () => {
            if (!sections.diagnosis.get().trim()) throw new Error('A final diagnosis is required before signing');
            if (critical && !told) throw new Error('Document who was told about the critical diagnosis before signing');
            await saveDraft({ silent: true });
            if (!await confirmDialog({ title: 'Sign out this case', message: 'Signing locks the report. Later changes are addenda. The ordering clinician is notified in their Inbox.', confirmLabel: 'Sign out', testid: 'sign-report' })) return;
            rep = await fhir.transition(rep, 'final'); toast('Case signed out. The ordering clinician has been notified.'); record('sign-out', `DiagnosticReport/${rep.id}`); detail = await api.get(`/api/pathology/cases/${id}`); c = detail.case; drawReport();
          } }), savedAt), h('p', { class: 'muted small' }, 'Drafts save automatically every 30 seconds.'));
      return;
    }
    const released = flagged(rep, 'released');
    let syn = null; try { syn = JSON.parse(ext(rep, U.synoptic) || 'null'); } catch { syn = null; }
    let toldRo = null; try { toldRo = JSON.parse(ext(rep, U.told) || 'null'); } catch { toldRo = null; }
    report.append(h('div', { class: 'toolbar' }, badge(rep.status === 'final' ? 'Signed out' : `Signed · ${rep.status}`, 'ok', 'report-status'), released ? badge('In Patient Portal', 'accent', 'report-released') : null, (rep.extension || []).find((e) => e.url === U.critical)?.valueBoolean ? badge('Critical diagnosis', 'danger', 'report-critical-badge') : null),
      kv([['Signed by', rep.resultsInterpreter?.[0]?.display], ['Signed', fmtDateTime(rep.issued)], ...(toldRo ? [['Communicated to', `${toldRo.to} at ${fmtDateTime(toldRo.at)}`]] : [])]),
      ...[['clinical', 'Clinical information'], ['gross', 'Gross description'], ['micro', 'Microscopic description']].map(([k, label]) => [h('h3', { style: 'margin-top:0.75rem' }, label), h('p', { class: 'ro', testid: `ro-${k}` }, ext(rep, U[k]) || '—')]).flat(),
      h('h3', {}, 'Final diagnosis'), h('p', { class: 'ro', testid: 'ro-diagnosis' }, rep.conclusion), ext(rep, U.comment) ? [h('h3', {}, 'Comment'), h('p', { class: 'ro', testid: 'ro-comment' }, ext(rep, U.comment))] : null,
      syn?.template && detail.synoptic[syn.template] ? [h('h3', {}, `Synoptic: ${detail.synoptic[syn.template].label}`), kv(detail.synoptic[syn.template].fields.map(([k, label]) => [label, syn.values?.[k] || '—']))] : null,
      ...addenda.map((a) => h('div', { class: 'banner info', testid: `addendum-${a.id}` }, h('strong', {}, `Addendum · ${a.status === 'preliminary' ? 'draft' : `signed by ${a.resultsInterpreter?.[0]?.display || ''} ${fmtDateTime(a.issued)}`}`), h('div', { class: 'note-body' }, ext(a, U.findings) || ''))),
      h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn(released ? 'Hide from the Patient Portal' : 'Release to the Patient Portal', { testid: 'report-release', write: true, disabled: readOnlyHere(), onClick: async () => { rep = await fhir.release(rep, !released); toast(released ? 'Hidden from the Patient Portal' : 'Released to the Patient Portal'); drawReport(); } })));
    if (!view.readOnly && !readOnlyHere()) {
      const draftAddendum = addenda.find((a) => a.status === 'preliminary');
      const text = field({ name: 'addendum', label: 'Addendum', type: 'textarea', rows: 4, value: draftAddendum ? ext(draftAddendum, U.findings) || '' : '', dictate: true, testid: 'report-addendum' });
      const saveAddendum = async () => { if (!text.get()) throw new Error('Type the addendum text first'); const doc = { ...(draftAddendum || { resourceType: 'DiagnosticReport', status: 'preliminary', category: rep.category, subject: rep.subject, code: rep.code, specimen: rep.specimen, basedOn: rep.basedOn }), extension: [{ url: U.findings, valueString: text.get() }, { url: U.addendumOf, valueString: `DiagnosticReport/${rep.id}` }] }; return draftAddendum ? fhir.update(doc) : fhir.create(doc); };
      const reload = async () => { detail = await api.get(`/api/pathology/cases/${id}`); c = detail.case; rep = detail.report; addenda = detail.addenda; drawReport(); };
      report.append(h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }), text.el, h('div', { class: 'toolbar' }, btn('Save addendum draft', { testid: 'addendum-save', write: true, perm: ['DiagnosticReport', 'create'], onClick: async () => { await saveAddendum(); undefined; await reload(); } }),
        btn('Sign addendum', { kind: 'primary', testid: 'addendum-sign', write: true, perm: ['DiagnosticReport', 'sign'], onClick: async () => { const made = await saveAddendum(); if (!await confirmDialog({ title: 'Sign addendum', message: 'The addendum is appended to the signed report and the ordering clinician is notified.', confirmLabel: 'Sign addendum', testid: 'sign-addendum' })) { await reload(); return; } await fhir.transition(made, 'final'); toast('Addendum signed'); await reload(); } })));
    }
  }

  cleanup = () => {
    document.removeEventListener('keydown', onKey); document.removeEventListener('keydown', onAnnotKey); window.removeEventListener('message', onMessage);
    clearInterval(autosave); unsavedOff();
    panes.forEach((p) => p.destroy());
    const signed = rep && rep.status !== 'preliminary';
    const finish = dirty && canWrite() && !signed ? saveDraft({ silent: true }).catch(() => {}) : Promise.resolve();
    if (lock?.by === me() && !signed && !view.readOnly && !slideOnly) finish.then(() => api.post(`/api/pathology/cases/${id}/close`, {}).catch(() => {}));
  };
  clear(root).append(...[topbar('case'), timeStrip(), c ? patientStrip(c.patient) : null, h('div', { class: `casepage${slideOnly ? ' slideonly' : ''}`, testid: 'case-page' }, toolbar, slideOnly ? null : tray, h('div', { class: 'stagewrap' }, annot, stage, EMBED ? null : analysisPanel.el), slideOnly ? null : report), EMBED ? null : findingPanel({ log: (a, x) => record(a, null, x), onNext: () => { location.hash = '#/worklist'; } })].filter(Boolean));
  // The slide was loaded before the stage had a size: once it is on the page, fit the whole slide to the window, and again when the window changes size.
  const fitAll = () => { for (const pn of panes) { try { pn.command('fit'); } catch { /* not loaded yet */ } } };
  requestAnimationFrame(() => requestAnimationFrame(fitAll)); if (slideOnly) { const onResize = () => { if (!document.body.contains(stage)) { window.removeEventListener('resize', onResize); return; } fitAll(); }; window.addEventListener('resize', onResize); }
  if (!slideOnly) drawReport();
  await build();
  if (REGION && window.parent !== window) window.parent.postMessage({ type: 'hd-region-ready' }, '*');
}

// ---------- Upload ----------
async function upload() {
  const list = h('div', { testid: 'upload-list' });
  const queue = [];
  const mrn = field({ name: 'mrn', label: 'Attach to patient (MRN)', required: true, testid: 'upload-mrn' });
  const drop = h('div', { class: 'drop', testid: 'upload-drop', role: 'button', tabindex: 0, 'aria-label': 'Drop slide files here or press Enter to choose files' }, h('p', {}, h('strong', {}, 'Drop whole-slide images here'), h('br'), 'JPEG-tiled pyramidal TIFF (.svs, .tif, .tiff). JPEG 2000 slides and other vendor formats are refused with a reason. Files stream to the server and are never decoded there.'));
  const input = h('input', { type: 'file', multiple: true, accept: '.svs,.tif,.tiff,.ndpi,.mrxs', hidden: true, testid: 'upload-input', 'aria-label': 'Choose slide files' });
  const draw = () => clear(list).append(table({ testid: 'upload-table', rows: queue, rowId: (q) => q.name, empty: 'No slide files chosen yet', columns: [{ label: 'File', render: (q) => q.name }, { label: 'Size', cls: 'num', render: (q) => `${(q.size / 1024 / 1024).toFixed(1)} MB` }, { label: 'Result', render: (q) => (q.state === 'stored' ? badge('Stored', 'ok') : q.state === 'duplicate' ? badge('Already stored', 'info') : q.state === 'refused' ? h('span', { class: 'pending-stain' }, `Refused: ${q.reason}`) : q.state === 'error' ? h('span', { class: 'pending-stain' }, q.reason) : q.state || 'Waiting') }] }));
  const send = async () => {
    if (!mrn.get()) throw new Error('Enter the MRN the slides belong to');
    const patients = await fhir.search('Patient', { identifier: mrn.get() });
    const p = patients.find((x) => (x.identifier || []).some((i) => i.value === mrn.get()));
    if (!p) throw new Error(`No patient has MRN ${mrn.get()}`);
    for (const q of queue.filter((x) => !x.state)) {
      q.state = 'Uploading…'; draw();
      try {
        const r = await fetch(`/pathology/slides/upload?patient=${p.id}&name=${encodeURIComponent(q.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Role': identity.role, 'X-User-Id': identity.user }, body: q.file });
        const out = await r.json();
        if (!r.ok) { q.state = 'error'; q.reason = out.error || r.statusText; } else { q.state = out.status; q.reason = (out.reasons || []).join('; '); }
      } catch (err) { q.state = 'error'; q.reason = err.message; }
      draw();
    }
    toast('Upload finished');
  };
  const add = (files) => { for (const f of files) queue.push({ name: f.name, size: f.size, file: f }); draw(); };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add([...e.dataTransfer.files]); });
  drop.addEventListener('click', () => input.click()); drop.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.click(); });
  input.addEventListener('change', () => add([...input.files]));
  draw();
  cleanup = () => {};
  clear(root).append(topbar('upload'), timeStrip(), h('div', { class: 'centre scroll', style: 'flex:1;min-height:0;overflow:auto' }, h('h2', {}, 'Upload slides'), mrn.el, drop, input, list, h('div', { class: 'toolbar' }, btn('Upload', { kind: 'primary', write: true, perm: ['ImagingStudy', 'create'], testid: 'upload-send', onClick: () => send().catch(showError) })), h('p', { class: 'muted small' }, 'Only synthetic or public de-identified slides. Label and overview images inside slide files are never served unless SHOW_SLIDE_LABELS is on for a synthetic source.')));
}

// ---------- Router ----------
async function render() {
  cleanup(); cleanup = () => {};
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  try {
    if (parts[0] === 'case' && parts[1]) await casePage(parts[1], query);
    else if (parts[0] === 'slide' && parts[1]) await casePage(parts[1], query, { slideOnly: true });
    else if (parts[0] === 'upload') await upload();
    else { if (location.hash !== '#/worklist') { location.hash = '#/worklist'; return; } await worklist(); }
  } catch (err) { showError(err); clear(root).append(topbar(''), h('div', { class: 'centre' }, h('div', { class: 'banner warn' }, err.message))); }
}
window.addEventListener('hashchange', render);
view.onChange(() => render());
patientContext.onChange(() => { if (location.hash.startsWith('#/worklist') || !location.hash) render(); });
render();
