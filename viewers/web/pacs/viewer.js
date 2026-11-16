// Image viewport and series loading for PACS.
//
// The viewport draws from a "source": { count, frame(i), header }. An axial
// stack, a coronal reslice and a sagittal reslice are all sources, so every
// tool (scroll, window/level, zoom, pan, length) works the same in each pane.
// This file is the rendering boundary: a different engine can replace it by
// providing createViewport and the same source shape.
import { parse, pixels, toRGBA, autoWindow, distanceMm, WINDOW_PRESETS } from '/shared/dicom.js';
import { frameGroups } from '/shared/dicom-objects.js';
import { h } from '/shared/ui.js';
import { createMaskLayer } from '/shared/masks.js';

export { WINDOW_PRESETS };
const cache = new Map();

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const wadoUrl = (studyUid, seriesUid, sopUid) => `/dicom-web/wado?requestType=WADO&studyUID=${studyUid}&seriesUID=${seriesUid}&objectUID=${sopUid}&contentType=application/dicom`;

// Parsed files are kept per SOP instance for the session, so the preview image and a prefetched series are not fetched twice.
const fileCache = new Map();
function fetchFile(studyUid, seriesUid, sopUid) {
  if (!fileCache.has(sopUid)) {
    const p = (async () => { const response = await fetch(wadoUrl(studyUid, seriesUid, sopUid)); if (!response.ok) throw new Error(`Could not load image (${response.status})`); return parse(new Uint8Array(await response.arrayBuffer())); })();
    fileCache.set(sopUid, p); p.catch(() => fileCache.delete(sopUid));
  }
  return fileCache.get(sopUid);
}
const listCache = new Map();
const instanceList = (study, series) => { const key = `${study.studyUid}/${series.uid}`; if (!listCache.has(key)) { const p = fetch(`/dicom-web/studies/${study.studyUid}/series/${series.uid}/instances`).then((r) => r.json()); listCache.set(key, p); p.catch(() => listCache.delete(key)); } return listCache.get(key); };
export const isSeriesLoaded = (study, series) => cache.has(`${study.studyUid}/${series.uid}`);
/** Progressive loading: the middle image of a series alone, as a one-image source, so something is on screen before the rest arrives. */
export async function loadPreview(study, series) {
  const list = await instanceList(study, series);
  if (!list.length) return null;
  const file = await fetchFile(study.studyUid, series.uid, list[Math.floor((list.length - 1) / 2)]['00080018'].Value[0]);
  const info = pixels(file); const px = info.frame(Math.floor((info.frames - 1) / 2));
  const header = { patientName: file.str('PatientName').replace(/\^/g, ' ').trim(), mrn: file.str('PatientID'), studyDescription: file.str('StudyDescription') || study.description, seriesNumber: file.num('SeriesNumber') ?? series.number, seriesDescription: file.str('SeriesDescription') || series.description, modality: file.str('Modality') || series.modality, date: file.str('StudyDate') || study.started, rowSpacing: info.rowSpacing, columnSpacing: info.columnSpacing, bitsStored: info.bitsStored };
  return { kind: 'axial', preview: true, label: 'Loading the rest…', count: 1, header, frames: [{ info }], frame: () => ({ pixels: px, info, location: file.num('SliceLocation'), number: file.num('InstanceNumber') ?? 1 }) };
}

/** Loads every instance of a series and returns an axial stack source. */
export async function loadSeries(study, series, onProgress) {
  const key = `${study.studyUid}/${series.uid}`;
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const list = await instanceList(study, series);
    let done = 0;
    const files = await pool(list, 6, async (item) => { const f = await fetchFile(study.studyUid, series.uid, item['00080018'].Value[0]); done += 1; onProgress?.(done, list.length); return f; });
    const frames = [];
    for (const file of files) {
      const info = pixels(file);
      const position = file.nums('ImagePositionPatient');
      // Enhanced multi-frame CT and MR carry position, spacing and thickness per frame in the functional groups.
      const groups = info.frames > 1 && file.get('PerFrameFunctionalGroupsSequence') ? frameGroups(file).frames : null;
      for (let i = 0; i < info.frames; i += 1) {
        const g = groups?.[i];
        const frameInfo = g?.spacing || g?.slope != null ? { ...info, ...(g.spacing ? { rowSpacing: g.spacing[0], columnSpacing: g.spacing[1] } : {}), ...(g.slope != null ? { slope: g.slope, intercept: g.intercept ?? 0 } : {}) } : info;
        const z = g?.position ? g.position[2] : position.length === 3 ? position[2] : null;
        frames.push({ info: frameInfo, index: i, file, z, number: file.num('InstanceNumber') ?? 0, location: g?.position ? z : file.num('SliceLocation') ?? z, thickness: g?.thickness ?? file.num('SliceThickness') });
      }
    }
    frames.sort((a, b) => (a.z != null && b.z != null && a.z !== b.z ? a.z - b.z : a.number - b.number || a.index - b.index));
    const first = files[0];
    const header = { patientName: first.str('PatientName').replace(/\^/g, ' ').trim(), mrn: first.str('PatientID'), studyDescription: first.str('StudyDescription') || study.description, seriesNumber: first.num('SeriesNumber') ?? series.number, seriesDescription: first.str('SeriesDescription') || series.description, modality: first.str('Modality') || series.modality, date: study.started };
    const decoded = new Map();
    const source = {
      kind: 'axial', label: ['CT', 'MR'].includes(header.modality) ? 'Axial' : (header.seriesDescription || header.modality), count: frames.length, header, frames,
      frame(i) { if (!decoded.has(i)) decoded.set(i, frames[i].info.frame(frames[i].index)); const f = frames[i]; return { pixels: decoded.get(i), info: f.info, location: f.location, number: f.number }; },
    };
    return source;
  })();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

/** A stack can be shown in three planes when it is CT or MR with 20 or more uniform slices. */
export function supportsVolume(source) {
  if (!source || source.kind !== 'axial' || source.count < 20 || !['CT', 'MR'].includes(source.header.modality)) return false;
  const a = source.frames[0].info;
  return a.samples === 1 && source.frames.every((f) => f.info.rows === a.rows && f.info.columns === a.columns);
}

/** Builds coronal and sagittal sources by reslicing the axial stack. */
export function reslice(source) {
  const base = source.frames[0].info;
  const nx = base.columns;
  const ny = base.rows;
  const nz = source.count;
  const Ctor = base.signed ? Int16Array : Uint16Array;
  const data = new Ctor(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) data.set(source.frame(k).pixels, k * nx * ny);
  const zs = source.frames.map((f) => f.z).filter((z) => z != null);
  const dz = zs.length > 1 ? Math.abs(zs[zs.length - 1] - zs[0]) / (zs.length - 1) : (source.frames[0].thickness || 1);
  const dx = base.columnSpacing || 1;
  const dy = base.rowSpacing || 1;
  const plane = (kind, label, count, columns, columnSpacing, sample) => {
    const info = { ...base, rows: nz, columns, rowSpacing: dz, columnSpacing, frames: 1 };
    const made = new Map();
    return { kind, label, count, header: source.header, frame(i) {
      if (!made.has(i)) {
        const out = new Ctor(nz * columns);
        for (let k = 0; k < nz; k += 1) { const row = (nz - 1 - k) * columns; for (let c = 0; c < columns; c += 1) out[row + c] = sample(k, c, i); }
        made.set(i, out);
      }
      return { pixels: made.get(i), info, location: i * (kind === 'coronal' ? dy : dx), number: i + 1 };
    } };
  };
  return {
    coronal: plane('coronal', 'Coronal', ny, nx, dx, (k, x, j) => data[k * nx * ny + j * nx + x]),
    sagittal: plane('sagittal', 'Sagittal', nx, ny, dy, (k, y, i) => data[k * nx * ny + y * nx + i]),
    spacing: { dx, dy, dz }, dims: { nx, ny, nz },
  };
}

/** Draws the middle image of a series into a small canvas. */
export async function thumbnail(study, series, size = 72) {
  const canvas = h('canvas', { width: size, height: size, class: 'thumb', 'aria-hidden': 'true' });
  if (!series.middle) return canvas;
  fetchFile(study.studyUid, series.uid, series.middle).then((file) => {
    const info = pixels(file);
    const frame = info.frame(Math.floor(info.frames / 2));
    const stage = new OffscreenCanvas(info.columns, info.rows);
    stage.getContext('2d').putImageData(new ImageData(toRGBA(frame, info, autoWindow(frame, info)), info.columns, info.rows), 0, 0);
    const scale = Math.min(size / info.columns, size / info.rows);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(stage, (size - info.columns * scale) / 2, (size - info.rows * scale) / 2, info.columns * scale, info.rows * scale);
  }).catch(() => {});
  return canvas;
}

/**
 * One image pane. Returns { el, setSource, state, command, render, destroy }.
 * callbacks: onActivate(), onMeasure(measurement), onChange(state).
 */
export function createViewport({ id, prior = false, callbacks = {} }) {
  const canvas = h('canvas', { testid: `viewport-canvas-${id}`, tabindex: 0, role: 'img', 'aria-label': `Image pane ${id}` });
  const corner = (pos) => h('div', { class: `overlay ${pos}`, testid: `overlay-${pos}-${id}` });
  const overlays = { tl: corner('tl'), tr: corner('tr'), bl: corner('bl'), br: corner('br') };
  const tag = h('div', { class: 'pane-tag', testid: `pane-tag-${id}` });
  const el = h('div', { class: `viewport${prior ? ' prior' : ''}`, testid: `viewport-${id}` }, canvas, ...Object.values(overlays), tag);
  const ctx = canvas.getContext('2d');
  const stage = new OffscreenCanvas(1, 1);
  const state = { source: null, index: 0, center: 40, width: 400, invert: false, zoom: 1, panX: 0, panY: 0, tool: 'wl', preset: 'Auto', cine: null };
  const measurements = new Map();
  const masks = new Map(); // `${kind}:${index}` -> mask layer
  const marks = new Map(); // `${kind}:${index}` -> [{ kind: 'box' | 'point' | 'outline', label, x, y, width, height, points }]
  const brush = { size: 12, label: 'Finding', colour: '#F7313B', erase: false };
  const maskFor = () => { const key = `${state.source.kind}:${state.index}`; if (!masks.has(key)) { const f = state.source.frame(state.index); masks.set(key, createMaskLayer(f.info.columns, f.info.rows)); } return masks.get(key); };
  const maskCanvas = document.createElement('canvas');
  const segCanvas = document.createElement('canvas');
  let geometry = null;
  let draft = null;

  function current() { return state.source ? state.source.frame(state.index) : null; }

  function applyAuto() { const f = current(); if (!f) return; const w = autoWindow(f.pixels, f.info); state.center = w.center; state.width = w.width; state.preset = 'Auto'; }

  function render() {
    const rect = el.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const f = current();
    if (!f) { geometry = null; return; }
    const { info } = f;
    if (stage.width !== info.columns || stage.height !== info.rows) { stage.width = info.columns; stage.height = info.rows; }
    stage.getContext('2d').putImageData(new ImageData(toRGBA(f.pixels, info, { center: state.center, width: state.width, invert: state.invert }), info.columns, info.rows), 0, 0);
    const sx = info.columnSpacing || 1;
    const sy = info.rowSpacing || 1;
    const fit = Math.min(W / (info.columns * sx), H / (info.rows * sy));
    const scale = fit * state.zoom;
    const w = info.columns * sx * scale;
    const hh = info.rows * sy * scale;
    const x0 = (W - w) / 2 + state.panX;
    const y0 = (H - hh) / 2 + state.panY;
    geometry = { x0, y0, px: sx * scale, py: sy * scale, info };
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(stage, x0, y0, w, hh);
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffd24a'; ctx.fillStyle = '#ffd24a'; ctx.font = `${parseFloat(getComputedStyle(document.documentElement).fontSize) || 16}px ui-monospace, Menlo, Consolas, monospace`;
    for (const m of [...(measurements.get(`${state.source.kind}:${state.index}`) || []), ...(draft && draft.a ? [draft] : [])]) {
      const ax = x0 + m.a.x * geometry.px; const ay = y0 + m.a.y * geometry.py; const bx = x0 + m.b.x * geometry.px; const by = y0 + m.b.y * geometry.py;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillRect(ax - 2, ay - 2, 4, 4); ctx.fillRect(bx - 2, by - 2, 4, 4);
      ctx.fillText(m.mm == null ? 'no pixel spacing' : `${m.mm.toFixed(1)} mm`, bx + 6, by - 6);
    }
    // Annotation layer (plan-master 5.4, 6.6): the brush mask, bounding boxes and points for this frame.
    const key = `${state.source.kind}:${state.index}`;
    // Segmentation overlay: the page gives the labels of this plane and image as RGBA (segment.js).
    const seg = state.overlayFor ? state.overlayFor(state.source, state.index) : null;
    if (seg) {
      if (segCanvas.width !== seg.columns || segCanvas.height !== seg.rows) { segCanvas.width = seg.columns; segCanvas.height = seg.rows; }
      segCanvas.getContext('2d').putImageData(new ImageData(seg.rgba, seg.columns, seg.rows), 0, 0);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(segCanvas, x0, y0, w, hh); ctx.imageSmoothingEnabled = true;
    }
    const mask = masks.get(key);
    if (mask && mask.count()) {
      if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) { maskCanvas.width = mask.width; maskCanvas.height = mask.height; }
      const img = maskCanvas.getContext('2d').createImageData(mask.width, mask.height);
      const [r, g, b] = [parseInt(brush.colour.slice(1, 3), 16), parseInt(brush.colour.slice(3, 5), 16), parseInt(brush.colour.slice(5, 7), 16)];
      for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i]) { img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 110; }
      maskCanvas.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(maskCanvas, x0, y0, w, hh); ctx.imageSmoothingEnabled = true;
    }
    for (const m of [...(marks.get(key) || []), ...(draft?.kind === 'box' || draft?.kind === 'outline' ? [draft] : [])]) {
      ctx.strokeStyle = m.colour || '#4fb3d1'; ctx.fillStyle = m.colour || '#4fb3d1'; ctx.lineWidth = 2;
      // An outline: a freehand closed shape in image pixels.
      if (m.kind === 'outline') { ctx.beginPath(); m.points.forEach(([px, py], i) => { const X = x0 + px * geometry.px; const Y = y0 + py * geometry.py; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }); if (m !== draft) ctx.closePath(); ctx.stroke(); if (m.points[0]) ctx.fillText(m.label, x0 + m.points[0][0] * geometry.px + 3, y0 + m.points[0][1] * geometry.py - 4); }
      else if (m.kind === 'box') { ctx.strokeRect(x0 + m.x * geometry.px, y0 + m.y * geometry.py, m.width * geometry.px, m.height * geometry.py); ctx.fillText(m.label, x0 + m.x * geometry.px + 3, y0 + m.y * geometry.py - 4); }
      else { ctx.beginPath(); ctx.arc(x0 + m.x * geometry.px, y0 + m.y * geometry.py, 5, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(m.label, x0 + m.x * geometry.px + 8, y0 + m.y * geometry.py - 6); }
    }
    if (draft?.kind === 'brush-cursor' && geometry) { ctx.strokeStyle = brush.erase ? '#fff' : brush.colour; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x0 + draft.x * geometry.px, y0 + draft.y * geometry.py, brush.size * geometry.px, 0, Math.PI * 2); ctx.stroke(); }
    const hd = state.source.header;
    overlays.tl.textContent = `${hd.patientName ? `${hd.patientName}\n` : ''}${hd.mrn}\n${hd.studyDescription || ''}${hd.seriesDescription ? `\n${hd.seriesNumber != null ? `${hd.seriesNumber}. ` : ''}${hd.seriesDescription}` : ''}${f.info.sliceThickness ?? state.source.frames?.[state.index]?.thickness ? `\nSlice: ${Number(f.info.sliceThickness ?? state.source.frames[state.index].thickness)} mm` : ''}`;
    overlays.tr.textContent = `Se ${hd.seriesNumber ?? ''}  Im ${state.index + 1}/${state.source.count}\nW ${Math.round(state.width)}  L ${Math.round(state.center)}`;
    overlays.bl.textContent = `Image ${state.index + 1} of ${state.source.count}\n${f.location != null ? `Loc ${Number(f.location).toFixed(1)} mm` : 'Loc n/a'}\n${info.rowSpacing ? `Spacing ${info.rowSpacing.toFixed(2)} x ${info.columnSpacing.toFixed(2)} mm` : 'Spacing n/a'}${hd.date ? `\n${String(hd.date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3').slice(0, 10)}` : ''}`;
    overlays.br.textContent = `Zoom ${Math.round(state.zoom * 100)}%\n${info.bitsStored} bit`;
    tag.textContent = `${prior ? 'PRIOR  ' : ''}${state.source.label}${hd.date ? `  ${String(hd.date).slice(0, 10)}` : ''}`;
    callbacks.onChange?.(state);
  }

  function setIndex(i) { if (!state.source) return; state.index = Math.max(0, Math.min(state.source.count - 1, i)); render(); }
  function setSource(source, { keepWindow = false } = {}) {
    state.source = source; state.index = Math.floor((source.count - 1) / 2); state.zoom = 1; state.panX = 0; state.panY = 0;
    if (!keepWindow) applyAuto();
    render();
  }
  const toImage = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - geometry.x0) / geometry.px, y: (e.clientY - r.top - geometry.y0) / geometry.py }; };

  function command(name, arg) {
    if (name === 'scroll') setIndex(state.index + arg);
    else if (name === 'goto') setIndex(arg);
    else if (name === 'first') setIndex(0);
    else if (name === 'last') setIndex(state.source ? state.source.count - 1 : 0);
    else if (name === 'invert') { state.invert = !state.invert; render(); }
    else if (name === 'reset') { state.zoom = 1; state.panX = 0; state.panY = 0; state.invert = false; applyAuto(); render(); }
    else if (name === 'tool') { state.tool = arg; }
    else if (name === 'preset') { if (arg === 'Auto') applyAuto(); else { state.center = WINDOW_PRESETS[arg].center; state.width = WINDOW_PRESETS[arg].width; state.preset = arg; } render(); }
    else if (name === 'window') { state.center = arg.center; state.width = Math.max(1, arg.width); state.preset = 'Custom'; render(); }
    else if (name === 'zoom') { state.zoom = Math.max(0.1, Math.min(20, arg)); render(); }
    else if (name === 'clear') { measurements.clear(); render(); }
    else if (name === 'brush') { Object.assign(brush, arg); render(); }
    else if (name === 'undo') { if (state.source && maskFor().undo()) render(); }
    else if (name === 'redo') { if (state.source && maskFor().redo()) render(); }
    else if (name === 'clear-mask') { if (state.source) { maskFor().clear(); render(); } }
    else if (name === 'cine') {
      if (state.cine) { clearInterval(state.cine); state.cine = null; } else if (state.source?.count > 1) state.cine = setInterval(() => setIndex((state.index + 1) % state.source.count), 100);
      callbacks.onChange?.(state);
    }
  }

  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    callbacks.onActivate?.();
    if (!geometry) return;
    e.preventDefault();
    const mode = e.button === 1 ? 'pan' : e.button === 2 ? 'zoom' : state.tool;
    drag = { mode, x: e.clientX, y: e.clientY, center: state.center, width: state.width, zoom: state.zoom, panX: state.panX, panY: state.panY };
    // Segmentation tools: the page owns the label volume; this pane only reports where the pointer is, in image pixels.
    if (String(mode).startsWith('seg-')) { const p = toImage(e); callbacks.onSegPointer?.({ phase: 'down', mode, x: p.x, y: p.y, source: state.source, index: state.index }); if (mode === 'seg-grow' || mode === 'seg-probe') drag = null; render(); return; }
    if (mode === 'length') draft = { a: toImage(e), b: toImage(e), mm: 0 };
    if (mode === 'brush' || mode === 'erase') { const m = maskFor(); m.begin(); const p = toImage(e); m.paint(p.x, p.y, brush.size, mode === 'erase'); draft = { kind: 'brush-cursor', ...p }; render(); }
    if (mode === 'outline') { const p = toImage(e); draft = { kind: 'outline', label: brush.label, colour: brush.colour, points: [[p.x, p.y]] }; }
    if (mode === 'box') { const p = toImage(e); draft = { kind: 'box', label: brush.label, colour: brush.colour, x: p.x, y: p.y, width: 0, height: 0, from: p }; }
    if (mode === 'point') { const p = toImage(e); const key = `${state.source.kind}:${state.index}`; const mk = { kind: 'point', label: brush.label, colour: brush.colour, x: Math.round(p.x), y: Math.round(p.y), plane: state.source.kind, frame: state.index }; marks.set(key, [...(marks.get(key) || []), mk]); drag = null; render(); callbacks.onMark?.(mk); }
  });
  const move = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (String(drag.mode).startsWith('seg-')) { const p = toImage(e); callbacks.onSegPointer?.({ phase: 'move', mode: drag.mode, x: p.x, y: p.y, source: state.source, index: state.index }); render(); return; }
    if (drag.mode === 'wl') { const step = Math.max(1, drag.width / 300); state.width = Math.max(1, drag.width + dx * step); state.center = drag.center + dy * step; state.preset = 'Custom'; }
    else if (drag.mode === 'pan') { state.panX = drag.panX + dx; state.panY = drag.panY + dy; }
    else if (drag.mode === 'zoom') state.zoom = Math.max(0.1, Math.min(20, drag.zoom * Math.exp(-dy / 200)));
    else if (drag.mode === 'length' && draft) { draft.b = toImage(e); draft.mm = distanceMm(draft.a, draft.b, geometry.info.rowSpacing, geometry.info.columnSpacing); }
    else if ((drag.mode === 'brush' || drag.mode === 'erase') && draft) { const p = toImage(e); maskFor().paint(p.x, p.y, brush.size, drag.mode === 'erase'); draft = { kind: 'brush-cursor', ...p }; }
    else if (drag.mode === 'outline' && draft) { const p = toImage(e); const [lx, ly] = draft.points.at(-1); if (Math.hypot(p.x - lx, p.y - ly) >= 1.5) draft.points.push([p.x, p.y]); }
    else if (drag.mode === 'box' && draft) { const p = toImage(e); draft.x = Math.min(draft.from.x, p.x); draft.y = Math.min(draft.from.y, p.y); draft.width = Math.abs(p.x - draft.from.x); draft.height = Math.abs(p.y - draft.from.y); }
    render();
  };
  const up = () => {
    if (String(drag?.mode).startsWith('seg-')) { callbacks.onSegPointer?.({ phase: 'up', mode: drag.mode, source: state.source, index: state.index }); drag = null; render(); return; }
    if ((drag?.mode === 'brush' || drag?.mode === 'erase') && draft) { maskFor().end(); draft = null; render(); callbacks.onMask?.(maskFor()); drag = null; return; }
    if (drag?.mode === 'outline' && draft) { if (draft.points.length >= 3) { const key = `${state.source.kind}:${state.index}`; const pts = draft.points.map(([px, py]) => [Math.round(px), Math.round(py)]); const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]); const mk = { kind: 'outline', label: draft.label, colour: draft.colour, points: pts, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), plane: state.source.kind, frame: state.index }; marks.set(key, [...(marks.get(key) || []), mk]); callbacks.onMark?.(mk); } draft = null; render(); drag = null; return; }
    if (drag?.mode === 'box' && draft) { if (draft.width >= 2 && draft.height >= 2) { const key = `${state.source.kind}:${state.index}`; const mk = { kind: 'box', label: draft.label, colour: draft.colour, x: Math.round(draft.x), y: Math.round(draft.y), width: Math.round(draft.width), height: Math.round(draft.height), plane: state.source.kind, frame: state.index }; marks.set(key, [...(marks.get(key) || []), mk]); callbacks.onMark?.(mk); } draft = null; render(); drag = null; return; }
    if (drag?.mode === 'length' && draft) {
      const pxLen = Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y);
      if (pxLen >= 2) {
        const key = `${state.source.kind}:${state.index}`;
        const m = { ...draft, plane: state.source.kind, frame: state.index };
        measurements.set(key, [...(measurements.get(key) || []), m]);
        callbacks.onMeasure?.(m);
      }
      draft = null;
      render();
    }
    drag = null;
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    callbacks.onActivate?.();
    if (e.ctrlKey) command('zoom', state.zoom * Math.exp(-e.deltaY / 400)); else command('scroll', e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  const observer = new ResizeObserver(() => render());
  observer.observe(el);

  return {
    el, canvas, state, setSource, command, render, measurements, marks, masks, maskFor, brush, engine: 'canvas',
    destroy() { observer.disconnect(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (state.cine) clearInterval(state.cine); },
  };
}
