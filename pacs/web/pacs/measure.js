// Measurement maths for the PACS viewer, in image pixel coordinates with the image's pixel spacing.
// Pure functions: used by the measurements panel, the report link and the tests. Points are [x, y].
const sq = (v) => v * v;
/** Distance in mm; null when the image has no pixel spacing. Spacing is [row, column] as in DICOM. */
export function lengthMm(a, b, rowSpacing, columnSpacing) {
  if (!(rowSpacing > 0) || !(columnSpacing > 0)) return null;
  return Math.sqrt(sq((b[0] - a[0]) * columnSpacing) + sq((b[1] - a[1]) * rowSpacing));
}
const vec = (from, to, rs = 1, cs = 1) => [(to[0] - from[0]) * cs, (to[1] - from[1]) * rs];
const between = (u, v) => { const d = Math.hypot(...u) * Math.hypot(...v); if (!d) return null; return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / d))) * 180) / Math.PI; };
/** The angle at `vertex` between the rays to a and c, in degrees (0 to 180). Spacing matters when pixels are not square. */
export const angleDeg = (a, vertex, c, rowSpacing = 1, columnSpacing = 1) => between(vec(vertex, a, rowSpacing, columnSpacing), vec(vertex, c, rowSpacing, columnSpacing));
/** Cobb angle: the angle between two lines (each two points), 0 to 90 degrees, whichever way the lines were drawn. */
export function cobbAngleDeg(line1, line2, rowSpacing = 1, columnSpacing = 1) {
  const a = between(vec(line1[0], line1[1], rowSpacing, columnSpacing), vec(line2[0], line2[1], rowSpacing, columnSpacing));
  return a == null ? null : a > 90 ? 180 - a : a;
}
const summarise = (sum, sumSq, n, min, max) => (n ? { count: n, mean: sum / n, sd: Math.sqrt(Math.max(0, sumSq / n - sq(sum / n))), min, max } : { count: 0, mean: null, sd: null, min: null, max: null });
const valueAt = (frame, i, slope, intercept) => frame[i] * slope + intercept;
/** Mean, standard deviation, min, max and area inside an ellipse (centre, radii in pixels). Values are rescaled (HU for CT). */
export function ellipseStats(frame, columns, rows, centre, rx, ry, { slope = 1, intercept = 0, rowSpacing = null, columnSpacing = null } = {}) {
  let sum = 0; let sumSq = 0; let n = 0; let min = Infinity; let max = -Infinity;
  const x0 = Math.max(0, Math.floor(centre[0] - rx)); const x1 = Math.min(columns - 1, Math.ceil(centre[0] + rx)); const y0 = Math.max(0, Math.floor(centre[1] - ry)); const y1 = Math.min(rows - 1, Math.ceil(centre[1] + ry));
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) { if (sq((x - centre[0]) / rx) + sq((y - centre[1]) / ry) > 1) continue; const v = valueAt(frame, y * columns + x, slope, intercept); sum += v; sumSq += v * v; n += 1; if (v < min) min = v; if (v > max) max = v; }
  return { ...summarise(sum, sumSq, n, min, max), areaMm2: rowSpacing > 0 && columnSpacing > 0 ? Math.PI * rx * columnSpacing * ry * rowSpacing : null };
}
export const polygonAreaPx = (points) => Math.abs(points.reduce((s, p, i) => { const q = points[(i + 1) % points.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) { const [xi, yi] = points[i]; const [xj, yj] = points[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
/** The same statistics inside a freehand region (a closed polygon). Pixel centres decide membership. */
export function polygonStats(frame, columns, rows, points, { slope = 1, intercept = 0, rowSpacing = null, columnSpacing = null } = {}) {
  let sum = 0; let sumSq = 0; let n = 0; let min = Infinity; let max = -Infinity;
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))); const x1 = Math.min(columns - 1, Math.ceil(Math.max(...xs))); const y0 = Math.max(0, Math.floor(Math.min(...ys))); const y1 = Math.min(rows - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) { if (!pointInPolygon(x, y, points)) continue; const v = valueAt(frame, y * columns + x, slope, intercept); sum += v; sumSq += v * v; n += 1; if (v < min) min = v; if (v > max) max = v; }
  return { ...summarise(sum, sumSq, n, min, max), areaMm2: rowSpacing > 0 && columnSpacing > 0 ? polygonAreaPx(points) * rowSpacing * columnSpacing : null };
}
/** The value under the pointer, rescaled (HU for CT); null outside the image. */
export function probe(frame, columns, rows, x, y, { slope = 1, intercept = 0 } = {}) {
  const px = Math.round(x); const py = Math.round(y);
  if (px < 0 || py < 0 || px >= columns || py >= rows) return null;
  return valueAt(frame, py * columns + px, slope, intercept);
}
/** Bidirectional: the long axis and the short axis drawn across it, in mm, and how far from perpendicular they are. */
export function bidirectional(long, short, rowSpacing, columnSpacing) {
  const a = lengthMm(long[0], long[1], rowSpacing, columnSpacing); const b = lengthMm(short[0], short[1], rowSpacing, columnSpacing);
  if (a == null || b == null) return { longMm: null, shortMm: null, offPerpendicularDeg: null };
  const ang = between(vec(long[0], long[1], rowSpacing, columnSpacing), vec(short[0], short[1], rowSpacing, columnSpacing));
  return { longMm: Math.max(a, b), shortMm: Math.min(a, b), offPerpendicularDeg: ang == null ? null : Math.abs(90 - ang) };
}
const f1 = (v) => (v == null ? 'n/a' : (Math.round(v * 10) / 10).toFixed(1));
/** One plain line per measurement, for the measurements panel and for linking into the report. */
export function describeMeasurement(m) {
  const where = `${m.seriesNumber != null ? `series ${m.seriesNumber}, ` : ''}image ${(m.frame ?? 0) + 1}`;
  const stats = m.mean != null ? `, mean ${f1(m.mean)}${m.sd != null ? ` (SD ${f1(m.sd)})` : ''}` : '';
  const name = m.label ? `${m.label}: ` : '';
  switch (m.kind) {
    case 'length': return `${name}Length ${f1(m.value)} mm (${where})`;
    case 'angle': return `${name}Angle ${f1(m.value)} degrees (${where})`;
    case 'cobb': return `${name}Cobb angle ${f1(m.value)} degrees (${where})`;
    case 'roi': case 'ellipse': case 'freehand': return `${name}${m.kind === 'ellipse' ? 'Ellipse' : m.kind === 'freehand' ? 'Freehand region' : 'Region'} area ${f1(m.value)} mm2${stats} (${where})`;
    case 'probe': return `${name}Value ${f1(m.value)} at a point (${where})`;
    case 'bidirectional': return `${name}Bidirectional ${f1(m.longMm ?? m.value)} x ${f1(m.shortMm)} mm (${where})`;
    case 'arrow': return `${name}${m.text || 'Arrow'} (${where})`;
    default: return `${name}${m.kind} ${f1(m.value)} (${where})`;
  }
}
export const MEASUREMENT_KINDS = { length: 'mm', angle: 'deg', cobb: 'deg', roi: 'mm2', ellipse: 'mm2', freehand: 'mm2', probe: 'HU', bidirectional: 'mm', arrow: null };
