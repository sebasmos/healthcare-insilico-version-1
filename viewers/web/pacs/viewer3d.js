// Cornerstone3D engine for the PACS viewer. Loaded from the vendored
// bundle in viewers/web/vendor/ (no CDN, no telemetry); the image loader reads only
// this server's DICOMweb routes. It provides a stack viewport with the same
// interface as the hand-written one in viewer.js (used for compressed
// series), true MPR with linked crosshairs, a 3D volume-rendering pane with
// presets, and annotation tools (length, angle, rectangle ROI) that the
// page persists as Observations.
import { h } from '/shared/ui.js';
import { WINDOW_PRESETS } from '/shared/dicom.js';
import { lengthMm, angleDeg, cobbAngleDeg, ellipseStats, polygonStats, probe as probeValue, bidirectional as bidirectionalMm } from '/pacs/measure.js';

let csPromise = null;
export function cornerstone() {
  if (!csPromise) {
    csPromise = (async () => {
      const cs = await import('/vendor/cornerstone.js');
      const { core, tools, dicomImageLoader } = cs;
      await core.init();
      dicomImageLoader.init({ maxWebWorkers: Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) >> 1)), decodeConfig: { wasmBasePath: '/vendor/codecs/' } });
      tools.init();
      for (const T of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool, tools.LengthTool, tools.AngleTool, tools.RectangleROITool, tools.CrosshairsTool, tools.TrackballRotateTool, tools.CobbAngleTool, tools.EllipticalROITool, tools.PlanarFreehandROITool, tools.ProbeTool, tools.BidirectionalTool, tools.ArrowAnnotateTool]) { try { tools.addTool(T); } catch { /* already added */ } }
      return cs;
    })();
    csPromise.catch(() => { csPromise = null; });
  }
  return csPromise;
}

const engineId = 'hospital-desktop';
let engine = null;
async function renderingEngine() { const { core } = await cornerstone(); if (!engine) engine = new core.RenderingEngine(engineId); return engine; }
export const imageIdFor = (studyUid, seriesUid, sopUid) => `wadouri:${location.origin}/dicom-web/wado?requestType=WADO&studyUID=${studyUid}&seriesUID=${seriesUid}&objectUID=${sopUid}&contentType=application/dicom`;

/** A source for the Cornerstone engine: image ids in slice order plus the overlay header from the first image's metadata. */
export async function loadSeries3d(study, series, onProgress) {
  const { core, dicomImageLoader } = await cornerstone();
  const list = await (await fetch(`/dicom-web/studies/${study.studyUid}/series/${series.uid}/instances`)).json();
  let imageIds = list.map((item) => imageIdFor(study.studyUid, series.uid, item['00080018'].Value[0]));
  const first = await core.imageLoader.loadAndCacheImage(imageIds[0]);
  onProgress?.(1, imageIds.length);
  const meta = (mod, id) => core.metaData.get(mod, id) || {};
  // Sort by position along the normal when the plane module is present, else by instance number.
  const keyed = imageIds.map((id) => { const plane = meta('imagePlaneModule', id); const gen = meta('generalImageModule', id); return { id, z: plane.imagePositionPatient?.[2] ?? null, loc: plane.sliceLocation ?? plane.imagePositionPatient?.[2] ?? null, n: Number(gen.instanceNumber) || 0 }; });
  if (keyed.length > 1) { await Promise.all(keyed.slice(1).map(async (k, i) => { try { await core.imageLoader.loadAndCacheImage(k.id); } catch { /* shown as missing */ } onProgress?.(i + 2, imageIds.length); const plane = meta('imagePlaneModule', k.id); const gen = meta('generalImageModule', k.id); k.z = plane.imagePositionPatient?.[2] ?? null; k.loc = plane.sliceLocation ?? k.z; k.n = Number(gen.instanceNumber) || 0; })); }
  keyed.sort((a, b) => (a.z != null && b.z != null && a.z !== b.z ? a.z - b.z : a.n - b.n));
  imageIds = keyed.map((k) => k.id);
  const patient = meta('patientModule', imageIds[0]); const gs = meta('generalStudyModule', imageIds[0]); const ser = meta('generalSeriesModule', imageIds[0]); const pix = meta('imagePixelModule', imageIds[0]); const plane = meta('imagePlaneModule', imageIds[0]);
  const header = { patientName: String(patient.patientName?.Alphabetic || patient.patientName || '').replace(/\^/g, ' ').trim(), mrn: patient.patientId || '', studyDescription: gs.studyDescription || study.description, seriesNumber: ser.seriesNumber ?? series.number, seriesDescription: ser.seriesDescription || series.description, modality: ser.modality || series.modality || 'OT', date: gs.studyDate || study.started, bitsStored: pix.bitsStored ?? first.image?.bitsStored ?? null, rowSpacing: plane.pixelSpacing?.[0] ?? plane.rowPixelSpacing ?? null, columnSpacing: plane.pixelSpacing?.[1] ?? plane.columnPixelSpacing ?? null, rows: pix.rows ?? first.rows, columns: pix.columns ?? first.columns, compression: series.compression || null };
  const voi = meta('voiLutModule', imageIds[0]);
  return { kind: 'axial', engine: 'cs3d', label: ['CT', 'MR'].includes(header.modality) ? 'Axial' : (header.seriesDescription || header.modality), count: imageIds.length, header, imageIds, locations: keyed.map((k) => k.loc), defaultWindow: ctWindow(header.modality, voi.windowCenter != null ? { center: Array.isArray(voi.windowCenter) ? voi.windowCenter[0] : voi.windowCenter, width: Array.isArray(voi.windowWidth) ? voi.windowWidth[0] : voi.windowWidth } : null), volumeId: `cornerstoneStreamingImageVolume:${study.studyUid}:${series.uid}` };
}

const voiToWindow = (range) => ({ width: Math.max(1, range.upper - range.lower), center: (range.upper + range.lower) / 2 });
// A CT converted from another format often carries the full data range as its window (for example W 4764 L -642),
// which looks washed out. Such a CT opens in the soft-tissue window instead; a sensible stored window is kept.
const ctWindow = (modality, w) => (modality === 'CT' && (!w || !(w.width > 0) || w.width > 2000) ? { center: 40, width: 400 } : w);
const windowToVoi = (center, width) => ({ lower: center - width / 2, upper: center + width / 2 });
let groupSeq = 0;

/** A stack viewport with the same surface as viewer.js createViewport: { el, canvas, state, setSource, command, render, measurements, destroy }. */
export async function createStackViewport3d({ id, prior = false, callbacks = {} }) {
  const { core, tools } = await cornerstone();
  const eng = await renderingEngine();
  const viewportId = `${id}-${(groupSeq += 1)}`;
  const element = h('div', { class: 'cs-element', testid: `viewport-canvas-${id}`, tabindex: 0, role: 'img', 'aria-label': `Image pane ${id}`, style: 'position:absolute;inset:0' });
  element.oncontextmenu = (e) => e.preventDefault();
  const corner = (pos) => h('div', { class: `overlay ${pos}`, testid: `overlay-${pos}-${id}` });
  const overlays = { tl: corner('tl'), tr: corner('tr'), bl: corner('bl'), br: corner('br') };
  const tag = h('div', { class: 'pane-tag', testid: `pane-tag-${id}` });
  const el = h('div', { class: `viewport cs3d${prior ? ' prior' : ''}`, testid: `viewport-${id}` }, element, ...Object.values(overlays), tag);
  const state = { source: null, index: 0, center: 40, width: 400, invert: false, zoom: 1, tool: 'wl', preset: 'Auto', cine: null, engine: 'cs3d' };
  const measurements = new Map();
  let vp = null; let onCompleted = null; let restoring = false;
  const group = tools.ToolGroupManager.createToolGroup(`g-${viewportId}`);
  for (const T of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.LengthTool, tools.AngleTool, tools.RectangleROITool, tools.CobbAngleTool, tools.EllipticalROITool, tools.PlanarFreehandROITool, tools.ProbeTool, tools.BidirectionalTool]) group.addTool(T.toolName);
  // The arrow note asks for its text in the page's own way (callbacks.askText), not a browser prompt, when the page provides one.
  group.addTool(tools.ArrowAnnotateTool.toolName, { getTextCallback: (done) => { if (callbacks.askText) callbacks.askText().then((t) => done(t || '')); else done(window.prompt('Note for the arrow') || ''); } });
  const KIND = { [tools.LengthTool.toolName]: 'length', [tools.AngleTool.toolName]: 'angle', [tools.RectangleROITool.toolName]: 'roi', [tools.CobbAngleTool.toolName]: 'cobb', [tools.EllipticalROITool.toolName]: 'ellipse', [tools.PlanarFreehandROITool.toolName]: 'freehand', [tools.ProbeTool.toolName]: 'probe', [tools.BidirectionalTool.toolName]: 'bidirectional', [tools.ArrowAnnotateTool.toolName]: 'arrow' };
  const TOOL_OF = Object.fromEntries(Object.entries(KIND).map(([t, k]) => [k, t]));
  /** Our own maths on the image's pixels (measure.js), so the numbers do not depend on the tool library's cached statistics. */
  function measureOurs(kind, a, imageId) {
    const image = core.cache.getImage(imageId); if (!image) return {};
    const toImg = (p) => { try { return Array.from(core.utilities.worldToImageCoords(imageId, p)); } catch { return [p[0], p[1]]; } };
    const pts = (a.data.handles?.points || []).map(toImg);
    const rs = image.rowPixelSpacing || null; const cs = image.columnPixelSpacing || null;
    const opts = { slope: image.slope ?? 1, intercept: image.intercept ?? 0, rowSpacing: rs, columnSpacing: cs };
    const px = image.getPixelData?.() || image.voxelManager?.getScalarData?.();
    const out = { imagePoints: pts.map((p) => p.map((v) => Math.round(v * 100) / 100)) };
    if (kind === 'length' && pts.length >= 2) out.mm = lengthMm(pts[0], pts[1], rs, cs);
    else if (kind === 'angle' && pts.length >= 3) out.degrees = angleDeg(pts[0], pts[1], pts[2], rs || 1, cs || 1);
    else if (kind === 'cobb' && pts.length >= 4) out.degrees = cobbAngleDeg([pts[0], pts[1]], [pts[2], pts[3]], rs || 1, cs || 1);
    else if (kind === 'ellipse' && pts.length >= 4 && px) { const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const st = ellipseStats(px, image.columns, image.rows, [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], Math.max(0.5, (Math.max(...xs) - Math.min(...xs)) / 2), Math.max(0.5, (Math.max(...ys) - Math.min(...ys)) / 2), opts); Object.assign(out, { areaMm2: st.areaMm2, mean: st.mean, sd: st.sd, min: st.min, max: st.max }); }
    else if (kind === 'freehand' && px) { const poly = (a.data.contour?.polyline || []).map(toImg); if (poly.length >= 3) { const st = polygonStats(px, image.columns, image.rows, poly, opts); Object.assign(out, { areaMm2: st.areaMm2, mean: st.mean, sd: st.sd, min: st.min, max: st.max, imagePoints: poly.filter((_, i) => i % Math.max(1, Math.ceil(poly.length / 200)) === 0).map((p) => p.map((v) => Math.round(v * 10) / 10)) }); } }
    else if (kind === 'probe' && pts.length && px) out.value = probeValue(px, image.columns, image.rows, pts[0][0], pts[0][1], opts);
    else if (kind === 'bidirectional' && pts.length >= 4) { const b = bidirectionalMm([pts[0], pts[1]], [pts[2], pts[3]], rs, cs); out.mm = b.longMm; out.shortMm = b.shortMm; }
    else if (kind === 'arrow') out.text = String(a.data.text || a.data.label || '').slice(0, 300);
    return out;
  }
  const M = tools.Enums.MouseBindings;
  group.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: M.Auxiliary }] });
  group.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: M.Secondary }] });
  const LEFT = { wl: tools.WindowLevelTool.toolName, pan: tools.PanTool.toolName, zoom: tools.ZoomTool.toolName, ...TOOL_OF };
  const setLeft = (name) => { for (const t of Object.values(LEFT)) { if (t !== name && ![tools.PanTool.toolName, tools.ZoomTool.toolName].includes(t)) group.setToolPassive(t); } group.setToolActive(name, { bindings: [{ mouseButton: M.Primary }] }); };
  setLeft(LEFT.wl);

  function syncState() {
    if (!vp) return;
    const props = vp.getProperties();
    if (props.voiRange) { const w = voiToWindow(props.voiRange); state.center = w.center; state.width = w.width; }
    state.invert = Boolean(props.invert);
    state.index = vp.getCurrentImageIdIndex();
    state.zoom = vp.getZoom();
  }
  function overlay() {
    if (!state.source) return;
    const hd = state.source.header;
    overlays.tl.textContent = `${hd.patientName ? `${hd.patientName}\n` : ''}${hd.mrn}\n${hd.studyDescription || ''}${hd.seriesDescription ? `\n${hd.seriesNumber != null ? `${hd.seriesNumber}. ` : ''}${hd.seriesDescription}` : ''}`;
    overlays.tr.textContent = `Se ${hd.seriesNumber ?? ''}  Im ${state.index + 1}/${state.source.count}\nW ${Math.round(state.width)}  L ${Math.round(state.center)}`;
    const loc = state.source.locations?.[state.index];
    overlays.bl.textContent = `Image ${state.index + 1} of ${state.source.count}\n${loc != null ? `Loc ${Number(loc).toFixed(1)} mm` : 'Loc n/a'}\n${hd.rowSpacing ? `Spacing ${Number(hd.rowSpacing).toFixed(2)} x ${Number(hd.columnSpacing).toFixed(2)} mm` : 'No pixel spacing'}`;
    overlays.br.textContent = `Zoom ${Math.round(state.zoom * 100)}%\n${hd.bitsStored ?? '?'} bit${hd.compression ? `\n${hd.compression}` : ''}`;
    tag.textContent = `${prior ? 'PRIOR  ' : ''}${state.source.label}${hd.date ? `  ${String(hd.date).slice(0, 10)}` : ''}`;
    callbacks.onChange?.(state);
  }
  function render() { if (vp) { vp.render(); syncState(); overlay(); } }

  async function setSource(source, { keepWindow = false } = {}) {
    state.source = source;
    if (!vp) {
      eng.enableElement({ viewportId, type: core.Enums.ViewportType.STACK, element });
      vp = eng.getViewport(viewportId);
      group.addViewport(viewportId, engineId);
      element.addEventListener(core.Enums.Events.STACK_NEW_IMAGE, () => { syncState(); overlay(); });
      element.addEventListener(core.Enums.Events.VOI_MODIFIED, () => { state.preset = 'Custom'; syncState(); overlay(); });
      element.addEventListener(core.Enums.Events.CAMERA_MODIFIED, () => { syncState(); overlay(); });
      // Annotation events are sent on the library's global event target, not on the pane: keep the ones drawn on this pane's images.
      const seen = new Set();
      onCompleted = (e) => {
        const a = e.detail.annotation;
        if (!a || seen.has(a.annotationUID) || restoring) return;
        const ref = a.metadata?.referencedImageId;
        if (e.detail.viewportId ? e.detail.viewportId !== viewportId : !(ref && state.source?.imageIds.includes(ref))) return;
        seen.add(a.annotationUID);
        const kind = KIND[a.metadata.toolName] || null;
        if (!kind) return;
        const stats = Object.values(a.data.cachedStats || {})[0] || {};
        const ours = measureOurs(kind, a, a.metadata.referencedImageId || state.source.imageIds[state.index]);
        const worldPoints = (kind === 'freehand' ? (a.data.contour?.polyline || []).filter((_, i, all) => i % Math.max(1, Math.ceil(all.length / 200)) === 0) : a.data.handles.points).map((p) => Array.from(p).map((v) => Math.round(v * 100) / 100));
        const m = { kind, plane: state.source.kind, frame: state.index, points: worldPoints, imagePoints: ours.imagePoints || null, mm: kind === 'length' ? (stats.length ?? ours.mm ?? null) : kind === 'bidirectional' ? (ours.mm ?? null) : null, shortMm: ours.shortMm ?? null, degrees: kind === 'angle' ? (stats.angle ?? ours.degrees ?? null) : kind === 'cobb' ? (ours.degrees ?? null) : null, areaMm2: kind === 'roi' ? (stats.area ?? null) : ['ellipse', 'freehand'].includes(kind) ? (ours.areaMm2 ?? null) : null, mean: ours.mean ?? null, sd: ours.sd ?? null, hu: kind === 'probe' ? (ours.value ?? null) : null, text: ours.text || null, uid: a.annotationUID };
        const key = `${state.source.kind}:${state.index}`;
        measurements.set(key, [...(measurements.get(key) || []), m]);
        callbacks.onMeasure?.(m);
      };
      core.eventTarget.addEventListener(tools.Enums.Events.ANNOTATION_COMPLETED, onCompleted);
      element.addEventListener('mousedown', () => { element.focus(); callbacks.onActivate?.(); });
      element.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); callbacks.onActivate?.(); if (e.ctrlKey) command('zoom', state.zoom * Math.exp(-e.deltaY / 400)); else command('scroll', e.deltaY > 0 ? 1 : -1); }, { passive: false, capture: true });
    }
    await vp.setStack(source.imageIds, Math.floor((source.count - 1) / 2));
    // Prefetch the rest of the stack around the image on screen, in the decode workers.
    try { tools.utilities.stackPrefetch.enable(element); } catch { /* prefetch is an optimisation only */ }
    if (!keepWindow) applyAuto();
    vp.resetCamera();
    render();
  }
  function applyAuto() {
    if (!vp) return;
    const w = state.source?.defaultWindow;
    if (w && w.width > 0) vp.setProperties({ voiRange: windowToVoi(w.center, w.width) }); else vp.resetProperties();
    state.preset = 'Auto';
  }
  function command(name, arg) {
    if (!vp) return;
    if (name === 'scroll') vp.setImageIdIndex(Math.max(0, Math.min(state.source.count - 1, state.index + arg)));
    else if (name === 'goto') vp.setImageIdIndex(Math.max(0, Math.min(state.source.count - 1, arg)));
    else if (name === 'first') vp.setImageIdIndex(0);
    else if (name === 'last') vp.setImageIdIndex(state.source.count - 1);
    else if (name === 'invert') vp.setProperties({ invert: !state.invert });
    else if (name === 'reset') { vp.resetCamera(); vp.setProperties({ invert: false }); applyAuto(); }
    else if (name === 'tool') { state.tool = arg; setLeft(LEFT[arg] || LEFT.wl); }
    else if (name === 'preset') { if (arg === 'Auto') applyAuto(); else { vp.setProperties({ voiRange: windowToVoi(WINDOW_PRESETS[arg].center, WINDOW_PRESETS[arg].width) }); state.preset = arg; } }
    else if (name === 'window') { vp.setProperties({ voiRange: windowToVoi(arg.center, Math.max(1, arg.width)) }); state.preset = 'Custom'; }
    else if (name === 'zoom') vp.setZoom(Math.max(0.1, Math.min(20, arg)));
    else if (name === 'clear') { tools.annotation.state.removeAllAnnotations(); measurements.clear(); }
    else if (name === 'remove') { try { tools.annotation.state.removeAnnotation(arg); } catch { /* not on this pane */ } for (const [k, list] of measurements) measurements.set(k, list.filter((x) => x.uid !== arg)); }
    else if (name === 'cine') { if (state.cine) { clearInterval(state.cine); state.cine = null; } else if (state.source?.count > 1) state.cine = setInterval(() => vp.setImageIdIndex((vp.getCurrentImageIdIndex() + 1) % state.source.count), 100); callbacks.onChange?.(state); return; }
    render();
  }
  /** Restores a persisted annotation into the tool state. */
  function restore(m) {
    if (!vp || !state.source) return;
    const toolName = TOOL_OF[m.kind];
    if (!toolName || !Array.isArray(m.points)) return;
    const extra = m.kind === 'freehand' ? { contour: { polyline: m.points.map((p) => [...p]), closed: true } } : m.kind === 'arrow' ? { text: m.text || '' } : {};
    const imageId = state.source.imageIds[m.frame] || state.source.imageIds[0];
    tools.annotation.state.addAnnotation({ annotationUID: m.uid, highlighted: false, invalidated: false, metadata: { toolName, FrameOfReferenceUID: core.metaData.get('imagePlaneModule', imageId)?.frameOfReferenceUID, referencedImageId: imageId, viewPlaneNormal: vp.getCamera().viewPlaneNormal, viewUp: vp.getCamera().viewUp }, data: { handles: { points: m.kind === 'freehand' ? [] : m.points.map((p) => [...p]), activeHandleIndex: null, textBox: { hasMoved: false } }, label: m.label || '', cachedStats: {}, ...extra } }, element);
    const key = `${state.source.kind}:${m.frame}`;
    measurements.set(key, [...(measurements.get(key) || []), m]);
    render();
  }
  const observer = new ResizeObserver(() => { try { eng.resize(true); render(); } catch { /* not enabled yet */ } });
  observer.observe(el);
  return {
    el, canvas: element, state, setSource, command, render, measurements, restore, engine: 'cs3d',
    destroy() { observer.disconnect(); if (onCompleted) core.eventTarget.removeEventListener(tools.Enums.Events.ANNOTATION_COMPLETED, onCompleted); if (state.cine) clearInterval(state.cine); try { tools.ToolGroupManager.destroyToolGroup(`g-${viewportId}`); eng.disableElement(viewportId); } catch { /* already gone */ } },
  };
}

export const ARRANGEMENTS = { '2x2': { panes: ['axial', 'coronal', 'sagittal', '3d'], cls: 'panes n4' }, '1+3': { panes: ['axial', 'coronal', 'sagittal', '3d'], cls: 'panes n4 big1' }, '3d': { panes: ['3d'], cls: 'panes n1' }, 'mpr+prior': { panes: ['axial', 'coronal', 'sagittal', 'prior'], cls: 'panes n4' } };
// Four named 3D looks first (bone, soft tissue, lung, angiography), each mapped to the library's transfer function of that kind.
const NAMED_3D = [['Bone', ['CT-Bone', 'CT-Bones']], ['Soft tissue', ['CT-Soft-Tissue', 'CT-Muscle', 'CT-Fat']], ['Lung', ['CT-Lung', 'CT-Chest-Contrast-Enhanced']], ['Angiography', ['CT-Coronary-Arteries-2', 'CT-Coronary-Arteries', 'CT-AAA', 'CT-Cardiac']]];
export const SLAB_MODES = [['off', 'Thin slice'], ['mip', 'MIP (brightest)'], ['minip', 'MinIP (darkest)'], ['average', 'Average']];

/**
 * True MPR with linked crosshairs, slab thickness with MIP, MinIP and average, and a 3D volume pane with
 * presets and a clipping box: up to four viewports on one volume. arrangement picks the panes
 * (see ARRANGEMENTS); priorEl is the prior study's pane for 'mpr+prior'.
 */
export async function createVolumeLayout({ source, container, callbacks = {}, arrangement = '2x2', priorEl = null }) {
  const { core, tools, vtkPlane } = await cornerstone();
  const eng = await renderingEngine();
  const seq = (groupSeq += 1);
  const plan = ARRANGEMENTS[arrangement] || ARRANGEMENTS['2x2'];
  const t0 = performance.now(); let firstAt = null; let fullAt = null;
  const volume = await core.volumeLoader.createAndCacheVolume(source.volumeId, { imageIds: source.imageIds });
  // Progressive: the volume fills in as slices arrive; the first slice shows at once.
  volume.load((evt) => { if (firstAt == null) { firstAt = performance.now() - t0; callbacks.onTiming?.({ firstMs: firstAt }); } if (evt?.framesProcessed != null && evt?.totalNumFrames != null && evt.framesProcessed >= evt.totalNumFrames && fullAt == null) { fullAt = performance.now() - t0; callbacks.onTiming?.({ firstMs: firstAt, fullMs: fullAt }); } });
  if (volume.loadStatus?.loaded && fullAt == null) { firstAt = firstAt ?? 0; fullAt = performance.now() - t0; callbacks.onTiming?.({ firstMs: firstAt, fullMs: fullAt, cached: true }); }
  const ORIENT = { axial: core.Enums.OrientationAxis.AXIAL, coronal: core.Enums.OrientationAxis.CORONAL, sagittal: core.Enums.OrientationAxis.SAGITTAL };
  const made = [];
  const M = tools.Enums.MouseBindings;
  const inputs = [];
  const orthoNames = plan.panes.filter((p) => ORIENT[p]);
  for (const name of orthoNames) {
    const element = h('div', { class: 'cs-element', testid: `viewport-canvas-${name}`, tabindex: 0, role: 'img', 'aria-label': `${name} plane`, style: 'position:absolute;inset:0' });
    element.oncontextmenu = (e) => e.preventDefault();
    const tagEl = h('div', { class: 'pane-tag', testid: `pane-tag-${name}` }, name.replace(/^\w/, (m) => m.toUpperCase()));
    const tr = h('div', { class: 'overlay tr', testid: `overlay-tr-${name}` });
    const el = h('div', { class: 'viewport cs3d', testid: `viewport-${name}` }, element, tr, tagEl);
    inputs.push({ viewportId: `${name}-${seq}`, type: core.Enums.ViewportType.ORTHOGRAPHIC, element, defaultOptions: { orientation: ORIENT[name], background: [0, 0, 0] } });
    made.push({ id: name, el, element, tr });
  }
  const has3d = plan.panes.includes('3d');
  const el3d = h('div', { class: 'cs-element', testid: 'viewport-canvas-3d', tabindex: 0, role: 'img', 'aria-label': '3D volume rendering', style: 'position:absolute;inset:0' });
  el3d.oncontextmenu = (e) => e.preventDefault();
  const presetSelect = h('select', { testid: 'volume-preset', 'aria-label': 'Volume rendering preset', class: 'pane-select' });
  const all = core.CONSTANTS.VIEWPORT_PRESETS.map((p) => p.name);
  const named = NAMED_3D.map(([label, tries]) => [label, tries.find((n) => all.includes(n))]).filter(([, n]) => n);
  const presets = [...named.map(([, n]) => n), ...all.filter((n) => /^CT-|^MR-/.test(n) && !named.some(([, x]) => x === n)).slice(0, 20)];
  for (const name of presets) presetSelect.append(h('option', { value: name }, named.find(([, n]) => n === name)?.[0] || name));
  const el3dWrap = h('div', { class: 'viewport cs3d', testid: 'viewport-3d' }, el3d, h('div', { class: 'pane-tag', testid: 'pane-tag-3d' }, '3D volume'), presetSelect);
  if (has3d) inputs.push({ viewportId: `volume3d-${seq}`, type: core.Enums.ViewportType.VOLUME_3D, element: el3d, defaultOptions: { background: [0, 0, 0] } });
  // The elements must be in the document with their final size before the viewports are enabled, or the canvases keep the 300 x 150 default.
  container.className = plan.cls;
  container.append(...plan.panes.map((p) => (p === '3d' ? el3dWrap : p === 'prior' ? priorEl : made.find((m) => m.id === p).el)).filter(Boolean));
  eng.setViewports(inputs);
  let group = null;
  if (orthoNames.length) {
    group = tools.ToolGroupManager.createToolGroup(`mpr-${seq}`);
    group.addTool(tools.CrosshairsTool.toolName, { getReferenceLineColor: (id) => ({ [`axial-${seq}`]: '#ffd24a', [`coronal-${seq}`]: '#4fb3d1', [`sagittal-${seq}`]: '#9be36d' }[id] || '#fff') });
    group.addTool(tools.WindowLevelTool.toolName); group.addTool(tools.ZoomTool.toolName); group.addTool(tools.PanTool.toolName); group.addTool(tools.StackScrollTool.toolName);
    for (const m of made) group.addViewport(`${m.id}-${seq}`, engineId);
    await core.setVolumesForViewports(eng, [{ volumeId: source.volumeId }], made.map((m) => `${m.id}-${seq}`));
  }
  let v3 = null; let group3d = null; let applyPreset = () => {};
  if (has3d) {
    group3d = tools.ToolGroupManager.createToolGroup(`vol-${seq}`);
    group3d.addTool(tools.TrackballRotateTool.toolName); group3d.addTool(tools.ZoomTool.toolName); group3d.addTool(tools.PanTool.toolName);
    group3d.addViewport(`volume3d-${seq}`, engineId);
    group3d.setToolActive(tools.TrackballRotateTool.toolName, { bindings: [{ mouseButton: M.Primary }] });
    group3d.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: M.Secondary }] });
    group3d.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: M.Auxiliary }] });
    v3 = eng.getViewport(`volume3d-${seq}`);
    await v3.setVolumes([{ volumeId: source.volumeId }]);
    applyPreset = (name) => { try { v3.setProperties({ preset: name }); v3.render(); callbacks.onPreset?.(named.find(([, n]) => n === name)?.[0] || name); } catch (err) { console.warn('preset', err.message); } };
    const bone = named.find(([l]) => l === 'Bone')?.[1];
    const defaultPreset = bone && source.header.modality === 'CT' ? bone : presets[0];
    presetSelect.value = defaultPreset;
    applyPreset(defaultPreset);
    presetSelect.addEventListener('change', (e) => applyPreset(e.target.value));
  }
  if (group) {
    group.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: M.Primary }] });
    group.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: M.Secondary }] });
    group.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: M.Auxiliary }] });
    group.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: M.Wheel }] });
  }
  const w = source.defaultWindow;
  const ortho = (m) => eng.getViewport(`${m.id}-${seq}`);
  for (const m of made) { if (w && w.width > 0) ortho(m).setProperties({ voiRange: windowToVoi(w.center, w.width) }); }
  eng.renderViewports(inputs.map((i) => i.viewportId));

  // ----- slab thickness with MIP, MinIP and average on the three planes -----
  const slab = { mode: 'off', mm: 10 };
  const BLEND = { off: core.Enums.BlendModes.COMPOSITE, mip: core.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND, minip: core.Enums.BlendModes.MINIMUM_INTENSITY_BLEND, average: core.Enums.BlendModes.AVERAGE_INTENSITY_BLEND };
  function applySlab() {
    for (const m of made) { const vp = ortho(m); try { vp.setBlendMode(BLEND[slab.mode]); vp.setSlabThickness(slab.mode === 'off' ? core.CONSTANTS.RENDERING_DEFAULTS?.MINIMUM_SLAB_THICKNESS ?? 0.05 : Math.max(0.1, slab.mm)); vp.render(); } catch (err) { console.warn('slab', err.message); } }
    overlay();
  }
  // ----- clipping box on the 3D pane: six planes, each face given as a fraction of the volume along its axis -----
  const clip = { on: false, x: [0, 1], y: [0, 1], z: [0, 1] };
  function applyClip() {
    if (!v3) return;
    try {
      const actor = v3.getDefaultActor?.()?.actor ?? v3.getActors?.()[0]?.actor; const mapper = actor?.getMapper?.(); if (!mapper) return;
      mapper.removeAllClippingPlanes();
      if (clip.on) {
        const b = volume.imageData.getBounds(); // world box [xmin, xmax, ymin, ymax, zmin, zmax]
        const at = (axis, f) => b[axis * 2] + (b[axis * 2 + 1] - b[axis * 2]) * f;
        ['x', 'y', 'z'].forEach((k, axis) => {
          const lo = [0, 0, 0]; lo[axis] = at(axis, clip[k][0]); const nLo = [0, 0, 0]; nLo[axis] = 1;
          const hi = [0, 0, 0]; hi[axis] = at(axis, clip[k][1]); const nHi = [0, 0, 0]; nHi[axis] = -1;
          mapper.addClippingPlane(vtkPlane.newInstance({ origin: lo, normal: nLo })); mapper.addClippingPlane(vtkPlane.newInstance({ origin: hi, normal: nHi }));
        });
      }
      v3.render();
    } catch (err) { console.warn('clip', err.message); }
  }
  const slabMode = h('select', { testid: 'slab-mode', 'aria-label': 'Slab mode on the three planes', onChange: (e) => { slab.mode = e.target.value; applySlab(); callbacks.onSlab?.({ ...slab }); } }, SLAB_MODES.map(([v, t]) => h('option', { value: v }, t)));
  const slabMm = h('input', { type: 'number', min: 1, max: 200, step: 1, value: String(slab.mm), testid: 'slab-thickness', 'aria-label': 'Slab thickness in millimetres', style: 'width:5.25rem', onChange: (e) => { slab.mm = Math.max(1, Math.min(200, Number(e.target.value) || 10)); applySlab(); callbacks.onSlab?.({ ...slab }); } });
  const clipOn = h('input', { type: 'checkbox', testid: 'clip-on', 'aria-label': 'Clipping box on the 3D pane', style: 'width:auto;height:auto', onChange: (e) => { clip.on = e.target.checked; applyClip(); callbacks.onClip?.({ ...clip }); } });
  const clipInputs = ['x', 'y', 'z'].flatMap((k) => [0, 1].map((side) => h('input', { type: 'range', min: 0, max: 100, value: String(clip[k][side] * 100), testid: `clip-${k}-${side ? 'max' : 'min'}`, 'aria-label': `Clipping box: ${k} ${side ? 'far' : 'near'} face`, style: 'width:4.375rem', onInput: (e) => { const v = Number(e.target.value) / 100; clip[k][side] = side ? Math.max(v, clip[k][0] + 0.02) : Math.min(v, clip[k][1] - 0.02); applyClip(); } })));
  const controls = h('div', { class: 'volbar', testid: 'volume-controls', role: 'toolbar', 'aria-label': 'Volume tools' },
    ...(orthoNames.length ? [h('label', { class: 'small' }, 'Slab ', slabMode), h('label', { class: 'small' }, 'Thickness (mm) ', slabMm)] : []),
    ...(has3d ? [h('label', { class: 'small' }, clipOn, ' Clipping box'), h('span', { class: 'small muted' }, 'x'), clipInputs[0], clipInputs[1], h('span', { class: 'small muted' }, 'y'), clipInputs[2], clipInputs[3], h('span', { class: 'small muted' }, 'z'), clipInputs[4], clipInputs[5]] : []));

  const overlay = () => { for (const m of made) { const vp = ortho(m); if (!vp) return; const idx = vp.getSliceIndex?.() ?? 0; const n = vp.getNumberOfSlices?.() ?? 0; const props = vp.getProperties(); const win = props.voiRange ? voiToWindow(props.voiRange) : { width: 0, center: 0 }; m.tr.textContent = `Slice ${idx + 1}/${n}\nW ${Math.round(win.width)}  L ${Math.round(win.center)}${slab.mode === 'off' ? '' : `\n${SLAB_MODES.find(([v]) => v === slab.mode)[1]} ${slab.mm} mm`}`; } };
  // For the prior pane: tell the page where the axial plane is (mm along the patient), so the prior can follow by position.
  const axial = made.find((m) => m.id === 'axial');
  const tellAxial = () => { if (!axial || !callbacks.onAxialLocation || !ortho(axial)) return; try { callbacks.onAxialLocation(ortho(axial).getCamera().focalPoint[2]); } catch { /* not ready */ } };
  for (const m of made) { m.element.addEventListener(core.Enums.Events.VOLUME_NEW_IMAGE, () => { overlay(); if (m === axial) tellAxial(); }); m.element.addEventListener(core.Enums.Events.CAMERA_MODIFIED, () => { overlay(); if (m === axial) tellAxial(); }); m.element.addEventListener(core.Enums.Events.VOI_MODIFIED, overlay); m.element.addEventListener('mousedown', () => callbacks.onActivate?.(m.id)); }
  setTimeout(() => { overlay(); tellAxial(); }, 300);
  const observer = new ResizeObserver(() => { try { eng.resize(true); } catch { /* ignore */ } });
  observer.observe(container);
  return {
    el: container, controls, arrangement, viewports: made.map((m) => ({ id: m.id, el: m.el })), presets, applyPreset, slab, clip,
    setSlab(mode, mm) { slab.mode = BLEND[mode] ? mode : 'off'; if (mm) slab.mm = mm; slabMode.value = slab.mode; slabMm.value = String(slab.mm); applySlab(); },
    setClip(next) { Object.assign(clip, next); clipOn.checked = clip.on; applyClip(); },
    timing: () => ({ firstMs: firstAt, fullMs: fullAt }),
    setPreset(name) { for (const m of made) { const vp = ortho(m); if (name === 'Auto') { if (w) vp.setProperties({ voiRange: windowToVoi(w.center, w.width) }); } else vp.setProperties({ voiRange: windowToVoi(WINDOW_PRESETS[name].center, WINDOW_PRESETS[name].width) }); vp.render(); } overlay(); },
    destroy() { observer.disconnect(); try { if (group) tools.ToolGroupManager.destroyToolGroup(`mpr-${seq}`); if (group3d) tools.ToolGroupManager.destroyToolGroup(`vol-${seq}`); for (const i of inputs) eng.disableElement(i.viewportId); } catch { /* already gone */ } },
  };
}
