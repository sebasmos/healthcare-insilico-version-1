// A minimal PNG encoder (8-bit greyscale or RGBA), for rendered image frames
// returned by the environment API's view-image tool. No dependencies.
import zlib from 'node:zlib';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

/** Encodes pixels (Uint8 grey, or RGBA with channels = 4) as a PNG buffer. */
export function encodePng({ width, height, pixels, channels = 1 }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) { raw[y * (stride + 1)] = 0; Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Nearest-neighbour resample of a greyscale frame to a zoom factor (0.1 to 4), optionally cropped to a region first. */
export function resampleGrey(grey, width, height, { zoom = 1, region = null } = {}) {
  const r = region && region.width > 0 && region.height > 0 ? { x: Math.max(0, Math.floor(region.x)), y: Math.max(0, Math.floor(region.y)), width: Math.min(width, Math.floor(region.width)), height: Math.min(height, Math.floor(region.height)) } : { x: 0, y: 0, width, height };
  const z = Math.max(0.1, Math.min(4, Number(zoom) || 1));
  const ow = Math.max(1, Math.round(r.width * z)); const oh = Math.max(1, Math.round(r.height * z));
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y += 1) { const sy = Math.min(height - 1, r.y + Math.floor(y / z)); for (let x = 0; x < ow; x += 1) { const sx = Math.min(width - 1, r.x + Math.floor(x / z)); out[y * ow + x] = grey[sy * width + sx]; } }
  return { pixels: out, width: ow, height: oh, region: r, zoom: z };
}
