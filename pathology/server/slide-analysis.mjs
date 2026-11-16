// Slide image analysis for the pathology viewer. All of it is our own
// code, written from the published methods named below; nothing is taken from QuPath or any other
// program. Pure functions on RGB pixel arrays (Uint8, 3 bytes per pixel), so they run on the
// server, in the browser (copied to pathology/web/shared/slide-analysis.js) and in the tests.
//
// - Colour deconvolution: Ruifrok and Johnston, "Quantification of histochemical staining by color
//   deconvolution", 2001: optical density, then unmixing with the inverse of the stain matrix.
// - Threshold: Otsu, "A threshold selection method from gray-level histograms", 1979.
// - Nucleus detection: haematoxylin channel, Gaussian smoothing, Otsu threshold, distance transform
//   and seeded watershed to split touching nuclei (the classical pipeline).
// - Classifiers: multinomial logistic regression trained by gradient descent on standardised features.

// ---------- colour deconvolution ----------
export const STAINS = {
  HE: { name: 'Haematoxylin and eosin', channels: ['Haematoxylin', 'Eosin', 'Residual'], vectors: [[0.65, 0.704, 0.286], [0.072, 0.99, 0.105]] },
  HDAB: { name: 'Haematoxylin and DAB', channels: ['Haematoxylin', 'DAB', 'Residual'], vectors: [[0.65, 0.704, 0.286], [0.268, 0.57, 0.776]] },
};
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function invert3(m) {
  const [a, b, c] = m[0]; const [d, e, f] = m[1]; const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]];
}
/** The stain matrix (rows are unit stain vectors; the third is perpendicular to the first two) and its inverse. */
export function stainMatrix(kind = 'HE') {
  const s = STAINS[kind]; if (!s) throw new Error(`Unknown stain set "${kind}". Known: ${Object.keys(STAINS).join(', ')}`);
  const v1 = unit(s.vectors[0]); const v2 = unit(s.vectors[1]); const v3 = unit(cross(v1, v2));
  const m = [v1, v2, v3];
  return { m, inv: invert3(m), channels: s.channels };
}
const OD = new Float32Array(256); for (let i = 0; i < 256; i += 1) OD[i] = -Math.log10((i + 1) / 256);
/** Stain amounts per pixel: three Float32Arrays (one per channel), in optical density units; 0 is no stain. */
export function deconvolve(rgb, kind = 'HE') {
  const { inv } = stainMatrix(kind); const n = rgb.length / 3;
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i += 1) { const r = OD[rgb[i * 3]]; const g = OD[rgb[i * 3 + 1]]; const b = OD[rgb[i * 3 + 2]]; for (let k = 0; k < 3; k += 1) out[k][i] = Math.max(0, r * inv[0][k] + g * inv[1][k] + b * inv[2][k]); }
  return out;
}
/** One stain alone, drawn in its own colour on white (for the "stain view"). */
export function stainImage(amount, kind = 'HE', channel = 0) {
  const { m } = stainMatrix(kind); const v = m[channel]; const out = new Uint8ClampedArray(amount.length * 4);
  for (let i = 0; i < amount.length; i += 1) { for (let k = 0; k < 3; k += 1) out[i * 4 + k] = 256 * 10 ** (-amount[i] * v[k]) - 1; out[i * 4 + 3] = 255; }
  return out;
}

// ---------- thresholds, masks, components, contours ----------
export function otsu(hist) {
  const total = hist.reduce((a, b) => a + b, 0); let sum = 0; for (let i = 0; i < hist.length; i += 1) sum += i * hist[i];
  let wB = 0; let sumB = 0; let best = 0; let at = 0;
  for (let i = 0; i < hist.length; i += 1) { wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += i * hist[i]; const d = sumB / wB - (sum - sumB) / wF; const v = wB * wF * d * d; if (v > best) { best = v; at = i; } }
  return at;
}
export function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0)) return Float32Array.from(src);
  const r = Math.max(1, Math.ceil(sigma * 2.5)); const k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i += 1) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i += 1) k[i] /= s;
  const tmp = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { let a = 0; for (let i = -r; i <= r; i += 1) a += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { let a = 0; for (let i = -r; i <= r; i += 1) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]; out[y * w + x] = a; }
  return out;
}
const morph = (mask, w, h, grow) => { const out = new Uint8Array(w * h); for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { let v = grow ? 0 : 1; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) { const yy = y + dy; const xx = x + dx; const m = yy >= 0 && xx >= 0 && yy < h && xx < w ? mask[yy * w + xx] : 0; if (grow) v |= m; else v &= m; } out[y * w + x] = v; } return out; };
export const dilate = (mask, w, h, times = 1) => { let m = mask; for (let i = 0; i < times; i += 1) m = morph(m, w, h, true); return m; };
export const erode = (mask, w, h, times = 1) => { let m = mask; for (let i = 0; i < times; i += 1) m = morph(m, w, h, false); return m; };
/** 4-connected components of a mask: labels (Int32, 0 is background) and one entry per component. */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h); const list = []; const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    const id = list.length + 1; const c = { id, area: 0, minX: w, minY: h, maxX: 0, maxY: 0, sumX: 0, sumY: 0 }; stack.push(start); labels[start] = id;
    while (stack.length) { const i = stack.pop(); const y = Math.floor(i / w); const x = i - y * w; c.area += 1; c.sumX += x; c.sumY += y; if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack.push(i - 1); } if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = id; stack.push(i - w); } if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = id; stack.push(i + w); } }
    list.push(c);
  }
  return { labels, list };
}
/** The outer boundary of one component as a closed polygon of pixel corners (clockwise square tracing along pixel edges). */
export function traceBoundary(labels, w, h, id, c) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id);
  // start: the top-left-most pixel of the component (first in row order inside its bounding box)
  let sx = -1; let sy = -1;
  outer: for (let y = c.minY; y <= c.maxY; y += 1) for (let x = c.minX; x <= c.maxX; x += 1) if (at(x, y)) { sx = x; sy = y; break outer; }
  if (sx < 0) return [];
  // Walk the pixel edges clockwise with the inside on the right. At each corner try the right turn first, then
  // straight on, then the left turn: that keeps to the same 4-connected component where two parts touch at a corner.
  const DX = [1, 0, -1, 0]; const DY = [0, 1, 0, -1]; // 0 east, 1 south, 2 west, 3 north
  const edge = (x, y, d) => (d === 0 ? at(x, y) && !at(x, y - 1) : d === 1 ? at(x - 1, y) && !at(x, y) : d === 2 ? at(x - 1, y - 1) && !at(x - 1, y) : at(x, y - 1) && !at(x - 1, y - 1));
  const pts = []; let x = sx; let y = sy; let dir = 0; let guard = 0;
  do {
    pts.push([x, y]); x += DX[dir]; y += DY[dir]; guard += 1;
    const next = [(dir + 1) % 4, dir, (dir + 3) % 4].find((d) => edge(x, y, d));
    if (next == null) break;
    dir = next;
  } while ((x !== sx || y !== sy || dir !== 0) && guard < 4 * w * h + 16);
  // drop points on straight runs
  const out = []; for (let i = 0; i < pts.length; i += 1) { const p = pts[(i + pts.length - 1) % pts.length]; const q = pts[i]; const r = pts[(i + 1) % pts.length]; if ((q[0] - p[0]) * (r[1] - q[1]) !== (q[1] - p[1]) * (r[0] - q[0])) out.push(q); }
  return out;
}
/** Douglas-Peucker simplification of a closed polygon. */
export function simplify(points, tolerance = 1) {
  if (points.length <= 4 || !(tolerance > 0)) return points;
  const dist = (p, a, b) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const l = dx * dx + dy * dy; if (!l) return Math.hypot(p[0] - a[0], p[1] - a[1]); const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const run = (pts) => { if (pts.length < 3) return pts; let far = 0; let at = 0; for (let i = 1; i < pts.length - 1; i += 1) { const d = dist(pts[i], pts[0], pts[pts.length - 1]); if (d > far) { far = d; at = i; } } if (far <= tolerance) return [pts[0], pts[pts.length - 1]]; return [...run(pts.slice(0, at + 1)).slice(0, -1), ...run(pts.slice(at))]; };
  // split the ring at its two farthest-apart points so both halves simplify well
  let far = 0; let k = 0; for (let i = 1; i < points.length; i += 1) { const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]); if (d > far) { far = d; k = i; } }
  const a = run(points.slice(0, k + 1)); const b = run([...points.slice(k), points[0]]);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : points;
}
/** Polygons (in mask pixels) around every component of at least minArea pixels, largest first. */
export function maskPolygons(mask, w, h, { minArea = 1, tolerance = 0.75, max = 500 } = {}) {
  const { labels, list } = components(mask, w, h);
  return list.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area).slice(0, max).map((c) => ({ points: simplify(traceBoundary(labels, w, h, c.id, c), tolerance), area: c.area, bbox: [c.minX, c.minY, c.maxX + 1, c.maxY + 1] }));
}

// ---------- polygon geometry ----------
export const polygonArea = (pts) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
export const polygonPerimeter = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);
export function pointInPolygon(x, y, pts) { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) { const [xi, yi] = pts[i]; const [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; }
export const ellipsePolygon = (cx, cy, rx, ry, n = 48) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
/** Fills polygons into a mask of w x h pixels; coordinates are divided by `scale` and moved by the origin first. */
export function rasterize(polygons, w, h, { scale = 1, origin = [0, 0] } = {}) {
  const mask = new Uint8Array(w * h);
  for (const poly of polygons) {
    const pts = poly.map((p) => [(p[0] - origin[0]) / scale, (p[1] - origin[1]) / scale]);
    const ys = pts.map((p) => p[1]); const y0 = Math.max(0, Math.floor(Math.min(...ys))); const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y += 1) { const yc = y + 0.5; const xs = []; for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) { const [xi, yi] = pts[i]; const [xj, yj] = pts[j]; if ((yi > yc) !== (yj > yc)) xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi)); } xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) { const from = Math.max(0, Math.ceil(xs[k] - 0.5)); const to = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); for (let x = from; x <= to; x += 1) mask[y * w + x] = 1; } }
  }
  return mask;
}
const boundsOf = (polys) => { const xs = polys.flat().map((p) => p[0]); const ys = polys.flat().map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const gridFor = (polys, maxSide = 1024) => { const [x0, y0, x1, y1] = boundsOf(polys); const scale = Math.max(1, Math.max(x1 - x0, y1 - y0) / maxSide); const pad = 2 * scale; return { origin: [x0 - pad, y0 - pad], scale, w: Math.ceil((x1 - x0) / scale) + 4, h: Math.ceil((y1 - y0) / scale) + 4 }; };
const back = (poly, g) => poly.map((p) => [Math.round(p[0] * g.scale + g.origin[0]), Math.round(p[1] * g.scale + g.origin[1])]);
/** Merges overlapping or touching polygons into their union; polygons that do not touch stay separate. */
export function mergePolygons(polys) {
  const g = gridFor(polys); const mask = rasterize(polys, g.w, g.h, g);
  return maskPolygons(mask, g.w, g.h, { tolerance: 0.75 }).map((p) => back(p.points, g));
}
/** Splits a polygon along a drawn line (two or more points): the line is cut out, a few pixels wide, and each remaining piece comes back as its own polygon. */
export function splitPolygon(poly, line) {
  const g = gridFor([poly]); const mask = rasterize([poly], g.w, g.h, g);
  for (let i = 0; i + 1 < line.length; i += 1) { const a = [(line[i][0] - g.origin[0]) / g.scale, (line[i][1] - g.origin[1]) / g.scale]; const b = [(line[i + 1][0] - g.origin[0]) / g.scale, (line[i + 1][1] - g.origin[1]) / g.scale]; const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2) + 1; for (let k = 0; k <= n; k += 1) { const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n); const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n); for (let dy = -1; dy <= 0; dy += 1) for (let dx = -1; dx <= 0; dx += 1) { const xx = x + dx; const yy = y + dy; if (xx >= 0 && yy >= 0 && xx < g.w && yy < g.h) mask[yy * g.w + xx] = 0; } } }
  return maskPolygons(mask, g.w, g.h, { minArea: 4, tolerance: 0.75 }).map((p) => back(p.points, g));
}
/** Parent of each annotation: the smallest other annotation that contains all of its points. annotations: [{ id, points }] with closed shapes. */
export function hierarchy(annotations) {
  const areas = new Map(annotations.map((a) => [a.id, polygonArea(a.points)]));
  const out = new Map();
  for (const a of annotations) { let best = null; for (const b of annotations) { if (b.id === a.id || b.points.length < 3 || areas.get(b.id) <= areas.get(a.id)) continue; if (a.points.every((p) => pointInPolygon(p[0], p[1], b.points)) && (!best || areas.get(b.id) < areas.get(best))) best = b.id; } out.set(a.id, best); }
  return out;
}

// ---------- tissue detection ----------
/** Tissue against a bright background at a low-resolution level: Otsu on total optical density, closed and cleaned. Returns the mask and its polygons in the image's own pixels. */
export function detectTissue(rgb, w, h, { minAreaFraction = 0.002, close = 2 } = {}) {
  const n = w * h; const od = new Uint8Array(n); const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i += 1) { const v = Math.min(255, Math.round(((OD[rgb[i * 3]] + OD[rgb[i * 3 + 1]] + OD[rgb[i * 3 + 2]]) / 3) * 255)); od[i] = v; hist[v] += 1; }
  const t = Math.max(8, otsu(hist));
  let mask = new Uint8Array(n); for (let i = 0; i < n; i += 1) mask[i] = od[i] > t ? 1 : 0;
  mask = erode(dilate(mask, w, h, close), w, h, close);
  const polygons = maskPolygons(mask, w, h, { minArea: Math.max(4, n * minAreaFraction), tolerance: 1 });
  const kept = rasterize(polygons.map((p) => p.points), w, h);
  return { mask: kept, polygons, threshold: t / 255, tissueFraction: kept.reduce((a, b) => a + b, 0) / n };
}

// ---------- nucleus (cell) detection ----------
function distanceTransform(mask, w, h) {
  const d = new Float32Array(w * h); const INF = 1e9;
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + 1); if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + 1.4142); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.4142); } d[i] = x === 0 || y === 0 ? Math.min(v, 1) : v; }
  for (let y = h - 1; y >= 0; y -= 1) for (let x = w - 1; x >= 0; x -= 1) { const i = y * w + x; if (!d[i]) continue; let v = d[i]; if (x < w - 1) v = Math.min(v, d[i + 1] + 1); if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.4142); if (x > 0) v = Math.min(v, d[i + w - 1] + 1.4142); } d[i] = x === w - 1 || y === h - 1 ? Math.min(v, 1) : v; }
  return d;
}
export const FEATURES = ['area', 'circularity', 'eccentricity', 'nucleusStain', 'secondStain', 'red', 'green', 'blue'];
export const MAX_REGION_PIXELS = 2048 * 2048;
/**
 * Nuclei in an RGB region. mpp is microns per pixel of the region (areas are reported in µm² when given).
 * Returns { cells: [{ x, y, area, areaUm2, perimeter, circularity, eccentricity, nucleusStain, secondStain, red, green, blue, radius }], labels }.
 */
export function detectNuclei(rgb, w, h, { stains = 'HE', sigma = 1, minArea = 12, maxArea = 4000, threshold = null, seedDistance = 3, mpp = null } = {}) {
  if (w * h > MAX_REGION_PIXELS) throw new Error(`The region is ${w} x ${h} pixels; cell detection takes at most ${MAX_REGION_PIXELS} pixels (2048 x 2048). Select a smaller region or a lower magnification.`);
  const [nuc, second] = deconvolve(rgb, stains);
  const smooth = gaussianBlur(nuc, w, h, sigma);
  let max = 0; for (let i = 0; i < smooth.length; i += 1) if (smooth[i] > max) max = smooth[i];
  let t = threshold;
  if (t == null) {
    // Two estimates, and the lower one wins: Otsu on the smoothed nucleus stain, and the background level plus a margin (median plus four robust
    // standard deviations, at least 0.1). Each nucleus is then cut back to the pixels above half of its own peak, so a low threshold does not fatten it. The second keeps nuclei when a few very dark areas would pull Otsu's threshold above them.
    const hist = new Array(256).fill(0); const k = max > 0 ? 255 / max : 0; for (let i = 0; i < smooth.length; i += 1) hist[Math.min(255, Math.round(smooth[i] * k))] += 1;
    const quantile = (q) => { let n = 0; const want = q * smooth.length; for (let i = 0; i < 256; i += 1) { n += hist[i]; if (n >= want) return i / (k || 1); } return max; };
    const median = quantile(0.5); const spread = (median - quantile(0.25)) * 1.4826; // the lower half only: the upper half holds the nuclei
    t = max > 0 ? Math.max(0.08, Math.min(otsu(hist) / k, median + Math.max(0.1, 4 * spread))) : Infinity;
  }
  const mask = new Uint8Array(w * h); for (let i = 0; i < mask.length; i += 1) mask[i] = smooth[i] > t ? 1 : 0;
  const dist = gaussianBlur(distanceTransform(mask, w, h), w, h, 1);
  // Seeds: local maxima of the distance map, at least seedDistance pixels from the background.
  const seeds = [];
  const R = Math.max(1, Math.round(seedDistance));
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = y * w + x; const v = dist[i]; if (!mask[i] || v < Math.min(seedDistance, 1.5)) continue; let top = true; for (let dy = -R; dy <= R && top; dy += 1) for (let dx = -R; dx <= R; dx += 1) { if (!dx && !dy) continue; const xx = x + dx; const yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const u = dist[yy * w + xx]; if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) { top = false; break; } } if (top) seeds.push(i); }
  // Seeded watershed: flood outwards from the seeds, highest distance first, inside the mask.
  const labels = new Int32Array(w * h); const buckets = new Map(); let hi = 0;
  const put = (i, id) => { labels[i] = id; const b = Math.round(dist[i] * 4); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(i); if (b > hi) hi = b; };
  seeds.forEach((i, n) => put(i, n + 1));
  for (let b = hi; b >= 0; b -= 1) { const q = buckets.get(b); if (!q) continue; for (let k = 0; k < q.length; k += 1) { const i = q[k]; const id = labels[i]; const y = Math.floor(i / w); const x = i - y * w; const visit = (j) => { if (mask[j] && !labels[j]) { labels[j] = id; const bb = Math.min(b, Math.round(dist[j] * 4)); if (!buckets.has(bb)) buckets.set(bb, []); buckets.get(bb).push(j); } }; if (x > 0) visit(i - 1); if (x < w - 1) visit(i + 1); if (y > 0) visit(i - w); if (y < h - 1) visit(i + w); } }
  // Cut each nucleus back to its half-maximum outline: pixels below half of that nucleus's own peak (above the background level) are dropped.
  { const peak = new Float32Array(seeds.length + 1); for (let i = 0; i < labels.length; i += 1) { const id = labels[i]; if (id && smooth[i] > peak[id]) peak[id] = smooth[i]; } const floor = Math.min(t, max) * 0.5; for (let i = 0; i < labels.length; i += 1) { const id = labels[i]; if (id && smooth[i] < floor + (peak[id] - floor) * 0.5) labels[i] = 0; } }
  // Measurements per nucleus.
  const acc = seeds.map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, per: 0, nuc: 0, sec: 0, r: 0, g: 0, b: 0 }));
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = y * w + x; const id = labels[i]; if (!id) continue; const a = acc[id - 1]; a.n += 1; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y; a.nuc += nuc[i]; a.sec += second[i]; a.r += rgb[i * 3]; a.g += rgb[i * 3 + 1]; a.b += rgb[i * 3 + 2];
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || labels[i - 1] !== id || labels[i + 1] !== id || labels[i - w] !== id || labels[i + w] !== id) a.per += 1; }
  const r2 = (v) => Math.round(v * 100) / 100; const cells = []; const keep = new Int32Array(seeds.length + 1);
  acc.forEach((a, k) => {
    if (a.n < minArea || a.n > maxArea) return;
    const cx = a.sx / a.n; const cy = a.sy / a.n; const mxx = a.sxx / a.n - cx * cx; const myy = a.syy / a.n - cy * cy; const mxy = a.sxy / a.n - cx * cy;
    const common = Math.sqrt(Math.max(0, ((mxx - myy) / 2) ** 2 + mxy * mxy)); const l1 = (mxx + myy) / 2 + common; const l2 = (mxx + myy) / 2 - common;
    const perimeter = a.per * 0.95; // boundary pixel count, lightly corrected for the staircase
    keep[k + 1] = cells.length + 1;
    cells.push({ x: r2(cx), y: r2(cy), area: a.n, areaUm2: mpp ? r2(a.n * mpp * mpp) : null, perimeter: r2(perimeter), circularity: r2(Math.min(1, (4 * Math.PI * a.n) / (perimeter * perimeter || 1))), eccentricity: r2(l1 > 0 ? Math.sqrt(Math.max(0, 1 - Math.max(0, l2) / l1)) : 0), nucleusStain: r2(a.nuc / a.n), secondStain: r2(a.sec / a.n), red: Math.round(a.r / a.n), green: Math.round(a.g / a.n), blue: Math.round(a.b / a.n), radius: r2(Math.sqrt(a.n / Math.PI)) });
  });
  for (let i = 0; i < labels.length; i += 1) labels[i] = keep[labels[i]];
  return { cells, labels, threshold: r2(t), seeds: seeds.length };
}
export const featuresOf = (cell) => FEATURES.map((f) => Number(cell[f]) || 0);

// ---------- classifiers ----------
/** Trains multinomial logistic regression. samples: [{ features: number[], label }]. Deterministic. */
export function trainClassifier(samples, { classes = null, iterations = 400, rate = 0.5, l2 = 0.001, minSd = null } = {}) {
  const names = classes || [...new Set(samples.map((s) => s.label))].sort();
  if (names.length < 2) throw new Error('Give examples of at least two classes');
  for (const c of names) if (!samples.some((s) => s.label === c)) throw new Error(`There is no example of the class "${c}"`);
  const d = samples[0].features.length; const n = samples.length;
  const mean = new Array(d).fill(0); const sd = new Array(d).fill(0);
  for (const s of samples) s.features.forEach((v, j) => { mean[j] += v / n; });
  for (const s of samples) s.features.forEach((v, j) => { sd[j] += (v - mean[j]) ** 2 / n; });
  // A feature that barely varies among the examples must not dominate elsewhere: its spread has a floor (minSd, in the feature's own units).
  for (let j = 0; j < d; j += 1) sd[j] = Math.max(Math.sqrt(sd[j]), minSd?.[j] ?? 0) || 1;
  const X = samples.map((s) => s.features.map((v, j) => (v - mean[j]) / sd[j])); const Y = samples.map((s) => names.indexOf(s.label));
  const K = names.length; const W = Array.from({ length: K }, () => new Array(d + 1).fill(0));
  for (let it = 0; it < iterations; it += 1) {
    const G = Array.from({ length: K }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i += 1) { const z = W.map((wk) => wk[d] + wk.reduce((a, v, j) => (j < d ? a + v * X[i][j] : a), 0)); const m = Math.max(...z); const e = z.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0); for (let k = 0; k < K; k += 1) { const g = e[k] / s - (Y[i] === k ? 1 : 0); for (let j = 0; j < d; j += 1) G[k][j] += g * X[i][j]; G[k][d] += g; } }
    for (let k = 0; k < K; k += 1) for (let j = 0; j <= d; j += 1) W[k][j] -= rate * (G[k][j] / n + (j < d ? l2 * W[k][j] : 0));
  }
  const model = { kind: 'logistic', classes: names, mean, sd, weights: W.map((wk) => wk.map((v) => Math.round(v * 1e5) / 1e5)), trainedOn: n };
  model.trainingAccuracy = samples.filter((s) => predict(model, s.features).label === s.label).length / n;
  return model;
}
export function predict(model, features) {
  const d = model.mean.length; const x = features.map((v, j) => (v - model.mean[j]) / model.sd[j]);
  const z = model.weights.map((wk) => wk[d] + wk.reduce((a, v, j) => (j < d ? a + v * x[j] : a), 0)); const m = Math.max(...z); const e = z.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0);
  let best = 0; for (let k = 1; k < e.length; k += 1) if (e[k] > e[best]) best = k;
  return { label: model.classes[best], probability: e[best] / s };
}
/** Features of every pixel for pixel classification: colour, two stain amounts, and the local mean and spread of brightness in a 5 x 5 window. */
export const PIXEL_FEATURES = ['red', 'green', 'blue', 'stain1', 'stain2', 'localMean', 'localSpread'];
export const PIXEL_MIN_SD = [10, 10, 10, 0.05, 0.05, 10, 8];
export function pixelFeatures(rgb, w, h, stains = 'HE') {
  const [s1, s2] = deconvolve(rgb, stains); const n = w * h; const grey = new Float32Array(n);
  for (let i = 0; i < n; i += 1) grey[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
  const mean = gaussianBlur(grey, w, h, 1.5); const sq = new Float32Array(n); for (let i = 0; i < n; i += 1) sq[i] = (grey[i] - mean[i]) ** 2;
  const spread = gaussianBlur(sq, w, h, 1.5);
  return (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], s1[i], s2[i], mean[i], Math.sqrt(spread[i])];
}
/** Classifies every pixel. Returns the class index per pixel and the pixel count per class. */
export function classifyPixels(rgb, w, h, model, stains = 'HE') {
  const f = pixelFeatures(rgb, w, h, stains); const out = new Uint8Array(w * h); const counts = Object.fromEntries(model.classes.map((c) => [c, 0]));
  for (let i = 0; i < out.length; i += 1) { const p = predict(model, f(i)); const k = model.classes.indexOf(p.label); out[i] = k; counts[p.label] += 1; }
  return { classMap: out, counts };
}

// ---------- wand ----------
/** Click to select a similar-looking region: spreads from (x, y) through 4-connected pixels whose colour stays within `tolerance` of the clicked colour. Returns the mask and its outline. */
export function wand(rgb, w, h, x, y, { tolerance = 24, maxPixels = 400000 } = {}) {
  const sx = Math.round(x); const sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { mask: new Uint8Array(w * h), polygon: [], pixels: 0, capped: false };
  const s = sy * w + sx; const r0 = rgb[s * 3]; const g0 = rgb[s * 3 + 1]; const b0 = rgb[s * 3 + 2]; const t2 = tolerance * tolerance * 3;
  const mask = new Uint8Array(w * h); const stack = [s]; mask[s] = 1; let pixels = 0; let capped = false;
  const ok = (i) => { const dr = rgb[i * 3] - r0; const dg = rgb[i * 3 + 1] - g0; const db = rgb[i * 3 + 2] - b0; return dr * dr + dg * dg + db * db <= t2; };
  while (stack.length) { const i = stack.pop(); pixels += 1; if (pixels >= maxPixels) { capped = true; break; } const yy = Math.floor(i / w); const xx = i - yy * w; const push = (j) => { if (!mask[j] && ok(j)) { mask[j] = 1; stack.push(j); } }; if (xx > 0) push(i - 1); if (xx < w - 1) push(i + 1); if (yy > 0) push(i - w); if (yy < h - 1) push(i + w); }
  const { labels, list } = components(mask, w, h); const c = list.find((q) => q.id === labels[s]);
  return { mask, polygon: c ? simplify(traceBoundary(labels, w, h, c.id, c), 0.75) : [], pixels, capped };
}

// ---------- measurements ----------
/** Area, perimeter and mean stain amounts inside a polygon. The polygon is in full-resolution pixels; the RGB region starts at `origin` and is `scale` full-resolution pixels per pixel. */
export function measureRegion(rgb, w, h, polygon, { scale = 1, origin = [0, 0], stains = 'HE', mpp = null } = {}) {
  const mask = rasterize([polygon], w, h, { scale, origin }); const [s1, s2] = deconvolve(rgb, stains);
  let n = 0; let a = 0; let b = 0; let r = 0; let g = 0; let bl = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) { n += 1; a += s1[i]; b += s2[i]; r += rgb[i * 3]; g += rgb[i * 3 + 1]; bl += rgb[i * 3 + 2]; }
  const r3 = (v) => Math.round(v * 1000) / 1000; const names = STAINS[stains].channels;
  return { areaPx: polygonArea(polygon), perimeterPx: polygonPerimeter(polygon), areaUm2: mpp ? polygonArea(polygon) * mpp * mpp : null, perimeterUm: mpp ? polygonPerimeter(polygon) * mpp : null, pixelsMeasured: n,
    mean: n ? { [names[0]]: r3(a / n), [names[1]]: r3(b / n), red: Math.round(r / n), green: Math.round(g / n), blue: Math.round(bl / n) } : null };
}
/** Per class: how many annotations, total area and perimeter, total count of points, and the area-weighted mean stain amounts. rows: [{ class, areaUm2, perimeterUm, count, mean, pixelsMeasured }] */
export function summariseByClass(rows) {
  const by = new Map();
  for (const r of rows) { const k = r.class || 'Unclassified'; if (!by.has(k)) by.set(k, { class: k, annotations: 0, areaUm2: 0, perimeterUm: 0, count: 0, weight: 0, sums: {} }); const b = by.get(k); b.annotations += 1; b.areaUm2 += r.areaUm2 || 0; b.perimeterUm += r.perimeterUm || 0; b.count += r.count || 0; if (r.mean && r.pixelsMeasured) { b.weight += r.pixelsMeasured; for (const [ch, v] of Object.entries(r.mean)) b.sums[ch] = (b.sums[ch] || 0) + v * r.pixelsMeasured; } }
  return [...by.values()].map(({ weight, sums, ...b }) => ({ ...b, areaUm2: Math.round(b.areaUm2 * 100) / 100, perimeterUm: Math.round(b.perimeterUm * 100) / 100, mean: weight ? Object.fromEntries(Object.entries(sums).map(([ch, v]) => [ch, Math.round((v / weight) * 1000) / 1000])) : null })).sort((a, b) => a.class.localeCompare(b.class));
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** A table as CSV text. columns: [[key, heading]]. */
export const toCsv = (rows, columns) => [columns.map(([, hd]) => csvCell(hd)).join(','), ...rows.map((r) => columns.map(([k]) => csvCell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\n');
