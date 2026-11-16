import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  parse, write, pixels, toRGBA, autoWindow, distanceMm, isValidUid, generateUid, parseNifti, gunzip, TS, SOP_CLASS, WINDOW_PRESETS, DicomError,
} from '../viewers/dicom/dicom.js';
import { validateInstance, niftiToInstances } from '../pacs/server/dicom.mjs';
import { buildPhantom } from './support/phantom.mjs';
import { REPO_ROOT } from '../platform/server/db/index.mjs';

const NAMES = { [TS.IMPLICIT_LE]: 'implicit VR little endian', [TS.EXPLICIT_LE]: 'explicit VR little endian', [TS.EXPLICIT_BE]: 'explicit VR big endian' };
const base = (extra = {}) => ({
  SOPClassUID: SOP_CLASS.CT, SOPInstanceUID: generateUid(), StudyInstanceUID: generateUid(), SeriesInstanceUID: generateUid(), Modality: 'CT',
  PatientName: 'Roundtrip^Synthetic', PatientID: 'N100001', StudyDate: '20260102', StudyTime: '131415', AccessionNumber: 'ACC1', StudyDescription: 'Odd length',
  SeriesNumber: '3', InstanceNumber: '7', PixelSpacing: ['0.5', '0.25'], ImagePositionPatient: ['-1.5', '2', '30'], SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2',
  Rows: 4, Columns: 6, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1, RescaleIntercept: '-1024', RescaleSlope: '2', WindowCenter: '40', WindowWidth: '400', ...extra,
});

for (const ts of Object.values(TS)) {
  test(`round trip, ${NAMES[ts]}: signed 16-bit pixels, strings, numbers and multi-valued elements`, () => {
    const px = Int16Array.from({ length: 24 }, (_, i) => (i - 12) * 1000);
    const file = parse(write(base({ PixelData: px }), { transferSyntax: ts }));
    assert.equal(file.transferSyntax, ts);
    assert.equal(file.str('PatientName'), 'Roundtrip^Synthetic');
    assert.equal(file.str('StudyDescription'), 'Odd length', 'padding is stripped');
    assert.equal(file.num('Rows'), 4);
    assert.equal(file.num('InstanceNumber'), 7);
    assert.deepEqual(file.nums('PixelSpacing'), [0.5, 0.25]);
    assert.deepEqual(file.nums('ImagePositionPatient'), [-1.5, 2, 30]);
    const info = pixels(file);
    assert.deepEqual([info.rows, info.columns, info.frames, info.signed, info.slope, info.intercept], [4, 6, 1, true, 2, -1024]);
    assert.deepEqual([info.rowSpacing, info.columnSpacing], [0.5, 0.25]);
    assert.deepEqual(Array.from(info.frame(0)), Array.from(px));
    assert.deepEqual(validateInstance(file), []);
  });

  test(`round trip, ${NAMES[ts]}: unsigned 16-bit multi-frame`, () => {
    const px = Uint16Array.from({ length: 3 * 24 }, (_, i) => (i * 911) % 65536);
    const file = parse(write(base({ PixelRepresentation: 0, NumberOfFrames: '3', PixelData: px }), { transferSyntax: ts }));
    const info = pixels(file);
    assert.equal(info.frames, 3);
    for (let f = 0; f < 3; f += 1) assert.deepEqual(Array.from(info.frame(f)), Array.from(px.subarray(f * 24, (f + 1) * 24)));
    assert.throws(() => info.frame(3), /out of range/);
  });

  test(`round trip, ${NAMES[ts]}: 8-bit RGB, interleaved and planar`, () => {
    const interleaved = Uint8Array.from({ length: 4 * 6 * 3 }, (_, i) => (i * 7) % 256);
    const rgb = { SOPClassUID: SOP_CLASS.SC, Modality: 'OT', SamplesPerPixel: 3, PhotometricInterpretation: 'RGB', BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0, RescaleIntercept: undefined, RescaleSlope: undefined, WindowCenter: undefined, WindowWidth: undefined };
    const a = pixels(parse(write(base({ ...rgb, PlanarConfiguration: 0, PixelData: interleaved }), { transferSyntax: ts })));
    assert.deepEqual(Array.from(a.frame(0)), Array.from(interleaved));
    const planar = new Uint8Array(interleaved.length);
    for (let i = 0; i < 24; i += 1) for (let c = 0; c < 3; c += 1) planar[c * 24 + i] = interleaved[i * 3 + c];
    const b = pixels(parse(write(base({ ...rgb, PlanarConfiguration: 1, PixelData: planar }), { transferSyntax: ts })));
    assert.deepEqual(Array.from(b.frame(0)), Array.from(interleaved), 'planar data is returned interleaved');
    const rgba = toRGBA(a.frame(0), a);
    assert.deepEqual(Array.from(rgba.subarray(0, 8)), [interleaved[0], interleaved[1], interleaved[2], 255, interleaved[3], interleaved[4], interleaved[5], 255]);
  });

  test(`round trip, ${NAMES[ts]}: the phantom generator output parses and validates`, () => {
    const files = buildPhantom({ transferSyntax: ts });
    assert.equal(files.length, 42);
    const ct = files.filter((f) => f.folder === 'ct-chest').map((f) => parse(f.bytes));
    assert.equal(new Set(ct.map((f) => f.str('SeriesInstanceUID'))).size, 1);
    assert.deepEqual(ct.map((f) => f.num('InstanceNumber')), Array.from({ length: 40 }, (_, i) => i + 1));
    for (const f of files) assert.deepEqual(validateInstance(parse(f.bytes)), []);
    const info = pixels(ct[20]);
    const frame = info.frame(0);
    assert.equal(Math.round(frame[0] / 100), -10, 'air in the corner');
    assert.ok(frame[64 * 128 + 20] > 0 && frame[64 * 128 + 20] < 80, 'soft tissue at the body edge');
  });
}

test('rescale and windowing: values map to grey levels; presets, invert and MONOCHROME1', () => {
  const px = Int16Array.from([-1000, 0, 20, 40, 60, 2000]);
  const info = pixels(parse(write(base({ Rows: 1, Columns: 6, RescaleIntercept: '0', RescaleSlope: '1', PixelData: px }))));
  const grey = (opts) => Array.from(toRGBA(info.frame(0), info, opts)).filter((_, i) => i % 4 === 0);
  assert.deepEqual(grey({ center: 40, width: 80 }), [0, 0, 64, 128, 191, 255]);
  assert.deepEqual(grey({ center: 40, width: 80, invert: true }), [255, 255, 191, 128, 64, 0]);
  assert.deepEqual(autoWindow(info.frame(0), info), { center: 40, width: 400 }, 'header window wins');
  const noHeader = pixels(parse(write(base({ Rows: 1, Columns: 6, RescaleIntercept: '-10', RescaleSlope: '2', WindowCenter: undefined, WindowWidth: undefined, PixelData: px }))));
  assert.deepEqual(autoWindow(noHeader.frame(0), noHeader), { center: 990, width: 6000 }, 'otherwise the rescaled value range');
  const mono1 = pixels(parse(write(base({ Rows: 1, Columns: 6, PhotometricInterpretation: 'MONOCHROME1', RescaleIntercept: '0', RescaleSlope: '1', PixelData: px }))));
  assert.deepEqual(Array.from(toRGBA(mono1.frame(0), mono1, { center: 40, width: 80 })).filter((_, i) => i % 4 === 0), [255, 255, 191, 128, 64, 0]);
  assert.deepEqual(Object.keys(WINDOW_PRESETS), ['Soft Tissue', 'Lung', 'Bone', 'Brain', 'Liver', 'Mediastinum']);
});

test('measurement: length in millimetres from pixel spacing', () => {
  assert.equal(distanceMm({ x: 0, y: 0 }, { x: 30, y: 40 }, 0.5, 0.5), 25);
  assert.equal(distanceMm({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 0.25), 2.5, 'columns use column spacing');
  assert.equal(distanceMm({ x: 0, y: 0 }, { x: 0, y: 10 }, 2, 0.25), 20, 'rows use row spacing');
  assert.equal(distanceMm({ x: 0, y: 0 }, { x: 1, y: 1 }, null, null), null, 'no spacing, no millimetres');
});

test('UIDs: validation and generation', () => {
  for (const ok of ['1.2.840.10008.1.2', '2.25.0', generateUid()]) assert.ok(isValidUid(ok), ok);
  for (const bad of ['', '1', '1.02.3', '1..2', 'abc', '1.2.', `1.${'9'.repeat(70)}`, null]) assert.ok(!isValidUid(bad), String(bad));
  assert.notEqual(generateUid(), generateUid());
});

test('sequences are parsed in explicit and implicit files, with defined and undefined lengths', () => {
  const file = write(base({ PixelData: new Int16Array(24) }));
  const at = file.length - (24 * 2 + 12);
  const u16 = (n) => [n & 255, n >> 8];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const item = [...u16(0x0008), ...u16(0x0060), 0x43, 0x53, ...u16(2), 0x4d, 0x52];
  const defined = [...u16(0x0040), ...u16(0x0275), 0x53, 0x51, 0, 0, ...u32(item.length + 8), ...u16(0xfffe), ...u16(0xe000), ...u32(item.length), ...item];
  const undefinedLength = [...u16(0x0040), ...u16(0x0260), 0x53, 0x51, 0, 0, ...u32(0xffffffff), ...u16(0xfffe), ...u16(0xe000), ...u32(0xffffffff), ...item, ...u16(0xfffe), ...u16(0xe00d), ...u32(0), ...u16(0xfffe), ...u16(0xe0dd), ...u32(0)];
  const withSq = new Uint8Array([...file.subarray(0, at), ...undefinedLength, ...defined, ...file.subarray(at)]);
  const parsed = parse(withSq);
  assert.equal(parsed.elements.get('00400275').value[0].get('00080060').value, 'MR');
  assert.equal(parsed.elements.get('00400260').value[0].get('00080060').value, 'MR');
  assert.equal(pixels(parsed).frame(0).length, 24, 'elements after the sequences still parse');
});

test('invalid input is refused with a clear reason', () => {
  assert.throws(() => parse(new Uint8Array(200)), /no DICM prefix/);
  const good = write(base({ PixelData: new Int16Array(24) }));
  assert.throws(() => parse(good.subarray(0, good.length - 10)), /truncated/);
  const jpeg = new Uint8Array(good);
  const ts = Buffer.from(jpeg).indexOf('1.2.840.10008.1.2.1');
  jpeg.set(Buffer.from('1.2.840.10008.1.2.4.50'.slice(0, 20)), ts);
  assert.throws(() => parse(jpeg), /Unsupported transfer syntax/);
  assert.throws(() => pixels(parse(write(base({ PixelData: new Int16Array(10) })))), /need 48/);
  assert.throws(() => write({ Modality: 'CT' }), /SOPClassUID is required/);
  assert.throws(() => write(base({ NotAKeyword: 'x' })), /Unknown keyword/);
  assert.throws(() => write(base({}), { transferSyntax: '1.2.840.10008.1.2.4.50' }), DicomError);
  const issues = validateInstance(parse(write(base({ PatientID: undefined, PixelSpacing: ['0', '1'], StudyInstanceUID: '1.02', PixelData: new Int16Array(24) }))));
  assert.deepEqual(issues.map((i) => i.split(' ')[0]).sort(), ['PatientID', 'PixelSpacing', 'StudyInstanceUID']);
});

test('NIfTI-1: .nii and .nii.gz parse; conversion to DICOM keeps geometry and values', async () => {
  const dims = [5, 4, 3];
  const header = new Uint8Array(352);
  const view = new DataView(header.buffer);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((d, i) => view.setInt16(40 + i * 2, d, true));
  view.setInt16(70, 16, true); view.setInt16(72, 32, true);
  [1, 0.8, 0.9, 2.5].forEach((p, i) => view.setFloat32(76 + i * 4, p, true));
  view.setFloat32(108, 352, true); view.setFloat32(112, 1, true); view.setFloat32(116, 0, true);
  header.set([0x6e, 0x2b, 0x31, 0], 344);
  const values = Float32Array.from({ length: 60 }, (_, i) => i * 1.5);
  const nii = new Uint8Array(352 + 240);
  nii.set(header);
  nii.set(new Uint8Array(values.buffer), 352);

  const volume = parseNifti(nii);
  assert.deepEqual(volume.dims, dims);
  assert.deepEqual(volume.spacing.map((s) => Math.round(s * 10) / 10), [0.8, 0.9, 2.5]);
  assert.deepEqual(Array.from(volume.data), Array.from(values));
  assert.deepEqual(Array.from(parseNifti(await gunzip(new Uint8Array(gzipSync(nii)))).data), Array.from(values), '.nii.gz');
  assert.throws(() => parseNifti(new Uint8Array(400)), /Not a NIfTI-1 file/);

  const patient = { name: [{ family: 'Nifti', given: ['Synthetic'] }], gender: 'female', birthDate: '1970-01-01', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N100009' }] };
  const files = niftiToInstances(volume, { patient, modality: 'MR' }).map((b) => parse(b));
  assert.equal(files.length, 3);
  assert.equal(new Set(files.map((f) => f.str('StudyInstanceUID'))).size, 1);
  assert.equal(new Set(files.map((f) => f.str('AccessionNumber'))).size, 1);
  assert.equal(files[0].str('PatientID'), 'N100009');
  const info = pixels(files[1]);
  assert.deepEqual([info.rows, info.columns], [4, 5]);
  assert.deepEqual([info.rowSpacing, info.columnSpacing].map((s) => Math.round(s * 10) / 10), [0.9, 0.8]);
  const original = values[1 * 20 + 3 * 5 + 2];
  const restored = info.frame(0)[0 * 5 + 2] * info.slope + info.intercept;
  assert.ok(Math.abs(restored - original) < 0.05, `value preserved through rescale (${restored} vs ${original})`);
  for (const f of files) assert.deepEqual(validateInstance(f), []);
});

test('the browser copy of the codec is identical to the package source', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'viewers/dicom/dicom.js'), 'utf8');
  const copy = fs.readFileSync(path.join(REPO_ROOT, 'viewers/web/shared/dicom.js'), 'utf8');
  assert.equal(copy, source, 'run npm run sync');
});

test('RLE lossless: 16-bit signed, 8-bit and RGB frames round trip through PackBits segments; multi-frame needs one fragment per frame', async () => {
  const { rleEncodeFrame, rleDecodeFrames, COMPRESSED_TS, isCompressedSyntax } = await import('../viewers/dicom/dicom.js');
  const i16 = Int16Array.from({ length: 4 * 6 }, (_, i) => (i < 12 ? -1024 : 3071) - (i % 5) * 17);
  const back = rleDecodeFrames([rleEncodeFrame(i16)], { rows: 4, columns: 6, samples: 1, bitsAllocated: 16, frames: 1 });
  assert.deepEqual(Array.from(new Int16Array(back.buffer, back.byteOffset, 24)), Array.from(i16));
  const runs = Uint8Array.from({ length: 300 }, (_, i) => (i < 200 ? 7 : i));
  assert.deepEqual(Array.from(rleDecodeFrames([rleEncodeFrame(runs)], { rows: 10, columns: 30, samples: 1, bitsAllocated: 8, frames: 1 })), Array.from(runs));
  const rgb = Uint8Array.from({ length: 4 * 6 * 3 }, (_, i) => (i * 11) % 256);
  assert.deepEqual(Array.from(rleDecodeFrames([rleEncodeFrame(rgb, { samples: 3 })], { rows: 4, columns: 6, samples: 3, bitsAllocated: 8, frames: 1 })), Array.from(rgb));
  const file = parse(write(base({ PixelData: { encapsulated: true, fragments: [rleEncodeFrame(i16)] } }), { transferSyntax: COMPRESSED_TS.RLE }));
  assert.equal(file.transferSyntax, COMPRESSED_TS.RLE);
  assert.ok(isCompressedSyntax(file.transferSyntax));
  assert.deepEqual(Array.from(pixels(file).frame(0)), Array.from(i16), 'an RLE file decodes through pixels()');
  assert.throws(() => rleDecodeFrames([rleEncodeFrame(i16)], { rows: 4, columns: 6, samples: 1, bitsAllocated: 16, frames: 2 }), /one fragment per frame/);
  assert.throws(() => write(base({ PixelData: i16 }), { transferSyntax: COMPRESSED_TS.RLE }), /encapsulated/);
  assert.throws(() => write(base({ PixelData: { encapsulated: true, fragments: [new Uint8Array(2)] } })), /compressed transfer syntax/);
});

test('JPEG family: encapsulated fragments round trip untouched and are refused by the Node decoder with a pointer to the browser viewer', async () => {
  const { COMPRESSED_TS, COMPRESSED_LABEL } = await import('../viewers/dicom/dicom.js');
  const frag = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9, 0x01]);
  for (const ts of [COMPRESSED_TS.JPEG_BASELINE, COMPRESSED_TS.JPEG_LOSSLESS_SV1, COMPRESSED_TS.JPEG_LS_LOSSLESS, COMPRESSED_TS.J2K_LOSSLESS]) {
    const file = parse(write(base({ BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0, PixelData: { encapsulated: true, fragments: [frag, frag.slice(0, 4)] } }), { transferSyntax: ts }));
    const px = file.get('PixelData');
    assert.equal(px.encapsulated, true);
    assert.deepEqual(px.fragments.map((f) => Array.from(f)), [Array.from(frag).concat([0]), Array.from(frag.slice(0, 4))], `${COMPRESSED_LABEL[ts]}: odd fragments are padded, even ones untouched`);
    assert.throws(() => pixels(file), /browser viewer/);
    assert.deepEqual(validateInstance(file), [], `${COMPRESSED_LABEL[ts]}: a compressed instance validates`);
  }
});
