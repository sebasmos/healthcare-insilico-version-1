// Segmentations as answers. The imaging viewer saves brush, threshold and region-grow results as DICOM
// Segmentation files (binary frames, bits packed across frames). They are read back here with the project's
// own reader (viewers/web/shared/dicom-objects.js: plain JavaScript, nothing copied from elsewhere) and kept on the
// reader's answer as run-length rows, so readers can be compared with each other and with the reference:
// Dice for overlap, Hausdorff for the farthest disagreement between the two outlines.
import { readSeg } from '../../viewers/web/shared/dicom-objects.js';

/** [start, length, start, length, ...] for the voxels that are set. */
export function encodeRuns(mask) { const runs = []; let i = 0; const n = mask.length; while (i < n) { if (!mask[i]) { i += 1; continue; } let j = i; while (j < n && mask[j]) j += 1; runs.push(i, j - i); i = j; } return runs; }
export function decodeRuns(runs, n) { const m = new Uint8Array(n); for (let k = 0; k < runs.length; k += 2) m.fill(1, runs[k], runs[k] + runs[k + 1]); return m; }

/** One stored segmentation file -> what is kept on the answer. Returns null when the file cannot be read. */
export function segAnswer(doc) {
  try {
    const seg = readSeg(new Uint8Array(Buffer.from(doc.data, 'base64')));
    const n = seg.columns * seg.rows * seg.slices; const union = new Uint8Array(n); let voxels = 0;
    for (let i = 0; i < n; i += 1) if (seg.labels[i]) { union[i] = 1; voxels += 1; }
    return { id: doc.id, on: `ImagingStudy/${doc.study}`, seriesUid: seg.referencedSeriesUid, columns: seg.columns, rows: seg.rows, slices: seg.slices, voxels, segments: seg.segments.map((s) => ({ number: s.number, label: s.label, method: s.algorithm === 'MANUAL' ? 'brush' : s.algorithmName || 'semi-automatic' })), runs: encodeRuns(union) };
  } catch { return null; }
}
const key = (s) => `${s.on}|${s.seriesUid}|${s.columns}x${s.rows}x${s.slices}`;
/** The readers' masks over the same series, joined: Map key -> Uint8Array. */
function volumes(list) { const out = new Map(); for (const s of list || []) { const n = s.columns * s.rows * s.slices; const m = out.get(key(s)) || { mask: new Uint8Array(n), s }; const d = decodeRuns(s.runs, n); for (let i = 0; i < n; i += 1) if (d[i]) m.mask[i] = 1; out.set(key(s), m); } return out; }

/** Dice of two readers' segmentations: 2 x shared voxels / (voxels of one + voxels of the other). null when neither drew. */
export function segDice(a, b) {
  const A = volumes(a); const B = volumes(b); let both = 0; let sa = 0; let sb = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) { const x = A.get(k)?.mask; const y = B.get(k)?.mask; const n = (x || y).length; for (let i = 0; i < n; i += 1) { const p = x ? x[i] : 0; const q = y ? y[i] : 0; sa += p; sb += q; if (p && q) both += 1; } }
  return sa + sb ? (2 * both) / (sa + sb) : null;
}
function outline(mask, s) {
  const pts = []; const { columns: w, rows: h, slices: d } = s; const at = (x, y, z) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[z * w * h + y * w + x]);
  for (let z = 0; z < d; z += 1) for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (mask[z * w * h + y * w + x] && !(at(x - 1, y, z) && at(x + 1, y, z) && at(x, y - 1, z) && at(x, y + 1, z))) pts.push([x, y, z]);
  if (pts.length > 4000) { const step = Math.ceil(pts.length / 4000); return pts.filter((_, i) => i % step === 0); } // very large outlines are thinned so the comparison stays quick
  return pts;
}
const farthest = (P, Q) => { let worst = 0; for (const p of P) { let best = Infinity; for (const q of Q) { const dx = p[0] - q[0]; const dy = p[1] - q[1]; const dz = p[2] - q[2]; const d2 = dx * dx + dy * dy + dz * dz; if (d2 < best) { best = d2; if (best <= worst) break; } } if (best > worst) worst = best; } return Math.sqrt(worst); };
/** Hausdorff distance between the two outlines, in pixels (slices count as one pixel apart). null unless both drew on the same series. */
export function segHausdorff(a, b) {
  const A = volumes(a); const B = volumes(b); let worst = null;
  for (const [k, x] of A) { const y = B.get(k); if (!y) continue; const P = outline(x.mask, x.s); const Q = outline(y.mask, y.s); if (!P.length || !Q.length) continue; worst = Math.max(worst ?? 0, farthest(P, Q), farthest(Q, P)); }
  return worst == null ? null : Math.round(worst * 100) / 100;
}
