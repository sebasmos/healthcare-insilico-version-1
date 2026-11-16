// The analysis panel of the pathology viewer: display controls and the
// stain view, classes, editing the selected shapes, tissue and cell detection, the object and pixel
// classifiers, measurements with a table to export, named workflows and batch runs.
// The image maths runs on this server (pathology/server/pathology-analysis.mjs) or, for the stain view,
// in the page with the same library (pathology/web/shared/slide-analysis.js).
import { h, clear, btn, toast, showError } from '/shared/ui.js';
import { api } from '/shared/fhir.js';
import { deconvolve, stainImage, STAINS, toCsv } from '/shared/slide-analysis.js';
import { classColour, outlineOf, fmtArea } from '/pathology/viewer.js';

const download = (name, text, type = 'text/csv') => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
export const DEFAULT_CLASSES = ['Tumour', 'Stroma', 'Immune cells', 'Necrosis', 'Normal', 'Background'];

export function createAnalysisPanel({ getActive, getPanes, getCase, record, persist, canEdit, setTool, removeSaved, replaceSaved }) {
  const st = { stains: 'HE', stainChannel: -1, display: { brightness: 100, contrast: 100, r: true, g: true, b: true }, selected: [], cells: null, examples: new Map(), cellClass: 'Tumour', classifierName: 'Cells', pixelName: 'Tissue classes', background: 'Background', measure: null, classifiers: [], workflows: [], job: null, last: {} };
  const el = h('aside', { class: 'anpanel', testid: 'analysis-panel', 'aria-label': 'Analysis', hidden: true });
  const slideId = () => getActive()?.state.info?.id || null;
  const need = () => { const id = slideId(); if (!id) { toast('Open a slide first', { error: true }); throw new Error('no slide'); } return id; };
  const busy = async (button, label, fn) => { const was = button.textContent; button.disabled = true; button.textContent = label; try { await fn(); } catch (err) { if (err.message !== 'no slide') showError(err); } finally { button.disabled = false; button.textContent = was; } };
  // A section stays open or closed as the reader left it when the panel is drawn again.
  const opened = {};
  const section = (title, testid, open, ...kids) => h('details', { class: 'ansec', testid, open: (opened[testid] ?? open) || undefined, onToggle: (e) => { opened[testid] = e.target.open; } }, h('summary', { testid: `${testid}-open`, 'aria-label': title }, title), ...kids);
  const num = (testid, label, value, on, attrs = {}) => h('label', { class: 'small' }, `${label} `, h('input', { type: 'number', value: String(value), testid, 'aria-label': label, style: 'width:5.625rem', ...attrs, onChange: (e) => on(Number(e.target.value)) }));

  // ---------- display and the stain view ----------
  function applyDisplay() { for (const p of getPanes()) p.command('display', st.display); }
  function drawStain() {
    const pane = getActive(); if (!pane) return;
    const c = pane.stainCanvas;
    if (st.stainChannel < 0) { c.hidden = true; return; }
    const shot = pane.snapshot();
    if (!shot) { toast('The stain view could not read the picture on screen', { error: true }); return; }
    const n = shot.width * shot.height; const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i += 1) { rgb[i * 3] = shot.data[i * 4]; rgb[i * 3 + 1] = shot.data[i * 4 + 1]; rgb[i * 3 + 2] = shot.data[i * 4 + 2]; }
    const amounts = deconvolve(rgb, st.stains);
    c.width = shot.width; c.height = shot.height; c.getContext('2d').putImageData(new ImageData(stainImage(amounts[st.stainChannel], st.stains, st.stainChannel), shot.width, shot.height), 0, 0);
    c.hidden = false; c.dataset.stain = STAINS[st.stains].channels[st.stainChannel];
    record('stain-view', null, { stains: st.stains, channel: STAINS[st.stains].channels[st.stainChannel] });
  }

  // ---------- selection: class, remove, merge, split ----------
  const shapeIds = () => st.selected.map((a) => a.id).filter(Boolean);
  async function setClass(name) {
    const pane = getActive();
    for (const a of st.selected) { if (!a.id) continue; const saved = await api.put(`/api/pathology/slides/${need()}/annotations/${a.id}`, { class: name || null, colour: name ? classColour(name) : null }); Object.assign(a, { class: saved.class, label: saved.label, colour: saved.colour }); pane.replace(a); replaceSaved(saved); }
    record('annotation-class', null, { count: st.selected.length }); draw();
  }
  async function removeSelected() { const pane = getActive(); for (const a of st.selected) { if (!a.id) continue; await api.del(`/api/pathology/slides/${need()}/annotations/${a.id}`); pane.command('remove', a.id); removeSaved(a.id); } st.selected = []; draw(); }
  async function afterGeometry(out) { const pane = getActive(); for (const id of out.removed) { pane.command('remove', id); removeSaved(id); } for (const a of out.annotations) { pane.restore({ ...a, areaUm2: a.value, closed: true }); replaceSaved(a, true); } st.selected = []; pane.command('select', null); draw(); }
  async function merge() { const ids = shapeIds(); if (ids.length < 2) { toast('Select two or more shapes first (hold Shift to add to the selection)', { error: true }); return; } await afterGeometry(await api.post(`/api/pathology/slides/${need()}/annotations/merge`, { ids })); toast('Shapes merged'); record('annotation-merge', null, { count: ids.length }); }

  // ---------- analysis runs ----------
  const regionForCells = () => { const sel = st.selected.find((a) => outlineOf(a)); if (sel) { const o = outlineOf(sel); const xs = o.map((p) => p[0]); const ys = o.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), from: 'the selected shape' }; } return { ...getActive().bounds(), from: 'the part of the slide on screen' }; };
  async function detectTissue() {
    const id = need(); const out = await api.post(`/api/pathology/slides/${id}/analyses`, { kind: 'tissue' });
    // Tissue outlines become ordinary annotations of class "Tissue", so they can be edited like any other shape.
    const pane = getActive();
    for (const pg of out.polygons.slice(0, 20)) await persist(pane, { kind: 'polygon', points: pg.points, areaUm2: pg.areaUm2, class: 'Tissue', label: 'Tissue', colour: classColour('Tissue'), closed: true }, { method: out.method, params: out.params, analysis: out.id }, true);
    st.last.tissue = out.summary; toast(`Tissue found: ${out.polygons.length} piece${out.polygons.length === 1 ? '' : 's'}, ${Math.round(out.summary.tissueFraction * 100)}% of the slide`); draw();
  }
  function showCells(a) { st.cells = a; st.examples = new Map(); getActive().command('overlay', { cells: a.cells }); }
  async function detectCells() {
    const id = need(); const { from, ...region } = regionForCells();
    const out = await api.post(`/api/pathology/slides/${id}/analyses`, { kind: 'cells', region, params: { stains: st.stains } });
    showCells(out); toast(`${out.cells.length} cells found in ${from}`); draw();
  }
  function pickCell(i) { if (st.examples.get(i) === st.cellClass) st.examples.delete(i); else st.examples.set(i, st.cellClass); getActive().command('overlay', { examples: st.examples }); draw(); }
  async function trainCells() {
    if (!st.cells) { toast('Detect cells first', { error: true }); return; }
    const examples = [...st.examples.entries()].map(([cell, label]) => ({ analysis: st.cells.basedOn || st.cells.id, cell, label }));
    const c = await api.post('/api/pathology/classifiers', { name: st.classifierName, kind: 'object', stains: st.stains, examples });
    const out = await api.post(`/api/pathology/slides/${need()}/analyses/${st.cells.basedOn || st.cells.id}/classify`, { classifier: c.id });
    const keep = st.examples; st.cells = out; getActive().command('overlay', { cells: out.cells }); st.examples = keep; getActive().command('overlay', { examples: keep });
    st.last.classifier = `${c.name} version ${c.version}`; toast(`${c.name} version ${c.version} trained on ${c.examples} examples and applied`); await refreshLists(); draw();
  }
  async function trainPixels() {
    const id = need(); const examples = getActive().annotations.filter((a) => a.class && a.class !== 'Tissue' && outlineOf(a)).map((a) => ({ slide: id, label: a.class, points: outlineOf(a) }));
    if (new Set(examples.map((e) => e.label)).size < 2) { toast('Draw example areas for at least two classes first (pick a class, then draw a shape)', { error: true }); return; }
    const c = await api.post('/api/pathology/classifiers', { name: st.pixelName, kind: 'pixel', stains: st.stains, background: st.background || null, examples });
    st.last.pixelClassifier = `${c.name} version ${c.version}`; toast(`${c.name} version ${c.version} trained on ${c.examples} sampled pixels`); await refreshLists(); draw();
  }
  async function classifyPixels(whole) {
    const id = need(); const out = await api.post(`/api/pathology/slides/${id}/analyses`, { kind: 'pixels', classifier: st.pixelName, region: whole ? null : getActive().bounds() });
    getActive().command('overlay', { polygons: out.polygons }); st.last.pixels = out.summary; toast('Pixels classified'); draw();
  }
  async function measure() {
    const id = need(); const pane = getActive();
    const shapes = pane.annotations.filter((a) => a.id).map((a) => ({ id: a.id, kind: a.kind, class: a.class || a.label || null, points: a.kind === 'count' || a.kind === 'point' ? a.points : outlineOf(a) || a.points }));
    if (!shapes.length) { toast('There are no saved shapes to measure', { error: true }); return; }
    const out = await api.post(`/api/pathology/slides/${id}/analyses`, { kind: 'measure', params: { stains: st.stains }, annotations: shapes.map((x) => (x.kind === 'point' ? { ...x, kind: 'count' } : x)) });
    st.measure = out; draw();
  }
  const stainCols = () => STAINS[st.stains].channels.slice(0, 2);
  const measureColumns = () => [['kind', 'Shape'], ['class', 'Class'], ['areaUm2', 'Area (µm²)'], ['perimeterUm', 'Perimeter (µm)'], ['count', 'Count'], ...stainCols().map((ch) => [(r) => r.mean?.[ch] ?? '', `Mean ${ch}`])];
  const classColumns = () => [['class', 'Class'], ['annotations', 'Shapes'], ['areaUm2', 'Area (µm²)'], ['perimeterUm', 'Perimeter (µm)'], ['count', 'Count'], ...stainCols().map((ch) => [(r) => r.mean?.[ch] ?? '', `Mean ${ch}`])];
  const tableOf = (rows, columns, testid) => h('div', { class: 'antable' }, h('table', { testid }, h('thead', {}, h('tr', {}, ...columns.map(([, hd]) => h('th', {}, hd)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...columns.map(([k]) => h('td', {}, String((typeof k === 'function' ? k(r) : r[k]) ?? ''))))))));

  // ---------- workflows and batch ----------
  async function refreshLists() { try { [st.classifiers, st.workflows] = await Promise.all([api.get('/api/pathology/classifiers').then((x) => x.classifiers), api.get('/api/pathology/workflows').then((x) => x.workflows)]); } catch { /* shown as empty */ } }
  const wfDraft = { name: 'Count cells', tissue: true, cells: true, classify: false, pixels: false };
  async function saveWorkflow() {
    const steps = [...(wfDraft.tissue ? [{ kind: 'tissue' }] : []), ...(wfDraft.cells ? [{ kind: 'cells', params: { stains: st.stains } }] : []), ...(wfDraft.cells && wfDraft.classify ? [{ kind: 'classify', classifier: st.classifierName }] : []), ...(wfDraft.pixels ? [{ kind: 'pixels', classifier: st.pixelName }] : [])];
    const wf = await api.post('/api/pathology/workflows', { name: wfDraft.name, steps });
    toast(`Workflow "${wf.name}" saved as version ${wf.version}`); await refreshLists(); draw(); return wf;
  }
  async function runBatch(workflowId) {
    const c = getCase(); if (!c) { toast('Open a case first', { error: true }); return; }
    st.job = await api.post('/api/pathology/batch', { workflow: workflowId, case: c.id }); draw();
    const poll = async () => { try { st.job = await api.get(`/api/pathology/batch/${st.job.id}`); } catch { return; } draw(); if (st.job.status === 'running') setTimeout(poll, 700); else toast(`Batch finished: ${st.job.done - st.job.failed} of ${st.job.total} slide${st.job.total === 1 ? '' : 's'} analysed`, { error: st.job.failed > 0 }); };
    setTimeout(poll, 500);
  }

  function draw() {
    if (el.hidden) return;
    const classInput = (testid, label, value, on) => h('label', { class: 'small' }, `${label} `, h('input', { type: 'text', value, list: 'an-classes', maxlength: 60, testid, 'aria-label': label, style: 'width:10rem', onChange: (e) => on(e.target.value.trim()) }));
    const b = (label, testid, fn, opts = {}) => { const x = btn(label, { small: true, testid, disabled: opts.write !== false && !canEdit, kind: opts.kind, title: opts.title, onClick: () => busy(x, opts.busy || 'Working…', fn) }); return x; };
    const counts = new Map(); for (const lab of st.examples.values()) counts.set(lab, (counts.get(lab) || 0) + 1);
    const cs = st.cells?.summary;
    clear(el).append(
      h('datalist', { id: 'an-classes' }, ...[...new Set([...DEFAULT_CLASSES, ...getActive()?.annotations.map((a) => a.class).filter(Boolean) || []])].map((c) => h('option', { value: c }))),
      h('h3', {}, 'Analysis'),
      section('Display and stains', 'an-display', true,
        h('div', { class: 'anrow' }, ...[['brightness', 'Brightness'], ['contrast', 'Contrast']].map(([k, label]) => h('label', { class: 'small' }, `${label} `, h('input', { type: 'range', min: 40, max: 200, value: String(st.display[k]), testid: `display-${k}`, 'aria-label': `${label} (display only)`, onInput: (e) => { st.display[k] = Number(e.target.value); applyDisplay(); } })))),
        h('div', { class: 'anrow' }, h('span', { class: 'small' }, 'Channels'), ...[['r', 'Red'], ['g', 'Green'], ['b', 'Blue']].map(([k, label]) => h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: st.display[k], testid: `display-channel-${k}`, 'aria-label': `Show the ${label.toLowerCase()} channel`, style: 'width:auto;height:auto', onChange: (e) => { st.display[k] = e.target.checked; applyDisplay(); } }), ` ${label}`)),
          btn('Reset', { small: true, testid: 'display-reset', onClick: () => { st.display = { brightness: 100, contrast: 100, r: true, g: true, b: true }; applyDisplay(); draw(); } })),
        h('div', { class: 'anrow' }, h('label', { class: 'small' }, 'Stains ', h('select', { testid: 'stain-set', 'aria-label': 'Stain set for colour deconvolution', style: 'width:auto', onChange: (e) => { st.stains = e.target.value; st.stainChannel = -1; drawStain(); draw(); } }, ...Object.entries(STAINS).map(([k, v]) => h('option', { value: k, selected: k === st.stains }, v.name)))),
          h('label', { class: 'small' }, 'Show ', h('select', { testid: 'stain-view', 'aria-label': 'Stain view: one stain alone, by colour deconvolution', style: 'width:auto', onChange: (e) => { st.stainChannel = Number(e.target.value); drawStain(); } }, h('option', { value: -1, selected: st.stainChannel < 0 }, 'The slide as scanned'), ...STAINS[st.stains].channels.slice(0, 2).map((c, i) => h('option', { value: i, selected: i === st.stainChannel }, `${c} alone`)))),
          btn('Update', { small: true, testid: 'stain-update', title: 'Redo the stain view after moving the slide', onClick: () => drawStain() })),
        h('p', { class: 'muted small' }, 'Display only: nothing here changes the stored image. The stain view covers the part of the slide on screen.')),
      section('Classes and the selected shapes', 'an-shapes', true,
        h('div', { class: 'anrow' }, classInput('class-input', 'Class for new shapes', getActive()?.state.class || '', (v) => { for (const p of getPanes()) p.command('class', v ? { name: v, colour: classColour(v) } : null); draw(); }), getActive()?.state.class ? h('span', { class: 'swatch', style: `background:${classColour(getActive().state.class)}` }) : null),
        h('p', { class: 'small', testid: 'selection-text' }, st.selected.length ? `${st.selected.length} selected: ${st.selected.map((a) => `${a.class || a.label || a.kind}${a.areaUm2 != null ? ` (${fmtArea(a.areaUm2)})` : ''}${a.parentLabel ? ` inside ${a.parentLabel}` : ''}`).join(', ')}` : 'Nothing selected. Pick the Select tool and click a shape; Shift adds more.'),
        h('div', { class: 'anrow' }, btn('Select', { small: true, testid: 'an-select-tool', onClick: () => setTool('select') }),
          classInput('selection-class', 'Set class', '', (v) => setClass(v).catch(showError)),
          b('Merge', 'selection-merge', merge), btn('Split', { small: true, testid: 'selection-split', disabled: !canEdit, title: 'Then drag a line across the selected shape', onClick: () => { if (shapeIds().length !== 1) { toast('Select one shape first', { error: true }); return; } setTool('split'); toast('Drag a line across the shape'); } }),
          b('Remove', 'selection-remove', removeSelected, { kind: 'danger' }))),
      section('Tissue and cells', 'an-detect', true,
        h('div', { class: 'anrow' }, b('Detect tissue', 'detect-tissue', detectTissue, { busy: 'Looking…' }), st.last.tissue ? h('span', { class: 'small', testid: 'tissue-summary' }, `${st.last.tissue.pieces} piece${st.last.tissue.pieces === 1 ? '' : 's'}, ${Math.round(st.last.tissue.tissueFraction * 100)}% of the slide`) : null),
        h('div', { class: 'anrow' }, b('Detect cells', 'detect-cells', detectCells, { busy: 'Detecting…', title: 'In the selected shape, or in the part of the slide on screen' }),
          cs ? h('span', { class: 'small', testid: 'cells-summary' }, `${cs.cells} cells${cs.densityPerMm2 ? ` · ${cs.densityPerMm2} per mm²` : ''}${cs.meanAreaUm2 ? ` · mean area ${cs.meanAreaUm2} µm²` : ''}${cs.classes ? ` · ${Object.entries(cs.classes).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`) : h('span', { class: 'muted small' }, 'Runs in the selected shape, or in the part on screen (at most 2048 x 2048 pixels).'),
          st.cells ? btn('Export cells (CSV)', { small: true, testid: 'cells-export', onClick: () => download('cells.csv', toCsv(st.cells.cells, [['x', 'x (px)'], ['y', 'y (px)'], ['class', 'Class'], ['areaUm2', 'Area (µm²)'], ['perimeter', 'Perimeter (px)'], ['circularity', 'Circularity'], ['eccentricity', 'Eccentricity'], ['nucleusStain', 'Nucleus stain'], ['secondStain', 'Second stain']])) }) : null),
        st.cells ? h('div', { class: 'anrow' }, classInput('cell-class', 'Label cells as', st.cellClass, (v) => { st.cellClass = v || 'Tumour'; }), btn('Label cells', { small: true, testid: 'cell-pick-tool', title: 'Then click cells of that class', onClick: () => setTool('cell-pick') }),
          h('span', { class: 'small', testid: 'cell-examples' }, counts.size ? [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') : 'No examples yet')) : null,
        st.cells ? h('div', { class: 'anrow' }, h('label', { class: 'small' }, 'Classifier name ', h('input', { type: 'text', value: st.classifierName, maxlength: 60, testid: 'classifier-name', 'aria-label': 'Classifier name', style: 'width:9.375rem', onChange: (e) => { st.classifierName = e.target.value.trim() || 'Cells'; } })),
          b('Train and apply', 'classifier-train', trainCells, { busy: 'Training…', title: 'Each training makes a new version; correct the labels and train again' }), st.last.classifier ? h('span', { class: 'small', testid: 'classifier-version' }, st.last.classifier) : null) : null),
      section('Pixel classes', 'an-pixels', false,
        h('p', { class: 'muted small' }, 'Pick a class, draw example areas for at least two classes, then train. The classifier labels every pixel of the part on screen or of the whole slide at low resolution.'),
        h('div', { class: 'anrow' }, h('label', { class: 'small' }, 'Name ', h('input', { type: 'text', value: st.pixelName, maxlength: 60, testid: 'pixel-name', 'aria-label': 'Pixel classifier name', style: 'width:9.375rem', onChange: (e) => { st.pixelName = e.target.value.trim() || 'Tissue classes'; } })), classInput('pixel-background', 'Background class (not outlined)', st.background, (v) => { st.background = v; })),
        h('div', { class: 'anrow' }, b('Train', 'pixel-train', trainPixels, { busy: 'Training…' }), b('Classify the part on screen', 'pixel-classify-view', () => classifyPixels(false), { busy: 'Classifying…' }), b('Classify the whole slide', 'pixel-classify-all', () => classifyPixels(true), { busy: 'Classifying…' }), st.last.pixelClassifier ? h('span', { class: 'small', testid: 'pixel-version' }, st.last.pixelClassifier) : null),
        st.last.pixels ? h('p', { class: 'small', testid: 'pixel-summary' }, Object.entries(st.last.pixels.classes).map(([k, v]) => `${k} ${Math.round(v.fraction * 100)}%${v.areaUm2 ? ` (${fmtArea(v.areaUm2)})` : ''}`).join(' · ')) : null),
      section('Measurements', 'an-measure', false,
        h('div', { class: 'anrow' }, b('Measure the shapes', 'measure-run', measure, { busy: 'Measuring…', write: false }),
          st.measure ? btn('Export shapes (CSV)', { small: true, testid: 'measure-export', onClick: () => download('measurements.csv', toCsv(st.measure.rows, measureColumns())) }) : null,
          st.measure ? btn('Export classes (CSV)', { small: true, testid: 'measure-export-classes', onClick: () => download('measurements-by-class.csv', toCsv(st.measure.byClass, classColumns())) }) : null),
        st.measure ? tableOf(st.measure.byClass, classColumns(), 'measure-classes') : null, st.measure ? tableOf(st.measure.rows, measureColumns(), 'measure-rows') : null),
      section('Workflows and batch', 'an-batch', false,
        h('div', { class: 'anrow' }, h('label', { class: 'small' }, 'Name ', h('input', { type: 'text', value: wfDraft.name, maxlength: 60, testid: 'workflow-name', 'aria-label': 'Workflow name', style: 'width:9.375rem', onChange: (e) => { wfDraft.name = e.target.value.trim() || 'Count cells'; } })),
          ...[['tissue', 'Detect tissue'], ['cells', 'Detect cells'], ['classify', 'Class the cells'], ['pixels', 'Class the pixels']].map(([k, label]) => h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: wfDraft[k], testid: `workflow-step-${k}`, 'aria-label': `Workflow step: ${label}`, style: 'width:auto;height:auto', onChange: (e) => { wfDraft[k] = e.target.checked; } }), ` ${label}`)),
          b('Save workflow', 'workflow-save', saveWorkflow)),
        st.workflows.length ? h('div', { class: 'anrow' }, h('select', { testid: 'workflow-pick', 'aria-label': 'Saved workflow', style: 'width:auto' }, ...st.workflows.filter((w, i, all) => all.findIndex((x) => x.name === w.name) === i).map((w) => h('option', { value: w.id }, `${w.name} (version ${w.version}: ${w.steps.map((s2) => s2.kind).join(', ')})`))),
          b('Run on every slide of this case', 'batch-run', () => runBatch(el.querySelector('[data-testid="workflow-pick"]').value), { busy: 'Starting…' })) : h('p', { class: 'muted small' }, 'Save a workflow to run it on every slide of the case.'),
        st.job ? h('div', { testid: 'batch-progress' }, h('progress', { max: st.job.total, value: st.job.done, 'aria-label': 'Batch progress' }), h('span', { class: 'small' }, ` ${st.job.done} of ${st.job.total} slides · ${st.job.status}${st.job.failed ? ` · ${st.job.failed} failed` : ''}`),
          ...(st.job.results || []).map((r) => h('div', { class: 'small' }, r.ok ? r.analyses.map((a) => `${a.kind}: ${a.summary.cells != null ? `${a.summary.cells} cells` : a.summary.pieces != null ? `${a.summary.pieces} tissue pieces` : 'done'}`).join(' · ') : `Failed: ${r.error}`))) : null));
  }

  return {
    el, draw, state: st,
    toggle(show) { el.hidden = show == null ? !el.hidden : !show; if (!el.hidden) refreshLists().then(draw); return !el.hidden; },
    onSelect(hit, additive) { const pane = getActive(); if (!hit) st.selected = []; else if (additive) st.selected = st.selected.some((a) => a.id === hit.id) ? st.selected.filter((a) => a.id !== hit.id) : [...st.selected, hit]; else st.selected = [hit]; const parent = hit?.parent ? pane.annotations.find((a) => a.id === hit.parent) : null; if (hit) hit.parentLabel = parent ? (parent.class || parent.label || parent.kind) : null; draw(); },
    async onEdit(a) { if (!a.id) return; try { const mpp = getActive().state.mpp; const o = outlineOf(a); const areaUm2 = o && mpp ? (Math.abs(o.reduce((s2, p, i) => { const q = o[(i + 1) % o.length]; return s2 + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2) * mpp * mpp : undefined; const saved = await api.put(`/api/pathology/slides/${need()}/annotations/${a.id}`, { points: a.points, ...(areaUm2 != null ? { areaUm2 } : {}) }); replaceSaved(saved); record('annotation-move', null, {}); } catch (err) { showError(err); } },
    async onSplitLine(line) { const ids = shapeIds(); if (ids.length !== 1) { toast('Select one shape first, then drag the line', { error: true }); return; } try { await afterGeometry(await api.post(`/api/pathology/slides/${need()}/annotations/split`, { id: ids[0], line })); toast('Shape split in two'); record('annotation-split', null, {}); setTool('select'); } catch (err) { showError(err); } },
    async onWand(p) { try { const id = need(); const out = await api.post(`/api/pathology/slides/${id}/analyses`, { kind: 'wand', x: Math.round(p[0]), y: Math.round(p[1]), params: { tolerance: 28, window: Math.max(256, Math.round((getActive().bounds()?.w || 2048) / 2)) } }); const pg = out.polygons[0]; const pane = getActive(); const cls = pane.state.class || null; await persist(pane, { kind: 'polygon', points: pg.points.slice(0, 2000), areaUm2: pg.areaUm2, closed: true, ...(cls ? { class: cls, label: cls, colour: classColour(cls) } : {}) }, { method: out.method, params: out.params, analysis: out.id }, true); toast(`Wand: region of ${pg.areaUm2 != null ? fmtArea(pg.areaUm2) : `${out.summary.pixels} pixels`} added`); } catch (err) { if (err.message !== 'no slide') showError(err); } },
    onCellPick(i) { pickCell(i); },
  };
}
