// Whole-slide image handling: the TIFF reader on a generated
// file, JPEG table splicing, bounds, refused formats, label withholding,
// idempotent import and wrong-patient metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, tempDir, patient, BACKEND } from './support/helpers.mjs';
import { buildSlide, PLANTED } from './support/slide-gen.mjs';
import { encodeJpeg, decodeJpeg, jpegTables, spliceTables, jpegInfo, withAdobeMarker } from '../viewers/server/jpeg.mjs';
import { describeSlide, readTile, readAuxImage, writeTiff, parseTiff, TiffError } from '../viewers/server/tiff.mjs';
import { inspectSlideFile, importSlideFolder, inspectDicomSlides, slideIndex, slideSummary, WSI_SOP_CLASS } from '../pathology/server/slides.mjs';
import { write as writeDicom, generateUid, COMPRESSED_TS } from '../viewers/dicom/dicom.js';

const mrnOf = (p) => p.identifier.find((i) => i.type.coding[0].code === 'MR').value;
const work = tempDir('hd-slides-');
const slideFile = (name, opts = {}) => { const built = buildSlide({ width: 1024, height: 768, ...opts }); const file = path.join(work, name); fs.writeFileSync(file, built.bytes); return { file, built }; };
/** Changes the Compression value of every tiled directory in a classic little-endian TIFF written by writeTiff. */
const withCompression = (bytes, value) => { const out = Buffer.from(bytes); const needle = Buffer.from([0x03, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x00]); let i = 0; while ((i = out.indexOf(needle, i)) >= 0) { out.writeUInt16LE(value, i + 8); i += needle.length; } return out; };

test('JPEG codec: encode and decode round trip, abbreviated streams plus tables splice into a decodable JPEG, Adobe marker marks RGB', () => {
  const w = 24; const h = 16; const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) { px[i * 3] = i % w < 12 ? 220 : 20; px[i * 3 + 1] = 90; px[i * 3 + 2] = Math.floor(i / w) < 8 ? 40 : 200; }
  const full = encodeJpeg({ width: w, height: h, data: px, quality: 92 });
  const back = decodeJpeg(full);
  assert.deepEqual([back.width, back.height, back.channels], [w, h, 3]);
  let worst = 0; for (let i = 0; i < px.length; i += 1) worst = Math.max(worst, Math.abs(px[i] - back.data[i]));
  assert.ok(worst <= 12, `pixel error ${worst}`);
  const abbreviated = encodeJpeg({ width: w, height: h, data: px, quality: 92, tables: 'omit' });
  assert.equal(jpegInfo(abbreviated).hasQuantTables, false);
  assert.throws(() => decodeJpeg(abbreviated));
  const spliced = spliceTables(jpegTables(92), abbreviated);
  assert.equal(jpegInfo(spliced).hasQuantTables, true);
  assert.deepEqual(Array.from(decodeJpeg(spliced).data), Array.from(back.data), 'the spliced stream decodes to the same pixels');
  assert.equal(spliceTables(jpegTables(92), full), full, 'a complete stream is returned unchanged');
  const grey = encodeJpeg({ width: 8, height: 8, channels: 1, data: Uint8Array.from({ length: 64 }, (_, i) => i * 4) });
  assert.equal(decodeJpeg(grey).channels, 1);
  assert.equal(jpegInfo(withAdobeMarker(full, 0)).hasAdobe, true);
});

test('TIFF reader: levels, tile grid, shared tables on the base level, label image, microns per pixel and metadata from a generated slide', () => {
  const { file, built } = slideFile('a.tif', { patientId: 'N100001' });
  const d = describeSlide(file);
  assert.deepEqual([d.format, d.width, d.height, d.tileWidth, d.tileLength, d.mpp, d.magnification, d.patientId, d.vendor], ['tiff', 1024, 768, 256, 256, 0.5, 20, 'N100001', 'hospital-desktop']);
  assert.deepEqual(d.levels.map((l) => [l.width, l.height, l.tilesAcross, l.tilesDown, Boolean(l.jpegTables)]), [[1024, 768, 4, 3, true], [512, 384, 2, 2, false], [256, 192, 1, 1, false]]);
  assert.deepEqual(d.refused, []);
  assert.ok(d.label?.servable, 'the label image is a single JPEG strip');
  assert.equal(parseTiff(file).ifds.length, 4);
  // A base-level tile carries no tables in the file but is served complete; it decodes to the planted colour at the planted spot.
  const p = built.planted[0];
  const lv = d.levels[0];
  const tx = Math.floor(p.centre[0] / lv.tileWidth); const ty = Math.floor(p.centre[1] / lv.tileLength);
  const tile = readTile(file, lv, tx, ty);
  assert.ok(jpegInfo(tile).hasQuantTables && jpegInfo(tile).hasHuffmanTables);
  const px = decodeJpeg(tile);
  const lx = p.centre[0] % lv.tileWidth; const ly = p.centre[1] % lv.tileLength;
  const got = Array.from(px.data.slice((ly * px.width + lx) * 3, (ly * px.width + lx) * 3 + 3));
  got.forEach((v, i) => assert.ok(Math.abs(v - p.colour[i]) <= 8, `channel ${i}: ${v} vs ${p.colour[i]}`));
  assert.ok(readAuxImage(file, d.label).length > 100);
  assert.throws(() => readTile(file, lv, 4, 0), TiffError);
  assert.throws(() => readTile(file, lv, 0, 3), /outside/);
  assert.equal(built.planted.length, PLANTED.length);
  assert.equal(built.planted[0].width, 800, '400 µm at 0.5 µm/px is 800 px');
});

test('refused formats: vendor extensions, LZW and JPEG 2000 tiles, a stripped base image, and files that are not TIFF', () => {
  const { built } = slideFile('b.tif');
  const lzw = path.join(work, 'lzw.tif'); fs.writeFileSync(lzw, withCompression(built.bytes, 5));
  assert.match(inspectSlideFile(lzw).refused.join(' '), /LZW/);
  const j2k = path.join(work, 'j2k.svs'); fs.writeFileSync(j2k, withCompression(built.bytes, 33005));
  const look = inspectSlideFile(j2k);
  assert.equal(look.ok, false);
  assert.match(look.refused.join(' '), /JPEG 2000/);
  const stripped = path.join(work, 'stripped.tif');
  fs.writeFileSync(stripped, writeTiff({ levels: [], aux: [{ kind: 'image', width: 8, height: 8, jpeg: encodeJpeg({ width: 8, height: 8, channels: 1, data: new Uint8Array(64) }) }] }));
  assert.match(inspectSlideFile(stripped).refused.join(' '), /stripped, not tiled/);
  const ndpi = path.join(work, 'x.ndpi'); fs.writeFileSync(ndpi, 'not really');
  assert.match(inspectSlideFile(ndpi).refused.join(' '), /Hamamatsu NDPI/);
  const text = path.join(work, 'notes.tif'); fs.writeFileSync(text, 'hello');
  assert.match(inspectSlideFile(text).refused.join(' '), /Not a TIFF|too short/);
  const png = path.join(work, 'x.png'); fs.writeFileSync(png, 'x');
  assert.match(inspectSlideFile(png).refused.join(' '), /not a slide file/);
});

test('DICOM whole-slide: one instance per level with JPEG frames is grouped into a slide; non-JPEG and non-tiled sets are refused', () => {
  const tile = encodeJpeg({ width: 16, height: 16, channels: 3, data: new Uint8Array(16 * 16 * 3).fill(120) });
  const study = generateUid();
  const base = { SOPClassUID: WSI_SOP_CLASS, StudyInstanceUID: study, SeriesInstanceUID: generateUid(), Modality: 'SM', PatientName: 'Slide^Synthetic', PatientID: 'ZZ123', ImageType: ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'], DimensionOrganizationType: 'TILED_FULL', SamplesPerPixel: 3, PhotometricInterpretation: 'YBR_FULL_422', PlanarConfiguration: 0, Rows: 16, Columns: 16, BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0 };
  const dir = path.join(work, 'dicom-wsi'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level0.dcm'), writeDicom({ ...base, SOPInstanceUID: generateUid(), TotalPixelMatrixColumns: 32, TotalPixelMatrixRows: 32, NumberOfFrames: '4', PixelData: { encapsulated: true, fragments: [tile, tile, tile, tile] } }, { transferSyntax: COMPRESSED_TS.JPEG_BASELINE }));
  fs.writeFileSync(path.join(dir, 'level1.dcm'), writeDicom({ ...base, SOPInstanceUID: generateUid(), TotalPixelMatrixColumns: 16, TotalPixelMatrixRows: 16, NumberOfFrames: '1', PixelData: { encapsulated: true, fragments: [tile] } }, { transferSyntax: COMPRESSED_TS.JPEG_BASELINE }));
  fs.writeFileSync(path.join(dir, 'raw.dcm'), writeDicom({ ...base, SOPInstanceUID: generateUid(), StudyInstanceUID: generateUid(), TotalPixelMatrixColumns: 16, TotalPixelMatrixRows: 16, PixelData: new Uint8Array(16 * 16 * 3) }));
  const d = inspectDicomSlides(fs.readdirSync(dir).map((f) => path.join(dir, f)));
  assert.equal(d.slides.length, 1);
  assert.deepEqual(d.slides[0].levels.map((l) => [l.width, l.height, l.tilesAcross, l.tilesDown, l.offsets.length]), [[32, 32, 2, 2, 4], [16, 16, 1, 1, 1]]);
  assert.equal(d.slides[0].patientId, 'ZZ123');
  assert.match(d.refused.join(' '), /not encapsulated/);
});

test(`[${BACKEND}] slide routes: info is logged as a slide open, tiles are complete cached JPEGs, bounds are checked, labels are withheld unless enabled for a synthetic patient`, async () => {
  process.env.SLIDES_DIR = path.join(tempDir('hd-slide-store-'), 'slides');
  delete process.env.SHOW_SLIDE_LABELS;
  const s = await startTestServer();
  const synthetic = (await s.call('POST', '/fhir/R4/Patient', { ...patient('Slidepatient'), meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } })).json;
  const plain = (await s.call('POST', '/fhir/R4/Patient', patient('Plainpatient'))).json;
  const folder = path.join(work, 'import-a'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'one.svs'), buildSlide({ width: 512, height: 512, seed: 3 }).bytes);
  fs.writeFileSync(path.join(folder, 'two.tif'), buildSlide({ width: 512, height: 256, seed: 4, patientId: 'OTHER-1' }).bytes);
  fs.writeFileSync(path.join(folder, 'bad.mrxs'), 'x');
  const first = await importSlideFolder(s.store, folder, { patient: mrnOf(synthetic), tags: { synthetic: true, source: 'test' } });
  assert.deepEqual([first.stored, first.duplicate, first.refused.length, first.wrongPatient.length], [2, 0, 1, 1]);
  assert.match(first.refused[0].reasons[0], /MIRAX/);
  assert.equal(first.wrongPatient[0].metadataPatientId, 'OTHER-1');
  const again = await importSlideFolder(s.store, folder, { patient: mrnOf(synthetic), tags: { synthetic: true, source: 'test' } });
  assert.deepEqual([again.stored, again.duplicate], [0, 2], 'a rerun stores nothing new');
  const studies = (await s.call('GET', '/fhir/R4/ImagingStudy')).json.entry.map((e) => e.resource).filter((st) => st.modality?.[0]?.code === 'SM');
  assert.equal(studies.length, 2);
  const wrong = studies.find((st) => st.identifier.some((i) => i.system === 'urn:dicom:patient-id'));
  assert.equal(wrong.identifier.find((i) => i.system === 'urn:dicom:patient-id').value, 'OTHER-1', 'the embedded patient id stays on the study');
  const id = studies.find((st) => st.id !== wrong.id).id;
  assert.equal(slideSummary(studies[0]).levels.length, slideIndex(studies[0].id).levels.length);
  const info = await s.call('GET', `/pathology/slides/${id}/info`, undefined, { 'X-Role': 'physician', 'X-User-Id': 'dr-path' });
  assert.equal(info.status, 200, info.text);
  assert.deepEqual([info.json.width, info.json.height, info.json.tileWidth, info.json.mpp, info.json.levels.length, info.json.levels[0].scale], [512, 512, 256, 0.5, 2, 1]);
  assert.equal(info.json.label.available, false);
  const tile = await fetch(`${s.base}/pathology/slides/${id}/tiles/0/1_1.jpg`);
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get('content-type'), 'image/jpeg');
  assert.match(tile.headers.get('cache-control'), /immutable/);
  const px = decodeJpeg(new Uint8Array(await tile.arrayBuffer()));
  assert.deepEqual([px.width, px.height], [256, 256]);
  assert.equal((await fetch(`${s.base}/pathology/slides/${id}/tiles/0/2_0.jpg`)).status, 404);
  assert.equal((await fetch(`${s.base}/pathology/slides/${id}/tiles/5/0_0.jpg`)).status, 404);
  assert.equal((await fetch(`${s.base}/pathology/slides/${id}/label.jpg`)).status, 403, 'labels are withheld by default');
  process.env.SHOW_SLIDE_LABELS = 'true';
  assert.equal((await fetch(`${s.base}/pathology/slides/${id}/label.jpg`)).status, 200, 'enabled for a synthetic patient');
  const forPlain = await importSlideFolder(s.store, path.join(work, 'import-a'), { patient: mrnOf(plain), tags: { source: 'test2' } });
  assert.equal(forPlain.duplicate, 2, 'the same files already belong to a study');
  const plainFolder = path.join(work, 'import-b'); fs.mkdirSync(plainFolder, { recursive: true });
  fs.writeFileSync(path.join(plainFolder, 'p.tif'), buildSlide({ width: 256, height: 256, seed: 9 }).bytes);
  const plainImport = await importSlideFolder(s.store, plainFolder, { patient: mrnOf(plain), tags: { source: 'test2' } });
  assert.equal(plainImport.stored, 1);
  assert.equal((await fetch(`${s.base}/pathology/slides/${[...plainImport.studies][0]}/label.jpg`)).status, 403, 'never for a patient not marked synthetic');
  delete process.env.SHOW_SLIDE_LABELS;
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((x) => x.did.type);
  assert.ok(steps.includes('slide.open') && steps.includes('slide.store'));
  assert.equal(steps.filter((x) => x === 'slide.open').length, 1, 'tiles are not logged one by one');
  await s.close();
});
