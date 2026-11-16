// Segmentation for the PACS viewer, on a label volume: one byte per voxel, 0 is background and
// n is segment n. Brush, threshold and region growing are our own code. Pure functions.
export const createLabels = (columns, rows, slices) => new Uint8Array(columns * rows * slices);
export const SEGMENT_COLOURS = [[247, 49, 59], [31, 111, 134], [224, 168, 58], [106, 76, 147], [46, 160, 67], [255, 127, 80], [0, 191, 196], [199, 21, 133]];
export const colourOf = (n) => SEGMENT_COLOURS[(Math.max(1, n) - 1) % SEGMENT_COLOURS.length];

/** A round brush on one slice. label 0 erases. Returns the number of voxels changed. */
export function brush(labels, dims, z, cx, cy, radius, label, { only = null } = {}) {
  const { columns, rows } = dims; let changed = 0; const base = z * columns * rows; const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(rows - 1, Math.ceil(cy + radius)); y += 1) for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(columns - 1, Math.ceil(cx + radius)); x += 1) {
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
    const i = base + y * columns + x;
    if (only != null && labels[i] !== only) continue;
    if (labels[i] !== label) { labels[i] = label; changed += 1; }
  }
  return changed;
}
/**
 * Threshold: every voxel whose value (rescaled) is between low and high gets the label.
 * `voxel(i)` returns the stored value of voxel i. Limit to one slice with `slice`. Other segments are kept unless `overwrite`.
 */
export function threshold(labels, dims, voxel, { low, high, slope = 1, intercept = 0, slice = null, overwrite = false }, label) {
  const plane = dims.columns * dims.rows; const from = slice == null ? 0 : slice * plane; const to = slice == null ? labels.length : from + plane; let changed = 0;
  for (let i = from; i < to; i += 1) { const v = voxel(i) * slope + intercept; if (v < low || v > high) continue; if (labels[i] === label || (labels[i] !== 0 && !overwrite)) continue; labels[i] = label; changed += 1; }
  return changed;
}
/**
 * Region growing from a seed voxel [x, y, z]: spreads through face-connected voxels whose value stays
 * within `tolerance` of the seed's value. Stops at maxVoxels, and says so. `in3d: false` keeps to the seed's slice.
 */
export function regionGrow(labels, dims, voxel, seed, { tolerance, slope = 1, intercept = 0, in3d = true, maxVoxels = 2000000 }, label) {
  const { columns, rows, slices } = dims; const plane = columns * rows;
  const [sx, sy, sz] = seed.map(Math.round);
  if (sx < 0 || sy < 0 || sz < 0 || sx >= columns || sy >= rows || sz >= slices) return { changed: 0, capped: false, seedValue: null };
  const start = sz * plane + sy * columns + sx; const seedValue = voxel(start) * slope + intercept;
  const ok = (i) => Math.abs(voxel(i) * slope + intercept - seedValue) <= tolerance;
  const seen = new Uint8Array(labels.length); const stack = [start]; seen[start] = 1; let changed = 0; let capped = false;
  while (stack.length) {
    const i = stack.pop();
    if (labels[i] !== label) { labels[i] = label; changed += 1; if (changed >= maxVoxels) { capped = true; break; } }
    const z = Math.floor(i / plane); const rem = i - z * plane; const y = Math.floor(rem / columns); const x = rem - y * columns;
    const push = (j) => { if (!seen[j] && ok(j)) { seen[j] = 1; stack.push(j); } };
    if (x > 0) push(i - 1); if (x < columns - 1) push(i + 1); if (y > 0) push(i - columns); if (y < rows - 1) push(i + columns);
    if (in3d) { if (z > 0) push(i - plane); if (z < slices - 1) push(i + plane); }
  }
  return { changed, capped, seedValue };
}
/** Voxels and volume per segment. spacing = [row, column] mm; thickness in mm. */
export function segmentStats(labels, { spacing = null, thickness = null } = {}) {
  const counts = new Map();
  for (let i = 0; i < labels.length; i += 1) if (labels[i]) counts.set(labels[i], (counts.get(labels[i]) || 0) + 1);
  const voxelMm3 = spacing && thickness ? spacing[0] * spacing[1] * thickness : null;
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([number, voxels]) => ({ number, voxels, volumeMm3: voxelMm3 ? voxels * voxelMm3 : null }));
}
/** RGBA overlay of one slice of the label volume, for drawing over the image. */
export function sliceOverlay(labels, dims, z, { alpha = 110, hidden = new Set() } = {}) {
  const plane = dims.columns * dims.rows; const out = new Uint8ClampedArray(plane * 4); const base = z * plane;
  for (let i = 0; i < plane; i += 1) { const n = labels[base + i]; if (!n || hidden.has(n)) continue; const [r, g, b] = colourOf(n); out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = alpha; }
  return out;
}

/**
 * The overlay for one image of a plane made from the axial stack: axial image z, or a coronal or
 * sagittal image as viewer.js reslices them (rows run from the top slice down).
 */
export function planeOverlay(labels, dims, kind, index, opts = {}) {
  const { columns, rows, slices } = dims; const plane = columns * rows;
  if (kind === 'axial') return { rgba: sliceOverlay(labels, dims, index, opts), columns, rows };
  const { alpha = 110, hidden = new Set() } = opts;
  const width = kind === 'coronal' ? columns : rows;
  const rgba = new Uint8ClampedArray(width * slices * 4);
  for (let k = 0; k < slices; k += 1) { const row = (slices - 1 - k) * width; for (let c = 0; c < width; c += 1) {
    const n = kind === 'coronal' ? labels[k * plane + index * columns + c] : labels[k * plane + c * columns + index];
    if (!n || hidden.has(n)) continue; const [r, g, b] = colourOf(n); const o = (row + c) * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = alpha;
  } }
  return { rgba, columns: width, rows: slices };
}
/** Voxels on the surface of each segment (a face touches background or another segment), as [x, y, z, segment]. Thinned to at most `max` points. */
export function surfaceVoxels(labels, dims, { hidden = new Set(), max = 150000 } = {}) {
  const { columns, rows, slices } = dims; const plane = columns * rows; const out = [];
  for (let z = 0; z < slices; z += 1) for (let y = 0; y < rows; y += 1) for (let x = 0; x < columns; x += 1) {
    const i = z * plane + y * columns + x; const n = labels[i]; if (!n || hidden.has(n)) continue;
    if (x === 0 || x === columns - 1 || y === 0 || y === rows - 1 || z === 0 || z === slices - 1 || labels[i - 1] !== n || labels[i + 1] !== n || labels[i - columns] !== n || labels[i + columns] !== n || labels[i - plane] !== n || labels[i + plane] !== n) out.push([x, y, z, n]);
  }
  if (out.length <= max) return out;
  const step = Math.ceil(out.length / max); return out.filter((_, i) => i % step === 0);
}
/**
 * Our own small 3D view of the segments: surface voxels rotated by yaw and pitch (radians), drawn
 * nearest-first into a size x size RGBA image, shaded by depth. scale = mm per voxel [x, y, z].
 */
export function renderSurface(points, dims, { yaw = 0.6, pitch = 0.4, size = 256, scale = [1, 1, 1] } = {}) {
  const rgba = new Uint8ClampedArray(size * size * 4); const depth = new Float32Array(size * size).fill(Infinity);
  if (!points.length) return { rgba, size, drawn: 0 };
  const cx = (dims.columns * scale[0]) / 2; const cy = (dims.rows * scale[1]) / 2; const cz = (dims.slices * scale[2]) / 2;
  const radius = Math.hypot(cx, cy, cz) || 1; const k = (size * 0.46) / radius;
  const cyaw = Math.cos(yaw); const syaw = Math.sin(yaw); const cp = Math.cos(pitch); const sp = Math.sin(pitch);
  const dot = Math.max(1, Math.ceil(k * Math.max(...scale))); let drawn = 0;
  for (const [x, y, z, n] of points) {
    const px = x * scale[0] - cx; const py = y * scale[1] - cy; const pz = cz - z * scale[2]; // up is towards the head
    const x1 = px * cyaw + py * syaw; const y1 = -px * syaw + py * cyaw; // turn about the head-foot axis
    const y2 = y1 * cp - pz * sp; const z2 = y1 * sp + pz * cp; // tip towards the viewer
    const sx = Math.round(size / 2 + x1 * k); const sy = Math.round(size / 2 - z2 * k);
    const shade = 0.45 + 0.55 * (1 - (y2 + radius) / (2 * radius)); const [r, g, b] = colourOf(n);
    for (let dy = 0; dy < dot; dy += 1) for (let dx = 0; dx < dot; dx += 1) {
      const u = sx + dx; const v = sy + dy; if (u < 0 || v < 0 || u >= size || v >= size) continue;
      const o = v * size + u; if (y2 >= depth[o]) continue; depth[o] = y2; rgba[o * 4] = r * shade; rgba[o * 4 + 1] = g * shade; rgba[o * 4 + 2] = b * shade; rgba[o * 4 + 3] = 255; drawn += 1;
    }
  }
  return { rgba, size, drawn };
}
