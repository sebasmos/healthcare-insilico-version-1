// PACS: worklist, viewer with reporting, and upload.
import { findingPanel } from '/shared/finding-panel.js';
import { h, clear, btn, bornSpan, badge, toast, table, kv, field, openDialog, confirmDialog, initApp, timeStrip, fmtDate, fmtDateTime, fmtTime, ageSpan, showError, slug, dictationButton } from '/shared/ui.js';
import { fhir, api, view, identity, flagged, ext, patientName, mrn as mrnOf } from '/shared/fhir.js';
import { canWrite as roleMay, reasonFor } from '/shared/roles.js';
import { capture } from '/shared/capture.js';
import { patientContext } from '/shared/context.js';
import { parse } from '/shared/dicom.js';
import { loadProposals, proposalCard } from '/shared/proposals.js';
import { draftEvent, decideDraft, editSize } from '/shared/drafts.js';
import { createViewport, loadSeries, loadPreview, isSeriesLoaded, supportsVolume, reslice, thumbnail, WINDOW_PRESETS } from '/pacs/viewer.js';
import { chooseLayout, saveLayout, nearestByLocation, LAYOUTS, canShow } from '/pacs/hanging.js';
import { layoutPicker, shortcutHelp, measurementsPanel, saveMeasurementsSr, savedViews, createSegmentation } from '/pacs/workstation.js';
import { maskObservation } from '/shared/masks.js';
import { TEMPLATES, templateFor, unfilled, fieldAfter, STARTER_MACROS, findMacro, COMMANDS, parseCommand, deleteLastSentence, CRITICAL_URL, CRITICAL_TOLD_URL } from '/shared/report-templates.js';
// The Cornerstone3D engine (vendored, 4.7 MB) loads only when a layout or a compressed series needs it.
const engine3d = () => import('/pacs/viewer3d.js');

const root = document.getElementById('app');
const shell = await initApp({ app: 'pacs', crumbs: { app: 'PACS', home: 'worklist', names: { worklist: 'Worklist', upload: 'Upload', study: 'Study' }, resolve: (segments) => (segments[0] === 'study' ? [['Worklist', '#/worklist'], [document.querySelector('[data-testid="patient-strip"] strong')?.textContent?.trim() || 'Study', location.hash.split('?')[0]]] : null) } });
const T_URL = 'urn:hospital-desktop:report-technique';
const F_URL = 'urn:hospital-desktop:report-findings';
const A_URL = 'urn:hospital-desktop:addendum-of';
// Macros are per user (short name → text), kept in this browser; the starter set is unverified.
const macroKey = () => `hd.macros.${identity.user || identity.role}`;
const userMacros = () => { try { return JSON.parse(localStorage.getItem(macroKey()) || '[]'); } catch { return []; } };
const allMacros = () => [...userMacros(), ...STARTER_MACROS.filter((m) => !userMacros().some((u) => u.name.toLowerCase() === m.name.toLowerCase()))];
const MODALITIES = ['CT', 'MR', 'XR', 'US', 'NM', 'Other'];
const ui = { queue: 'my', modality: 'All', selected: null, filter: '', patientFilter: null };
let cleanup = () => {};
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const me = () => identity.user || identity.role;
const initials = (name) => name.split(/[\s-]+/).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
const elapsed = (from, now) => { const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
// Embedded in the labelling workbench (?embed=1): images only. No reading lock is taken, no agent is triggered and nothing can be written.
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.dataset.embed = '1';
const record = (action, study, extra = {}) => shell.recorder.record('viewer', { viewer: { action, ...extra }, resources: study ? [{ ref: `ImagingStudy/${study.id}` }] : undefined, route: location.hash.split('?')[0].slice(0, 100) });

function topbar(active) {
  const search = h('input', { class: 'search', type: 'search', value: ui.filter, placeholder: 'Filter: name, MRN or accession', testid: 'pacs-search', 'aria-label': 'Filter worklist by name, MRN or accession', onInput: (e) => { ui.filter = e.target.value; if (active === 'worklist') drawWorklist(); } });
  return h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'PACS'), h('span', { class: 'dot' }, '·'), search,
    h('nav', { 'aria-label': 'PACS sections' }, [['worklist', '≡ Worklist'], ['upload', '⇪ Upload']].map(([id, label]) => h('a', { href: `#/${id}`, testid: `nav-${id}`, 'aria-label': label.slice(2), 'aria-current': active === id ? 'page' : undefined }, label))),
    shell.themeToggle, shell.roleSelect);
}
const col = (label, value) => h('span', { class: 'bcol' }, h('small', { class: 'muted' }, label), h('b', {}, value || '—'));
const patientStrip = (p) => h('div', { class: 'pstrip', testid: 'patient-strip' }, p ? [h('strong', {}, p.name), col('Born', bornSpan(p)), col('Age', p.birthDate ? ageSpan(p) : ''), col('Sex', p.gender ? p.gender.replace(/^\w/, (m) => m.toUpperCase()) : ''), col('Medical record number', h('span', { class: 'mono' }, p.mrn)), col('Alert', '—')] : h('span', { class: 'muted' }, 'No patient linked'));
const prio = (r) => h('span', { title: r.priority.toUpperCase() }, h('span', { class: `prio ${r.priority}`, 'aria-label': `Priority ${r.priority}` }), r.lock ? h('span', { class: 'reader', title: `Being read by ${r.lock.by}`, testid: `lock-${r.id}` }, initials(r.lock.by)) : null);
const statusBadge = (r) => badge(r.status === 'read' ? 'Read' : r.status === 'draft' ? 'Draft report' : 'Unread', r.status === 'read' ? 'ok' : r.status === 'draft' ? 'warn' : 'info');

// ---------- Worklist ----------
let drawWorklist = () => {};
async function worklist() {
  let data = await api.get('/api/pacs/worklist', { queue: ui.queue, modality: ui.modality });
  const waiting = new Set((await loadProposals({ status: 'pending', detail: 'false' })).map((p) => p.subject));
  let detail = null;
  const tree = h('div', { class: 'tree', testid: 'worklist-tree' });
  const centre = h('div', { class: 'centre' });
  const info = h('div', { class: 'info', testid: 'study-info' });
  const strip = h('div');
  const pick = async (id) => { ui.selected = id; detail = id ? await api.get(`/api/pacs/studies/${id}`) : null; if (detail?.study.patient) patientContext.set(detail.study.patient.id); draw(); };
  const open = (r) => go(`#/study/${r.id}`);

  function draw() {
    const node = (label, pressed, count, onClick, testid) => h('button', { type: 'button', testid, 'aria-label': `Worklist: ${label}`, 'aria-pressed': String(pressed), onClick }, h('span', {}, label), count ? badge(count, 'accent') : null);
    const choose = (queue, modality) => async () => { ui.queue = queue; ui.modality = modality; data = await api.get('/api/pacs/worklist', { queue, modality }); draw(); };
    clear(tree).append(h('h3', {}, 'Favourites'),
      node('To be reported', ui.queue === 'my' && ui.modality === 'All', data.counts.my, choose('my', 'All'), 'tree-my'),
      h('h3', {}, 'All worklists'), node('All studies', ui.queue === 'all' && ui.modality === 'All', data.counts.all, choose('all', 'All'), 'tree-all'),
      h('h3', {}, 'Reading worklists'), ...MODALITIES.map((m) => node(`Unread ${m}`, ui.modality === m, data.counts.unreadByModality[m] || 0, choose('my', m), `tree-${m.toLowerCase()}`)),
      h('h3', {}, 'History'), node('Read today', ui.queue === 'read', data.metrics.readToday, async () => { ui.queue = 'read'; ui.modality = 'All'; data = await api.get('/api/pacs/worklist', { queue: 'all', modality: 'All' }); draw(); }, 'tree-history'),
      h('h3', {}, 'Archive'), node('Upload studies', false, 0, () => go('#/upload'), 'tree-upload'));

    const f = ui.filter.trim().toLowerCase();
    const rows = data.rows.filter((r) => (ui.queue !== 'read' || r.status === 'read') && (!ui.patientFilter || r.patient?.id === ui.patientFilter) && (!f || [r.patient?.name, r.patient?.mrn, r.accession, r.description].some((x) => (x || '').toLowerCase().includes(f))));
    const m = data.metrics;
    const mean = (p) => (m.byPriority[p].meanMinutes == null ? '—' : `${m.byPriority[p].meanMinutes} min`);
    const selectedRow = detail?.study;
    clear(strip).append(patientStrip(selectedRow?.patient));
    clear(centre).append(
      h('div', { class: 'metrics', testid: 'metrics' }, h('span', {}, 'Read today ', h('b', { testid: 'metric-read' }, m.readToday)), h('span', {}, 'Unread ', h('b', {}, m.unread)),
        ...['stat', 'urgent', 'routine'].map((p) => h('span', {}, `Mean turnaround ${p === 'stat' ? 'STAT' : p} `, h('b', {}, mean(p)), h('span', { class: 'muted' }, ` (target ${m.byPriority[p].target} min)`))),
        h('span', {}, 'Within target ', h('b', { testid: 'metric-target' }, m.withinTargetPercent == null ? '—' : `${m.withinTargetPercent}%`))),
      ui.patientFilter ? h('div', { class: 'banner info', testid: 'patient-filter' }, 'Showing studies for the patient selected in another app. ', btn('Show all patients', { small: true, testid: 'patient-filter-clear', onClick: () => { ui.patientFilter = null; draw(); } })) : '',
      table({ testid: 'worklist-table', rows, selected: ui.selected, onRow: (r) => pick(r.id), empty: 'No studies in this worklist. Use Upload studies to add some.', columns: [
        { label: '', render: prio }, { label: 'Date of birth', render: (r) => (r.patient ? bornSpan(r.patient) : '') }, { label: 'Name', render: (r) => r.patient?.name || '' }, { label: 'MRN', cls: 'mono', render: (r) => r.patient?.mrn || '' }, { label: 'Sex', render: (r) => (r.patient?.gender || '').slice(0, 1).toUpperCase() },
        { label: 'Date and time', render: (r) => fmtDateTime(r.started) }, { label: 'Modality', render: (r) => badge(r.modality, 'info') }, { label: 'Description', render: (r) => r.description }, { label: 'Status', render: (r) => [statusBadge(r), waiting.has(`ImagingStudy/${r.id}`) ? badge('AI draft', 'warn', `ai-draft-${r.id}`) : null] },
        { label: 'Accession', cls: 'mono', render: (r) => r.accession }, { label: 'Body part', render: (r) => r.bodyPart },
        { label: 'Waiting', cls: 'num', render: (r) => (r.status === 'read' ? '' : h('span', { class: `elapsed${r.priority === 'stat' && Date.parse(data.now) - Date.parse(r.receivedAt) > 3600000 ? ' late' : ''}`, testid: `elapsed-${r.id}` }, r.priority === 'stat' ? elapsed(r.receivedAt, data.now) : '')) },
        { label: '', cls: 'actions', render: (r) => btn('Open', { small: true, kind: 'primary', testid: `open-${r.id}`, title: `Open study ${r.description}`, onClick: () => open(r) }) },
      ] }),
      selectedRow ? h('div', {}, h('h3', {}, `Patient History · ${detail.history.length + 1} examinations, ${detail.history.filter((r) => r.bodyPart === selectedRow.bodyPart).length + 1} matching`), table({ testid: 'history-table', rows: detail.history, empty: 'No other studies for this patient', onRow: open, columns: [
        { label: 'Date and time', render: (r) => fmtDateTime(r.started) }, { label: 'Modality', render: (r) => badge(r.modality, 'info') }, { label: 'Body part', render: (r) => r.bodyPart }, { label: 'Description', render: (r) => r.description }, { label: 'Accession', cls: 'mono', render: (r) => r.accession },
        { label: 'Status', render: statusBadge }, { label: '', render: (r) => (r.id === selectedRow.priorId ? badge('Relevant prior', 'warn', `prior-${r.id}`) : '') },
      ] })) : null,
      selectedRow ? h('div', {}, h('h3', {}, `Images in ${selectedRow.accession || 'study'}`), (() => { const box = h('div', { class: 'thumbs', testid: 'thumbs' }); selectedRow.series.forEach(async (s) => box.append(h('figure', {}, await thumbnail(selectedRow, s, 96), h('figcaption', {}, `${s.description || `Series ${s.number}`} · ${s.frames} img`)))); return box; })()) : null,
    );
    for (const tr of centre.querySelectorAll('[data-testid^="worklist-table-row-"]')) tr.addEventListener('dblclick', () => open(rows.find((r) => tr.dataset.testid.endsWith(r.id))));

    clear(info);
    if (!selectedRow) { info.append(h('p', { class: 'muted' }, 'Select a study to see the request and report. Double-click or press Open to read it.')); return; }
    const rep = detail.report;
    info.append(
      h('section', {}, h('h3', {}, 'Request'), kv([['Reason for examination', selectedRow.reason || 'Not given'], ['Case history', detail.history.length ? `${detail.history.length} earlier examination${detail.history.length === 1 ? '' : 's'}` : 'No earlier examinations'], ['Referred by', selectedRow.referrer || 'Not given'], ['Examinations', selectedRow.description], ['Examination comments', selectedRow.reason || '—'], ['Accession number', h('span', { class: 'mono' }, selectedRow.accession)], ['Received', fmtDateTime(selectedRow.receivedAt)]]),
        h('label', { class: 'field', style: 'margin-top:0.625rem' }, h('span', {}, 'Priority'), h('select', { testid: 'priority-select', 'aria-label': 'Study priority', disabled: view.readOnly || !roleMay('ImagingStudy', 'update'), title: roleMay('ImagingStudy', 'update') ? undefined : reasonFor('ImagingStudy', 'update'), onChange: async (e) => { try { await api.put(`/api/pacs/studies/${selectedRow.id}/priority`, { priority: e.target.value }); undefined; data = await api.get('/api/pacs/worklist', { queue: ui.queue, modality: ui.modality }); await pick(selectedRow.id); } catch (err) { showError(err); } } },
          [['stat', 'STAT'], ['urgent', 'Urgent'], ['routine', 'Routine']].map(([v, t]) => h('option', { value: v, selected: v === selectedRow.priority }, t))))),
      h('section', {}, h('h3', {}, 'Report'), rep ? [kv([['Status', badge(rep.status === 'preliminary' ? 'Draft' : rep.status, rep.status === 'preliminary' ? 'warn' : 'ok')], ['Signed by', rep.resultsInterpreter?.[0]?.display], ['Signed', fmtDateTime(rep.issued)]]), rep.conclusion ? [h('h3', { style: 'margin-top:0.625rem' }, 'Impression'), h('div', { class: 'note-body' }, rep.conclusion)] : null, detail.addenda.length ? h('p', { class: 'muted' }, `${detail.addenda.length} addendum`) : null] : h('p', { class: 'muted' }, 'No report yet.'),
        selectedRow.lock && selectedRow.lock.by !== me() ? h('div', { class: 'banner warn', testid: 'info-locked' }, `Being read by ${selectedRow.lock.by} since ${fmtTime(selectedRow.lock.at)}.`) : null,
        h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn(rep && rep.status !== 'preliminary' ? 'Open study' : 'Open and report', { kind: 'primary', testid: 'info-open', onClick: () => open(selectedRow) }))));
  }
  drawWorklist = draw;
  if (ui.selected && !data.rows.some((r) => r.id === ui.selected)) ui.selected = null;
  if (ui.selected) detail = await api.get(`/api/pacs/studies/${ui.selected}`).catch(() => null);
  draw();
  const timer = setInterval(async () => { try { data = await api.get('/api/pacs/worklist', { queue: ui.queue, modality: ui.modality }); draw(); } catch { /* next tick */ } }, 30000);
  cleanup = () => clearInterval(timer);
  clear(root).append(...[topbar('worklist'), timeStrip(), strip, h('div', { class: 'wl' }, tree, centre, info)].filter(Boolean));
}

// ---------- Viewer and reporting ----------
async function studyView(id, query) {
  const detail = await api.get(`/api/pacs/studies/${id}`);
  const { study, prior } = detail;
  if (study.patient && !EMBED) patientContext.set(study.patient.id);
  let lock = { by: null };
  let lockedByOther = null;
  if (!view.readOnly && !EMBED) {
    try { lock = (await api.post(`/api/pacs/studies/${id}/open`, {})).lock; } catch (err) { if (err.status !== 423) throw err; lockedByOther = (await api.get(`/api/pacs/studies/${id}`)).study.lock; }
  }
  record('open-study', study);

  const panes = h('div', { class: 'panes n1', testid: 'panes' });
  const rail = h('div', { class: 'rail', testid: 'series-rail' });
  const status = h('span', { class: 'muted small', testid: 'viewer-status' });
  let viewports = [];
  let active = null;
  let layout = query.get('layout') || (prior ? 'compare' : 'single');
  // Hanging protocols (part 2.1): without a layout in the address, the first build picks one by modality and body part, or the reader's saved choice.
  let hangPending = !query.get('layout') && !EMBED && !capture.active;
  let hang = { layout: null, protocol: null, from: 'protocol' };
  let arrangement = '2x2';
  let forceCs = false; // the measuring tools beyond length live in the Cornerstone engine; picking one moves the stack there
  const timings = { start: 0, firstMs: null, fullMs: null };
  const HANG_TO_LAYOUT = { '1x1': ['single', null], '1x2': ['compare', null], '2x2': ['volume', '2x2'], 'mpr+prior': ['volume', 'mpr+prior'], '1+3': ['volume', '1+3'], '3d': ['volume', '3d'] };
  const hangIdOf = () => (layout === 'volume' ? arrangement : layout === 'compare' ? '1x2' : layout === 'single' ? '1x1' : null);
  const lastView = new Map();
  let tool = 'wl';
  let currentSeries = study.series[0];
  let priorSeries = prior?.series[0] || null;
  let currentSource = null;
  let volumeLayout = null;
  let linked = true;
  let syncing = false;
  const lastIndex = new Map();
  let annotations = [];
  const mayAnnotate = () => !view.readOnly && !EMBED && roleMay('Observation', 'create');
  const measureCount = h('span', { class: 'muted small', testid: 'measure-count' });
  const countSaved = () => { measureCount.textContent = annotations.length ? `${annotations.length} saved measurement${annotations.length === 1 ? '' : 's'}` : ''; };
  const valueOf = (m) => (['angle', 'cobb'].includes(m.kind) ? m.degrees : ['roi', 'ellipse', 'freehand'].includes(m.kind) ? m.areaMm2 : m.kind === 'probe' ? m.hu : m.kind === 'arrow' ? null : m.mm);
  const sayMeasure = (kind, value, m) => (kind === 'arrow' ? `Arrow note saved${m.text ? `: ${m.text}` : ''}` : value == null ? (kind === 'length' ? 'No pixel spacing in this image: length unavailable' : 'Measurement unavailable') : kind === 'length' ? `Length ${value.toFixed(1)} mm` : kind === 'angle' ? `Angle ${value.toFixed(1)} deg` : kind === 'cobb' ? `Cobb angle ${value.toFixed(1)} deg` : kind === 'probe' ? `Value ${value.toFixed(0)}` : kind === 'bidirectional' ? `Bidirectional ${value.toFixed(1)} x ${(m.shortMm ?? 0).toFixed(1)} mm` : `Area ${value.toFixed(1)} mm2${m.mean != null ? `, mean ${m.mean.toFixed(1)} (SD ${(m.sd ?? 0).toFixed(1)})` : ''}`);
  async function persist(m, of, seriesUid, engine) {
    if (!mayAnnotate()) return;
    const points = m.points || [[m.a.x, m.a.y], [m.b.x, m.b.y]];
    try {
      const saved = await api.post(`/api/pacs/studies/${of.id}/annotations`, { kind: m.kind || 'length', series: seriesUid, plane: m.plane, frame: m.frame, points, space: engine === 'cs3d' ? 'world' : 'image', engine, mm: m.mm, degrees: m.degrees, areaMm2: m.areaMm2, hu: m.hu, mean: m.mean, sd: m.sd, shortMm: m.shortMm, text: m.text, imagePoints: m.imagePoints || undefined, uid: m.uid });
      m.id = saved.id; annotations.push({ ...saved, study: of.id }); countSaved(); measures.draw();
      return saved;
    } catch (err) { showError(err); return null; }
  }
  async function restoreAnnotations() {
    annotations = [];
    if (EMBED) { countSaved(); return; }
    for (const of of [study, ...(prior ? [prior] : [])]) { try { annotations.push(...(await api.get(`/api/pacs/studies/${of.id}/annotations`)).annotations.map((a) => ({ ...a, study: of.id }))); } catch { /* none */ } }
    for (const v of viewports) {
      for (const a of annotations.filter((x) => x.study === v.of.id && x.series === v.seriesUid && (x.engine || 'canvas') === v.engine)) {
        if (v.engine === 'cs3d') v.restore({ ...a, mm: ['length', 'bidirectional'].includes(a.kind) ? a.value : null, degrees: ['angle', 'cobb'].includes(a.kind) ? a.value : null, areaMm2: ['roi', 'ellipse', 'freehand'].includes(a.kind) ? a.value : null });
        else if (a.kind === 'length' && a.points?.length === 2) { const key = `${a.plane}:${a.frame}`; v.measurements.set(key, [...(v.measurements.get(key) || []), { id: a.id, kind: 'length', a: { x: a.points[0][0], y: a.points[0][1] }, b: { x: a.points[1][0], y: a.points[1][1] }, mm: a.value, plane: a.plane, frame: a.frame }]); }
      }
      v.render();
    }
    countSaved(); measures.draw();
  }
  async function clearMeasurements() {
    viewports.forEach((v) => v.command('clear'));
    const saved = annotations.splice(0);
    for (const a of saved) { try { await api.del(`/api/pacs/studies/${a.study}/annotations/${a.id}`); } catch { /* already gone */ } }
    countSaved(); measures.draw();
    if (saved.length) toast(`${saved.length} saved measurement${saved.length === 1 ? '' : 's'} removed`);
  }

  const setActive = (vp) => { active = vp; for (const v of viewports) v.el.classList.toggle('active', v === vp); syncToolbar(); };
  const presetSelect = h('select', { testid: 'preset-select', 'aria-label': 'Window preset', onChange: (e) => { if (volumeLayout) volumeLayout.setPreset(e.target.value); else active?.command('preset', e.target.value); record('preset', study, { preset: slug(e.target.value) }); } }, ['Auto', ...Object.keys(WINDOW_PRESETS)].map((p) => h('option', { value: p }, p)));
  const cineBtn = btn('Cine', { testid: 'tool-cine', title: 'Play or stop cine (Space)', onClick: () => { active?.command('cine'); syncToolbar(); } });
  function syncToolbar() {
    if (!active) return;
    presetSelect.value = ['Auto', ...Object.keys(WINDOW_PRESETS)].includes(active.state.preset) ? active.state.preset : 'Auto';
    cineBtn.textContent = active.state.cine ? 'Stop cine' : 'Cine';
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  // Picking a tool. The measuring tools beyond length are Cornerstone tools: on a stack shown by the in-house engine, the stack is reopened in the Cornerstone engine first.
  async function pickTool(id2, eng) {
    tool = id2;
    if (eng === 'cs3d' && (volumeLayout || viewports.some((v) => v.engine !== 'cs3d'))) { forceCs = true; if (!['single', 'compare'].includes(layout)) layout = prior ? 'compare' : 'single'; await build(); }
    viewports.forEach((v) => v.command('tool', id2)); syncToolbar();
  }
  const toolButtons = [['wl', 'W/L', 'Window and level: drag (W)'], ['length', 'Length', 'Measure length: drag (L)'], ['pan', 'Pan', 'Pan: drag (or middle button) (P)'], ['zoom', 'Zoom', 'Zoom: drag (or right button, Ctrl+wheel) (Z)'], ['angle', 'Angle', 'Measure angle: three clicks (A)', 'cs3d'], ['cobb', 'Cobb', 'Cobb angle: draw two lines (C)', 'cs3d'], ['roi', 'ROI', 'Rectangle region of interest: drag', 'cs3d'], ['ellipse', 'Ellipse', 'Ellipse region with mean, standard deviation and area: drag (E)', 'cs3d'], ['freehand', 'Freehand', 'Freehand region with mean, standard deviation and area: draw (F)', 'cs3d'], ['probe', 'Probe', 'Value at a point, in HU on CT: click (H)', 'cs3d'], ['bidirectional', 'Bidirectional', 'Long and short axis: drag the long axis (B)', 'cs3d'], ['arrow', 'Arrow', 'Arrow with a note: drag, then type (T)', 'cs3d']].map(([id2, label, title, eng]) => {
    const b = h('button', { type: 'button', testid: `tool-${id2}`, 'aria-label': title, title, 'aria-pressed': String(tool === id2), onClick: () => pickTool(id2, eng).catch(showError) }, label);
    b.dataset.tool = id2;
    if (eng) b.dataset.engine = eng;
    return b;
  });
  const layoutButtons = h('div', { class: 'lay', role: 'group', 'aria-label': 'Layout' });
  const layoutTabs = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Viewer layouts', testid: 'layout-tabs' });
  let thumbsShown = true;

  // While a recording is on, note which image was on screen and for how long (a frame shown for under half a second is not counted).
  const shown = new Map();
  function dwell(paneId, of, st) {
    const now = Date.now();
    const was = shown.get(paneId);
    const key = st?.source ? `${st.source.label}|${st.index}` : null;
    if (was && was.key === key) return;
    if (was && capture.active && now - was.at >= 500) record('dwell', was.of, { frame: was.index, ms: Math.min(now - was.at, 3600000), prior: was.of !== study });
    if (key) shown.set(paneId, { key, at: now, of, index: st.index }); else shown.delete(paneId);
  }

  async function makeViewport(paneId, isPrior, engine = 'canvas', seriesUid = null) {
    const of = isPrior ? prior : study;
    let vp = null;
    const callbacks = {
      onActivate: () => setActive(vp),
      onChange: (st) => {
        dwell(paneId, of, st);
        // Linked scrolling in the compare layout: a scroll in one pane moves the other by the same number of images.
        const prev = lastIndex.get(paneId);
        lastIndex.set(paneId, st.index);
        const locOf = (v, i) => { const src = v.state.source; const loc = src?.locations ? src.locations[i] : src?.frames?.[i]?.location; return loc == null || Number.isNaN(Number(loc)) ? null : Number(loc); };
        const locsOf = (v) => { const src = v.state.source; const list = src?.locations || src?.frames?.map((fr) => fr.location); return list?.length > 1 && list.every((x) => x != null) ? list.map(Number) : null; };
        if (layout === 'compare' && linked && !syncing && prev != null && prev !== st.index) { syncing = true; try { for (const v of viewports) if (v !== vp) {
          // Current against prior by position (mm) when both stacks know where their slices are; otherwise by the same number of images.
          const here = locOf(vp, st.index); const there = locsOf(v); const byPos = here != null && there && locsOf(vp) ? nearestByLocation(there, here) : null;
          if (byPos != null) { lastIndex.set(v.paneId, byPos); v.command('goto', byPos); } else { lastIndex.set(v.paneId, (lastIndex.get(v.paneId) ?? v.state.index) + (st.index - prev)); v.command('scroll', st.index - prev); }
        } } finally { syncing = false; } }
        // Linked zoom and window: a change in one pane is copied to the others (window only between images of the same modality).
        const was = lastView.get(paneId); const now = { zoom: st.zoom, center: st.center, width: st.width };
        lastView.set(paneId, now);
        if (layout === 'compare' && linked && !syncing && was && st.source && !st.source.preview) { syncing = true; try { for (const v of viewports) if (v !== vp && v.state.source) {
          if (Math.abs(was.zoom - now.zoom) > 1e-6) { v.command('zoom', now.zoom); lastView.set(v.paneId, { ...(lastView.get(v.paneId) || {}), zoom: now.zoom }); }
          if ((was.center !== now.center || was.width !== now.width) && v.state.source.header?.modality === st.source.header?.modality) { v.command('window', { center: now.center, width: now.width }); lastView.set(v.paneId, { ...(lastView.get(v.paneId) || {}), center: now.center, width: now.width }); }
        } } finally { syncing = false; } }
      },
      onMeasure: (m) => {
        const kind = m.kind || 'length';
        const value = valueOf({ ...m, kind });
        if (kind === 'length' && m.a) record('length', of, { mm: m.mm == null ? -1 : Math.round(m.mm * 10) / 10, plane: m.plane, frame: m.frame, x1: Math.round(m.a.x), y1: Math.round(m.a.y), x2: Math.round(m.b.x), y2: Math.round(m.b.y) });
        else record(kind, of, { value: value == null ? -1 : Math.round(value * 10) / 10, plane: m.plane, frame: m.frame, engine });
        toast(sayMeasure(kind, value, m), { error: value == null && kind !== 'arrow' });
        persist({ ...m, kind }, of, seriesUid, engine).then((saved) => { if (saved) m.id = saved.id; });
      },
    };
    callbacks.onMark = async (mk) => { if (!capture.active || view.readOnly) return; try { await fhir.create({ resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:observation-category', code: 'annotation' }] }], code: { coding: [{ system: 'urn:hospital-desktop:annotation-label', code: mk.label }], text: `${mk.kind === 'box' ? 'Bounding box' : mk.kind === 'outline' ? 'Outline' : 'Point'}: ${mk.label}` }, subject: { reference: `Patient/${of.patient.id}` }, derivedFrom: [{ reference: `ImagingStudy/${of.id}` }], effectiveDateTime: new Date().toISOString(), extension: [{ url: 'urn:hospital-desktop:annotation', valueString: JSON.stringify({ kind: mk.kind, series: seriesUid, plane: mk.plane, frame: mk.frame, x: mk.x, y: mk.y, width: mk.width ?? 0, height: mk.height ?? 0, ...(mk.points ? { points: mk.points } : {}), space: 'image' }) }, { url: 'urn:hospital-desktop:run', valueString: capture.active.runId }] }); record(mk.kind, of, { label: slug(mk.label) }); toast(`${mk.kind === 'box' ? 'Box' : 'Point'} saved: ${mk.label}`); } catch (err) { showError(err); } };
    callbacks.onSegPointer = (evt) => segmentation.onPointer(evt);
    vp = engine === 'cs3d' ? await (await engine3d()).createStackViewport3d({ id: paneId, prior: isPrior, callbacks }) : createViewport({ id: paneId, prior: isPrior, callbacks });
    if (engine !== 'cs3d' && !isPrior) vp.state.overlayFor = (source, index) => segmentation.overlayFor(source, index);
    vp.paneId = paneId; vp.of = of; vp.seriesUid = seriesUid;
    vp.command('tool', tool);
    return vp;
  }

  async function build() {
    viewports.forEach((v) => v.destroy());
    viewports = [];
    volumeLayout?.destroy(); volumeLayout = null;
    lastIndex.clear();
    status.textContent = 'Loading images…';
    timings.start = performance.now(); timings.firstMs = null; timings.fullMs = null;
    const sayTimes = () => { window.__pacsTimings = { ...timings, layout, arrangement }; timesEl.textContent = timings.firstMs == null ? '' : `First image ${(timings.firstMs / 1000).toFixed(2)} s${timings.fullMs != null ? ` · all images ${(timings.fullMs / 1000).toFixed(2)} s` : ''}`; };
    const progress = (d, n) => { status.textContent = `Loading ${d}/${n}`; };
    // A compressed series (JPEG family) is decoded by the Cornerstone engine's codecs; everything else uses the in-house canvas engine so the overlays and tests stay exact.
    const engineFor = (s) => (s.compression || forceCs ? 'cs3d' : 'canvas');
    // Progressive loading: the middle image of an uncached series is on screen before the rest arrives.
    if (!EMBED && engineFor(currentSeries) === 'canvas' && !isSeriesLoaded(study, currentSeries) && currentSeries.instances > 1) {
      try { const pre = await loadPreview(study, currentSeries); if (pre) { const pv = createViewport({ id: 'preview', callbacks: {} }); clear(panes); panes.className = 'panes n1'; panes.append(pv.el); pv.setSource(pre); timings.firstMs = performance.now() - timings.start; sayTimes(); await new Promise((r) => requestAnimationFrame(r)); } } catch { /* the full load reports any real problem */ }
    }
    const load = async (st, s) => (engineFor(s) === 'cs3d' ? (await engine3d()).loadSeries3d(st, s, progress) : loadSeries(st, s, progress));
    currentSource = await load(study, currentSeries);
    if (timings.firstMs == null) timings.firstMs = performance.now() - timings.start;
    timings.fullMs = performance.now() - timings.start; sayTimes();
    const canVolume = currentSource.engine === 'cs3d' ? currentSource.count >= 8 : supportsVolume(currentSource);
    const can = { prior: Boolean(priorSeries), volume: canVolume };
    if (hangPending) { hangPending = false; hang = chooseLayout({ modality: study.modality, bodyPart: study.bodyPart, description: study.description }, can, localStorage); [layout, arrangement] = [HANG_TO_LAYOUT[hang.layout][0], HANG_TO_LAYOUT[hang.layout][1] || arrangement]; record('hanging-protocol', study, { protocol: hang.protocol.id, layout: hang.layout, from: hang.from }); }
    if (layout === 'volume' && arrangement === 'mpr+prior' && !priorSeries) arrangement = '2x2';
    clear(pickerHost).append(layoutPicker({ can, current: hangIdOf(), protocol: hang.protocol, from: hang.from, onPick: (idp) => { saveLayout({ modality: study.modality, bodyPart: study.bodyPart }, idp, localStorage); hang = { ...hang, layout: idp, from: 'saved' }; [layout, arrangement] = [HANG_TO_LAYOUT[idp][0], HANG_TO_LAYOUT[idp][1] || arrangement]; forceCs = false; record('layout', study, { layout: idp }); build().catch(showError); } }));
    clear(volbarHost);
    if (layout === 'mpr' && (!canVolume || currentSource.engine === 'cs3d')) layout = prior ? 'compare' : 'single';
    if (layout === 'volume' && !canVolume) layout = prior ? 'compare' : 'single';
    if (layout === 'compare' && !priorSeries) layout = 'single';
    if (layout === 'overview' && !(priorSeries && canVolume && currentSource.engine !== 'cs3d')) layout = priorSeries ? 'compare' : 'single';
    const options = [['single', 'Single'], ...(priorSeries ? [['compare', 'Compare prior']] : []), ...(priorSeries && canVolume && currentSource.engine !== 'cs3d' ? [['overview', 'Comparison overview']] : []), ...(canVolume && currentSource.engine !== 'cs3d' ? [['mpr', '3D: axial, coronal, sagittal']] : []), ...(canVolume ? [['volume', 'Volume: MPR with crosshairs and 3D']] : [])];
    clear(layoutButtons).append(...options.map(([l, label]) => h('button', { type: 'button', testid: `layout-${l}`, 'aria-label': `Layout: ${label}`, 'aria-pressed': String(layout === l), onClick: () => { layout = l; record('layout', study, { layout: l }); build().catch(showError); } }, label)));
    clear(layoutTabs).append(h('span', { class: 'muted', style: 'margin-right:0.375rem' }, 'Layouts'), ...options.map(([l, label]) => h('button', { type: 'button', testid: `tab-${l}`, 'aria-label': `Layout: ${label}`, 'aria-pressed': String(layout === l), onClick: () => { layout = l; record('layout', study, { layout: l }); build().catch(showError); } }, label)), h('span', { class: 'muted', style: 'margin-left:auto' }, `${study.modality} · ${study.description}`));
    clear(panes);
    if (layout === 'volume') {
      const v3 = await engine3d();
      const src3 = currentSource.engine === 'cs3d' ? currentSource : await v3.loadSeries3d(study, currentSeries, progress);
      // "MPR + prior": the prior study in the fourth pane, following the axial plane by position.
      let priorVp = null;
      if (arrangement === 'mpr+prior' && priorSeries) { const priorSource = await load(prior, priorSeries); priorVp = await makeViewport('prior', true, priorSource.engine || 'canvas', priorSeries.uid); viewports = [priorVp]; }
      const tVol = performance.now();
      volumeLayout = await v3.createVolumeLayout({ source: src3, container: panes, arrangement, priorEl: priorVp?.el || null, callbacks: {
        onPreset: (name) => record('preset', study, { preset: slug(name) }), onSlab: (sl) => record('slab', study, { mode: sl.mode, mm: sl.mm }), onClip: (c) => record('clip', study, { on: c.on }),
        onTiming: (t0) => { const off = tVol - timings.start; const t = { ...t0, firstMs: (t0.firstMs ?? 0) + off, fullMs: t0.fullMs == null ? null : t0.fullMs + off }; /* counted from the moment the study was opened, including fetching and decoding the slices */ window.__pacsVolume = { firstMs: Math.round(t.firstMs ?? 0), fullMs: t.fullMs == null ? null : Math.round(t.fullMs), cached: Boolean(t.cached), slices: src3.count }; volTimes.textContent = t.fullMs != null ? `Volume: first slice ${((t.firstMs ?? 0) / 1000).toFixed(2)} s, full volume ${(t.fullMs / 1000).toFixed(2)} s${t.cached ? ' (cached)' : ''}` : `Volume: first slice ${((t.firstMs ?? 0) / 1000).toFixed(2)} s, loading…`; if (t.fullMs != null) record('volume-loaded', study, { firstMs: Math.round(t.firstMs ?? 0), fullMs: Math.round(t.fullMs), slices: src3.count }); },
        onAxialLocation: (mm) => { if (!priorVp || !linked) return; const src = priorVp.state.source; const locs = src?.locations || src?.frames?.map((fr) => fr.location); const i = locs && locs.every((x) => x != null) ? nearestByLocation(locs.map(Number), mm) : null; if (i != null && i !== priorVp.state.index) priorVp.command('goto', i); },
      } });
      if (priorVp) { await priorVp.setSource(await load(prior, priorSeries)); }
      volbarHost.append(volumeLayout.controls, volTimes);
      active = priorVp;
      status.textContent = `${src3.count} images · ${src3.header.modality} · volume`;
      drawRail();
      await restoreAnnotations();
      return;
    }
    if (layout === 'overview') {
      // Comparison overview (reference screens): current axial, coronal and sagittal above the prior's, the prior row labelled PRIOR.
      const priorSource = await load(prior, priorSeries);
      const cur = reslice(currentSource);
      const pri = supportsVolume(priorSource) && priorSource.engine !== 'cs3d' ? reslice(priorSource) : null;
      const sources = [currentSource, cur.coronal, cur.sagittal, priorSource, pri ? pri.coronal : priorSource, pri ? pri.sagittal : priorSource];
      const ids = ['axial', 'coronal', 'sagittal', 'prior-axial', 'prior-coronal', 'prior-sagittal'];
      viewports = await Promise.all(ids.map((pid, i) => makeViewport(pid, i >= 3, 'canvas', i >= 3 ? priorSeries.uid : currentSeries.uid)));
      panes.className = 'panes n6';
      panes.append(...viewports.map((v) => v.el));
      viewports.forEach((v, i) => v.setSource(sources[i]));
      const w = viewports[0].state; viewports.slice(1, 3).forEach((v) => v.command('window', { center: w.center, width: w.width }));
    } else if (layout === 'mpr') {
      const planes = reslice(currentSource);
      const sources = [currentSource, planes.coronal, planes.sagittal];
      viewports = await Promise.all(sources.map((_, i) => makeViewport(['axial', 'coronal', 'sagittal'][i], false, 'canvas', currentSeries.uid)));
      panes.className = 'panes n3';
      panes.append(...viewports.map((v) => v.el));
      viewports.forEach((v, i) => v.setSource(sources[i]));
      const w = viewports[0].state;
      viewports.slice(1).forEach((v) => v.command('window', { center: w.center, width: w.width }));
    } else if (layout === 'compare') {
      const priorSource = await load(prior, priorSeries);
      viewports = [await makeViewport('prior', true, priorSource.engine || 'canvas', priorSeries.uid), await makeViewport('current', false, currentSource.engine || 'canvas', currentSeries.uid)];
      panes.className = 'panes n2';
      panes.append(...viewports.map((v) => v.el));
      await viewports[0].setSource(priorSource);
      await viewports[1].setSource(currentSource);
    } else {
      viewports = [await makeViewport('current', false, currentSource.engine || 'canvas', currentSeries.uid)];
      panes.className = 'panes n1';
      panes.append(viewports[0].el);
      await viewports[0].setSource(currentSource);
    }
    setActive(viewports[viewports.length === 2 ? 1 : 0]);
    status.textContent = `${currentSource.count} image${currentSource.count === 1 ? '' : 's'} · ${currentSource.header.modality}${canVolume ? ' · volume' : ''}${currentSource.engine === 'cs3d' ? ` · ${currentSource.header.compression || 'compressed'}` : ''}`;
    linkBtn.hidden = layout !== 'compare';
    drawRail();
    await restoreAnnotations();
    segmentation.draw();
    // Prefetch the next series while the reader looks at this one.
    const next = study.series[study.series.findIndex((x) => x.uid === currentSeries.uid) + 1];
    if (next && !next.compression && !isSeriesLoaded(study, next) && !EMBED) (window.requestIdleCallback || ((fn) => setTimeout(fn, 800)))(() => { loadSeries(study, next).then(() => { window.__pacsPrefetched = next.uid; }, () => {}); });
  }
  const pickerHost = h('div', { class: 'vtabs', testid: 'layout-picker-host' });
  const volbarHost = h('div', { class: 'volhost', testid: 'volume-bar' });
  const timesEl = h('span', { class: 'muted small', testid: 'load-times' });
  const volTimes = h('span', { class: 'muted small', testid: 'volume-times' });
  const insertIntoReport = (lines) => { const target = document.querySelector('[data-testid="report-findings"]'); if (!target || target.disabled) { toast('The report is not open for editing', { error: true }); return; } target.value = `${target.value.trim()}${target.value.trim() ? '\n' : ''}${[].concat(lines).join('\n')}`; target.dispatchEvent(new Event('input', { bubbles: true })); record('measure-to-report', study, { count: [].concat(lines).length }); toast('Added to the report findings'); };
  const measures = measurementsPanel({
    list: () => annotations.map((a) => ({ ...a, seriesNumber: [...study.series, ...(prior?.series || [])].find((x) => x.uid === a.series)?.number ?? null })),
    canEdit: mayAnnotate(),
    onRename: async (m, label) => { const saved = await api.put(`/api/pacs/studies/${m.study}/annotations/${m.id}`, { label }); const i = annotations.findIndex((x) => x.id === m.id); if (i >= 0) annotations[i] = { ...saved, study: m.study }; },
    onRemove: async (m) => { await api.del(`/api/pacs/studies/${m.study}/annotations/${m.id}`); annotations = annotations.filter((x) => x.id !== m.id); for (const v of viewports) { if (v.engine === 'cs3d') v.command('remove', m.uid); else if (v.measurements) { for (const [k, list] of v.measurements) v.measurements.set(k, list.filter((x) => x.id !== m.id)); v.render(); } } countSaved(); },
    onInsert: (line) => insertIntoReport(line), onInsertAll: (lines) => insertIntoReport(lines),
    onGoto: (m) => { const v = viewports.find((x) => x.of.id === m.study && x.seriesUid === m.series) || active; if (v && m.frame != null) { v.command('goto', m.frame); setActive(v); } },
    onSaveSr: async (rows) => { const mine = rows.filter((r) => r.study === study.id && r.series === currentSeries.uid); const saved = await saveMeasurementsSr({ study, series: currentSeries, source: currentSource, rows: mine }); record('sr-save', study, { measurements: mine.length }); toast(`${mine.length} measurement${mine.length === 1 ? '' : 's'} saved as a DICOM structured report`); return saved; },
  });
  const segmentation = createSegmentation({ study, getSeries: () => currentSeries, getSource: () => currentSource, getViewports: () => viewports, getActive: () => active, canEdit: mayAnnotate(), record, setTool: (t2) => { forceCs = false; const go2 = async () => { if (volumeLayout || viewports.some((v) => v.engine === 'cs3d' && v.of === study)) { if (!['single', 'compare', 'mpr'].includes(layout)) layout = 'single'; await build(); } tool = t2; viewports.forEach((v) => v.command('tool', t2)); syncToolbar(); }; go2().catch(showError); } });
  const views = savedViews({ study, getActive: () => active, getSeries: () => currentSeries, getSource: () => currentSource, canEdit: mayAnnotate(), record });

  function drawRail() {
    const item = (st, s, isPrior) => { const b = h('button', { type: 'button', testid: `series-${isPrior ? 'prior' : 'current'}-${s.number}`, 'aria-label': `${isPrior ? 'Prior' : 'Current'} series ${s.number}: ${s.description}`, 'aria-pressed': String((isPrior ? priorSeries : currentSeries)?.uid === s.uid), onClick: () => { if (isPrior) priorSeries = s; else currentSeries = s; build().catch(showError); } }); if (s.compression) b.prepend(h('div', { class: 'thumb-ph', testid: `thumb-${isPrior ? 'prior' : 'current'}-${s.number}`, title: `${s.compression}: decoded in the viewer` }, s.compression)); else thumbnail(st, s, 72).then((c) => b.prepend(c)).catch(() => {}); b.append(h('div', {}, s.description || `Series ${s.number}`), h('div', { class: 'muted' }, `${s.modality} · ${s.frames} img`)); return b; };
    const block = (st, isPrior) => h('div', { class: 'study', testid: isPrior ? 'rail-prior-block' : 'rail-current-block' }, h('h3', { class: isPrior ? 'prior' : '', testid: isPrior ? 'rail-prior' : 'rail-current' }, isPrior ? `PRIOR · ${fmtDate(st.started)}` : `Current · ${fmtDate(st.started)}`, h('span', { class: 'muted' }, `${st.modality} ${st.description}`), h('span', { class: 'muted' }, `${st.series.length} series, ${st.series.reduce((n, s) => n + (s.frames || 0), 0)} images`)), h('div', { class: 'series' }, ...st.series.map((s) => item(st, s, isPrior))));
    clear(rail).append(block(study, false), ...(prior ? [block(prior, true)] : []));
    rail.hidden = !thumbsShown;
  }

  const linkBtn = h('button', { type: 'button', testid: 'tool-link', 'aria-label': 'Link scrolling between prior and current', title: 'Link scrolling between prior and current', 'aria-pressed': String(linked), hidden: true, onClick: () => { linked = !linked; linkBtn.setAttribute('aria-pressed', String(linked)); record('link', study, { linked }); } }, 'Link');
  const tb = (ico, label, opts) => { const b = h('button', { type: 'button', class: 'tb', testid: opts.testid, 'aria-label': opts.title || label, title: opts.title || label, 'aria-pressed': opts.pressed, onClick: opts.onClick }, h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), label); if (opts.disabled) b.disabled = true; return b; };
  for (const b of toolButtons) { b.classList.add('tb'); b.prepend(h('span', { class: 'ico', 'aria-hidden': 'true' }, { wl: '◐', length: '⟷', pan: '✥', zoom: '⊕', angle: '∠', roi: '▭' }[b.dataset.tool] || '·')); }
  // Annotation toolbar while recording (plan-master 6.6): bounding box, point, brush with eraser and size, labels (number keys), undo and redo, save mask.
  const labelsOf = () => { try { return (JSON.parse(localStorage.getItem('hd.annotate') || 'null')?.labels || [{ name: 'Finding', colour: '#F7313B', key: 1 }, { name: 'Normal', colour: '#1F6F86', key: 2 }]); } catch { return [{ name: 'Finding', colour: '#F7313B', key: 1 }]; } };
  let activeLabel = labelsOf()[0];
  const annot = h('div', { class: 'annot', testid: 'annotation-toolbar', role: 'toolbar', 'aria-label': 'Annotation tools', hidden: true });
  const brushSize = h('input', { type: 'range', min: 2, max: 60, value: 12, testid: 'annot-brush-size', 'aria-label': 'Brush size', style: 'width:5.625rem', onInput: (e) => viewports.forEach((v) => v.command?.('brush', { size: Number(e.target.value) })) });
  const applyLabel = (l) => { activeLabel = l; viewports.forEach((v) => v.command?.('brush', { label: l.name, colour: l.colour })); drawAnnot(); };
  const setTool = (t2) => { tool = t2; viewports.forEach((v) => v.command('tool', t2)); if (t2 === 'erase') viewports.forEach((v) => v.command?.('brush', { erase: true })); else viewports.forEach((v) => v.command?.('brush', { erase: false })); syncToolbar(); drawAnnot(); };
  const saveMask = async () => {
    const vp = active; const mask = vp?.maskFor?.(); if (!vp || !mask) { toast('Brush a mask first', { error: true }); return; }
    const enc = mask.encode(); if (!enc) { toast('The mask is empty', { error: true }); return; }
    const f = vp.state.source.frames?.[vp.state.index];
    await fhir.create(maskObservation({ patientRef: `Patient/${vp.of.patient.id}`, label: activeLabel.name, image: { ref: `ImagingStudy/${vp.of.id}`, series: vp.seriesUid, sop: f?.file?.str?.('SOPInstanceUID') || null, plane: vp.state.source.kind, frame: vp.state.index, rows: mask.height, columns: mask.width }, mask: enc, runId: capture.active?.runId || null }));
    record('mask', vp.of, { label: slug(activeLabel.name), pixels: enc.pixels }); toast(`Mask saved: ${activeLabel.name} (${enc.pixels} px)`);
  };
  const drawAnnot = () => {
    annot.hidden = !capture.active;
    clear(annot);
    if (annot.hidden) return;
    annot.append(h('strong', { class: 'small' }, 'Annotate'),
      ...[['box', 'Box'], ['outline', 'Outline'], ['brush', 'Brush'], ['erase', 'Eraser'], ['point', 'Point'], ['length', 'Ruler']].map(([t2, label]) => h('button', { type: 'button', class: 'small', testid: `annot-${t2}`, 'aria-label': `${label} tool`, 'aria-pressed': String(tool === t2), onClick: () => setTool(t2) }, label)),
      brushSize, btn('Undo', { small: true, testid: 'annot-undo', title: 'Undo the last brush stroke', onClick: () => active?.command?.('undo') }), btn('Redo', { small: true, testid: 'annot-redo', onClick: () => active?.command?.('redo') }),
      ...labelsOf().map((l, i) => h('button', { type: 'button', class: 'small', testid: `annot-label-${i + 1}`, 'aria-label': `Label ${l.name} (key ${i + 1})`, 'aria-pressed': String(activeLabel?.name === l.name), style: `border-left:0.25rem solid ${l.colour}`, onClick: () => applyLabel(l) }, `${i + 1} ${l.name}`)),
      btn('Save mask', { small: true, kind: 'primary', testid: 'annot-save-mask', write: true, perm: ['Observation', 'create'], onClick: () => saveMask().catch(showError) }));
  };
  capture.onChange(drawAnnot); drawAnnot();
  const onAnnotKey = (e) => { if (!capture.active || e.target.closest('input, textarea, select, dialog')) return; const n = Number(e.key); const l = labelsOf()[n - 1]; if (n >= 1 && l) { applyLabel(l); e.preventDefault(); } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { active?.command?.(e.shiftKey ? 'redo' : 'undo'); e.preventDefault(); } };
  document.addEventListener('keydown', onAnnotKey);
  const toolbar = h('div', { class: 'vtool', role: 'toolbar', 'aria-label': 'Viewer tools' },
    tb('✕', 'Close', { testid: 'back-worklist', title: 'Close and go back to the worklist', onClick: () => go('#/worklist') }),
    tb('▤', 'Thumbnails', { testid: 'tool-thumbnails', title: 'Show or hide the thumbnail strip', pressed: 'true', onClick: (e) => { thumbsShown = !thumbsShown; rail.hidden = !thumbsShown; e.currentTarget.setAttribute('aria-pressed', String(thumbsShown)); } }),
    h('span', { class: 'sep' }), h('div', { class: 'seg' }, toolButtons), h('span', { class: 'sep' }),
    tb('◫', 'Prior', { testid: 'tool-prior', title: prior ? 'Compare with the prior study' : 'No prior study', disabled: !prior, onClick: () => { layout = 'compare'; record('layout', study, { layout: 'compare' }); build().catch(showError); } }),
    h('span', { class: 'sep' }), presetSelect,
    btn('Invert', { testid: 'tool-invert', title: 'Invert (i)', onClick: () => active?.command('invert') }), btn('Reset', { testid: 'tool-reset', title: 'Reset view (r)', onClick: () => { active?.command('reset'); syncToolbar(); } }), cineBtn,
    btn('Clear measurements', { testid: 'tool-clear', onClick: () => clearMeasurements().catch(showError) }), linkBtn,
    btn('Measurements', { testid: 'tool-measurements', title: 'Show or hide the list of measurements (M)', onClick: () => measures.toggle() }), btn('Segmentation', { testid: 'tool-segmentation', title: 'Show or hide the segmentation tools (S)', onClick: () => segmentation.toggle() }), views.el,
    btn('?', { testid: 'tool-help', title: 'Keyboard shortcuts (?)', onClick: () => shortcutHelp() }), measureCount);

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    // Reading-workstation shortcuts (the help panel lists them). While a recording is on, the number keys pick annotation labels instead of layouts.
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const toolKey = { w: ['wl'], l: ['length'], p: ['pan'], z: ['zoom'], a: ['angle', 'cs3d'], c: ['cobb', 'cs3d'], e: ['ellipse', 'cs3d'], f: ['freehand', 'cs3d'], h: ['probe', 'cs3d'], b: ['bidirectional', 'cs3d'], t: ['arrow', 'cs3d'] }[k];
    if (toolKey && !capture.active) { e.preventDefault(); pickTool(...toolKey).catch(showError); return; }
    if (k === '?') { e.preventDefault(); shortcutHelp(); return; }
    if (k === 'm') { e.preventDefault(); measures.toggle(); return; }
    if (k === 's') { e.preventDefault(); segmentation.toggle(); return; }
    if (k === 'k') { e.preventDefault(); linkBtn.click(); return; }
    if (/^[1-6]$/.test(k) && !capture.active) { const pick = LAYOUTS[Number(k) - 1]; const b = pickerHost.querySelector(`[data-testid="hang-${pick.id.replace('+', '-')}"]`); if (b && !b.disabled) { e.preventDefault(); b.click(); } return; }
    if (!active) return;
    const map = { ArrowDown: ['scroll', 1], ArrowRight: ['scroll', 1], ArrowUp: ['scroll', -1], ArrowLeft: ['scroll', -1], PageDown: ['scroll', 10], PageUp: ['scroll', -10], Home: ['first'], End: ['last'], i: ['invert'], r: ['reset'], ' ': ['cine'] };
    const cmd = map[e.key];
    if (!cmd) return;
    e.preventDefault();
    active.command(...cmd);
    syncToolbar();
  };
  document.addEventListener('keydown', onKey);

  // ----- Report pane -----
  const report = h('div', { class: 'report', testid: 'report-pane' });
  let rep = detail.report;
  let addenda = detail.addenda;
  let dirty = false;
  let saving = Promise.resolve();
  // Reporting needs the reading lock, live time, and a role that may write reports.
  const canWrite = () => !view.readOnly && !lockedByOther && !EMBED && roleMay('DiagnosticReport', 'update');
  const sections = { technique: null, findings: null, impression: null };
  const savedAt = h('span', { class: 'muted small', testid: 'draft-status' });
  const body = (status2) => ({ ...(rep || { resourceType: 'DiagnosticReport', subject: { reference: `Patient/${study.patient.id}` }, code: { text: study.description }, imagingStudy: [{ reference: `ImagingStudy/${study.id}` }], effectiveDateTime: study.started || undefined }),
    status: status2 ?? rep?.status ?? 'preliminary', conclusion: sections.impression.get(), extension: [...((rep?.extension || []).filter((e) => ![T_URL, F_URL, CRITICAL_URL, CRITICAL_TOLD_URL].includes(e.url))), { url: T_URL, valueString: sections.technique.get() }, { url: F_URL, valueString: sections.findings.get() }, { url: CRITICAL_URL, valueBoolean: critical }, ...(told ? [{ url: CRITICAL_TOLD_URL, valueString: JSON.stringify(told) }] : [])] });
  let critical = false; let told = null;
  async function saveDraft({ silent = false } = {}) {
    if (!canWrite() || (rep && rep.status !== 'preliminary')) return;
    saving = saving.then(async () => { rep = rep ? await fhir.update(body()) : await fhir.create(body('preliminary')); dirty = false; savedAt.textContent = `Draft saved ${fmtTime(new Date())}`; if (!silent) undefined; });
    await saving;
  }
  const autosave = setInterval(() => { if (dirty) saveDraft({ silent: true }).catch(showError); }, 30000);
  const unsavedOff = shell.unsaved(() => dirty && canWrite() && !(rep && rep.status !== 'preliminary'));

  // AI proposals for this study, shown above the report fields until one is decided.
  const cards = h('div', { testid: 'proposal-cards' });
  const shownDrafts = new Set();
  let usedDraft = null;
  async function loadCards() {
    if (lockedByOther || (rep && rep.status !== 'preliminary')) { clear(cards); return 0; }
    const list = await loadProposals({ subject: `ImagingStudy/${id}`, status: 'pending' });
    for (const p of list) if (!shownDrafts.has(p.id)) { shownDrafts.add(p.id); draftEvent(p.id, 'shown', { branch: view.branch }); }
    clear(cards).append(...list.map((p) => {
      const cardEl = proposalCard(p, { onDone: async () => { const d = await api.get(`/api/pacs/studies/${id}`); rep = d.report; addenda = d.addenda; dirty = false; drawReport(); await loadCards(); } });
      // draft-report: the draft can be taken into the template, edited there, and signed as the radiologist's own report.
      if (p.kind === 'report' && sections.technique) cardEl.append(h('div', { class: 'toolbar', style: 'margin:0.375rem 0 0' }, btn('Start with this draft in the template', { small: true, kind: 'primary', testid: `draft-use-${p.id}`, onClick: () => { sections.technique.set(p.content.technique || ''); sections.findings.set(p.content.findings || ''); sections.impression.set(p.content.impression || ''); usedDraft = p; dirty = true; savedAt.textContent = 'Unsaved changes'; draftEvent(p.id, 'used', { branch: view.branch }); jumpField('findings'); toast('Draft loaded into the template. Edit it, then sign.'); } })));
      return cardEl;
    }));
    return list.length;
  }
  // The agent starts when the study is opened, so its proposal can arrive a moment later.
  const cardTimers = [1500, 4000].map((ms) => setTimeout(async () => { if (report.isConnected && !cards.children.length) await loadCards().catch(() => {}); }, ms));

  function drawReport() {
    clear(report).append(h('h2', {}, 'Report'), kv([['Exam', study.description], ['Reason', study.reason || 'Not given'], ['Referred by', study.referrer || 'Not given']]), h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }));
    if (lockedByOther) report.append(h('div', { class: 'banner warn', testid: 'locked-banner' }, h('strong', {}, `Being read by ${lockedByOther.by}`), `Locked since ${fmtTime(lockedByOther.at)}. You can view the images; reporting is disabled. `, btn('Take over', { small: true, write: true, perm: ['ImagingStudy', 'update'], testid: 'take-over', onClick: async () => { if (!await confirmDialog({ title: 'Take over this study?', message: `${lockedByOther.by} will lose the reading lock.`, confirmLabel: 'Take over', testid: 'take-over-confirm' })) return; lock = (await api.post(`/api/pacs/studies/${id}/open`, { force: true })).lock; lockedByOther = null; drawReport(); } })));
    const signed = rep && rep.status !== 'preliminary';
    if (!signed) {
      const editable = canWrite();
      report.append(cards);
      if (rep && ext(rep, 'urn:hospital-desktop:ai-drafted')) report.append(h('div', { class: 'banner warn', testid: 'ai-draft-banner' }, h('strong', {}, 'AI-drafted — not signed'), 'This draft was written by an agent. Check every section before you sign.'));
      // ----- Reporting workspace (plan-master task 3C): header from the order, template with bracketed fields, macros, typed voice commands, critical finding, prior reports -----
      critical = Boolean((rep?.extension || []).find((e) => e.url === CRITICAL_URL)?.valueBoolean);
      try { told = rep ? JSON.parse(ext(rep, CRITICAL_TOLD_URL) || 'null') : null; } catch { told = null; }
      let lastFocus = null;
      const mk = (name, label, value) => { const f = field({ name, label, type: 'textarea', rows: 4, value, testid: `report-${name}` }); f.input.disabled = !editable; f.input.addEventListener('input', () => { dirty = true; savedAt.textContent = 'Unsaved changes'; drawFields(); }); f.input.addEventListener('focus', () => { lastFocus = name; }); f.input.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) { if (jumpField(name, e.shiftKey)) e.preventDefault(); } }); return f; };
      sections.technique = mk('technique', 'Technique', rep ? ext(rep, T_URL) || '' : '');
      sections.findings = mk('findings', 'Findings', rep ? ext(rep, F_URL) || '' : '');
      sections.impression = mk('impression', 'Impression', rep?.conclusion || '');
      const ORDER = ['technique', 'findings', 'impression'];
      // One Dictate button for the whole report: what is said goes into the box the reader last clicked (Findings to begin with).
      let dictInto = null;
      for (const n of ORDER) sections[n].input.addEventListener('focus', () => { dictInto = sections[n].input; });
      const dictateOne = editable ? dictationButton(() => dictInto || sections.findings.input, 'report') : null;
      if (dictateOne) dictateOne.querySelector('button').title = 'Dictate into the box you last clicked: click Technique, Findings or Impression to move';
      const current = () => sections[lastFocus] || sections.findings;
      const fieldsNote = h('span', { class: 'muted small', testid: 'report-unfilled' });
      const drawFields = () => { const open = unfilled({ technique: sections.technique.get(), findings: sections.findings.get(), impression: sections.impression.get() }); fieldsNote.textContent = open.length ? `${open.length} field${open.length === 1 ? '' : 's'} to fill` : 'All fields filled'; };
      // Selects the next (or previous) [bracketed field], moving on to the next section when a section has none left. Returns false when there is none anywhere.
      function jumpField(from, backwards = false) {
        const start = ORDER.indexOf(from);
        for (let k = 0; k < ORDER.length; k += 1) {
          const name = ORDER[(start + (backwards ? -k : k) + ORDER.length) % ORDER.length];
          const input = sections[name].input;
          const caret = k === 0 ? (backwards ? input.selectionStart : input.selectionEnd) : (backwards ? input.value.length : 0);
          const f = fieldAfter(input.value, caret, { backwards });
          if (!f || (k === 0 && !backwards && f.start < caret && fieldAfter(input.value, 0) && f.start === fieldAfter(input.value, 0).start && input.value.slice(caret).search(/\[/) < 0 && ORDER.length > 1 && k === 0 && false)) continue;
          input.focus(); input.setSelectionRange(f.start, f.end); lastFocus = name; return true;
        }
        return false;
      }
      const insertText = (text) => { const f = current(); const input = f.input; const a = input.selectionStart ?? input.value.length; const b = input.selectionEnd ?? a; input.value = `${input.value.slice(0, a)}${text}${input.value.slice(b)}`; input.setSelectionRange(a + text.length, a + text.length); input.focus(); dirty = true; savedAt.textContent = 'Unsaved changes'; drawFields(); };
      // Template per exam.
      const fitting = templateFor({ description: study.description, modality: study.modality });
      const templateSelect = h('select', { testid: 'report-template', 'aria-label': 'Report template', disabled: !editable, style: 'width:auto' }, h('option', { value: '' }, 'No template'), ...TEMPLATES.map((t) => h('option', { value: t.id, selected: t.id === fitting?.id }, t.label)));
      const applyTemplate = async () => {
        const t = TEMPLATES.find((x) => x.id === templateSelect.value); if (!t) return;
        const filled = ORDER.filter((n) => sections[n].get().trim());
        if (filled.length && !(await confirmDialog({ title: 'Replace the report text?', message: `The ${t.label} template replaces what is in ${filled.join(', ')}.`, confirmLabel: 'Replace', testid: 'template-replace' }))) return;
        sections.technique.set(t.technique); sections.findings.set(t.findings); sections.impression.set(t.impression);
        dirty = true; savedAt.textContent = 'Unsaved changes'; drawFields(); jumpField('technique'); record('template', study, { template: t.id });
      };
      // Macros.
      const macroList = h('datalist', { id: 'macro-names' });
      const drawMacros = () => clear(macroList).append(...allMacros().map((m) => h('option', { value: m.name })));
      drawMacros();
      const macroInput = h('input', { type: 'text', list: 'macro-names', placeholder: 'Macro short name', testid: 'report-macro', 'aria-label': 'Macro short name', disabled: !editable, style: 'width:11.25rem' });
      const insertMacro = (name) => { const m = findMacro(allMacros(), name); if (!m) { toast(`No macro called "${name}"`, { error: true }); return false; } insertText(m.text); record('macro', study, { macro: slug(m.name) }); return true; };
      const addMacro = () => formDialog({ title: 'New macro', testid: 'macro-form', submitLabel: 'Save macro', intro: 'Macros are yours (kept in this browser). Insert one by its short name, or say "insert <name>".', fields: [{ name: 'name', label: 'Short name', required: true, testid: 'macro-name' }, { name: 'text', label: 'Text', type: 'textarea', rows: 4, required: true, testid: 'macro-text', wide: true }], onSubmit: async (v) => { const mine = userMacros().filter((m) => m.name.toLowerCase() !== v.name.trim().toLowerCase()); mine.push({ name: v.name.trim(), text: v.text.trim() }); try { localStorage.setItem(macroKey(), JSON.stringify(mine)); } catch { /* ignore */ } drawMacros(); undefined; } });
      // Typed or spoken commands.
      const runCommand = async (text) => {
        const cmd = parseCommand(text);
        if (!cmd) { toast('Not a command. Say "help" for the list.', { error: true }); return; }
        record('command', study, { command: cmd.kind });
        if (cmd.kind === 'next') { if (!jumpField(lastFocus || 'technique')) toast('No fields left to fill'); }
        else if (cmd.kind === 'previous') { if (!jumpField(lastFocus || 'technique', true)) toast('No fields left to fill'); }
        else if (cmd.kind === 'insert') insertMacro(cmd.arg);
        else if (cmd.kind === 'delete-sentence') { const f = current(); f.set(deleteLastSentence(f.get())); dirty = true; savedAt.textContent = 'Unsaved changes'; drawFields(); }
        else if (cmd.kind === 'save') await saveDraft();
        else if (cmd.kind === 'sign') await signReport();
      };
      const commandInput = h('input', { type: 'text', placeholder: 'Type a command: next field, insert <macro>, sign report…', testid: 'report-command', 'aria-label': 'Voice command (typed or dictated)', disabled: !editable, onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = commandInput.value.trim(); commandInput.value = ''; if (/^help$/i.test(v)) { helpPanel.open = true; return; } runCommand(v).catch(showError); } } });
      commandInput.addEventListener('focus', () => { dictInto = commandInput; }); // the one Dictate button also speaks commands when the command box was clicked last
      const helpPanel = h('details', { class: 'small', testid: 'report-help' }, h('summary', { 'aria-label': 'Voice command help' }, 'Voice commands'), h('ul', { style: 'margin:0.375rem 0 0;padding-left:1.125rem' }, ...COMMANDS.map(([c, d]) => h('li', {}, h('code', {}, c), ` — ${d}`))), h('p', { class: 'muted small', style: 'margin:0.375rem 0 0' }, 'Say them into the command box with Dictate, or type them. Dictation uses the browser\'s speech service; synthetic cases only.'));
      // Critical finding: who was told, how and when, before signing.
      const toldEl = h('div', { testid: 'critical-told' });
      const drawTold = () => { clear(toldEl); if (!critical) return; toldEl.append(told ? h('span', { class: 'small', testid: 'critical-told-summary' }, `Told ${told.to} by ${told.how} at ${fmtDateTime(told.at)}${told.readBack ? ' (read back)' : ''}. `) : h('span', { class: 'small', style: 'color:var(--danger-text)' }, 'Document who was told before signing. '), btn(told ? 'Change' : 'Document who was told', { small: true, testid: 'critical-document', disabled: !editable, onClick: () => formDialog({ title: 'Critical finding communicated', testid: 'critical-form', submitLabel: 'Record', fields: [{ name: 'to', label: 'Told to (name and role)', required: true, testid: 'critical-to' }, { name: 'how', label: 'How', type: 'select', options: [['phone', 'Phone'], ['in person', 'In person'], ['secure message', 'Secure message']], testid: 'critical-how' }, { name: 'readBack', label: 'Read back by the recipient', type: 'checkbox', value: true, testid: 'critical-readback' }], onSubmit: async (v) => { told = { to: v.to, how: v.how, at: new Date().toISOString(), by: me(), readBack: Boolean(v.readBack) }; dirty = true; savedAt.textContent = 'Unsaved changes'; drawTold(); record('critical', study, { documented: 1 }); } }) })); };
      const criticalBox = h('input', { type: 'checkbox', testid: 'report-critical', 'aria-label': 'Critical finding', checked: critical, disabled: !editable, onChange: (e) => { critical = e.target.checked; dirty = true; drawTold(); } });
      drawTold();
      // Prior reports for this patient.
      const priorsPanel = h('details', { class: 'small', testid: 'prior-reports' }, h('summary', { 'aria-label': 'Prior reports' }, `Prior reports (${detail.history.filter((r) => r.status === 'read').length})`), h('div', { testid: 'prior-reports-list' }, detail.history.filter((r) => r.status === 'read').length ? detail.history.filter((r) => r.status === 'read').slice(0, 8).map((r) => h('p', { style: 'margin:0.25rem 0' }, `${fmtDate(r.started)} · ${r.description} · `, h('a', { href: `#/study/${r.id}`, testid: `prior-open-${r.id}`, 'aria-label': `Open prior study ${r.description}` }, 'Open prior study'))) : h('p', { class: 'muted', style: 'margin:0.25rem 0' }, 'No signed prior reports.')));
      async function signReport() {
        const open = unfilled({ technique: sections.technique.get(), findings: sections.findings.get(), impression: sections.impression.get() });
        if (open.length) { jumpField(open[0].section === 'technique' ? 'impression' : ORDER[ORDER.indexOf(open[0].section) - 1] || 'impression'); throw new Error(`Fill or remove the template fields before signing: ${open.slice(0, 3).map((f) => f.field).join(', ')}`); }
        const missing = Object.entries(sections).filter(([, f]) => !f.get().trim()).map(([k]) => k);
        if (missing.length) throw new Error(`Required before signing: ${missing.join(', ')}`);
        if (critical && !told) throw new Error('Document who was told about the critical finding, how and when, before signing');
        if (usedDraft) {
          // Signing a report started from the AI draft: the edit is logged and the proposal closes with the radiologist's text.
          if (!await confirmDialog({ title: 'Sign final report', message: 'You are signing a report that started from an AI draft, as your own. Changes after signing are made as an addendum.', confirmLabel: 'Sign report', testid: 'sign-report' })) return;
          const content = { technique: sections.technique.get(), findings: sections.findings.get(), impression: sections.impression.get() };
          const size = ['technique', 'findings', 'impression'].reduce((a, k) => a + editSize(usedDraft.content[k] || '', content[k]), 0);
          if (size) await draftEvent(usedDraft.id, 'edited', { editSize: size, branch: view.branch });
          await decideDraft(usedDraft, 'edit', { content });
          usedDraft = null; dirty = false;
          const d = await api.get(`/api/pacs/studies/${id}`); rep = d.report; addenda = d.addenda; toast('Report signed. The referring clinician has been notified.'); record('sign-report', study); drawReport(); await loadCards();
          return;
        }
        await saveDraft({ silent: true });
        if (!await confirmDialog({ title: 'Sign final report', message: `Signing locks this report. Changes after signing are made as an addendum. The referring clinician is notified${critical ? ' with a STAT critical alert' : ''}.`, confirmLabel: 'Sign report', testid: 'sign-report' })) return;
        rep = await fhir.transition(rep, 'final'); toast('Report signed. The referring clinician has been notified.'); record('sign-report', study); drawReport();
      }
      report.append(
        kv([['Patient', `${study.patient?.name || ''} · ${study.patient?.mrn || ''}`], ['Exam', study.description], ['Accession', h('span', { class: 'mono' }, study.accession || '—')], ['Indication', study.reason || 'Not given'], ['Comparison', prior ? `${prior.description} · ${fmtDate(prior.started)}` : 'None']]),
        h('div', { class: 'toolbar', style: 'margin:0.625rem 0 0.375rem' }, templateSelect, btn('Apply template', { small: true, testid: 'report-template-apply', disabled: !editable, onClick: () => applyTemplate().catch(showError) }), dictateOne, btn('Next field', { small: true, testid: 'report-next-field', title: 'Tab also moves to the next field', disabled: !editable, onClick: () => { if (!jumpField(lastFocus || 'technique')) toast('No fields left to fill'); } }), fieldsNote),
        sections.technique.el, sections.findings.el, sections.impression.el,
        h('div', { class: 'toolbar', style: 'margin:0.375rem 0' }, macroInput, macroList, btn('Insert macro', { small: true, testid: 'report-macro-insert', disabled: !editable, onClick: () => { if (insertMacro(macroInput.value)) macroInput.value = ''; } }), btn('New macro', { small: true, testid: 'report-macro-new', disabled: !editable, onClick: addMacro }), h('span', { class: 'muted small' }, 'Starter macros: unverified')),
        h('div', { class: 'toolbar', style: 'margin:0.375rem 0' }, commandInput, btn('Run', { small: true, testid: 'report-command-run', disabled: !editable, onClick: () => { const v = commandInput.value.trim(); commandInput.value = ''; if (/^help$/i.test(v)) { helpPanel.open = true; return; } runCommand(v).catch(showError); } })),
        helpPanel,
        h('label', { style: 'display:flex;gap:0.5rem;align-items:center;margin:0.5rem 0' }, criticalBox, h('strong', {}, 'Critical finding')), toldEl, priorsPanel,
        h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, btn('Save draft', { testid: 'report-save', write: true, perm: ['DiagnosticReport', 'create'], disabled: !editable, onClick: () => saveDraft() }),
          btn('Sign final', { kind: 'primary', testid: 'report-sign', write: true, perm: ['DiagnosticReport', 'sign'], disabled: !editable, onClick: () => signReport().catch(showError) }), savedAt),
        h('p', { class: 'muted small' }, 'Drafts save automatically every 30 seconds. A Report Drafter proposal appears above the fields as an AI draft; it is never signed without you.'));
      drawFields();
      return;
    }
    const released = flagged(rep, 'released');
    let toldRo = null; try { toldRo = JSON.parse(ext(rep, CRITICAL_TOLD_URL) || 'null'); } catch { toldRo = null; }
    report.append(h('div', { class: 'toolbar' }, badge(rep.status === 'final' ? 'Signed' : `Signed · ${rep.status}`, 'ok', 'report-status'), released ? badge('In Patient Portal', 'accent', 'report-released') : null, (rep.extension || []).find((e) => e.url === CRITICAL_URL)?.valueBoolean ? badge('Critical finding', 'solid-danger', 'report-critical-badge') : null),
      toldRo ? h('p', { class: 'small', testid: 'critical-told-ro' }, `Critical finding told to ${toldRo.to} by ${toldRo.how} at ${fmtDateTime(toldRo.at)}.`) : null,
      kv([['Signed by', rep.resultsInterpreter?.[0]?.display], ['Signed', fmtDateTime(rep.issued)]]),
      h('h3', { style: 'margin-top:0.75rem' }, 'Technique'), h('p', { class: 'ro', testid: 'ro-technique' }, ext(rep, T_URL)), h('h3', {}, 'Findings'), h('p', { class: 'ro', testid: 'ro-findings' }, ext(rep, F_URL)), h('h3', {}, 'Impression'), h('p', { class: 'ro', testid: 'ro-impression' }, rep.conclusion),
      ...addenda.map((a) => h('div', { class: 'banner info', testid: `addendum-${a.id}` }, h('strong', {}, `Addendum · ${a.status === 'preliminary' ? 'draft' : `signed by ${a.resultsInterpreter?.[0]?.display || ''} ${fmtDateTime(a.issued)}`}`), h('div', { class: 'note-body' }, ext(a, F_URL) || ''))),
      h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, btn(released ? 'Hide from the Patient Portal' : 'Release to the Patient Portal', { testid: 'report-release', write: true, onClick: async () => { rep = await fhir.release(rep, !released); toast(released ? 'Hidden from the Patient Portal' : 'Released to the Patient Portal'); drawReport(); } })));
    if (!view.readOnly) {
      const draftAddendum = addenda.find((a) => a.status === 'preliminary');
      const text = field({ name: 'addendum', label: 'Addendum', type: 'textarea', rows: 4, value: draftAddendum ? ext(draftAddendum, F_URL) || '' : '', dictate: true, testid: 'report-addendum' });
      const saveAddendum = async () => {
        if (!text.get()) throw new Error('Type the addendum text first');
        const doc = { ...(draftAddendum || { resourceType: 'DiagnosticReport', status: 'preliminary', subject: rep.subject, code: rep.code, imagingStudy: rep.imagingStudy }), extension: [{ url: F_URL, valueString: text.get() }, { url: A_URL, valueString: `DiagnosticReport/${rep.id}` }] };
        return draftAddendum ? fhir.update(doc) : fhir.create(doc);
      };
      const reload = async () => { const d = await api.get(`/api/pacs/studies/${id}`); rep = d.report; addenda = d.addenda; drawReport(); };
      report.append(h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:0.75rem 0' }), text.el, h('div', { class: 'toolbar' }, btn('Save addendum draft', { testid: 'addendum-save', write: true, perm: ['DiagnosticReport', 'create'], onClick: async () => { await saveAddendum(); undefined; await reload(); } }),
        btn('Sign addendum', { kind: 'primary', testid: 'addendum-sign', write: true, perm: ['DiagnosticReport', 'sign'], onClick: async () => { const saved = await saveAddendum(); if (!await confirmDialog({ title: 'Sign addendum', message: 'The addendum is appended to the signed report and the referring clinician is notified.', confirmLabel: 'Sign addendum', testid: 'sign-addendum' })) { await reload(); return; } await fhir.transition(saved, 'final'); toast('Addendum signed'); await reload(); } })));
    }
  }

  cleanup = () => {
    for (const paneId of [...shown.keys()]) dwell(paneId, null, null);
    document.removeEventListener('keydown', onKey); document.removeEventListener('keydown', onAnnotKey);
    clearInterval(autosave); cardTimers.forEach(clearTimeout); unsavedOff();
    viewports.forEach((v) => v.destroy());
    const signed = rep && rep.status !== 'preliminary';
    const finish = dirty && canWrite() && !signed ? saveDraft({ silent: true }).catch(() => {}) : Promise.resolve();
    if (lock?.by === me() && !signed && !view.readOnly) finish.then(() => api.post(`/api/pacs/studies/${id}/close`, {}).catch(() => {}));
  };
  clear(root).append(...[topbar('study'), timeStrip(), patientStrip(study.patient), h('div', { class: 'viewer', testid: 'viewer' }, toolbar, h('div', { class: 'vtabs', style: 'display:flex' }, pickerHost, layoutButtons, annot, h('span', { class: 'vstatus' }, status, timesEl)), volbarHost, panes, h('div', { class: 'wsfloat', testid: 'workstation-panels' }, measures.el, segmentation.el), report, rail), findingPanel({ log: (a, x) => record(a, study, x), onNext: () => { location.hash = '#/worklist'; } })].filter(Boolean));
  drawReport();
  loadCards().catch(() => {});
  await build();
}

// ---------- Upload ----------
async function upload() {
  const queue = [];
  const nifti = [];
  const list = h('div', { testid: 'upload-list' });
  const progress = h('div', { class: 'muted', testid: 'upload-progress', role: 'status' });
  // Attach-to-patient choice: by default the header PatientID must match an MRN; a chosen patient overrides it (logged on the server).
  const patients = (await fhir.search('Patient', { _count: 500 })).sort((a, b) => patientName(a).localeCompare(patientName(b)));
  const attach = field({ name: 'patient', label: 'Attach to patient', type: 'select', testid: 'upload-patient', options: [['', 'Match by Patient ID in the header'], ...patients.map((p) => [p.id, `${patientName(p)} · ${mrnOf(p)}`])] });
  async function add(files) {
    for (const file of files) {
      if (/\.nii(\.gz)?$/i.test(file.name)) { nifti.push(file); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const d = parse(bytes);
        queue.push({ file, bytes, studyUid: d.str('StudyInstanceUID'), seriesUid: d.str('SeriesInstanceUID'), sopUid: d.str('SOPInstanceUID'), patientId: d.str('PatientID'), patientName: d.str('PatientName').replace(/\^/g, ' '), modality: d.str('Modality'), description: d.str('StudyDescription'), date: d.str('StudyDate'), state: 'ready' });
      } catch (err) { queue.push({ file, state: 'invalid', reason: err.message }); }
    }
    draw();
  }
  async function walk(entry, out) {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) { const reader = entry.createReader(); for (;;) { const batch = await new Promise((res, rej) => reader.readEntries(res, rej)); if (!batch.length) break; for (const e of batch) await walk(e, out); } }
  }
  function draw() {
    const studies = [...new Set(queue.filter((q) => q.studyUid).map((q) => q.studyUid))].map((uid) => { const items = queue.filter((q) => q.studyUid === uid); return { id: uid, items, first: items[0] }; });
    const invalid = queue.filter((q) => q.state === 'invalid');
    const count = (items, st) => items.filter((i) => i.state === st).length;
    clear(list).append(...[
      table({ testid: 'upload-table', rows: studies, empty: 'No DICOM files chosen yet', columns: [
        { label: 'Patient ID', cls: 'mono', render: (s) => s.first.patientId }, { label: 'Patient name in file', render: (s) => s.first.patientName }, { label: 'Study', render: (s) => s.first.description }, { label: 'Date', render: (s) => s.first.date },
        { label: 'Mod', render: (s) => badge(s.first.modality, 'info') }, { label: 'Series', cls: 'num', render: (s) => new Set(s.items.map((i) => i.seriesUid)).size }, { label: 'Files', cls: 'num', render: (s) => s.items.length },
        { label: 'Result', render: (s) => [count(s.items, 'stored') ? badge(`${count(s.items, 'stored')} stored`, 'ok') : null, ' ', count(s.items, 'skipped') ? badge(`${count(s.items, 'skipped')} already archived`, 'info') : null, ' ', count(s.items, 'failed') ? badge(`${count(s.items, 'failed')} failed`, 'danger') : null, h('div', { class: 'small', style: 'color:var(--danger)' }, [...new Set(s.items.filter((i) => i.state === 'failed').map((i) => i.reason))].join('; '))] },
      ] }),
      invalid.length ? h('div', { class: 'banner warn', testid: 'upload-invalid' }, h('strong', {}, `${invalid.length} file(s) are not readable DICOM and will be skipped`), invalid.slice(0, 5).map((q) => h('div', {}, `${q.file.name}: ${q.reason}`))) : null,
      nifti.length ? (() => {
        const mrn = field({ name: 'mrn', label: 'Patient MRN', required: true, testid: 'nifti-mrn' });
        const modality = field({ name: 'modality', label: 'Modality', type: 'select', options: ['MR', 'CT'], testid: 'nifti-modality' });
        const description = field({ name: 'description', label: 'Description', value: nifti[0].name.replace(/\.nii(\.gz)?$/i, ''), testid: 'nifti-description' });
        return h('div', { class: 'card', testid: 'nifti-card', style: 'margin-top:0.75rem' }, h('h3', {}, `NIfTI volume: ${nifti.map((f) => f.name).join(', ')}`), h('p', { class: 'muted' }, 'NIfTI files carry no patient identity. Say which patient this volume belongs to. It is stored as a DICOM series; patient orientation is not derived from the NIfTI header.'),
          h('div', { class: 'form' }, mrn.el, modality.el, description.el), h('div', { class: 'toolbar', style: 'margin-top:0.625rem' }, btn('Import NIfTI', { kind: 'primary', write: true, testid: 'nifti-import', onClick: async () => {
            for (const file of nifti.splice(0)) {
              const q = new URLSearchParams({ mrn: mrn.get(), modality: modality.get(), description: description.get() });
              const r = await fetch(`/dicom-web/nifti?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Role': identity.role }, body: file });
              const out = await r.json();
              if (!r.ok) throw new Error(out.error || 'Import failed');
              toast(`Imported ${out.slices} slices from ${file.name}`);
            }
            draw();
          } })));
      })() : null].filter(Boolean));
  }
  async function send() {
    // Failed files can be sent again (for example after choosing a patient to attach them to).
    const ready = queue.filter((q) => q.state === 'ready' || q.state === 'failed');
    for (const q of ready) { q.state = 'ready'; delete q.reason; }
    const existing = new Set();
    for (const uid of new Set(ready.map((q) => q.studyUid))) {
      const found = await (await fetch(`/dicom-web/studies?StudyInstanceUID=${uid}`)).json();
      if (!found.length) continue;
      for (const i of await (await fetch(`/dicom-web/studies/${uid}/instances`)).json()) existing.add(i['00080018'].Value[0]);
    }
    let done = 0;
    const todo = ready.filter((q) => { if (existing.has(q.sopUid)) { q.state = 'skipped'; return false; } return true; });
    progress.textContent = `Uploading 0/${todo.length}`;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (next < todo.length) {
        const q = todo[next]; next += 1;
        const boundary = `hd${crypto.randomUUID()}`;
        const bodyBlob = new Blob([`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`, q.bytes, `\r\n--${boundary}--\r\n`]);
        try {
          const r = await fetch(`/dicom-web/studies${attach.get() ? `?patient=${encodeURIComponent(attach.get())}` : ''}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`, 'X-Role': identity.role, ...(identity.user ? { 'X-User-Id': identity.user } : {}) }, body: bodyBlob });
          const out = await r.json();
          if (out.summary?.stored) q.state = 'stored'; else if (out.summary?.duplicates) q.state = 'skipped'; else { q.state = 'failed'; q.reason = out.summary?.failed?.[0]?.reason || out.error || `HTTP ${r.status}`; }
        } catch (err) { q.state = 'failed'; q.reason = err.message; }
        done += 1;
        progress.textContent = `Uploading ${done}/${todo.length}`;
      }
    }));
    const n = (st) => queue.filter((q) => q.state === st).length;
    progress.textContent = `Done: ${n('stored')} stored, ${n('skipped')} already archived, ${n('failed')} failed.`;
    draw();
  }
  const drop = h('div', { class: 'drop', testid: 'drop-zone', tabindex: 0, role: 'button', 'aria-label': 'Drop DICOM or NIfTI files or folders here' }, h('p', {}, 'Drop DICOM files or folders here (.dcm), or NIfTI volumes (.nii, .nii.gz).'), h('p', { class: 'muted' }, 'Synthetic or public images only. Files are checked in the browser before upload. The PatientID in each file must match the MRN of a registered patient, unless you attach the upload to a chosen patient below.'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); const out = []; const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean); if (entries.length) for (const en of entries) await walk(en, out); else out.push(...e.dataTransfer.files); await add(out); });
  const files = h('input', { type: 'file', multiple: true, testid: 'file-input', 'aria-label': 'Choose files', style: 'width:auto', onChange: (e) => add([...e.target.files]) });
  const folder = h('input', { type: 'file', webkitdirectory: true, testid: 'folder-input', 'aria-label': 'Choose a folder', style: 'width:auto', onChange: (e) => add([...e.target.files]) });
  clear(root).append(...[topbar('upload'), timeStrip(), h('div', { class: 'scroll' }, h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, 'Upload studies')), drop,
    h('div', { class: 'toolbar', style: 'margin-top:0.75rem' }, h('span', { class: 'small muted' }, 'Files'), files, h('span', { class: 'small muted' }, 'Folder'), folder, attach.el, h('span', { class: 'grow' }), progress,
      btn('Clear', { testid: 'upload-clear', onClick: () => { queue.length = 0; nifti.length = 0; progress.textContent = ''; draw(); } }), btn('Upload', { kind: 'primary', write: true, perm: ['ImagingStudy', 'create'], testid: 'upload-start', onClick: async () => { if (!queue.some((q) => q.state === 'ready' || q.state === 'failed')) throw new Error('Choose DICOM files first'); await send(); } })), list))].filter(Boolean));
  draw();
}

// ---------- Router ----------
let token = 0;
async function render() {
  const mine = token += 1;
  cleanup(); cleanup = () => {};
  const [path, qs] = (location.hash.slice(2) || 'worklist').split('?');
  const [route, id] = path.split('/');
  try {
    if (route === 'study' && id) await studyView(id, new URLSearchParams(qs || ''));
    else if (route === 'upload') await upload();
    else await worklist();
  } catch (err) {
    if (mine !== token) return;
    clear(root).append(topbar(route), h('main', { class: 'content' }, h('div', { class: 'banner danger', testid: 'load-error' }, err.message), btn('Back to worklist', { testid: 'retry', onClick: () => go('#/worklist') })));
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('hd:role', render);
window.addEventListener('pagehide', () => cleanup());
view.onChange(render);
patientContext.onChange((pid, { remote }) => { if (remote && pid && !location.hash.startsWith('#/study')) { ui.patientFilter = pid; ui.queue = 'all'; ui.modality = 'All'; go('#/worklist'); } });
render();
