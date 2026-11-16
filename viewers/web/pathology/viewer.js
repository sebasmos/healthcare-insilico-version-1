// The slide viewer: OpenSeadragon (vendored, no CDN) over the
// server's tile routes, objective buttons from microns per pixel, a scale
// bar, rotate, fit, full screen, measurement and annotation tools drawn on
// an overlay canvas in level-0 pixel coordinates, and coarse viewed-area
// tracking by tile-grid cell. Every control has a data-testid and a label.
import { h } from '/shared/ui.js';
import { createMaskLayer } from '/shared/masks.js';

let osdPromise = null;
export function openSeadragon() { if (!osdPromise) osdPromise = import('/vendor/openseadragon.js').then((m) => m.default || m.OpenSeadragon); return osdPromise; }

export const OBJECTIVES = [1, 2, 5, 10, 20, 40];
export const TOOLS = [['none', 'Navigate', 'Pan and zoom'], ['ruler', 'Ruler', 'Ruler: click two points (µm)'], ['area', 'Area', 'Area: click the corners, double-click to close (µm² or mm²)'], ['count', 'Count', 'Point counter: click to add points, Enter to finish'], ['arrow', 'Arrow', 'Arrow with text: click the tip, then the tail'], ['text', 'Text', 'Text note: click where it belongs'], ['rect', 'Rect', 'Rectangle region: drag'], ['ellipse', 'Ellipse', 'Ellipse region: drag'], ['polygon', 'Polygon', 'Polygon region: click the corners, double-click to close'], ['freehand', 'Freehand', 'Freehand region: drag'], ['line', 'Line', 'Line: click along it, double-click to end'], ['point', 'Point', 'Point: click'], ['wand', 'Wand', 'Wand: click to select the similar-looking region'], ['select', 'Select', 'Select a shape to move it, change its class, merge, split or remove it (Shift adds to the selection)'], ['split', 'Split', 'Split the selected shape: drag a line across it']];
const BRUSH = { size: 40, label: 'Finding', colour: '#F7313B', erase: false };
const COLOURS = { ruler: '#ffd24a', area: '#9be36d', count: '#4fb3d1', arrow: '#ff8a65', text: '#ff8a65', rect: '#e8a0c8', freehand: '#e8a0c8', region: '#ffd24a', ellipse: '#e8a0c8', polygon: '#9be36d', line: '#ffd24a', point: '#4fb3d1' };
// Classes get a steady colour from their name unless the annotation carries its own.
export const CLASS_COLOURS = ['#F7313B', '#1F9FBF', '#E0A83A', '#8E6AD8', '#2EA043', '#FF7F50', '#00BFC4', '#C71585', '#7A8190'];
export const classColour = (name) => { if (!name) return null; let n = 0; for (const ch of String(name)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return CLASS_COLOURS[n % CLASS_COLOURS.length]; };
const pointInPoly = (x, y, pts) => { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) { const [xi, yi] = pts[i]; const [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
/** The closed outline of a shape in image pixels, or null for lines, points and notes. */
export const outlineOf = (a) => (['rect', 'region'].includes(a.kind) && a.points.length >= 2 ? [[a.points[0][0], a.points[0][1]], [a.points[1][0], a.points[0][1]], [a.points[1][0], a.points[1][1]], [a.points[0][0], a.points[1][1]]] : a.kind === 'ellipse' && a.points.length >= 2 ? Array.from({ length: 40 }, (_, i) => [(a.points[0][0] + a.points[1][0]) / 2 + (Math.abs(a.points[1][0] - a.points[0][0]) / 2) * Math.cos((Math.PI * i) / 20), (a.points[0][1] + a.points[1][1]) / 2 + (Math.abs(a.points[1][1] - a.points[0][1]) / 2) * Math.sin((Math.PI * i) / 20)]) : ['area', 'freehand', 'polygon'].includes(a.kind) && a.points.length >= 3 && a.closed !== false ? a.points : null);

/** The custom tile source: OpenSeadragon level 0 is the smallest pyramid level; the server's level 0 is the largest. */
async function tileSourceFor(OSD, info) {
  const n = info.levels.length;
  class SlideSource extends OSD.TileSource {
    constructor() { super({ width: info.width, height: info.height, tileSize: info.tileWidth, tileOverlap: 0, minLevel: 0, maxLevel: n - 1 }); }
    lv(level) { return info.levels[n - 1 - level]; }
    getLevelScale(level) { return this.lv(level).scale; }
    getNumTiles(level) { const l = this.lv(level); return new OSD.Point(l.tilesAcross, l.tilesDown); }
    getTileWidth() { return info.tileWidth; }
    getTileHeight() { return info.tileLength; }
    getTileUrl(level, x, y) { return `/pathology/slides/${info.id}/tiles/${this.lv(level).level}/${x}_${y}.jpg`; }
  }
  return new SlideSource();
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polygonArea = (pts) => { let s = 0; for (let i = 0; i < pts.length; i += 1) { const a = pts[i]; const b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
export const fmtLength = (um) => (um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} µm`);
export const fmtArea = (um2) => (um2 >= 1e6 ? `${(um2 / 1e6).toFixed(3)} mm²` : `${Math.round(um2)} µm²`);
const niceBar = (umPerPx, maxPx = 120) => { const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]; let best = steps[0]; for (const s of steps) if (s / umPerPx <= maxPx) best = s; return { um: best, px: best / umPerPx }; };

/**
 * Creates one slide pane. callbacks: onActivate(), onMeasure(annotation), onView(state), onViewed(cells), onRegion(boxes).
 * Returns { el, load(info), command(name, arg), state, annotations, restore(a), clear(), destroy(), viewer }.
 */
export async function createSlidePane({ id, callbacks = {}, region = false }) {
  const OSD = await openSeadragon();
  const osdEl = h('div', { class: 'osd', testid: `slide-osd-${id}`, tabindex: 0, role: 'img', 'aria-label': `Slide pane ${id}` });
  const canvas = h('canvas', { class: 'tools-canvas', testid: `slide-tools-${id}`, 'aria-hidden': 'true' });
  const scalebar = h('div', { class: 'scalebar', testid: `scalebar-${id}` }, h('div', { class: 'bar' }), h('span'));
  const mag = h('div', { class: 'mag', testid: `mag-${id}` });
  const tag = h('div', { class: 'pane-tag', testid: `pane-tag-${id}` });
  const navigator = h('div', { class: 'navigator', id: `navigator-${id}-${Math.random().toString(36).slice(2, 7)}`, testid: `navigator-${id}` });
  // Channel filter for the display controls (an SVG colour matrix used from CSS).
  const filterId = `chan-${id}-${Math.random().toString(36).slice(2, 7)}`;
  const svgNs = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
  const filterEl = document.createElementNS(svgNs, 'filter'); filterEl.setAttribute('id', filterId); filterEl.setAttribute('color-interpolation-filters', 'sRGB'); const matrix = document.createElementNS(svgNs, 'feColorMatrix'); matrix.setAttribute('type', 'matrix'); matrix.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0'); filterEl.append(matrix); svg.append(filterEl);
  const stainCanvas = h('canvas', { class: 'stain-canvas', testid: `stain-view-${id}`, 'aria-hidden': 'true', hidden: true });
  const el = h('div', { class: 'slidepane', testid: `slidepane-${id}` }, osdEl, stainCanvas, canvas, mag, tag, scalebar, navigator, svg);
  const state = { info: null, tool: region ? 'region' : 'none', objective: null, rotation: 0, heat: false, mpp: null, magnification: 20 };
  let viewer = null;
  let annotations = [];
  let draft = null;
  const overlay = { polygons: [], cells: [], examples: new Map(), picked: new Set() };
  const viewed = new Map();
  let lastView = null;
  let regions = [];
  // Brush mask at a working scale (at most 2048 px across) with level-0 coordinates recorded on the mask.
  let mask = null; let maskScale = 1;
  const maskCanvas = document.createElement('canvas');
  const maskLayer = () => { if (!mask && state.info) { const w = Math.min(2048, state.info.width); maskScale = w / state.info.width; mask = createMaskLayer(w, Math.max(1, Math.round(state.info.height * maskScale))); } return mask; };
  const ctx = canvas.getContext('2d');

  const toImage = (px, py) => { const vp = viewer.viewport.pointFromPixel(new OSD.Point(px, py), true); const ip = viewer.viewport.viewportToImageCoordinates(vp); return [ip.x, ip.y]; };
  const toScreen = (p) => { const s = viewer.viewport.imageToViewerElementCoordinates(new OSD.Point(p[0], p[1])); return [s.x, s.y]; };
  const imageZoom = () => viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom(true));

  function resize() { const r = el.getBoundingClientRect(); canvas.width = Math.max(1, Math.round(r.width)); canvas.height = Math.max(1, Math.round(r.height)); draw(); }
  function draw() {
    if (!viewer || !state.info) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.heat) {
      const max = Math.max(1, ...viewed.values());
      for (const [key, ms] of viewed) { const [cx, cy, size] = key.split(':').map(Number); const a = toScreen([cx * size, cy * size]); const b = toScreen([(cx + 1) * size, (cy + 1) * size]); ctx.fillStyle = `rgba(255, 120, 40, ${0.08 + 0.5 * (ms / max)})`; ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); }
    }
    if (mask && mask.count()) {
      if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) { maskCanvas.width = mask.width; maskCanvas.height = mask.height; }
      const img = maskCanvas.getContext('2d').createImageData(mask.width, mask.height);
      const [r, g, b] = [parseInt(BRUSH.colour.slice(1, 3), 16), parseInt(BRUSH.colour.slice(3, 5), 16), parseInt(BRUSH.colour.slice(5, 7), 16)];
      for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i]) { img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 110; }
      maskCanvas.getContext('2d').putImageData(img, 0, 0);
      const a = toScreen([0, 0]); const b2 = toScreen([state.info.width, state.info.height]);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(maskCanvas, a[0], a[1], b2[0] - a[0], b2[1] - a[1]); ctx.imageSmoothingEnabled = true;
    }
    const paint = (a, ghost = false) => {
      const pts = a.points.map(toScreen);
      const need = { ruler: 2, arrow: 2, rect: 2, region: 2, ellipse: 2, text: 1 }[a.kind] ?? 1;
      if (pts.length < need) return;
      const col = a.colour || classColour(a.class || (['rect', 'ellipse', 'polygon', 'freehand', 'area', 'point', 'line'].includes(a.kind) ? a.label : null)) || COLOURS[a.kind] || '#fff';
      ctx.lineWidth = a.id && a.id === state.selected ? 4 : 2; ctx.strokeStyle = col; ctx.fillStyle = col; ctx.font = `${parseFloat(getComputedStyle(document.documentElement).fontSize) || 16}px ui-monospace, monospace`;
      if (a.kind === 'ellipse') { const [p, q] = pts; ctx.beginPath(); ctx.ellipse((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Math.abs(q[0] - p[0]) / 2, Math.abs(q[1] - p[1]) / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
      else if (a.kind === 'polygon') { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); if (a.closed !== false) ctx.closePath(); ctx.stroke(); }
      else if (a.kind === 'line' || a.kind === 'split') { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.stroke(); }
      else if (a.kind === 'point') { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 6, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 1.5, 0, Math.PI * 2); ctx.fill(); }
      if (a.id && a.id === state.selected) { ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); ctx.strokeRect(Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(...xs) - Math.min(...xs) + 12, Math.max(...ys) - Math.min(...ys) + 12); ctx.restore(); }
      ctx.setLineDash(ghost ? [6, 4] : []);
      if (a.kind === 'ruler' || a.kind === 'arrow') { ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.stroke(); if (a.kind === 'arrow') { const ang = Math.atan2(pts[0][1] - pts[1][1], pts[0][0] - pts[1][0]); ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(pts[0][0] - 12 * Math.cos(ang - 0.4), pts[0][1] - 12 * Math.sin(ang - 0.4)); ctx.lineTo(pts[0][0] - 12 * Math.cos(ang + 0.4), pts[0][1] - 12 * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill(); } }
      else if (a.kind === 'rect' || a.kind === 'region') { const [p, q] = pts; ctx.strokeRect(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])); }
      else if (a.kind === 'area' || a.kind === 'freehand') { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); if (a.closed !== false) ctx.closePath(); ctx.stroke(); }
      else if (a.kind === 'count') { for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.stroke(); } }
      else if (a.kind === 'text') { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 4, 0, Math.PI * 2); ctx.fill(); }
      const size = (a.kind === 'ruler' || a.kind === 'line') && a.microns != null ? fmtLength(a.microns) : ['area', 'freehand', 'rect', 'ellipse', 'polygon'].includes(a.kind) && a.areaUm2 != null ? fmtArea(a.areaUm2) : a.kind === 'count' ? `${a.points.length}` : '';
      const label = [a.class || a.label || '', size, a.text || ''].filter(Boolean).join(' · ');
      if (label) { const at = pts[pts.length - 1]; ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeText(label, at[0] + 8, at[1] - 6); ctx.fillText(label, at[0] + 8, at[1] - 6); }
      ctx.setLineDash([]);
    };
    // Analysis overlays: outlines from tissue detection and pixel classification, and detected cells coloured by class.
    for (const pg of overlay.polygons) { const pts = pg.points.map(toScreen); ctx.save(); ctx.setLineDash([8, 4]); ctx.lineWidth = 2; ctx.strokeStyle = pg.colour || classColour(pg.class) || '#7CFC9A'; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.stroke(); ctx.restore(); }
    if (overlay.cells.length) {
      const zoom = imageZoom(); const w0 = canvas.width; const h0 = canvas.height; let shown = 0;
      for (let i = 0; i < overlay.cells.length; i += 1) { const c = overlay.cells[i]; const [sx, sy] = toScreen([c.x, c.y]); if (sx < -10 || sy < -10 || sx > w0 + 10 || sy > h0 + 10) continue; shown += 1; if (shown > 6000) break; const r = Math.max(2, c.radius * zoom); ctx.lineWidth = overlay.picked.has(i) ? 3 : 1.5; ctx.strokeStyle = classColour(overlay.examples.get(i) || c.class) || '#7CFC9A'; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke(); if (overlay.examples.has(i)) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.5, r / 3), 0, Math.PI * 2); ctx.fill(); } }
    }
    for (const a of annotations) paint(a);
    for (const r of regions) paint({ kind: 'region', points: r.points, label: r.label, ghost: r.ghost }, r.ghost);
    if (draft) paint(draft);
  }
  function hud() {
    if (!viewer || !state.info) return;
    const z = imageZoom();
    const umPerPx = state.mpp ? state.mpp / z : null;
    const objective = state.magnification * z;
    mag.textContent = `${objective >= 1 ? objective.toFixed(objective >= 10 ? 0 : 1) : objective.toFixed(2)}x${state.mpp ? `\n${state.mpp} µm/px scan` : ''}`;
    if (umPerPx) { const bar = niceBar(umPerPx); scalebar.firstChild.style.width = `${Math.round(bar.px)}px`; scalebar.lastChild.textContent = fmtLength(bar.um); scalebar.hidden = false; } else scalebar.hidden = true;
    callbacks.onView?.({ objective, zoom: z });
  }
  // Coarse viewed-area telemetry: which tile-grid cells (512 level-0 pixels at 1x, finer at higher power) were on screen for how long.
  function trackView() {
    if (!viewer || !state.info) return;
    const now = Date.now();
    const z = imageZoom();
    const size = z >= 0.5 ? 256 : z >= 0.125 ? 1024 : 4096;
    const b = viewer.viewport.viewportToImageRectangle(viewer.viewport.getBounds(true));
    const cells = [];
    for (let cy = Math.max(0, Math.floor(b.y / size)); cy <= Math.min(Math.ceil(state.info.height / size) - 1, Math.floor((b.y + b.height) / size)); cy += 1) for (let cx = Math.max(0, Math.floor(b.x / size)); cx <= Math.min(Math.ceil(state.info.width / size) - 1, Math.floor((b.x + b.width) / size)); cx += 1) cells.push(`${cx}:${cy}:${size}`);
    if (lastView) { const ms = now - lastView.at; if (ms >= 300 && lastView.cells.length <= 64) { for (const k of lastView.cells) viewed.set(k, (viewed.get(k) || 0) + ms); callbacks.onViewed?.(lastView.cells.map((k) => { const [x, y, s] = k.split(':').map(Number); return { x, y, size: s, ms: Math.min(ms, 600000) }; }), lastView.objective); } }
    lastView = { at: now, cells, objective: Math.round(state.magnification * z * 10) / 10 };
  }

  async function load(info) {
    state.info = info; state.mpp = info.mpp; state.magnification = info.magnification || 20;
    annotations = []; draft = null; viewed.clear(); lastView = null;
    if (viewer) { viewer.destroy(); viewer = null; }
    const source = await tileSourceFor(OSD, info);
    viewer = OSD({ element: osdEl, tileSources: source, showNavigationControl: false, showNavigator: true, navigatorId: navigator.id, navigatorAutoFade: false, gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false }, maxZoomPixelRatio: 4, minZoomImageRatio: 0.5, visibilityRatio: 0.3, constrainDuringPan: false, animationTime: 0.4, imageLoaderLimit: 6, timeout: 60000, crossOriginPolicy: false, loadTilesWithAjax: false });
    viewer.addHandler('open', () => { resize(); hud(); trackView(); callbacks.onOpen?.(info); });
    viewer.addHandler('animation', () => { draw(); hud(); });
    viewer.addHandler('animation-finish', () => { draw(); hud(); trackView(); });
    viewer.addHandler('resize', resize);
    viewer.addHandler('rotate', draw);
    viewer.addHandler('canvas-click', () => { osdEl.focus(); callbacks.onActivate?.(); });
    tag.textContent = `${info.stain || ''} ${info.description || ''}`.trim();
    command('tool', state.tool);
  }

  // ----- tools on the overlay canvas -----
  const finish = (a) => {
    draft = null;
    if (a.kind === 'ruler') a.microns = state.mpp ? dist(a.points[0], a.points[1]) * state.mpp : null;
    if (a.kind === 'area' || a.kind === 'freehand') a.areaUm2 = state.mpp ? polygonArea(a.points) * state.mpp * state.mpp : null;
    if (a.kind === 'rect') a.areaUm2 = state.mpp ? Math.abs(a.points[1][0] - a.points[0][0]) * Math.abs(a.points[1][1] - a.points[0][1]) * state.mpp * state.mpp : null;
    if (a.kind === 'count') a.count = a.points.length;
    if (a.kind === 'ellipse') a.areaUm2 = state.mpp ? Math.PI * (Math.abs(a.points[1][0] - a.points[0][0]) / 2) * (Math.abs(a.points[1][1] - a.points[0][1]) / 2) * state.mpp * state.mpp : null;
    if (a.kind === 'polygon') a.areaUm2 = state.mpp ? polygonArea(a.points) * state.mpp * state.mpp : null;
    if (a.kind === 'line') a.microns = state.mpp ? a.points.reduce((n, p, i) => (i ? n + dist(a.points[i - 1], p) : 0), 0) * state.mpp : null;
    if (state.class && ['rect', 'ellipse', 'polygon', 'freehand', 'area', 'point', 'line', 'count'].includes(a.kind)) { a.class = state.class; a.label = state.class; a.colour = state.classColour || null; }
    a.points = a.points.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    annotations.push(a); draw();
    callbacks.onMeasure?.(a);
  };
  const finishRegion = (p, q) => { const box = { points: [[Math.round(Math.min(p[0], q[0])), Math.round(Math.min(p[1], q[1]))], [Math.round(Math.max(p[0], q[0])), Math.round(Math.max(p[1], q[1]))]], label: state.regionLabel || null }; regions = [...regions.filter((r) => !r.ghost), box, ...regions.filter((r) => r.ghost)]; draft = null; draw(); callbacks.onRegion?.(regions.filter((r) => !r.ghost)); };
  let dragging = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!viewer || state.tool === 'none') return;
    callbacks.onActivate?.();
    const r = canvas.getBoundingClientRect(); const p = toImage(e.clientX - r.left, e.clientY - r.top);
    const t = state.tool;
    if (t === 'brush' || t === 'erase') { const m = maskLayer(); m.begin(); m.paint(p[0] * maskScale, p[1] * maskScale, BRUSH.size * maskScale, t === 'erase'); dragging = { brush: true }; canvas.setPointerCapture(e.pointerId); draw(); return; }
    if (t === 'wand') { callbacks.onWand?.(p); return; }
    if (t === 'cell-pick') { let best = -1; let bd = Infinity; overlay.cells.forEach((c, i) => { const d = dist([c.x, c.y], p); if (d < bd && d <= Math.max(c.radius * 1.5, 8 / imageZoom())) { bd = d; best = i; } }); if (best >= 0) callbacks.onCellPick?.(best, overlay.cells[best]); return; }
    if (t === 'point') { finish({ kind: 'point', points: [p] }); return; }
    if (t === 'select') {
      // The topmost shape under the pointer (smallest closed shape first, then anything within a few screen pixels of the click).
      const tol = 8 / imageZoom(); let hit = null; let hitArea = Infinity;
      for (const a of annotations) { const o = outlineOf(a); if (o && pointInPoly(p[0], p[1], o)) { const ar = polygonArea(o); if (ar < hitArea) { hit = a; hitArea = ar; } } }
      if (!hit) hit = annotations.find((a) => a.points.some((q) => dist(q, p) <= tol)) || null;
      state.selected = hit?.id || null; callbacks.onSelect?.(hit, e.shiftKey);
      if (hit) { dragging = { move: hit, from: p, start: hit.points.map((q) => [...q]), moved: false }; canvas.setPointerCapture(e.pointerId); }
      draw(); return;
    }
    if (t === 'split') { dragging = { from: p }; draft = { kind: 'split', points: [p, p] }; canvas.setPointerCapture(e.pointerId); draw(); return; }
    if (t === 'rect' || t === 'freehand' || t === 'region' || t === 'ellipse') { dragging = { from: p }; draft = { kind: t, points: [p, p], closed: false }; canvas.setPointerCapture(e.pointerId); draw(); return; }
    if (!draft) { draft = { kind: t, points: [p], closed: false }; if (t === 'text') { const text = window.prompt('Text note'); if (text && text.trim()) finish({ kind: 'text', points: [p], text: text.trim() }); else draft = null; } draw(); return; }
    draft.points.push(p);
    if (t === 'ruler') finish({ kind: 'ruler', points: draft.points.slice(0, 2) });
    else if (t === 'arrow') { const text = window.prompt('Arrow label (optional)') || ''; finish({ kind: 'arrow', points: draft.points.slice(0, 2), text: text.trim() }); }
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!viewer) return;
    if (dragging?.brush) { const r0 = canvas.getBoundingClientRect(); const p0 = toImage(e.clientX - r0.left, e.clientY - r0.top); maskLayer().paint(p0[0] * maskScale, p0[1] * maskScale, BRUSH.size * maskScale, state.tool === 'erase'); draw(); return; }
    if (dragging?.move) { const r1 = canvas.getBoundingClientRect(); const p1 = toImage(e.clientX - r1.left, e.clientY - r1.top); const dx = p1[0] - dragging.from[0]; const dy = p1[1] - dragging.from[1]; if (Math.hypot(dx, dy) * imageZoom() > 3) dragging.moved = true; if (dragging.moved) dragging.move.points = dragging.start.map((q) => [Math.round(q[0] + dx), Math.round(q[1] + dy)]); draw(); return; }
    if (!draft) return;
    const r = canvas.getBoundingClientRect(); const p = toImage(e.clientX - r.left, e.clientY - r.top);
    if (dragging) { if (draft.kind === 'freehand') { if (dist(draft.points[draft.points.length - 1], p) > 3 / imageZoom()) draft.points.push(p); } else draft.points[1] = p; }
    else if (['ruler', 'arrow', 'area', 'polygon', 'line'].includes(draft.kind)) { draft.preview = p; draft.points = [...draft.points.filter((_, i) => i < draft.fixed || draft.fixed == null), p]; draft.fixed = draft.points.length - 1; }
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    if (dragging?.brush) { maskLayer().end(); dragging = null; draw(); callbacks.onMask?.(mask); return; }
    if (dragging?.move) { const m = dragging; dragging = null; if (m.moved) callbacks.onEdit?.(m.move); draw(); return; }
    if (!dragging || !draft) return;
    const d = draft; dragging = null;
    if (d.kind === 'split') { draft = null; if (dist(d.points[0], d.points[1]) * imageZoom() >= 6) callbacks.onSplitLine?.([d.points[0], d.points[1]]); draw(); return; }
    if (d.kind === 'ellipse') { if (dist(d.points[0], d.points[1]) * imageZoom() >= 4) finish({ kind: 'ellipse', points: [d.points[0], d.points[1]] }); else draft = null; draw(); return; }
    if (d.kind === 'region') { if (dist(d.points[0], d.points[1]) * imageZoom() >= 4) finishRegion(d.points[0], d.points[1]); else { draft = null; draw(); } return; }
    if (d.kind === 'rect') { if (dist(d.points[0], d.points[1]) * imageZoom() >= 4) finish({ kind: 'rect', points: [d.points[0], d.points[1]] }); else draft = null; }
    else if (d.kind === 'freehand') { if (d.points.length >= 3) finish({ kind: 'freehand', points: d.points, closed: true }); else draft = null; }
    draw();
  });
  canvas.addEventListener('dblclick', (e) => { e.preventDefault(); if (draft?.kind === 'polygon' || draft?.kind === 'line') { const pts = draft.points.slice(0, draft.fixed ?? draft.points.length); const kind = draft.kind; if (pts.length >= (kind === 'polygon' ? 3 : 2)) finish({ kind, points: pts, closed: kind === 'polygon' }); else draft = null; draw(); return; } if (draft?.kind === 'area') { const pts = draft.points.slice(0, draft.fixed ?? draft.points.length); if (pts.length >= 3) finish({ kind: 'area', points: pts, closed: true }); else draft = null; draw(); } });
  const keys = (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'Enter' && draft) { e.preventDefault(); const pts = draft.points.slice(0, draft.fixed ?? draft.points.length); if (draft.kind === 'count' && pts.length) finish({ kind: 'count', points: pts }); else if (draft.kind === 'polygon' && pts.length >= 3) finish({ kind: 'polygon', points: pts, closed: true }); else if (draft.kind === 'line' && pts.length >= 2) finish({ kind: 'line', points: pts, closed: false }); else if (draft.kind === 'area' && pts.length >= 3) finish({ kind: 'area', points: pts, closed: true }); else { draft = null; draw(); } }
    if (e.key === 'Escape') { draft = null; dragging = null; draw(); }
  };
  el.addEventListener('keydown', keys);
  canvas.addEventListener('keydown', keys);

  function command(name, arg) {
    if (!viewer) return;
    const vp = viewer.viewport;
    if (name === 'tool') { state.tool = arg; draft = null; canvas.classList.toggle('active', arg !== 'none'); canvas.tabIndex = arg !== 'none' ? 0 : -1; draw(); }
    else if (name === 'objective') { const z = Math.min(arg, state.magnification) / state.magnification; vp.zoomTo(vp.imageToViewportZoom(z)); state.objective = arg; }
    else if (name === 'zoom') vp.zoomBy(arg);
    else if (name === 'fit') { state.rotation = 0; vp.setRotation(0); vp.goHome(); }
    else if (name === 'rotate') { state.rotation = (state.rotation + (arg || 90)) % 360; vp.setRotation(state.rotation); }
    else if (name === 'fullscreen') viewer.setFullScreen(!viewer.isFullPage());
    else if (name === 'pan') vp.panBy(new OSD.Point(arg[0] / vp.getZoom(true) / 4, arg[1] / vp.getZoom(true) / 4));
    else if (name === 'heat') { state.heat = !state.heat; draw(); }
    else if (name === 'clear') { annotations = []; draft = null; state.selected = null; draw(); }
    else if (name === 'class') { state.class = arg?.name || null; state.classColour = arg?.colour || null; }
    else if (name === 'select') { state.selected = arg || null; draw(); }
    else if (name === 'remove') { annotations = annotations.filter((a) => a.id !== arg); if (state.selected === arg) state.selected = null; draw(); }
    else if (name === 'overlay') { if (arg.polygons) overlay.polygons = arg.polygons; if (arg.cells) { overlay.cells = arg.cells; overlay.examples = new Map(); overlay.picked = new Set(); } if (arg.examples) overlay.examples = arg.examples; draw(); }
    // Display only: brightness, contrast and which colour channels are shown. The pixels on the server are never changed.
    else if (name === 'display') { const d = { brightness: 100, contrast: 100, r: true, g: true, b: true, ...arg }; state.display = d; const all = d.r && d.g && d.b; matrix.setAttribute('values', `${d.r ? 1 : 0} 0 0 0 0  0 ${d.g ? 1 : 0} 0 0 0  0 0 ${d.b ? 1 : 0} 0 0  0 0 0 1 0`); osdEl.style.filter = `brightness(${d.brightness}%) contrast(${d.contrast}%)${all ? '' : ` url(#${filterId})`}`; }
    else if (name === 'goto') { vp.panTo(vp.imageToViewportCoordinates(new OSD.Point(arg[0], arg[1]))); if (arg[2]) vp.zoomTo(vp.imageToViewportZoom(arg[2])); }
    else if (name === 'sync') { if (arg.zoom != null) vp.zoomTo(arg.zoom, null, true); if (arg.centre) vp.panTo(arg.centre, true); }
    else if (name === 'regions') { regions = arg.map((r) => ({ ...r })); draw(); }
    else if (name === 'regionLabel') state.regionLabel = arg;
    else if (name === 'brush') { Object.assign(BRUSH, arg); draw(); }
    else if (name === 'undo') { if (mask?.undo()) draw(); }
    else if (name === 'redo') { if (mask?.redo()) draw(); }
    else if (name === 'clear-mask') { if (mask) { mask.clear(); draw(); } }
  }
  const observer = new ResizeObserver(resize);
  observer.observe(el);
  return {
    el, state, load, command, draw, viewer: () => viewer,
    get annotations() { return annotations; }, get regions() { return regions.filter((r) => !r.ghost); },
    restore(a) { annotations.push({ ...a, points: a.points.map((p) => [...p]) }); draw(); },
    replace(a) { annotations = annotations.map((x) => (x.id === a.id ? { ...x, ...a, points: a.points.map((p) => [...p]) } : x)); draw(); },
    overlay, stainCanvas,
    /** The pixels of the slide as shown now (RGBA), for the stain view and other display-only analysis. Null when the drawing surface cannot be read. */
    snapshot() { try { const c = viewer?.drawer?.canvas || osdEl.querySelector('canvas'); if (!c) return null; const g = document.createElement('canvas'); g.width = c.width; g.height = c.height; const x = g.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0); return x.getImageData(0, 0, g.width, g.height); } catch { return null; } },
    /** The part of the slide on screen, in full-resolution pixels. */
    bounds() { if (!viewer || !state.info) return null; const b = viewer.viewport.viewportToImageRectangle(viewer.viewport.getBounds(true)); const x = Math.max(0, Math.round(b.x)); const y = Math.max(0, Math.round(b.y)); return { x, y, w: Math.min(state.info.width - x, Math.round(b.width)), h: Math.min(state.info.height - y, Math.round(b.height)) }; },
    clear() { annotations = []; draw(); },
    maskLayer, get maskScale() { return maskScale; },
    viewedCells() { return [...viewed.entries()].map(([k, ms]) => { const [x, y, size] = k.split(':').map(Number); return { x, y, size, ms }; }); },
    view() { return viewer ? { zoom: viewer.viewport.getZoom(true), centre: viewer.viewport.getCenter(true) } : null; },
    destroy() { observer.disconnect(); if (viewer) { trackView(); viewer.destroy(); viewer = null; } },
  };
}
