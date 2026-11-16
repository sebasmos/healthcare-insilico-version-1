// A small pure-JavaScript reader and writer for tiled pyramidal TIFF slides
//: directory structure, tile offsets and byte counts, JPEG tables,
// label and macro images, microns per pixel. Classic and BigTIFF, either byte
// order. Tiles are read as stored and never decoded here; `readTile` only
// splices shared JPEG tables (and an Adobe marker for RGB photometric data)
// so the browser receives a complete JPEG stream.
import fs from 'node:fs';
import { spliceTables, withAdobeMarker, jpegInfo } from './jpeg.mjs';

const TAG = { NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259, Photometric: 262, ImageDescription: 270, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279, XResolution: 282, YResolution: 283, PlanarConfiguration: 284, ResolutionUnit: 296, Software: 305, TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325, JPEGTables: 347, YCbCrSubsampling: 530 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
export const COMPRESSION = { 1: 'uncompressed', 5: 'LZW', 6: 'old-style JPEG', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits', 32946: 'Deflate', 33003: 'JPEG 2000 (Aperio YCbCr)', 33005: 'JPEG 2000 (Aperio RGB)', 34712: 'JPEG 2000', 34933: 'PNG', 34934: 'JPEG XR', 50001: 'WebP' };
export const SLIDE_EXTENSIONS = ['.svs', '.tif', '.tiff', '.ndpi', '.mrxs', '.scn', '.bif', '.vms'];
export class TiffError extends Error {}

class Source {
  constructor(file) { this.fd = fs.openSync(file, 'r'); this.size = fs.fstatSync(this.fd).size; }
  read(offset, length) { const buf = Buffer.alloc(Number(length)); let got = 0; while (got < length) { const n = fs.readSync(this.fd, buf, got, length - got, Number(offset) + got); if (n <= 0) break; got += n; } return buf.subarray(0, got); }
  close() { fs.closeSync(this.fd); }
}

function readValues(src, little, big, type, count, inlineBytes, inlineOffset) {
  const size = TYPE_SIZE[type];
  if (!size) throw new TiffError(`Unknown TIFF field type ${type}`);
  const total = size * Number(count);
  const buf = total <= (big ? 8 : 4) ? inlineBytes.subarray(0, total) : src.read(little ? inlineBytes.readUInt32LE(0) && !big ? inlineBytes.readUInt32LE(0) : Number(big ? inlineBytes.readBigUInt64LE(0) : inlineBytes.readUInt32BE(0)) : 0, total);
  const data = total <= (big ? 8 : 4) ? inlineBytes : (() => { const off = big ? (little ? inlineBytes.readBigUInt64LE(0) : inlineBytes.readBigUInt64BE(0)) : (little ? inlineBytes.readUInt32LE(0) : inlineBytes.readUInt32BE(0)); return src.read(off, total); })();
  void buf; void inlineOffset;
  if (type === 2) return data.subarray(0, total).toString('latin1').replace(/\0+$/, '');
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const o = i * size;
    if (type === 1 || type === 7 || type === 6) out.push(data[o]);
    else if (type === 3 || type === 8) out.push(little ? data.readUInt16LE(o) : data.readUInt16BE(o));
    else if (type === 4 || type === 9 || type === 13) out.push(little ? data.readUInt32LE(o) : data.readUInt32BE(o));
    else if (type === 5 || type === 10) { const n = little ? data.readUInt32LE(o) : data.readUInt32BE(o); const d = little ? data.readUInt32LE(o + 4) : data.readUInt32BE(o + 4); out.push(d ? n / d : 0); }
    else if (type === 11) out.push(little ? data.readFloatLE(o) : data.readFloatBE(o));
    else if (type === 12) out.push(little ? data.readDoubleLE(o) : data.readDoubleBE(o));
    else if (type === 16 || type === 17 || type === 18) out.push(Number(little ? data.readBigUInt64LE(o) : data.readBigUInt64BE(o)));
  }
  return out;
}

/** Parses the directory chain. Each IFD is { offset, tags: Map(tag → values) }. Tile offset arrays are read in full (they are small compared with the pixel data). */
export function parseTiff(file) {
  const src = new Source(file);
  try {
    const head = src.read(0, 16);
    if (head.length < 8) throw new TiffError('File is too short to be a TIFF');
    const order = head.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') throw new TiffError('Not a TIFF file (no II or MM byte-order mark)');
    const little = order === 'II';
    const magic = little ? head.readUInt16LE(2) : head.readUInt16BE(2);
    const big = magic === 43;
    if (magic !== 42 && magic !== 43) throw new TiffError(`Not a TIFF file (magic ${magic})`);
    let next = big ? Number(little ? head.readBigUInt64LE(8) : head.readBigUInt64BE(8)) : (little ? head.readUInt32LE(4) : head.readUInt32BE(4));
    const ifds = [];
    const seen = new Set();
    while (next && !seen.has(next) && ifds.length < 64) {
      seen.add(next);
      const countBuf = src.read(next, big ? 8 : 2);
      const count = big ? Number(little ? countBuf.readBigUInt64LE(0) : countBuf.readBigUInt64BE(0)) : (little ? countBuf.readUInt16LE(0) : countBuf.readUInt16BE(0));
      const entrySize = big ? 20 : 12;
      const entries = src.read(next + (big ? 8 : 2), count * entrySize);
      const tags = new Map();
      for (let i = 0; i < count; i += 1) {
        const e = entries.subarray(i * entrySize, (i + 1) * entrySize);
        const tag = little ? e.readUInt16LE(0) : e.readUInt16BE(0);
        const type = little ? e.readUInt16LE(2) : e.readUInt16BE(2);
        const n = big ? Number(little ? e.readBigUInt64LE(4) : e.readBigUInt64BE(4)) : (little ? e.readUInt32LE(4) : e.readUInt32BE(4));
        const inline = e.subarray(big ? 12 : 8);
        try { tags.set(tag, readValues(src, little, big, type, n, inline)); } catch (err) { if (err instanceof TiffError) throw err; tags.set(tag, null); }
      }
      ifds.push({ offset: next, tags });
      const nextBuf = src.read(next + (big ? 8 : 2) + count * entrySize, big ? 8 : 4);
      next = big ? Number(little ? nextBuf.readBigUInt64LE(0) : nextBuf.readBigUInt64BE(0)) : (little ? nextBuf.readUInt32LE(0) : nextBuf.readUInt32BE(0));
    }
    return { little, big, ifds, size: src.size };
  } finally { src.close(); }
}

const num = (ifd, tag) => { const v = ifd.tags.get(tag); return Array.isArray(v) ? v[0] : v ?? null; };
const str = (ifd, tag) => { const v = ifd.tags.get(tag); return typeof v === 'string' ? v : ''; };

/** Microns per pixel and objective power from an Aperio-style description or the resolution tags. */
export function slideMetadata(ifd) {
  const description = str(ifd, TAG.ImageDescription);
  const field = (name) => { const m = description.match(new RegExp(`\\|\\s*${name}\\s*=\\s*([^|]+)`, 'i')) || description.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*([^\\n|]+)`, 'i')); return m ? m[1].trim() : null; };
  let mpp = Number(field('MPP')) || null;
  const unit = num(ifd, TAG.ResolutionUnit);
  const xres = num(ifd, TAG.XResolution);
  if (!mpp && xres && unit === 3) mpp = 10000 / xres;
  if (!mpp && xres && unit === 2) mpp = 25400 / xres;
  const magnification = Number(field('AppMag')) || null;
  const patientId = field('PatientID') || field('Patient ID') || null;
  const vendor = /^Aperio/i.test(description) ? 'aperio' : /hospital-desktop/i.test(description) ? 'hospital-desktop' : description ? 'unknown' : null;
  return { description, mpp: mpp ? Math.round(mpp * 10000) / 10000 : null, magnification, patientId, vendor };
}

/**
 * Describes a slide file: the pyramid levels that can be served, the label and
 * macro images, metadata, and every reason a directory was refused.
 */
export function describeSlide(file) {
  const tiff = parseTiff(file);
  const levels = []; const refused = []; let label = null; let macro = null; let thumbnail = null;
  tiff.ifds.forEach((ifd, index) => {
    const width = num(ifd, TAG.ImageWidth); const height = num(ifd, TAG.ImageLength);
    const compression = num(ifd, TAG.Compression) ?? 1;
    const description = str(ifd, TAG.ImageDescription);
    const tiled = ifd.tags.has(TAG.TileOffsets) && ifd.tags.has(TAG.TileWidth);
    const kind = /\blabel\b/i.test(description) ? 'label' : /\bmacro\b/i.test(description) ? 'macro' : null;
    if (!tiled) {
      const aux = { index, width, height, compression, compressionName: COMPRESSION[compression] || `type ${compression}`, strips: (ifd.tags.get(TAG.StripOffsets) || []).length, servable: compression === 7 && (ifd.tags.get(TAG.StripOffsets) || []).length === 1 };
      if (kind === 'label') label = aux; else if (kind === 'macro') macro = aux; else if (index > 0) thumbnail = aux;
      else refused.push(`directory ${index}: the base image is stripped, not tiled; only tiled pyramids can be served`);
      return;
    }
    if (compression !== 7) { refused.push(`directory ${index}: tiles are ${COMPRESSION[compression] || `compression ${compression}`}; only JPEG tiles are served`); return; }
    if ((num(ifd, TAG.BitsPerSample) ?? 8) !== 8) { refused.push(`directory ${index}: ${num(ifd, TAG.BitsPerSample)}-bit samples are not supported`); return; }
    const tileWidth = num(ifd, TAG.TileWidth); const tileLength = num(ifd, TAG.TileLength);
    const offsets = ifd.tags.get(TAG.TileOffsets) || []; const byteCounts = ifd.tags.get(TAG.TileByteCounts) || [];
    const tilesAcross = Math.ceil(width / tileWidth); const tilesDown = Math.ceil(height / tileLength);
    if (offsets.length < tilesAcross * tilesDown || byteCounts.length < tilesAcross * tilesDown) { refused.push(`directory ${index}: ${offsets.length} tile offsets for a ${tilesAcross} x ${tilesDown} grid`); return; }
    levels.push({ index, width, height, tileWidth, tileLength, tilesAcross, tilesDown, offsets, byteCounts, photometric: num(ifd, TAG.Photometric) ?? 2, samples: num(ifd, TAG.SamplesPerPixel) ?? 3, jpegTables: ifd.tags.get(TAG.JPEGTables) ? Uint8Array.from(ifd.tags.get(TAG.JPEGTables)) : null, subfileType: num(ifd, TAG.NewSubfileType) ?? 0, description });
  });
  levels.sort((a, b) => b.width - a.width);
  const base = levels[0] || null;
  const meta = base ? slideMetadata(tiff.ifds[base.index]) : { description: '', mpp: null, magnification: null, patientId: null, vendor: null };
  return { format: 'tiff', bigTiff: tiff.big, byteOrder: tiff.little ? 'little' : 'big', size: tiff.size, levels, label, macro, thumbnail, refused, ...meta, width: base?.width ?? null, height: base?.height ?? null, tileWidth: base?.tileWidth ?? null, tileLength: base?.tileLength ?? null };
}

/** A complete JPEG for one tile: the bytes as stored, with shared tables spliced in and an Adobe marker when the photometric tag says the samples are RGB. */
export function readTile(file, level, x, y) {
  if (x < 0 || y < 0 || x >= level.tilesAcross || y >= level.tilesDown) throw new TiffError(`tile ${x},${y} is outside the ${level.tilesAcross} x ${level.tilesDown} grid`);
  const i = y * level.tilesAcross + x;
  const src = new Source(file);
  try {
    const bytes = Uint8Array.from(src.read(level.offsets[i], level.byteCounts[i]));
    if (!bytes.length) throw new TiffError(`tile ${x},${y} is empty`);
    let tile = spliceTables(level.jpegTables, bytes);
    if (level.photometric === 2 && level.samples === 3) { const info = jpegInfo(tile); if (!info.hasJfif && !info.hasAdobe) tile = withAdobeMarker(tile, 0); }
    return tile;
  } finally { src.close(); }
}

/** The single-strip JPEG of a label or macro directory, or null when it cannot be served as stored. */
export function readAuxImage(file, aux) {
  if (!aux || !aux.servable) return null;
  const tiff = parseTiff(file);
  const ifd = tiff.ifds[aux.index];
  const offsets = ifd.tags.get(TAG.StripOffsets); const counts = ifd.tags.get(TAG.StripByteCounts);
  const src = new Source(file);
  try { return spliceTables(ifd.tags.get(TAG.JPEGTables) ? Uint8Array.from(ifd.tags.get(TAG.JPEGTables)) : null, Uint8Array.from(src.read(offsets[0], counts[0]))); } finally { src.close(); }
}

// ---------- writer (classic TIFF, little endian) ----------
/**
 * Writes a tiled pyramidal TIFF. levels: [{ width, height, tileWidth, tileLength, tiles: [Uint8Array] (row-major), jpegTables?: Uint8Array }],
 * largest first. aux: [{ kind: 'label' | 'macro', width, height, jpeg }]. mpp in microns per pixel.
 */
export function writeTiff({ levels, aux = [], description = '', mpp = null, software = 'hospital-desktop gen-slide', photometric = 6 }) {
  const parts = []; let cursor = 8;
  const push = (buf) => { const at = cursor; parts.push(buf); cursor += buf.length; if (buf.length % 2) { parts.push(Buffer.alloc(1)); cursor += 1; } return at; };
  const ifdPlans = [];
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const rational = (v) => { const b = Buffer.alloc(8); const den = 10000; b.writeUInt32LE(Math.round(v * den)); b.writeUInt32LE(den, 4); return b; };
  const entry = (tag, type, values) => ({ tag, type, values });
  const resolution = mpp ? [entry(TAG.XResolution, 5, [10000 / mpp]), entry(TAG.YResolution, 5, [10000 / mpp]), entry(TAG.ResolutionUnit, 3, [3])] : [];
  levels.forEach((lv, i) => {
    const offsets = lv.tiles.map((t) => push(Buffer.from(t)));
    const entries = [entry(TAG.NewSubfileType, 4, [i === 0 ? 0 : 1]), entry(TAG.ImageWidth, 4, [lv.width]), entry(TAG.ImageLength, 4, [lv.height]), entry(TAG.BitsPerSample, 3, [8, 8, 8]), entry(TAG.Compression, 3, [7]), entry(TAG.Photometric, 3, [photometric]),
      ...(i === 0 && description ? [entry(TAG.ImageDescription, 2, description)] : []), entry(TAG.SamplesPerPixel, 3, [3]), ...resolution, entry(TAG.PlanarConfiguration, 3, [1]), ...(i === 0 ? [entry(TAG.Software, 2, software)] : []),
      entry(TAG.TileWidth, 3, [lv.tileWidth]), entry(TAG.TileLength, 3, [lv.tileLength]), entry(TAG.TileOffsets, 4, offsets), entry(TAG.TileByteCounts, 4, lv.tiles.map((t) => t.length)),
      ...(lv.jpegTables ? [entry(TAG.JPEGTables, 7, Array.from(lv.jpegTables))] : []), ...(photometric === 6 ? [entry(TAG.YCbCrSubsampling, 3, [1, 1])] : [])];
    ifdPlans.push(entries);
  });
  for (const a of aux) {
    const off = push(Buffer.from(a.jpeg));
    ifdPlans.push([entry(TAG.NewSubfileType, 4, [0]), entry(TAG.ImageWidth, 4, [a.width]), entry(TAG.ImageLength, 4, [a.height]), entry(TAG.BitsPerSample, 3, [8, 8, 8]), entry(TAG.Compression, 3, [7]), entry(TAG.Photometric, 3, [photometric]), entry(TAG.ImageDescription, 2, `hospital-desktop gen-slide\n${a.kind} ${a.width}x${a.height}`), entry(TAG.StripOffsets, 4, [off]), entry(TAG.SamplesPerPixel, 3, [3]), entry(TAG.RowsPerStrip, 4, [a.height]), entry(TAG.StripByteCounts, 4, [a.jpeg.length]), entry(TAG.PlanarConfiguration, 3, [1])]);
  }
  // Each IFD: out-of-line values first, then the directory itself.
  const ifdOffsets = [];
  const dirs = [];
  for (const entries of ifdPlans) {
    const encoded = entries.sort((a, b) => a.tag - b.tag).map((e) => {
      let data;
      if (e.type === 2) data = Buffer.from(`${e.values}\0`, 'latin1');
      else if (e.type === 3) data = Buffer.concat(e.values.map(u16));
      else if (e.type === 4) data = Buffer.concat(e.values.map(u32));
      else if (e.type === 5) data = Buffer.concat(e.values.map(rational));
      else data = Buffer.from(e.values);
      const count = e.type === 2 ? data.length : e.values.length;
      return { ...e, data, count };
    });
    for (const e of encoded) if (e.data.length > 4) e.offset = push(e.data);
    const dir = Buffer.alloc(2 + encoded.length * 12 + 4);
    dir.writeUInt16LE(encoded.length, 0);
    encoded.forEach((e, i) => { const o = 2 + i * 12; dir.writeUInt16LE(e.tag, o); dir.writeUInt16LE(e.type, o + 2); dir.writeUInt32LE(e.count, o + 4); if (e.data.length > 4) dir.writeUInt32LE(e.offset, o + 8); else e.data.copy(dir, o + 8); });
    ifdOffsets.push(cursor);
    dirs.push(dir);
    push(dir);
  }
  // Link the chain: patch each directory's next pointer.
  dirs.forEach((dir, i) => { dir.writeUInt32LE(i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0, dir.length - 4); });
  const header = Buffer.alloc(8); header.write('II', 0, 'latin1'); header.writeUInt16LE(42, 2); header.writeUInt32LE(ifdOffsets[0], 4);
  return Buffer.concat([header, ...parts]);
}
