// Slide annotations as GeoJSON that QuPath can import (File > Import objects) and
// export (Export objects as GeoJSON). Coordinates are full-resolution pixels with the
// origin at the top left, the same space the viewer and the server use.
const PALETTE = { Finding: [247, 49, 59], Normal: [31, 111, 134] };
const closeRing = (pts) => { const ring = pts.map(([x, y]) => [x, y]); const [a, b] = [ring[0], ring[ring.length - 1]]; if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]); return ring; };
const classification = (label) => (label ? { name: label, color: PALETTE[label] || [74, 89, 184] } : undefined);

const ellipseRing = (a, b, n = 48) => { const cx = (a[0] + b[0]) / 2; const cy = (a[1] + b[1]) / 2; const rx = Math.abs(b[0] - a[0]) / 2; const ry = Math.abs(b[1] - a[1]) / 2; return Array.from({ length: n }, (_, i) => [Math.round((cx + rx * Math.cos((2 * Math.PI * i) / n)) * 10) / 10, Math.round((cy + ry * Math.sin((2 * Math.PI * i) / n)) * 10) / 10]); };
/**
 * Viewer annotations ({ kind, points, label or class, text }) to a FeatureCollection.
 * flavour 'qupath' (default) writes QuPath's properties (objectType, classification with a colour);
 * flavour 'plain' writes plain GeoJSON with simple properties (class, name, kind).
 */
export function toGeoJSON(annotations, { flavour = 'qupath' } = {}) {
  const features = [];
  for (const a of annotations || []) {
    const pts = (a.points || []).map((p) => [Number(p[0]), Number(p[1])]);
    if (!pts.length || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
    let geometry;
    if (a.kind === 'rect' && pts.length >= 2) { const [[x0, y0], [x1, y1]] = pts; geometry = { type: 'Polygon', coordinates: [closeRing([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])] }; }
    else if (a.kind === 'ellipse' && pts.length >= 2) geometry = { type: 'Polygon', coordinates: [closeRing(ellipseRing(pts[0], pts[1]))] };
    else if (['area', 'freehand', 'region', 'polygon'].includes(a.kind) && pts.length >= 3) geometry = { type: 'Polygon', coordinates: [closeRing(pts)] };
    else if (a.kind === 'line' && pts.length >= 2) geometry = { type: 'LineString', coordinates: pts };
    else if (a.kind === 'point') geometry = { type: 'Point', coordinates: pts[0] };
    else if (a.kind === 'count') geometry = { type: 'MultiPoint', coordinates: pts };
    else if (a.kind === 'text') geometry = { type: 'Point', coordinates: pts[0] };
    else if (['ruler', 'arrow'].includes(a.kind) && pts.length >= 2) geometry = { type: 'LineString', coordinates: pts.slice(0, 2) };
    else continue;
    const cls = a.class || a.label || null;
    const properties = flavour === 'plain' ? { ...(cls ? { class: cls } : {}), ...(a.text ? { name: a.text } : {}), kind: a.kind, ...(a.kind === 'ellipse' ? { ellipse: [pts[0], pts[1]] } : {}) }
      : { objectType: 'annotation', ...(classification(cls) ? { classification: a.colour && /^#[0-9a-fA-F]{6}$/.test(a.colour) ? { name: cls, color: [1, 3, 5].map((i) => parseInt(a.colour.slice(i, i + 2), 16)) } : classification(cls) } : {}), ...(a.text ? { name: a.text } : {}), hdKind: a.kind, ...(a.kind === 'ellipse' ? { hdEllipse: [pts[0], pts[1]] } : {}) };
    features.push({ type: 'Feature', id: a.id ? String(a.id) : undefined, geometry, properties });
  }
  return { type: 'FeatureCollection', features };
}

const isRect = (ring) => {
  const pts = ring.slice(0, -1);
  if (pts.length !== 4) return false;
  const xs = new Set(pts.map((p) => p[0])); const ys = new Set(pts.map((p) => p[1]));
  return xs.size === 2 && ys.size === 2 && pts.every((p, i) => { const q = pts[(i + 1) % 4]; return p[0] === q[0] || p[1] === q[1]; });
};

/** QuPath GeoJSON (a FeatureCollection, a Feature or an array of Features) to viewer annotations. Holes and other geometry types are skipped and counted. */
export function fromGeoJSON(input) {
  const list = Array.isArray(input) ? input : input?.type === 'FeatureCollection' ? input.features : input?.type === 'Feature' ? [input] : null;
  if (!Array.isArray(list)) throw new Error('This is not GeoJSON: expected a FeatureCollection, a Feature or a list of Features');
  const out = []; let skipped = 0;
  const label = (f) => (typeof f.properties?.classification?.name === 'string' ? f.properties.classification.name.slice(0, 80) : typeof f.properties?.classification === 'string' ? f.properties.classification.slice(0, 80) : typeof f.properties?.class === 'string' ? f.properties.class.slice(0, 80) : null);
  const kindOf = (f) => f.properties?.hdKind || f.properties?.kind || null;
  const name = (f) => (typeof f.properties?.name === 'string' ? f.properties.name.slice(0, 500) : '');
  const polygon = (ring, f) => {
    const box = f.properties?.hdEllipse || f.properties?.ellipse;
    if (kindOf(f) === 'ellipse' && Array.isArray(box) && box.length === 2) { out.push({ kind: 'ellipse', points: box.map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]), label: label(f) }); return; }
    const pts = ring.map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]);
    if (pts.length < 4 || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { skipped += 1; return; }
    if (isRect(pts)) { const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); out.push({ kind: 'rect', points: [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], label: label(f) }); return; }
    const open = pts.slice(0, -1);
    if (open.length > 2000) { skipped += 1; return; }
    out.push({ kind: 'freehand', points: open, closed: true, label: label(f) });
  };
  for (const f of list) {
    const g = f?.geometry; if (!g) { skipped += 1; continue; }
    if (g.type === 'Polygon') { polygon(g.coordinates?.[0] || [], f); if ((g.coordinates || []).length > 1) skipped += g.coordinates.length - 1; }
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates || []) polygon(poly[0] || [], f);
    else if (g.type === 'MultiPoint' || g.type === 'Point') {
      const pts = (g.type === 'Point' ? [g.coordinates] : g.coordinates || []).map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!pts.length) { skipped += 1; continue; }
      if (g.type === 'Point' && kindOf(f) === 'point') out.push({ kind: 'point', points: pts, label: label(f) });
      else if (g.type === 'Point' && name(f)) out.push({ kind: 'text', points: pts, text: name(f), label: label(f) });
      else out.push({ kind: 'count', points: pts.slice(0, 400), label: label(f) });
    } else if (g.type === 'LineString' && (g.coordinates || []).length >= 2) {
      const pts = g.coordinates.map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]);
      if (kindOf(f) === 'arrow') out.push({ kind: 'arrow', points: pts.slice(0, 2), text: name(f), label: label(f) });
      else if (pts.length === 2 && kindOf(f) !== 'line') out.push({ kind: 'ruler', points: pts, label: label(f) });
      else out.push({ kind: 'line', points: pts.slice(0, 400), label: label(f) });
    } else skipped += 1;
  }
  return { annotations: out, skipped };
}

const polygonArea = (pts) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
/** The measurements the viewer keeps with each annotation, worked out with the slide's microns per pixel. */
export function measure(a, mpp) {
  const m = { ...a };
  if (a.kind === 'ruler') m.microns = mpp ? Math.hypot(a.points[1][0] - a.points[0][0], a.points[1][1] - a.points[0][1]) * mpp : null;
  if (a.kind === 'freehand' || a.kind === 'area') m.areaUm2 = mpp && a.points.length >= 3 ? polygonArea(a.points) * mpp * mpp : null;
  if (a.kind === 'rect') m.areaUm2 = mpp ? Math.abs(a.points[1][0] - a.points[0][0]) * Math.abs(a.points[1][1] - a.points[0][1]) * mpp * mpp : null;
  if (a.kind === 'count') m.count = a.points.length;
  return m;
}
