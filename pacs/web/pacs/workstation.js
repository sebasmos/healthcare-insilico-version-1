// Reading-workstation parts of the PACS viewer: the layout picker with
// hanging protocols, the measurements panel linked into the report, segmentation saved as DICOM SEG,
// measurements saved as DICOM SR, saved views as presentation states, and the shortcut help.
import { h, clear, btn, toast, showError, openDialog } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { LAYOUTS, canShow, SHORTCUTS } from '/pacs/hanging.js';
import { describeMeasurement } from '/pacs/measure.js';
import { createLabels, brush, threshold, regionGrow, segmentStats, planeOverlay, surfaceVoxels, renderSurface, colourOf } from '/pacs/segment.js';
import { writeSeg, readSeg, writeSr, writePresentationState, readPresentationState } from '/shared/dicom-objects.js';

const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const f1 = (v) => (v == null ? '' : (Math.round(v * 10) / 10).toFixed(1));

/** The layout picker: every layout, greyed out when this study cannot show it; the protocol that chose the first one is named. */
export function layoutPicker({ can, current, protocol, from, onPick }) {
  return h('div', { class: 'hang', role: 'group', 'aria-label': 'Layout picker', testid: 'layout-picker' },
    h('span', { class: 'muted small', testid: 'hang-protocol', title: from === 'saved' ? 'Your saved layout for this kind of study' : 'Chosen by the hanging protocol for this modality and body part' }, `${protocol?.name || 'Default'}${from === 'saved' ? ' (your choice)' : ''}`),
    ...LAYOUTS.map((l) => { const ok = canShow(l.id, can); return h('button', { type: 'button', class: 'small', testid: `hang-${l.id.replace('+', '-')}`, 'aria-label': `Layout ${l.label}: ${l.title}${ok ? '' : ' (not available for this study)'}`, title: ok ? l.title : `${l.title}: needs ${l.needs.join(' and ')}`, 'aria-pressed': String(current === l.id), disabled: !ok, onClick: () => onPick(l.id) }, l.label); }));
}

export function shortcutHelp() {
  openDialog({ title: 'Keyboard shortcuts', testid: 'shortcut-help', body: h('table', { class: 'keys' }, h('tbody', {}, ...SHORTCUTS.map(([key, what]) => h('tr', {}, h('td', {}, h('kbd', {}, key)), h('td', {}, what))))), actions: [{ label: 'Close', onClick: (c) => c() }] });
}

/** The image a measurement was drawn on, as a SOP instance UID, for either engine. */
export function sopUidOf(source, frame) {
  if (!source) return null;
  if (source.imageIds) { try { return new URL(source.imageIds[frame].replace(/^wadouri:/, '')).searchParams.get('objectUID'); } catch { return null; } }
  return source.frames?.[frame]?.file?.str('SOPInstanceUID') || null;
}
const refOf = (study, series, source) => {
  const frames = source?.frames || [];
  const first = frames[0]?.file;
  return { studyUid: study.studyUid, seriesUid: series.uid, sopClassUid: first?.str('SOPClassUID') || '1.2.840.10008.5.1.4.1.1.2', sopUids: source?.imageIds ? source.imageIds.map((_, i) => sopUidOf(source, i)) : frames.map((f) => f.file.str('SOPInstanceUID')),
    positions: frames.map((f) => { const p = f.file?.nums('ImagePositionPatient') || []; return p.length === 3 ? p : [0, 0, f.z ?? 0]; }), orientation: first?.nums('ImageOrientationPatient').length === 6 ? first.nums('ImageOrientationPatient') : [1, 0, 0, 0, 1, 0],
    spacing: [frames[0]?.info.rowSpacing || 1, frames[0]?.info.columnSpacing || 1], thickness: frames[0]?.thickness || 1, frameOfReferenceUid: first?.str('FrameOfReferenceUID') || undefined, patientName: first?.str('PatientName') || study.patient?.name, patientId: first?.str('PatientID') || study.patient?.mrn, studyDate: first?.str('StudyDate') || undefined };
};

/** Measurements in a list: what, where, the numbers; a name that can be edited; add to the report; go to; remove. */
export function measurementsPanel({ list, canEdit, onRename, onRemove, onInsert, onGoto, onSaveSr, onInsertAll }) {
  const el = h('section', { class: 'wspanel', testid: 'measure-panel', 'aria-label': 'Measurements', hidden: true });
  function draw() {
    const rows = list();
    clear(el).append(h('h3', {}, `Measurements (${rows.length})`),
      rows.length ? h('div', { class: 'wsrows' }, ...rows.map((m, i) => h('div', { class: 'wsrow', testid: `measure-row-${i}` },
        h('input', { type: 'text', value: m.label || '', placeholder: 'Name', maxlength: 80, disabled: !canEdit, testid: `measure-name-${i}`, 'aria-label': `Name of measurement ${i + 1}`, onChange: (e) => onRename(m, e.target.value.trim()).then(draw, showError) }),
        h('span', { class: 'small', testid: `measure-text-${i}` }, describeMeasurement({ ...m, label: null })),
        h('span', { class: 'wsacts' },
          btn('Go to', { small: true, testid: `measure-goto-${i}`, title: 'Show the image this was drawn on', onClick: () => onGoto(m) }),
          btn('Add to report', { small: true, testid: `measure-insert-${i}`, title: 'Add this measurement to the report findings', disabled: !canEdit, onClick: () => onInsert(describeMeasurement(m)) }),
          btn('Remove', { small: true, kind: 'danger', testid: `measure-remove-${i}`, disabled: !canEdit, onClick: () => onRemove(m).then(draw, showError) })))))
        : h('p', { class: 'muted small', testid: 'measure-empty' }, 'No measurements yet. Pick a measuring tool and draw on the image.'),
      h('div', { class: 'toolbar' }, btn('Add all to report', { small: true, testid: 'measure-insert-all', disabled: !canEdit || !rows.length, onClick: () => onInsertAll(rows.map((m) => describeMeasurement(m))) }), btn('Save as DICOM SR', { small: true, testid: 'measure-save-sr', title: 'Save the measurements as a DICOM structured report with the study', disabled: !canEdit || !rows.length, onClick: () => onSaveSr(rows).catch(showError) })));
  }
  return { el, draw, toggle(show) { el.hidden = show == null ? !el.hidden : !show; if (!el.hidden) draw(); return !el.hidden; } };
}

/** Builds and stores the SR for a list of measurements; each needs image points and the image it was drawn on. */
export async function saveMeasurementsSr({ study, series, source, rows }) {
  const measurements = rows.map((m) => ({ kind: m.kind, label: m.label, text: m.text, value: m.kind === 'bidirectional' ? null : m.value, longMm: m.kind === 'bidirectional' ? m.value : null, shortMm: m.shortMm ?? null, mean: m.mean ?? null, sd: m.sd ?? null, frame: null, points: (m.imagePoints || (m.space === 'image' ? m.points : [])).map((p) => [p[0], p[1]]), sopUid: sopUidOf(source, m.frame ?? 0) })).filter((m) => m.sopUid);
  if (!measurements.length) throw new Error('None of the measurements is on the series shown, so there is nothing to save');
  const out = writeSr({ measurements, ref: refOf(study, series, source) });
  return api.post(`/api/pacs/studies/${study.id}/objects`, { kind: 'sr', data: toBase64(out.bytes), label: `Measurements (${measurements.length})`, summary: { measurements: measurements.length } });
}

/** Saved views as DICOM presentation states: window, invert and zoom of the active pane. */
export function savedViews({ study, getActive, getSeries, getSource, canEdit, record }) {
  const select = h('select', { testid: 'view-select', 'aria-label': 'Saved views (presentation states)', style: 'width:auto' });
  let objects = [];
  async function refresh() { try { objects = (await api.get(`/api/pacs/studies/${study.id}/objects`)).objects.filter((o) => o.kind === 'pr'); } catch { objects = []; } clear(select).append(h('option', { value: '' }, objects.length ? `Saved views (${objects.length})` : 'No saved views'), ...objects.map((o) => h('option', { value: o.id }, o.label))); }
  select.addEventListener('change', async () => {
    const id = select.value; select.value = ''; const vp = getActive(); if (!id || !vp) return;
    try { const o = await api.get(`/api/pacs/studies/${study.id}/objects/${id}`); const st = readPresentationState(fromBase64(o.data)); vp.command('window', { center: st.center, width: st.width }); if (Boolean(vp.state.invert) !== st.invert) vp.command('invert'); if (st.zoom) vp.command('zoom', st.zoom); record?.('view-apply', study, { view: o.label.slice(0, 40) }); } catch (err) { showError(err); }
  });
  const save = btn('Save view', { testid: 'view-save', title: 'Save the window, invert and zoom of this pane as a DICOM presentation state', disabled: !canEdit, onClick: async () => {
    const vp = getActive(); const source = getSource();
    if (!vp?.state?.source || !source) { toast('Open an image pane first', { error: true }); return; }
    const info = source.frames?.[0]?.info; const st = vp.state;
    try {
      const out = writePresentationState({ state: { center: Math.round(st.center), width: Math.round(st.width), invert: Boolean(st.invert), zoom: Math.round(st.zoom * 100) / 100, area: { left: 0, top: 0, right: info?.columns || 512, bottom: info?.rows || 512 }, label: `W${Math.round(st.width)} L${Math.round(st.center)}` }, ref: refOf(study, getSeries(), source) });
      await api.post(`/api/pacs/studies/${study.id}/objects`, { kind: 'pr', data: toBase64(out.bytes), label: `W ${Math.round(st.width)} L ${Math.round(st.center)}${st.invert ? ' inverted' : ''} zoom ${Math.round(st.zoom * 100)}%` });
      await refresh(); toast('View saved with the study');
    } catch (err) { showError(err); }
  } });
  refresh();
  return { el: h('span', { class: 'seg' }, save, select), refresh };
}

/**
 * Segmentation on the canvas engine: a label volume over the axial stack, painted with a brush,
 * filled by threshold or grown from a click; shown on every plane and in a small 3D view; saved as DICOM SEG.
 */
export function createSegmentation({ study, getSeries, getSource, getViewports, getActive, canEdit, setTool, record }) {
  const st = { labels: null, dims: null, sourceKey: null, segments: [], active: 1, hidden: new Set(), radius: 6, low: 200, high: 3000, tolerance: 60, in3d: true, yaw: 0.6, pitch: 0.4, dirty: false };
  const el = h('section', { class: 'wspanel', testid: 'seg-panel', 'aria-label': 'Segmentation', hidden: true });
  const view3d = h('canvas', { width: 220, height: 220, testid: 'seg-3d', role: 'img', 'aria-label': 'Segments in 3D. Drag to turn.', class: 'seg3d' });
  const axial = () => { const s = getSource(); return s && !s.imageIds && s.kind === 'axial' ? s : null; };
  function ensure() {
    const s = axial();
    if (!s) return null;
    const info = s.frames[0].info; const key = `${getSeries().uid}:${s.count}`;
    if (st.sourceKey !== key) { st.labels = createLabels(info.columns, info.rows, s.count); st.dims = { columns: info.columns, rows: info.rows, slices: s.count }; st.sourceKey = key; st.segments = [{ number: 1, label: 'Segment 1', algorithm: 'MANUAL' }]; st.active = 1; st.hidden = new Set(); st.dirty = false; }
    return s;
  }
  const voxelOf = (s) => { const plane = st.dims.columns * st.dims.rows; let z = -1; let px = null; return (i) => { const k = Math.floor(i / plane); if (k !== z) { z = k; px = s.frame(k).pixels; } return px[i - k * plane]; }; };
  const scaleOf = (s) => { const info = s.frames[0].info; return { slope: info.slope ?? 1, intercept: info.intercept ?? 0 }; };
  const redraw = () => { getViewports().forEach((v) => v.render?.()); draw3d(); };
  const mark = (name) => { const sg = st.segments.find((x) => x.number === st.active); if (sg && name !== 'brush') { sg.algorithm = 'SEMIAUTOMATIC'; sg.algorithmName = name; } st.dirty = true; };
  function draw3d() {
    const ctx = view3d.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, view3d.width, view3d.height);
    if (!st.labels) return;
    const s = axial(); const info = s?.frames[0].info;
    const img = renderSurface(surfaceVoxels(st.labels, st.dims, { hidden: st.hidden }), st.dims, { yaw: st.yaw, pitch: st.pitch, size: view3d.width, scale: [info?.columnSpacing || 1, info?.rowSpacing || 1, s?.frames[0].thickness || 1] });
    if (img.drawn) ctx.putImageData(new ImageData(img.rgba, img.size, img.size), 0, 0);
    view3d.dataset.drawn = String(img.drawn);
  }
  let turning = null;
  view3d.addEventListener('pointerdown', (e) => { turning = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch }; view3d.setPointerCapture(e.pointerId); });
  view3d.addEventListener('pointermove', (e) => { if (!turning) return; st.yaw = turning.yaw + (e.clientX - turning.x) / 80; st.pitch = Math.max(-1.5, Math.min(1.5, turning.pitch + (e.clientY - turning.y) / 80)); draw3d(); });
  view3d.addEventListener('pointerup', () => { turning = null; });

  /** The pane tells where the pointer is; only the axial stack is painted on, every plane shows the result. */
  function onPointer(evt) {
    if (evt.phase === 'up') { draw(); return; }
    const s = ensure();
    if (!s || evt.source !== s) { if (evt.phase === 'down') toast('Paint and click on the axial images. The other planes show the result.', { error: true }); return; }
    if (evt.mode === 'seg-brush' || evt.mode === 'seg-erase') { brush(st.labels, st.dims, evt.index, evt.x, evt.y, st.radius, evt.mode === 'seg-erase' ? 0 : st.active, evt.mode === 'seg-erase' ? { only: st.active } : {}); mark('brush'); }
    else if (evt.mode === 'seg-grow' && evt.phase === 'down') {
      const out = regionGrow(st.labels, st.dims, voxelOf(s), [evt.x, evt.y, evt.index], { tolerance: st.tolerance, in3d: st.in3d, ...scaleOf(s) }, st.active);
      mark('region growing'); record?.('seg-grow', study, { voxels: out.changed, tolerance: st.tolerance, in3d: st.in3d });
      toast(out.capped ? `Stopped at ${out.changed} voxels: the region is too large. Lower the tolerance.` : `${out.changed} voxels added from a value of ${Math.round(out.seedValue)}`, { error: out.capped });
      draw();
    }
    redraw();
  }
  const overlayFor = (source, index) => { if (!st.labels || !['axial', 'coronal', 'sagittal'].includes(source.kind) || source.imageIds || source.preview) return null; const d = st.dims; const fits = source.kind === 'axial' ? source.count === d.slices : true; return fits ? planeOverlay(st.labels, d, source.kind, index, { hidden: st.hidden }) : null; };

  async function save() {
    const s = ensure(); if (!s) throw new Error('Open a series in the 1 x 1 layout first');
    const used = new Set(segmentStats(st.labels).map((x) => x.number));
    const segments = st.segments.filter((x) => used.has(x.number));
    const out = writeSeg({ labels: st.labels, ...st.dims, segments, ref: refOf(study, getSeries(), s) });
    const stats = segmentStats(st.labels, { spacing: [s.frames[0].info.rowSpacing || 1, s.frames[0].info.columnSpacing || 1], thickness: s.frames[0].thickness || 1 });
    const saved = await api.post(`/api/pacs/studies/${study.id}/objects`, { kind: 'seg', data: toBase64(out.bytes), label: segments.map((x) => x.label).join(', ').slice(0, 80), summary: { segments: segments.length, frames: out.frames, voxels: stats.reduce((n, x) => n + x.voxels, 0) } });
    st.dirty = false; record?.('seg-save', study, { segments: segments.length, frames: out.frames });
    toast(`Segmentation saved as DICOM SEG (${out.frames} frames)`);
    return saved;
  }
  async function load(id) {
    const s = ensure(); if (!s) throw new Error('Open the series the segmentation was made on, in the 1 x 1 layout');
    const o = await api.get(`/api/pacs/studies/${study.id}/objects/${id}`);
    const ref = refOf(study, getSeries(), s);
    const back = readSeg(fromBase64(o.data), { sopUids: ref.sopUids, positions: ref.positions });
    if (back.columns !== st.dims.columns || back.rows !== st.dims.rows) throw new Error('This segmentation was made on images of another size');
    st.labels.fill(0); st.labels.set(back.labels.subarray(0, st.labels.length));
    st.segments = back.segments.length ? back.segments : st.segments; st.active = st.segments[0].number; st.hidden = new Set(); st.dirty = false;
    redraw(); draw();
  }

  let saved = [];
  async function refreshSaved() { try { saved = (await api.get(`/api/pacs/studies/${study.id}/objects`)).objects.filter((o) => o.kind === 'seg'); } catch { saved = []; } }
  function draw() {
    const s = ensure();
    if (!s) { clear(el).append(h('h3', {}, 'Segmentation'), h('p', { class: 'muted small', testid: 'seg-unavailable' }, 'Segmentation works on an uncompressed series shown as a stack. Choose the 1 x 1 or 1 x 2 layout, or the "3D: axial, coronal, sagittal" layout.')); return; }
    const info = s.frames[0].info;
    const stats = new Map(segmentStats(st.labels, { spacing: [info.rowSpacing || 1, info.columnSpacing || 1], thickness: s.frames[0].thickness || 1 }).map((x) => [x.number, x]));
    const num = (testid, label, value, on, attrs = {}) => h('label', { class: 'small' }, `${label} `, h('input', { type: 'number', value: String(value), testid, 'aria-label': label, style: 'width:5.25rem', ...attrs, onChange: (e) => { on(Number(e.target.value)); } }));
    const tool = (id, label, title) => btn(label, { small: true, testid: `seg-tool-${id}`, title, disabled: !canEdit, onClick: () => setTool(`seg-${id}`) });
    clear(el).append(h('h3', {}, 'Segmentation'),
      h('div', { class: 'wsrows' }, ...st.segments.map((sg) => { const [r, g, b] = colourOf(sg.number); const x = stats.get(sg.number); return h('div', { class: `wsrow${sg.number === st.active ? ' on' : ''}`, testid: `seg-row-${sg.number}` },
        h('button', { type: 'button', class: 'swatch', style: `background:rgb(${r},${g},${b})`, testid: `seg-pick-${sg.number}`, 'aria-label': `Paint with ${sg.label}`, 'aria-pressed': String(sg.number === st.active), onClick: () => { st.active = sg.number; draw(); } }),
        h('input', { type: 'text', value: sg.label, maxlength: 64, testid: `seg-name-${sg.number}`, 'aria-label': `Name of segment ${sg.number}`, onChange: (e) => { sg.label = e.target.value.trim() || `Segment ${sg.number}`; st.dirty = true; } }),
        h('span', { class: 'small', testid: `seg-stats-${sg.number}` }, x ? `${x.voxels} voxels${x.volumeMm3 != null ? ` · ${f1(x.volumeMm3 / 1000)} ml` : ''}` : 'empty'),
        h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: !st.hidden.has(sg.number), testid: `seg-show-${sg.number}`, 'aria-label': `Show ${sg.label}`, style: 'width:auto;height:auto', onChange: (e) => { if (e.target.checked) st.hidden.delete(sg.number); else st.hidden.add(sg.number); redraw(); } }), ' show')); })),
      h('div', { class: 'toolbar' }, btn('+ Segment', { small: true, testid: 'seg-add', disabled: !canEdit, onClick: () => { const n = Math.max(0, ...st.segments.map((x) => x.number)) + 1; st.segments.push({ number: n, label: `Segment ${n}`, algorithm: 'MANUAL' }); st.active = n; draw(); } }),
        tool('brush', 'Brush', 'Paint the active segment on the axial image'), tool('erase', 'Eraser', 'Erase the active segment'), tool('grow', 'Grow from a click', 'Click inside a structure: the segment spreads through connected voxels of similar value'),
        num('seg-radius', 'Brush radius (pixels)', st.radius, (v) => { st.radius = Math.max(1, Math.min(60, v || 6)); }, { min: 1, max: 60 })),
      h('div', { class: 'toolbar' }, num('seg-tolerance', 'Grow tolerance', st.tolerance, (v) => { st.tolerance = Math.max(0, v || 0); }, { min: 0 }),
        h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: st.in3d, testid: 'seg-grow-3d', 'aria-label': 'Grow through neighbouring slices', style: 'width:auto;height:auto', onChange: (e) => { st.in3d = e.target.checked; } }), ' through slices')),
      h('div', { class: 'toolbar' }, num('seg-low', 'Threshold from', st.low, (v) => { st.low = v; }), num('seg-high', 'to', st.high, (v) => { st.high = v; }),
        btn('Fill this image', { small: true, testid: 'seg-threshold-slice', disabled: !canEdit, onClick: () => { const vp = getActive(); const z = vp?.state?.source === s ? vp.state.index : Math.floor(s.count / 2); const n = threshold(st.labels, st.dims, voxelOf(s), { low: st.low, high: st.high, slice: z, ...scaleOf(s) }, st.active); mark('threshold'); record?.('seg-threshold', study, { voxels: n, low: st.low, high: st.high, slice: z }); redraw(); draw(); } }),
        btn('Fill whole series', { small: true, testid: 'seg-threshold-all', disabled: !canEdit, onClick: () => { const n = threshold(st.labels, st.dims, voxelOf(s), { low: st.low, high: st.high, ...scaleOf(s) }, st.active); mark('threshold'); record?.('seg-threshold', study, { voxels: n, low: st.low, high: st.high }); redraw(); draw(); } })),
      h('div', { class: 'seg3dwrap' }, view3d, h('span', { class: 'muted small' }, 'Segments in 3D. Drag to turn.')),
      h('div', { class: 'toolbar' }, btn('Clear segment', { small: true, testid: 'seg-clear', disabled: !canEdit, onClick: () => { for (let i = 0; i < st.labels.length; i += 1) if (st.labels[i] === st.active) st.labels[i] = 0; st.dirty = true; redraw(); draw(); } }),
        btn('Save as DICOM SEG', { small: true, kind: 'primary', testid: 'seg-save', disabled: !canEdit, onClick: () => save().then(refreshSaved).then(draw).catch(showError) }),
        saved.length ? h('select', { testid: 'seg-load', 'aria-label': 'Load a saved segmentation', style: 'width:auto', onChange: (e) => { const id = e.target.value; e.target.value = ''; if (id) load(id).catch(showError); } }, h('option', { value: '' }, `Load saved (${saved.length})`), ...saved.map((o) => h('option', { value: o.id }, `${o.label} · ${String(o.createdAt).slice(0, 16).replace('T', ' ')}`))) : null));
    draw3d();
  }
  return { el, draw, overlayFor, onPointer, save, load, state: st, toggle(show) { el.hidden = show == null ? !el.hidden : !show; if (!el.hidden) refreshSaved().then(draw); return !el.hidden; } };
}
