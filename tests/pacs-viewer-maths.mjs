// PACS viewer at professional quality: measurement maths, hanging protocols,
// segmentation, and DICOM SEG, SR and presentation state round trips, all in our own code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lengthMm, angleDeg, cobbAngleDeg, ellipseStats, polygonStats, polygonAreaPx, probe, bidirectional, describeMeasurement } from '../pacs/web/pacs/measure.js';
import { chooseLayout, protocolFor, canShow, saveLayout, nearestByLocation, LAYOUTS, SHORTCUTS } from '../pacs/web/pacs/hanging.js';
import { createLabels, brush, threshold, regionGrow, segmentStats, sliceOverlay } from '../pacs/web/pacs/segment.js';
import { writeSeg, readSeg, writeSr, readSr, writePresentationState, readPresentationState, frameGroups } from '../viewers/dicom/objects.js';
import { parse, write, generateUid, SOP_CLASS } from '../viewers/dicom/dicom.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('length, angle and Cobb angle respect pixel spacing', () => {
  near(lengthMm([0, 0], [30, 40], 0.5, 0.5), 25);
  near(lengthMm([0, 0], [10, 0], 2, 0.7), 7);
  near(lengthMm([0, 0], [0, 10], 2, 0.7), 20);
  assert.equal(lengthMm([0, 0], [1, 1], null, null), null, 'no spacing, no length');
  near(angleDeg([10, 0], [0, 0], [0, 10]), 90);
  near(angleDeg([10, 0], [0, 0], [10, 10]), 45);
  near(angleDeg([10, 0], [0, 0], [10, 10], 2, 1), Math.atan2(20, 10) * 180 / Math.PI, 1e-9);
  near(cobbAngleDeg([[0, 0], [10, 0]], [[0, 5], [10, 15]]), 45);
  near(cobbAngleDeg([[0, 0], [10, 0]], [[10, 15], [0, 5]]), 45, 1e-9);
  near(cobbAngleDeg([[0, 0], [10, 0]], [[0, 3], [10, 3]]), 0);
  assert.equal(cobbAngleDeg([[0, 0], [0, 0]], [[0, 3], [10, 3]]), null);
});

test('region statistics: ellipse and freehand mean, standard deviation and area in mm2; probe in HU; bidirectional', () => {
  const columns = 64; const rows = 64; const frame = new Int16Array(columns * rows);
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < columns; x += 1) frame[y * columns + x] = x < 32 ? 1000 : 1100; // stored; HU = stored - 1024
  const opts = { slope: 1, intercept: -1024, rowSpacing: 0.5, columnSpacing: 0.8 };
  const left = ellipseStats(frame, columns, rows, [16, 32], 8, 6, opts);
  near(left.mean, -24); near(left.sd, 0); near(left.areaMm2, Math.PI * 8 * 0.8 * 6 * 0.5);
  assert.ok(Math.abs(left.count - Math.PI * 8 * 6) < 12, `${left.count} pixels in the ellipse`);
  const across = ellipseStats(frame, columns, rows, [31.5, 32], 10, 10, opts);
  near(across.mean, 26, 1); near(across.sd, 50, 1);
  assert.deepEqual([across.min, across.max], [-24, 76]);
  const square = [[10, 10], [20, 10], [20, 20], [10, 20]];
  assert.equal(polygonAreaPx(square), 100);
  const poly = polygonStats(frame, columns, rows, square, opts);
  near(poly.areaMm2, 100 * 0.5 * 0.8); near(poly.mean, -24); assert.equal(poly.count, 100);
  assert.equal(polygonStats(frame, columns, rows, [[40, 40], [50, 40], [45, 50]], opts).mean, 76);
  assert.equal(probe(frame, columns, rows, 40.2, 3.4, opts), 76);
  assert.equal(probe(frame, columns, rows, -1, 3, opts), null);
  const bi = bidirectional([[0, 0], [40, 0]], [[20, -10], [20, 10]], 0.5, 0.5);
  assert.deepEqual([bi.longMm, bi.shortMm, bi.offPerpendicularDeg], [20, 10, 0]);
  assert.equal(describeMeasurement({ kind: 'ellipse', value: 30.16, mean: -24, sd: 0, frame: 13, seriesNumber: 2 }), 'Ellipse area 30.2 mm2, mean -24.0 (SD 0.0) (series 2, image 14)');
  assert.equal(describeMeasurement({ kind: 'bidirectional', longMm: 20, shortMm: 10, frame: 0, label: 'Nodule' }), 'Nodule: Bidirectional 20.0 x 10.0 mm (image 1)');
});

test('hanging protocols: chosen by modality and body part, limited to what the study can show, and the saved choice wins', () => {
  assert.equal(protocolFor({ modality: 'CT', bodyPart: 'CHEST' }).id, 'ct-chest');
  assert.equal(protocolFor({ modality: 'CT', bodyPart: '', description: 'CT Head without contrast' }).id, 'ct-head');
  assert.equal(protocolFor({ modality: 'DX', bodyPart: 'CHEST' }).id, 'xr');
  assert.equal(protocolFor({ modality: 'US' }).id, 'default');
  const chest = { modality: 'CT', bodyPart: 'CHEST' };
  assert.equal(chooseLayout(chest, { prior: true, volume: true }).layout, 'mpr+prior', 'CT chest: axial, coronal, sagittal plus the prior');
  assert.equal(chooseLayout(chest, { prior: false, volume: true }).layout, '2x2');
  assert.equal(chooseLayout(chest, { prior: true, volume: false }).layout, '1x2');
  assert.equal(chooseLayout(chest, { prior: false, volume: false }).layout, '1x1');
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveLayout(chest, '3d', storage);
  assert.deepEqual([chooseLayout(chest, { prior: true, volume: true }, storage).layout, chooseLayout(chest, { prior: true, volume: true }, storage).from], ['3d', 'saved']);
  assert.equal(chooseLayout(chest, { prior: true, volume: false }, storage).layout, '1x2', 'a saved layout the study cannot show is not used');
  assert.equal(chooseLayout({ modality: 'CT', bodyPart: 'HEAD' }, { prior: true, volume: true }, storage).layout, '2x2', 'the choice is per modality and body part');
  assert.equal(canShow('nonsense', { prior: true, volume: true }), false);
  assert.deepEqual(LAYOUTS.map((l) => l.id), ['1x1', '1x2', '2x2', 'mpr+prior', '1+3', '3d']);
  assert.equal(nearestByLocation([-10, -5, 0, 5, 10], 3.4), 3);
  assert.equal(nearestByLocation([], 3), null);
  assert.ok(SHORTCUTS.length >= 15);
});

test('segmentation: brush, threshold and region growing on a label volume, with volumes per segment', () => {
  const dims = { columns: 32, rows: 32, slices: 4 }; const plane = 32 * 32;
  const vol = new Int16Array(plane * 4);
  // A bright 8x8x2 block in slices 1 and 2, and a separate bright pixel far away in slice 1.
  for (let z = 1; z <= 2; z += 1) for (let y = 8; y < 16; y += 1) for (let x = 8; x < 16; x += 1) vol[z * plane + y * 32 + x] = 500;
  vol[1 * plane + 30 * 32 + 30] = 500;
  const voxel = (i) => vol[i];
  const labels = createLabels(32, 32, 4);
  assert.equal(threshold(labels, dims, voxel, { low: 400, high: 600 }, 1), 129, 'threshold takes every voxel in range');
  labels.fill(0);
  const grown = regionGrow(labels, dims, voxel, [10, 10, 1], { tolerance: 50 }, 2);
  assert.deepEqual([grown.changed, grown.capped, grown.seedValue], [128, false, 500], 'region growing takes the connected block only');
  assert.equal(labels[1 * plane + 30 * 32 + 30], 0, 'the far pixel is not connected');
  labels.fill(0);
  assert.equal(regionGrow(labels, dims, voxel, [10, 10, 1], { tolerance: 50, in3d: false }, 2).changed, 64, 'kept to one slice');
  assert.equal(regionGrow(createLabels(32, 32, 4), dims, voxel, [10, 10, 1], { tolerance: 50, maxVoxels: 10 }, 2).capped, true);
  assert.equal(regionGrow(labels, dims, voxel, [99, 0, 0], { tolerance: 1 }, 2).changed, 0);
  const painted = brush(labels, dims, 0, 16, 16, 3, 3);
  assert.ok(painted >= 25 && painted <= 33, `${painted} voxels in a radius-3 brush`);
  assert.equal(brush(labels, dims, 0, 16, 16, 3, 0), painted, 'label 0 erases');
  assert.equal(threshold(labels, dims, voxel, { low: 400, high: 600, slice: 1 }, 1), 1, 'threshold on one slice does not overwrite another segment');
  const stats = segmentStats(labels, { spacing: [0.5, 0.5], thickness: 2 });
  assert.deepEqual(stats, [{ number: 1, voxels: 1, volumeMm3: 0.5 }, { number: 2, voxels: 64, volumeMm3: 32 }]);
  const rgba = sliceOverlay(labels, dims, 1);
  assert.deepEqual([...rgba.slice((10 * 32 + 10) * 4, (10 * 32 + 10) * 4 + 4)], [31, 111, 134, 110]);
  assert.equal(rgba[3], 0);
});

const ref = () => ({ studyUid: generateUid(), seriesUid: generateUid(), sopClassUid: SOP_CLASS.CT, sopUids: [generateUid(), generateUid(), generateUid()], positions: [[0, 0, 0], [0, 0, 2.5], [0, 0, 5]], orientation: [1, 0, 0, 0, 1, 0], spacing: [0.7, 0.7], thickness: 2.5, frameOfReferenceUid: generateUid(), patientName: 'Redteam^Seg', patientId: 'RT1' });

test('DICOM SEG round trip: two segments over three slices come back voxel for voxel, laid over the right source images', () => {
  const r = ref(); const columns = 10; const rows = 6; const slices = 3; const plane = 60;
  const labels = new Uint8Array(plane * slices);
  labels[0 * plane + 7] = 1; labels[0 * plane + 8] = 1; labels[2 * plane + 59] = 1; labels[2 * plane + 0] = 2; labels[1 * plane + 33] = 2;
  const out = writeSeg({ labels, columns, rows, slices, segments: [{ number: 1, label: 'Nodule', algorithm: 'MANUAL' }, { number: 2, label: 'Lung', algorithm: 'SEMIAUTOMATIC', algorithmName: 'region growing' }], ref: r });
  assert.equal(out.frames, 4, 'one frame per segment and slice that has a voxel');
  const file = parse(out.bytes);
  assert.equal(file.str('SOPClassUID'), SOP_CLASS.SEG);
  assert.equal(file.str('Modality'), 'SEG');
  assert.deepEqual([file.num('BitsAllocated'), file.num('NumberOfFrames'), file.str('SegmentationType')], [1, 4, 'BINARY']);
  assert.equal(file.get('PixelData').length, Math.ceil((4 * plane) / 8), 'bits are packed across frames');
  const back = readSeg(out.bytes);
  assert.deepEqual([...back.labels], [...labels]);
  assert.deepEqual(back.segments, [{ number: 1, label: 'Nodule', algorithm: 'MANUAL', algorithmName: null }, { number: 2, label: 'Lung', algorithm: 'SEMIAUTOMATIC', algorithmName: 'region growing' }]);
  assert.deepEqual(back.frames.map((f) => [f.seg, f.z, f.position[2]]), [[1, 0, 0], [1, 2, 5], [2, 1, 2.5], [2, 2, 5]]);
  assert.equal(back.referencedSeriesUid, r.seriesUid);
  // Laid over the same slices in another order, by position.
  const byPosition = readSeg(out.bytes, { sopUids: ['x', 'y', 'z'], positions: [[0, 0, 5], [0, 0, 2.5], [0, 0, 0]] });
  assert.equal(byPosition.labels[2 * plane + 7], 1);
  assert.throws(() => writeSeg({ labels: new Uint8Array(plane * slices), columns, rows, slices, segments: [{ number: 1, label: 'x' }], ref: r }), /empty/);
  assert.throws(() => readSeg(write({ SOPClassUID: SOP_CLASS.CT, SOPInstanceUID: generateUid() })), /Not a Segmentation/);
});

test('DICOM SR round trip: each measurement keeps its kind, numbers with units, graphic and source image', () => {
  const r = ref();
  const list = [
    { kind: 'length', label: 'Nodule diameter', points: [[10, 10], [40, 50]], sopUid: r.sopUids[1], value: 35.4 },
    { kind: 'ellipse', points: [[20, 20], [30, 20], [25, 15], [25, 25]], sopUid: r.sopUids[0], value: 78.5, mean: -24.25, sd: 12.5 },
    { kind: 'cobb', points: [[0, 0], [10, 0], [0, 5], [10, 15]], sopUid: r.sopUids[2], value: 45 },
    { kind: 'bidirectional', points: [[0, 0], [40, 0], [20, -10], [20, 10]], sopUid: r.sopUids[2], longMm: 20, shortMm: 10 },
    { kind: 'probe', points: [[5, 6]], sopUid: r.sopUids[0], frame: 3, value: -812 },
    { kind: 'arrow', points: [[1, 1], [9, 9]], sopUid: r.sopUids[0], text: 'Possible fracture line' },
  ];
  const out = writeSr({ measurements: list, ref: r });
  const file = parse(out.bytes);
  assert.deepEqual([file.str('SOPClassUID'), file.str('Modality'), file.str('StudyInstanceUID')], [SOP_CLASS.SR_COMPREHENSIVE, 'SR', r.studyUid]);
  const back = readSr(out.bytes);
  assert.equal(back.title, 'Imaging Measurement Report');
  assert.deepEqual(back.measurements.map((m) => m.kind), list.map((m) => m.kind));
  const [len, ell, cobb, bi, pr, arrow] = back.measurements;
  assert.deepEqual([len.label, len.value, len.points, len.sopUid, len.numbers[0].unit, len.graphicType], ['Nodule diameter', 35.4, [[10, 10], [40, 50]], r.sopUids[1], 'mm', 'POLYLINE']);
  assert.deepEqual([ell.value, ell.mean, ell.sd, ell.graphicType, ell.numbers.map((n) => n.unit)], [78.5, -24.25, 12.5, 'ELLIPSE', ['mm2', "[hnsf'U]", "[hnsf'U]"]]);
  assert.deepEqual([cobb.value, cobb.numbers[0].concept, cobb.points.length], [45, 'Cobb angle', 4]);
  assert.deepEqual([bi.longMm, bi.shortMm], [20, 10]);
  assert.deepEqual([pr.value, pr.frame, pr.graphicType], [-812, 3, 'POINT']);
  assert.deepEqual([arrow.text, arrow.value], ['Possible fracture line', undefined]);
});

test('presentation state round trip, and enhanced multi-frame functional groups', () => {
  const r = ref();
  const out = writePresentationState({ state: { center: -600, width: 1500, invert: true, area: { left: 32, top: 16, right: 480, bottom: 400 }, zoom: 2.5, label: 'lung window' }, ref: r });
  const back = readPresentationState(out.bytes);
  assert.deepEqual(back, { label: 'LUNG WINDOW', center: -600, width: 1500, invert: true, area: { left: 32, top: 16, right: 480, bottom: 400 }, zoom: 2.5, seriesUid: r.seriesUid, sopUids: r.sopUids });
  assert.equal(readPresentationState(writePresentationState({ state: { center: 40, width: 400, invert: false, area: { left: 0, top: 0, right: 512, bottom: 512 } }, ref: r }).bytes).zoom, null);
  // An enhanced CT with two frames: spacing shared, position and window per frame.
  const enhanced = write({ SOPClassUID: SOP_CLASS.ENHANCED_CT, SOPInstanceUID: generateUid(), Rows: 2, Columns: 2, NumberOfFrames: 2, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1, SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2',
    SharedFunctionalGroupsSequence: [{ PixelMeasuresSequence: [{ PixelSpacing: '0.5\\0.5', SliceThickness: '1.25' }], PlaneOrientationSequence: [{ ImageOrientationPatient: '1\\0\\0\\0\\1\\0' }], PixelValueTransformationSequence: [{ RescaleSlope: '1', RescaleIntercept: '-1024' }] }],
    PerFrameFunctionalGroupsSequence: [{ PlanePositionSequence: [{ ImagePositionPatient: '0\\0\\10' }], FrameVOILUTSequence: [{ WindowCenter: '40', WindowWidth: '400' }] }, { PlanePositionSequence: [{ ImagePositionPatient: '0\\0\\11.25' }] }],
    PixelData: new Int16Array(8) });
  const g = frameGroups(enhanced);
  assert.equal(g.enhanced, true);
  assert.deepEqual(g.frames.map((f) => [f.position[2], f.spacing, f.thickness, f.intercept, f.window]), [[10, [0.5, 0.5], 1.25, -1024, { center: 40, width: 400 }], [11.25, [0.5, 0.5], 1.25, -1024, null]]);
  assert.equal(frameGroups(write({ SOPClassUID: SOP_CLASS.CT, SOPInstanceUID: generateUid(), Rows: 1, Columns: 1 })).frames[0].position, null);
});

test('segments on other planes and in 3D: the overlay follows the reslice, and the surface view draws only the segment', async () => {
  const { planeOverlay, surfaceVoxels, renderSurface } = await import('../pacs/web/pacs/segment.js');
  const dims = { columns: 8, rows: 6, slices: 4 }; const labels = createLabels(8, 6, 4); const plane = 48;
  labels[2 * plane + 3 * 8 + 5] = 1; // x 5, y 3, slice 2
  const cor = planeOverlay(labels, dims, 'coronal', 3);
  assert.deepEqual([cor.columns, cor.rows], [8, 4]);
  assert.equal(cor.rgba[((4 - 1 - 2) * 8 + 5) * 4 + 3], 110, 'coronal image y=3: row counts down from the top slice, column is x');
  assert.equal(planeOverlay(labels, dims, 'coronal', 2).rgba.some((v) => v), false);
  const sag = planeOverlay(labels, dims, 'sagittal', 5);
  assert.deepEqual([sag.columns, sag.rows], [6, 4]);
  assert.equal(sag.rgba[((4 - 1 - 2) * 6 + 3) * 4 + 3], 110, 'sagittal image x=5: column is y');
  assert.equal(planeOverlay(labels, dims, 'axial', 2).rgba[(3 * 8 + 5) * 4 + 3], 110);
  // A solid 4x4x4 cube has 56 surface voxels (64 minus the 8 inside).
  const d2 = { columns: 10, rows: 10, slices: 10 }; const cube = createLabels(10, 10, 10);
  for (let z = 3; z < 7; z += 1) for (let y = 3; y < 7; y += 1) for (let x = 3; x < 7; x += 1) cube[z * 100 + y * 10 + x] = 2;
  const surf = surfaceVoxels(cube, d2);
  assert.equal(surf.length, 56);
  assert.equal(surfaceVoxels(cube, d2, { hidden: new Set([2]) }).length, 0);
  const img = renderSurface(surf, d2, { size: 64 });
  assert.ok(img.drawn > 50);
  const lit = []; for (let i = 0; i < 64 * 64; i += 1) if (img.rgba[i * 4 + 3]) lit.push(i);
  assert.ok(lit.length > 50 && lit.length < 64 * 64 / 2, 'the cube covers part of the picture, not all of it');
  assert.ok(lit.every((i) => img.rgba[i * 4 + 1] > img.rgba[i * 4]), 'drawn in the colour of segment 2');
  assert.equal(renderSurface([], d2).drawn, 0);
});
