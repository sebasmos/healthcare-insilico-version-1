// Test input only: a slide image drawn from shapes inside the test that needs one. Nothing like it ships in the product.
// regions of known size and position, a label image, and shared JPEG tables on the base level. It is drawn
// from shapes when someone asks for it; no slide image ships with the release.
import { encodeJpeg, jpegTables } from '../../viewers/server/jpeg.mjs';
import { writeTiff } from '../../viewers/server/tiff.mjs';

export const PLANTED = [
  { name: 'blue square', colour: [40, 60, 200], x: 0.25, y: 0.3, microns: 400 },
  { name: 'green square', colour: [30, 160, 70], x: 0.65, y: 0.55, microns: 250 },
  { name: 'dark circle', colour: [40, 20, 60], x: 0.5, y: 0.75, microns: 180, shape: 'circle' },
];

const hash = (x, y, seed) => { let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** Renders the base level as interleaved RGB: pale eosin background, purple nuclei, a few bands of stroma, and the planted regions. */
export function renderTissue({ width, height, mpp, seed = 1, regions = PLANTED }) {
  const data = new Uint8Array(width * height * 3);
  const cell = 24; // nucleus grid in pixels at the base level
  const planted = regions.map((r) => ({ ...r, px: Math.round(r.microns / mpp), cx: Math.round(r.x * width), cy: Math.round(r.y * height) }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      // Tissue: a slow band pattern plus per-cell nuclei; a clear (white) gap region near the left edge like slide glass.
      const band = 0.5 + 0.5 * Math.sin((x + y * 0.6) / 140 + seed);
      const glass = x < width * 0.06 || hash(Math.floor(x / 200), Math.floor(y / 200), seed + 7) < 0.08;
      let r = 236; let g = 196 + band * 20; let b = 214 + band * 10;
      if (glass) { r = 246; g = 246; b = 248; } else {
        const gx = Math.floor(x / cell); const gy = Math.floor(y / cell);
        const jx = hash(gx, gy, seed) * cell; const jy = hash(gx, gy, seed + 1) * cell;
        const rad = 4 + hash(gx, gy, seed + 2) * 4;
        const dx = (x % cell) - jx; const dy = (y % cell) - jy;
        if (dx * dx + dy * dy < rad * rad) { r = 90 + hash(gx, gy, seed + 3) * 30; g = 50; b = 130 + hash(gx, gy, seed + 4) * 40; }
        else if (band > 0.8) { r = 228; g = 170; b = 200; }
      }
      for (const p of planted) {
        const half = p.px / 2;
        const inside = p.shape === 'circle' ? (x - p.cx) ** 2 + (y - p.cy) ** 2 <= half * half : Math.abs(x - p.cx) <= half && Math.abs(y - p.cy) <= half;
        if (inside) { [r, g, b] = p.colour; }
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  return { data, planted: planted.map((p) => ({ name: p.name, colour: p.colour, shape: p.shape || 'square', x: p.cx - Math.round(p.px / 2), y: p.cy - Math.round(p.px / 2), width: p.px, height: p.px, microns: p.microns, centre: [p.cx, p.cy] })) };
}

function downsample(src, width, height) {
  const w = Math.max(1, Math.floor(width / 2)); const hgt = Math.max(1, Math.floor(height / 2));
  const out = new Uint8Array(w * hgt * 3);
  for (let y = 0; y < hgt; y += 1) for (let x = 0; x < w; x += 1) for (let c = 0; c < 3; c += 1) {
    const a = ((2 * y) * width + 2 * x) * 3 + c; const b = a + 3; const d = a + width * 3; const e = d + 3;
    out[(y * w + x) * 3 + c] = (src[a] + src[b] + src[d] + src[e]) >> 2;
  }
  return { data: out, width: w, height: hgt };
}

function tilesOf(data, width, height, tile, { quality, tables }) {
  const out = [];
  for (let ty = 0; ty < Math.ceil(height / tile); ty += 1) {
    for (let tx = 0; tx < Math.ceil(width / tile); tx += 1) {
      const buf = new Uint8Array(tile * tile * 3);
      for (let y = 0; y < tile; y += 1) for (let x = 0; x < tile; x += 1) {
        const sx = Math.min(width - 1, tx * tile + x); const sy = Math.min(height - 1, ty * tile + y);
        const si = (sy * width + sx) * 3; const di = (y * tile + x) * 3;
        buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2];
      }
      out.push(encodeJpeg({ width: tile, height: tile, channels: 3, data: buf, quality, tables }));
    }
  }
  return out;
}

/** Builds the slide in memory: { bytes, planted, levels, mpp, magnification }. */
export function buildSlide({ width = 2048, height = 1536, tile = 256, mpp = 0.5, magnification = 20, seed = 1, quality = 80, patientId = null, label = true, regions = PLANTED } = {}) {
  const base = renderTissue({ width, height, mpp, seed, regions });
  const levels = [];
  let cur = { data: base.data, width, height };
  let level = 0;
  for (;;) {
    levels.push({ width: cur.width, height: cur.height, tileWidth: tile, tileLength: tile, tiles: tilesOf(cur.data, cur.width, cur.height, tile, { quality, tables: level === 0 ? 'omit' : 'inline' }), ...(level === 0 ? { jpegTables: jpegTables(quality) } : {}) });
    if (cur.width <= tile && cur.height <= tile) break;
    cur = downsample(cur.data, cur.width, cur.height);
    level += 1;
  }
  const aux = [];
  if (label) {
    // A label image with a bar-code-like pattern; it stands in for the handwritten label real slides carry.
    const lw = 96; const lh = 96; const lab = new Uint8Array(lw * lh * 3);
    for (let y = 0; y < lh; y += 1) for (let x = 0; x < lw; x += 1) { const dark = y > 20 && y < 70 && hash(Math.floor(x / 3), 0, seed + 9) < 0.5; const v = dark ? 20 : 235; const i = (y * lw + x) * 3; lab[i] = v; lab[i + 1] = v; lab[i + 2] = dark ? 40 : 220; }
    aux.push({ kind: 'label', width: lw, height: lh, jpeg: encodeJpeg({ width: lw, height: lh, channels: 3, data: lab, quality }) });
  }
  const description = `hospital-desktop gen-slide synthetic|AppMag = ${magnification}|MPP = ${mpp}|Seed = ${seed}${patientId ? `|PatientID = ${patientId}` : ''}`;
  const bytes = writeTiff({ levels, aux, description, mpp });
  return { bytes, planted: base.planted, levels: levels.map((l) => ({ width: l.width, height: l.height, tiles: l.tiles.length })), mpp, magnification, width, height, tile };
}

