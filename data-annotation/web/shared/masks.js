// Segmentation masks (plan-master 5.4): a brush layer with undo and redo,
// run-length encoding in level-0 pixel coordinates, and the Observation that
// stores a mask (category annotation) linked to its image and the run.
// Shared by the PACS and Pathology viewers.

/** A binary mask over a width x height grid with an undo and redo history of strokes. */
export function createMaskLayer(width, height) {
  const data = new Uint8Array(width * height);
  const undo = []; const redo = [];
  let strokeBefore = null;
  const snapshot = () => Uint8Array.from(data);
  return {
    width, height, data,
    begin() { strokeBefore = snapshot(); },
    /** Paints (or erases) a filled circle of the given radius around a point. */
    paint(x, y, radius, erase = false) {
      const r = Math.max(1, radius); const r2 = r * r;
      for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(height - 1, Math.ceil(y + r)); yy += 1) for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(width - 1, Math.ceil(x + r)); xx += 1) { if ((xx - x) ** 2 + (yy - y) ** 2 <= r2) data[yy * width + xx] = erase ? 0 : 1; }
    },
    end() { if (strokeBefore) { undo.push(strokeBefore); redo.length = 0; strokeBefore = null; } },
    undo() { if (!undo.length) return false; redo.push(snapshot()); data.set(undo.pop()); return true; },
    redo() { if (!redo.length) return false; undo.push(snapshot()); data.set(redo.pop()); return true; },
    canUndo: () => undo.length > 0, canRedo: () => redo.length > 0,
    clear() { undo.push(snapshot()); data.fill(0); redo.length = 0; },
    count() { let n = 0; for (let i = 0; i < data.length; i += 1) n += data[i]; return n; },
    /** Bounding box of the painted pixels, or null when empty. */
    bbox() { let x0 = width, y0 = height, x1 = -1, y1 = -1; for (let i = 0; i < data.length; i += 1) { if (!data[i]) continue; const x = i % width; const y = (i - x) / width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }; },
    load(mask) { data.fill(0); const b = mask.bbox; const bits = rleDecode(mask.rle, b.width * b.height); for (let y = 0; y < b.height; y += 1) for (let x = 0; x < b.width; x += 1) { const X = b.x + x; const Y = b.y + y; if (X < width && Y < height && bits[y * b.width + x]) data[Y * width + X] = 1; } undo.length = 0; redo.length = 0; },
    /** The mask as run lengths over its bounding box, row by row (starting with a run of zeros). */
    encode() { const b = this.bbox(); if (!b) return null; const bits = new Uint8Array(b.width * b.height); for (let y = 0; y < b.height; y += 1) for (let x = 0; x < b.width; x += 1) bits[y * b.width + x] = data[(b.y + y) * width + (b.x + x)]; return { bbox: b, rle: rleEncode(bits), pixels: this.count() }; },
  };
}
/** Run-length encoding: alternating counts of 0s and 1s, starting with 0s (COCO style). */
export function rleEncode(bits) { const out = []; let cur = 0; let n = 0; for (let i = 0; i < bits.length; i += 1) { const v = bits[i] ? 1 : 0; if (v === cur) n += 1; else { out.push(n); cur = v; n = 1; } } out.push(n); return out; }
export function rleDecode(rle, length) { const out = new Uint8Array(length); let i = 0; let v = 0; for (const n of rle) { for (let k = 0; k < n && i < length; k += 1, i += 1) out[i] = v; v = 1 - v; } return out; }

/** The Observation that stores a mask: category annotation, label, the image reference, bounding box and run lengths in level-0 pixels. */
export function maskObservation({ patientRef, label, image, mask, runId = null, scale = 1, note = null }) {
  return {
    resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:observation-category', code: 'annotation' }] }],
    code: { coding: [{ system: 'urn:hospital-desktop:annotation-label', code: label }], text: `Segmentation mask: ${label}` },
    subject: { reference: patientRef }, effectiveDateTime: new Date().toISOString(),
    ...(image.ref ? { derivedFrom: [{ reference: image.ref }] } : {}),
    valueString: `mask ${mask.pixels} px in ${mask.bbox.width} x ${mask.bbox.height}`,
    ...(note ? { note: [{ text: note }] } : {}),
    extension: [
      { url: 'urn:hospital-desktop:segmentation', valueString: JSON.stringify({ kind: 'mask', encoding: 'rle', order: 'row-major', first: 0, coordinates: 'level-0 pixels', scale, image, bbox: mask.bbox, rle: mask.rle, pixels: mask.pixels }) },
      ...(runId ? [{ url: 'urn:hospital-desktop:run', valueString: runId }] : []),
    ],
  };
}
export const parseMask = (obs) => { try { return JSON.parse((obs.extension || []).find((e) => e.url === 'urn:hospital-desktop:segmentation')?.valueString || 'null'); } catch { return null; } };
