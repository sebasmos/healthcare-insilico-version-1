// A small baseline JPEG encoder and decoder in plain JavaScript.
// The encoder writes the synthetic slides (`scripts/gen-slide.mjs`); the
// decoder exists so tests can check that tiles served by the pathology
// routes decode to the planted colours. Baseline only: 8-bit, one or three
// components, no subsampling (4:4:4), optional restart intervals on decode.
// Nothing here runs on the request path for real slides: tiles are passed
// through to the browser as stored.

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const DC_LUM = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHR = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUM = { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], vals: [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] };
const AC_CHR = { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], vals: [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] };

const COS = Array.from({ length: 8 }, (_, x) => Array.from({ length: 8 }, (_, u) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)));
const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);

export function quantTables(quality = 85) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const make = (base) => base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  return { lum: make(LUM_Q), chr: make(CHR_Q) };
}

/** Code lengths and codes for a table given as BITS and HUFFVAL (JPEG Annex C). */
function huffmanCodes({ bits, vals }) {
  const out = new Map();
  let code = 0; let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < bits[len - 1]; i += 1) { out.set(vals[k], { code, len }); k += 1; code += 1; }
    code <<= 1;
  }
  return out;
}
const CODES = { dcLum: huffmanCodes(DC_LUM), dcChr: huffmanCodes(DC_CHR), acLum: huffmanCodes(AC_LUM), acChr: huffmanCodes(AC_CHR) };

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(value, len) {
    for (let i = len - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((value >> i) & 1); this.n += 1;
      if (this.n === 8) { this.bytes.push(this.acc); if (this.acc === 0xff) this.bytes.push(0); this.acc = 0; this.n = 0; }
    }
  }
  flush() { if (this.n) { this.write((1 << (8 - this.n)) - 1, 8 - this.n); } return Uint8Array.from(this.bytes); }
}
const category = (v) => { let a = Math.abs(v); let n = 0; while (a) { n += 1; a >>= 1; } return n; };
const valueBits = (v, s) => (v >= 0 ? v : v + (1 << s) - 1);

function fdctQuant(block, q, out) {
  // Separable 2-D DCT: rows then columns.
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) for (let u = 0; u < 8; u += 1) { let s = 0; for (let x = 0; x < 8; x += 1) s += block[y * 8 + x] * COS[x][u]; tmp[y * 8 + u] = s * C(u) / 2; }
  for (let u = 0; u < 8; u += 1) for (let v = 0; v < 8; v += 1) { let s = 0; for (let y = 0; y < 8; y += 1) s += tmp[y * 8 + u] * COS[y][v]; out[v * 8 + u] = Math.round((s * C(v) / 2) / q[v * 8 + u]); }
}

function marker(id, payload) { return [0xff, id, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]; }
function dqtSegment(tables) { return marker(0xdb, [0, ...ZIGZAG.map((z) => tables.lum[z]), 1, ...ZIGZAG.map((z) => tables.chr[z])]); }
function dhtSegment() { return marker(0xc4, [[0x00, DC_LUM], [0x10, AC_LUM], [0x01, DC_CHR], [0x11, AC_CHR]].flatMap(([id, t]) => [id, ...t.bits, ...t.vals])); }
function sofSegment(width, height, channels) { return marker(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, channels, ...(channels === 1 ? [1, 0x11, 0] : [1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])]); }
function sosSegment(channels) { return marker(0xda, [channels, ...(channels === 1 ? [1, 0x00] : [1, 0x00, 2, 0x11, 3, 0x11]), 0, 63, 0]); }
const JFIF = marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** An Adobe APP14 segment; transform 0 means the three components are RGB, 1 means YCbCr. */
export function adobeSegment(transform) { return Uint8Array.from(marker(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform])); }

/** The tables-only stream (SOI, DQT, DHT, EOI) that a TIFF stores in JPEGTables. */
export function jpegTables(quality = 85) { return Uint8Array.from([0xff, 0xd8, ...dqtSegment(quantTables(quality)), ...dhtSegment(), 0xff, 0xd9]); }

/**
 * Encodes 8-bit pixels (interleaved, `channels` 1 or 3) as a baseline JPEG.
 * tables: 'inline' writes DQT and DHT in the stream; 'omit' leaves them out
 * (the abbreviated format used with a TIFF JPEGTables tag).
 */
export function encodeJpeg({ width, height, channels = 3, data, quality = 85, tables = 'inline' }) {
  if (![1, 3].includes(channels)) throw new Error('channels must be 1 or 3');
  if (data.length < width * height * channels) throw new Error('pixel data is too short');
  const q = quantTables(quality);
  const head = [0xff, 0xd8, ...JFIF, ...(tables === 'omit' ? [] : [...dqtSegment(q), ...dhtSegment()]), ...sofSegment(width, height, channels), ...sosSegment(channels)];
  const bw = new BitWriter();
  const comps = channels === 1 ? [{ q: q.lum, dc: CODES.dcLum, ac: CODES.acLum, pred: 0 }] : [{ q: q.lum, dc: CODES.dcLum, ac: CODES.acLum, pred: 0 }, { q: q.chr, dc: CODES.dcChr, ac: CODES.acChr, pred: 0 }, { q: q.chr, dc: CODES.dcChr, ac: CODES.acChr, pred: 0 }];
  const blocks = comps.map(() => new Float64Array(64));
  const coef = new Int32Array(64);
  const pixel = (x, y) => { const xx = Math.min(width - 1, x); const yy = Math.min(height - 1, y); const i = (yy * width + xx) * channels; return i; };
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
        const i = pixel(bx + x, by + y);
        if (channels === 1) blocks[0][y * 8 + x] = data[i] - 128;
        else {
          const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
          blocks[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blocks[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blocks[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      comps.forEach((c, ci) => {
        fdctQuant(blocks[ci], c.q, coef);
        const diff = coef[0] - c.pred; c.pred = coef[0];
        const s = category(diff); const dc = c.dc.get(s); bw.write(dc.code, dc.len); if (s) bw.write(valueBits(diff, s), s);
        let run = 0;
        for (let k = 1; k < 64; k += 1) {
          const v = coef[ZIGZAG[k]];
          if (v === 0) { run += 1; continue; }
          while (run > 15) { const z = c.ac.get(0xf0); bw.write(z.code, z.len); run -= 16; }
          const sz = category(v); const sym = c.ac.get((run << 4) | sz); bw.write(sym.code, sym.len); bw.write(valueBits(v, sz), sz); run = 0;
        }
        if (run) { const e = c.ac.get(0); bw.write(e.code, e.len); }
      });
    }
  }
  const scan = bw.flush();
  const out = new Uint8Array(head.length + scan.length + 2);
  out.set(head); out.set(scan, head.length); out[out.length - 2] = 0xff; out[out.length - 1] = 0xd9;
  return out;
}

/** Marker segments of a JPEG stream: [{ id, offset, length }] (entropy-coded data is skipped). */
export function jpegSegments(bytes) {
  const out = [];
  let i = 2;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG stream (no SOI)');
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const id = bytes[i + 1];
    if (id === 0xd8 || id === 0x01 || (id >= 0xd0 && id <= 0xd7)) { i += 2; continue; }
    if (id === 0xd9) { out.push({ id, offset: i, length: 2 }); break; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    out.push({ id, offset: i, length: len + 2 });
    i += len + 2;
    if (id === 0xda) break;
  }
  return out;
}
export function jpegInfo(bytes) {
  const segs = jpegSegments(bytes);
  const sof = segs.find((s) => [0xc0, 0xc1, 0xc2].includes(s.id));
  if (!sof) throw new Error('No frame header in JPEG stream');
  const o = sof.offset + 4;
  return { progressive: sof.id === 0xc2, height: (bytes[o + 1] << 8) | bytes[o + 2], width: (bytes[o + 3] << 8) | bytes[o + 4], channels: bytes[o + 5], hasQuantTables: segs.some((s) => s.id === 0xdb), hasHuffmanTables: segs.some((s) => s.id === 0xc4), hasJfif: segs.some((s) => s.id === 0xe0), hasAdobe: segs.some((s) => s.id === 0xee) };
}

/** Builds a complete JPEG from a tables-only stream and an abbreviated tile stream; a tile that already carries its tables is returned unchanged. */
export function spliceTables(tables, tile) {
  if (!tables || !tables.length) return tile;
  const info = jpegInfo(tile);
  if (info.hasQuantTables && info.hasHuffmanTables) return tile;
  const body = tables.subarray(2, tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.length - 2 : tables.length);
  const out = new Uint8Array(2 + body.length + tile.length - 2);
  out.set([0xff, 0xd8]); out.set(body, 2); out.set(tile.subarray(2), 2 + body.length);
  return out;
}
/** Inserts an Adobe APP14 marker after SOI so a decoder treats three components as RGB (transform 0). */
export function withAdobeMarker(jpeg, transform = 0) {
  const seg = adobeSegment(transform);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2)); out.set(seg, 2); out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

// ---------- decoder ----------
class BitReader {
  constructor(bytes, start) { this.b = bytes; this.i = start; this.acc = 0; this.n = 0; this.marker = null; }
  bit() {
    if (this.n === 0) {
      if (this.i >= this.b.length) throw new Error('Unexpected end of JPEG data');
      let v = this.b[this.i];
      if (v === 0xff) { const next = this.b[this.i + 1]; if (next === 0) { this.i += 2; } else if (next >= 0xd0 && next <= 0xd7) { this.marker = next; v = 0; } else { this.marker = next; v = 0; } } else this.i += 1;
      this.acc = v; this.n = 8;
    }
    this.n -= 1; return (this.acc >> this.n) & 1;
  }
  bits(k) { let v = 0; for (let i = 0; i < k; i += 1) v = (v << 1) | this.bit(); return v; }
  restart() { this.n = 0; this.marker = null; while (this.i < this.b.length - 1 && !(this.b[this.i] === 0xff && this.b[this.i + 1] >= 0xd0 && this.b[this.i + 1] <= 0xd7)) this.i += 1; this.i += 2; }
}
function decodeTable(bits, vals) {
  // lookup: code length → Map(code → symbol)
  const byLen = Array.from({ length: 17 }, () => new Map());
  let code = 0; let k = 0;
  for (let len = 1; len <= 16; len += 1) { for (let i = 0; i < bits[len - 1]; i += 1) { byLen[len].set(code, vals[k]); k += 1; code += 1; } code <<= 1; }
  return byLen;
}
function readSymbol(br, table) { let code = 0; for (let len = 1; len <= 16; len += 1) { code = (code << 1) | br.bit(); const sym = table[len].get(code); if (sym !== undefined) return sym; } throw new Error('Invalid Huffman code'); }
const extend = (v, s) => (s === 0 ? 0 : v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
function idct(coef, out) {
  const tmp = new Float64Array(64);
  for (let v = 0; v < 8; v += 1) for (let x = 0; x < 8; x += 1) { let s = 0; for (let u = 0; u < 8; u += 1) s += C(u) * coef[v * 8 + u] * COS[x][u]; tmp[v * 8 + x] = s / 2; }
  for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) { let s = 0; for (let v = 0; v < 8; v += 1) s += C(v) * tmp[v * 8 + x] * COS[y][v]; out[y * 8 + x] = s / 2; }
}

/** Decodes a baseline JPEG (8-bit, 1 or 3 components, no subsampling) to interleaved pixels. */
export function decodeJpeg(bytes) {
  const q = {}; const dc = {}; const ac = {}; let frame = null; let restartInterval = 0; let adobeTransform = null; let scanStart = -1; let scanComps = null;
  for (const seg of jpegSegments(bytes)) {
    const p = seg.offset + 4; const end = seg.offset + seg.length;
    if (seg.id === 0xdb) { let i = p; while (i < end) { const pq = bytes[i] >> 4; const id = bytes[i] & 15; i += 1; const t = new Int32Array(64); for (let k = 0; k < 64; k += 1) { t[ZIGZAG[k]] = pq ? (bytes[i] << 8) | bytes[i + 1] : bytes[i]; i += pq ? 2 : 1; } q[id] = t; } }
    else if (seg.id === 0xc4) { let i = p; while (i < end) { const cls = bytes[i] >> 4; const id = bytes[i] & 15; const bits = Array.from(bytes.subarray(i + 1, i + 17)); const n = bits.reduce((a, b) => a + b, 0); const vals = Array.from(bytes.subarray(i + 17, i + 17 + n)); (cls ? ac : dc)[id] = decodeTable(bits, vals); i += 17 + n; } }
    else if (seg.id === 0xc0 || seg.id === 0xc1) { const n = bytes[p + 5]; frame = { height: (bytes[p + 1] << 8) | bytes[p + 2], width: (bytes[p + 3] << 8) | bytes[p + 4], comps: Array.from({ length: n }, (_, k) => ({ id: bytes[p + 6 + k * 3], h: bytes[p + 7 + k * 3] >> 4, v: bytes[p + 7 + k * 3] & 15, tq: bytes[p + 8 + k * 3] })) }; }
    else if (seg.id === 0xc2) throw new Error('Progressive JPEG is not supported by this decoder');
    else if (seg.id === 0xdd) restartInterval = (bytes[p] << 8) | bytes[p + 1];
    else if (seg.id === 0xee && bytes[p] === 0x41 && bytes[p + 1] === 0x64) adobeTransform = bytes[end - 1];
    else if (seg.id === 0xda) { const n = bytes[p]; scanComps = Array.from({ length: n }, (_, k) => ({ id: bytes[p + 1 + k * 2], td: bytes[p + 2 + k * 2] >> 4, ta: bytes[p + 2 + k * 2] & 15 })); scanStart = end; }
  }
  if (!frame || scanStart < 0) throw new Error('JPEG stream has no frame or scan');
  if (frame.comps.some((c) => c.h !== 1 || c.v !== 1)) throw new Error('Subsampled JPEG is not supported by this decoder');
  const { width, height } = frame;
  const channels = frame.comps.length;
  const out = new Uint8Array(width * height * channels);
  const br = new BitReader(bytes, scanStart);
  const comps = frame.comps.map((c) => { const sc = scanComps.find((s) => s.id === c.id); return { q: q[c.tq], dc: dc[sc.td], ac: ac[sc.ta], pred: 0 }; });
  const coef = new Float64Array(64); const px = new Float64Array(64);
  let mcu = 0;
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) { br.restart(); comps.forEach((c) => { c.pred = 0; }); }
      mcu += 1;
      comps.forEach((c, ci) => {
        coef.fill(0);
        const s = readSymbol(br, c.dc); const diff = extend(br.bits(s), s); c.pred += diff; coef[0] = c.pred * c.q[0];
        for (let k = 1; k < 64;) { const sym = readSymbol(br, c.ac); const r = sym >> 4; const sz = sym & 15; if (sym === 0) break; if (sym === 0xf0) { k += 16; continue; } k += r; if (k > 63) break; coef[ZIGZAG[k]] = extend(br.bits(sz), sz) * c.q[ZIGZAG[k]]; k += 1; }
        idct(coef, px);
        for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { const xx = bx + x; const yy = by + y; if (xx < width && yy < height) out[(yy * width + xx) * channels + ci] = Math.max(0, Math.min(255, Math.round(px[y * 8 + x] + 128))); }
      });
    }
  }
  if (channels === 3 && adobeTransform !== 0) {
    for (let i = 0; i < out.length; i += 3) { const Y = out[i]; const cb = out[i + 1] - 128; const cr = out[i + 2] - 128; out[i] = Math.max(0, Math.min(255, Math.round(Y + 1.402 * cr))); out[i + 1] = Math.max(0, Math.min(255, Math.round(Y - 0.344136 * cb - 0.714136 * cr))); out[i + 2] = Math.max(0, Math.min(255, Math.round(Y + 1.772 * cb))); }
  }
  return { width, height, channels, data: out };
}
