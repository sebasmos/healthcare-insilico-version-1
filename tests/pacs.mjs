import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { startTestServer, tempDir, patient, BACKEND } from './support/helpers.mjs';
import { buildPhantom } from './support/phantom.mjs';
import { parse, pixels } from '../viewers/dicom/dicom.js';
import { parseMultipart } from '../pacs/server/dicomweb.mjs';

const LOINC = 'http://loinc.org';
const mrnOf = (p) => p.identifier.find((i) => i.type.coding[0].code === 'MR').value;

function multipart(files) {
  const boundary = 'test-boundary-123';
  const chunks = [];
  for (const f of files) chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f), Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/related; type="application/dicom"; boundary=${boundary}` };
}

async function setup() {
  process.env.DICOM_DIR = path.join(tempDir('hd-dicom-'), 'dicom');
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Imaging'))).json;
  const stow = async (files, headers = {}) => {
    const { body, type } = multipart(files);
    const r = await fetch(`${s.base}/dicom-web/studies`, { method: 'POST', headers: { 'Content-Type': type, 'X-Role': 'physician', 'X-User-Id': 'dr-reader', ...headers }, body });
    return { status: r.status, json: await r.json() };
  };
  const phantom = (extra) => buildPhantom({ mrn: mrnOf(p), name: 'Imaging^Synthetic', ...extra });
  const rad = { 'X-Role': 'physician', 'X-User-Id': 'dr-reader' };
  return { s, p, stow, phantom, rad };
}

test(`[${BACKEND}] STOW-RS stores instances, builds the ImagingStudy index and skips already-archived SOPs`, async () => {
  const { s, p, stow, phantom } = await setup();
  const files = phantom();
  const first = await stow(files.map((f) => f.bytes));
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.summary.stored, first.json.summary.duplicates, first.json.summary.failed.length], [42, 0, 0]);
  assert.equal(first.json['00081199'].Value.length, 42);
  const again = await stow(files.slice(0, 5).map((f) => f.bytes));
  assert.deepEqual([again.json.summary.stored, again.json.summary.duplicates], [0, 5]);

  const studies = (await s.call('GET', `/fhir/R4/ImagingStudy?patient=${p.id}`)).json.entry.map((e) => e.resource);
  assert.equal(studies.length, 3);
  const ct = studies.find((x) => x.modality[0].code === 'CT');
  assert.deepEqual([ct.numberOfSeries, ct.numberOfInstances, ct.series[0].instance.length], [1, 40, 40]);
  assert.deepEqual(ct.series[0].instance.map((i) => i.number), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(ct.series[0].bodySite.display, 'CHEST');
  const uid = ct.identifier.find((i) => i.system === 'urn:dicom:uid').value.replace('urn:oid:', '');
  const onDisk = fs.readdirSync(path.join(process.env.DICOM_DIR, uid, ct.series[0].uid));
  assert.equal(onDisk.length, 40);
  assert.ok(onDisk.every((f) => f.endsWith('.dcm')));
  const trace = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'dicom.store');
  assert.equal(trace.length, 3, 'one TraceStep per study stored');
  assert.equal((await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.filter((e) => /stored \d+ DICOM/.test(e.resource.outcomeDesc)).length, 3);
  await s.close();
});

test(`[${BACKEND}] STOW-RS validation: unknown patient, wrong patient for an existing study, corrupt file`, async () => {
  const { s, stow, phantom } = await setup();
  const other = (await s.call('POST', '/fhir/R4/Patient', patient('Other'))).json;
  const unknown = await stow([buildPhantom({ mrn: 'N999999' })[0].bytes]);
  assert.equal(unknown.status, 409);
  assert.match(unknown.json.summary.failed[0].reason, /does not match the MRN of any patient/);
  assert.equal(unknown.json['00081198'].Value.length, 1);

  const ct = phantom().filter((f) => f.folder === 'ct-chest');
  await stow([ct[0].bytes]);
  const forged = Buffer.from(ct[1].bytes);
  const at = forged.indexOf(mrnOf((await s.call('GET', '/auth/patients')).json.patients.map((x) => ({ identifier: [{ type: { coding: [{ code: 'MR' }] }, value: x.mrn }] }))[0]));
  forged.write(mrnOf(other), at, 'latin1');
  const wrong = await stow([forged]);
  assert.match(wrong.json.summary.failed[0].reason, /does not match the patient this study is already linked to/);

  const mixed = await stow([ct[2].bytes, new Uint8Array(300), ct[3].bytes.subarray(0, 900)]);
  assert.equal(mixed.status, 202);
  assert.equal(mixed.json.summary.stored, 1);
  assert.deepEqual(mixed.json.summary.failed.map((f) => f.reason.split(' ').slice(0, 3).join(' ')), ['Not a DICOM', 'File is truncated:']);
  assert.equal((await fetch(`${s.base}/dicom-web/studies`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  await s.close();
});

test(`[${BACKEND}] QIDO-RS and WADO: search parameters, series and instance lists, retrieval round trip`, async () => {
  const { s, p, stow, phantom } = await setup();
  const files = phantom();
  await stow(files.map((f) => f.bytes));
  const get = async (url) => { const r = await fetch(s.base + url); return { status: r.status, json: await r.json() }; };
  const all = (await get('/dicom-web/studies')).json;
  assert.equal(all.length, 3);
  assert.equal(all[0]['00100020'].Value[0], mrnOf(p));
  assert.match(all[0]['00100010'].Value[0].Alphabetic, /^Patient N\d{6}$/, 'the DICOM patient name is the number');
  assert.equal((await get('/dicom-web/studies?ModalitiesInStudy=CT')).json.length, 1);
  assert.equal((await get('/dicom-web/studies?PatientID=N999999')).json.length, 0);
  assert.equal((await get(`/dicom-web/studies?PatientID=${mrnOf(p)}&limit=2`)).json.length, 2);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  assert.equal((await get(`/dicom-web/studies?StudyDate=${today}`)).json.length, 2);
  assert.equal((await get(`/dicom-web/studies?StudyDate=19000101-${today - 1}`)).json.length, 1, 'date range finds only the prior');
  const acc = all.find((x) => x['00080061'].Value[0] === 'CT')['00080050'].Value[0];
  const ct = (await get(`/dicom-web/studies?AccessionNumber=${acc}`)).json[0];
  const uid = ct['0020000D'].Value[0];
  assert.equal(ct['00201208'].Value[0], 40);

  const series = (await get(`/dicom-web/studies/${uid}/series`)).json;
  assert.equal(series[0]['00080060'].Value[0], 'CT');
  const instances = (await get(`/dicom-web/studies/${uid}/series/${series[0]['0020000E'].Value[0]}/instances`)).json;
  assert.equal(instances.length, 40);

  const original = files.find((f) => f.folder === 'ct-chest' && f.name === 'slice-0017.dcm').bytes;
  const sop = parse(original).str('SOPInstanceUID');
  const uri = await fetch(`${s.base}/dicom-web/wado?requestType=WADO&studyUID=${uid}&seriesUID=${series[0]['0020000E'].Value[0]}&objectUID=${sop}&contentType=application/dicom`);
  assert.equal(uri.headers.get('content-type'), 'application/dicom');
  assert.deepEqual(new Uint8Array(await uri.arrayBuffer()), original, 'WADO-URI returns the stored bytes unchanged');

  const rs = await fetch(`${s.base}/dicom-web/studies/${uid}`);
  assert.match(rs.headers.get('content-type'), /multipart\/related; type="application\/dicom"/);
  const parts = parseMultipart(Buffer.from(await rs.arrayBuffer()), rs.headers.get('content-type'));
  assert.equal(parts.length, 40);
  const back = parts.map((x) => parse(x.bytes)).find((f) => f.str('SOPInstanceUID') === sop);
  assert.deepEqual(Array.from(pixels(back).frame(0)), Array.from(pixels(parse(original)).frame(0)), 'pixels survive store and retrieve');
  assert.ok((await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.some((t) => t.did.type === 'image.open' && t.did.args.via === 'wado-rs'));
  assert.equal((await get('/dicom-web/studies/1.2.3.999')).status, 404);
  assert.equal((await get('/dicom-web/studies/not-a-uid')).status, 400);
  await s.close();
});

test(`[${BACKEND}] worklist: order link and priority, prior match, reading lock, take-over`, async () => {
  const { s, p, stow, phantom, rad } = await setup();
  await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'stat', subject: { reference: `Patient/${p.id}` }, requester: { display: 'Dr Referrer' },
    category: [{ coding: [{ code: 'imaging' }] }], code: { coding: [{ system: LOINC, code: '36643-5', display: 'XR Chest 2 views' }] }, orderDetail: [{ coding: [{ code: 'DX' }] }], reasonCode: [{ text: 'cough' }] });
  const files = phantom();
  await stow(files.filter((f) => f.folder === 'chest-current').map((f) => f.bytes));
  await stow(files.filter((f) => f.folder !== 'chest-current').map((f) => f.bytes));

  const wl = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, rad)).json;
  assert.equal(wl.rows.length, 3);
  const current = wl.rows[0];
  assert.deepEqual([current.priority, current.modality, current.status, current.referrer, current.reason], ['stat', 'DX', 'unread', 'Dr Referrer', 'cough'], 'STAT sorts first and carries the order details');
  const prior = wl.rows.find((r) => r.id === current.priorId);
  assert.ok(prior && prior.started < current.started && prior.bodyPart === 'CHEST', 'prior is the earlier chest study');
  assert.equal(wl.rows.find((r) => r.modality === 'CT').priorId, null, 'a different modality is not a prior');
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=all&modality=CT', undefined, rad)).json.rows.length, 1);
  assert.deepEqual(wl.counts.unreadByModality, { XR: 2, CT: 1 });

  const open = await s.call('POST', `/api/pacs/studies/${current.id}/open`, {}, rad);
  assert.equal(open.json.lock.by, 'dr-reader');
  const other = { 'X-Role': 'physician', 'X-User-Id': 'dr-second' };
  const blocked = await s.call('POST', `/api/pacs/studies/${current.id}/open`, {}, other);
  assert.equal(blocked.status, 423);
  assert.equal(blocked.json.lock.by, 'dr-reader');
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=my', undefined, other)).json.rows.length, 2, 'a study locked by someone else leaves my queue');
  assert.equal((await s.call('GET', '/api/pacs/worklist?queue=my', undefined, rad)).json.rows.length, 3);
  assert.equal((await s.call('POST', `/api/pacs/studies/${current.id}/open`, { force: true }, other)).json.lock.by, 'dr-second');
  assert.equal((await s.call('POST', `/api/pacs/studies/${current.id}/close`, {}, rad)).json.lock.by, 'dr-second', 'only the holder can release');
  assert.equal((await s.call('POST', `/api/pacs/studies/${current.id}/close`, {}, other)).json.lock, null);

  await s.call('PUT', `/api/pacs/studies/${prior.id}/priority`, { priority: 'urgent' }, rad);
  assert.equal((await s.call('GET', `/api/pacs/studies/${prior.id}`, undefined, rad)).json.study.priority, 'urgent');
  assert.equal((await s.call('PUT', `/api/pacs/studies/${prior.id}/priority`, { priority: 'asap' }, rad)).status, 422);
  const lockFree = (await s.call('GET', `/fhir/R4/ImagingStudy/${current.id}`)).json;
  assert.ok(!JSON.stringify(lockFree).includes('_lock'), 'the lock is not exposed as a FHIR field');
  await s.close();
});

test(`[${BACKEND}] reporting: sections required, sign locks the report, Inbox task, order completed, release, addendum`, async () => {
  const { s, p, stow, phantom, rad } = await setup();
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, requester: { display: 'Dr Referrer' },
    category: [{ coding: [{ code: 'imaging' }] }], code: { coding: [{ system: LOINC, code: '36643-5', display: 'XR Chest 2 views' }] }, orderDetail: [{ coding: [{ code: 'DX' }] }] })).json;
  await stow(phantom().filter((f) => f.folder === 'chest-current').map((f) => f.bytes));
  const study = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, rad)).json.rows[0];
  await s.call('POST', `/api/pacs/studies/${study.id}/open`, {}, rad);
  const T = 'urn:hospital-desktop:report-technique';
  const F = 'urn:hospital-desktop:report-findings';
  const draft = (technique, findings, conclusion, extra = {}) => ({ resourceType: 'DiagnosticReport', status: 'preliminary', subject: { reference: `Patient/${p.id}` }, code: { text: 'XR Chest 2 views' },
    imagingStudy: [{ reference: `ImagingStudy/${study.id}` }], basedOn: [{ reference: `ServiceRequest/${order.id}` }], conclusion,
    extension: [{ url: T, valueString: technique }, { url: F, valueString: findings }], ...extra });

  const report = (await s.call('POST', '/fhir/R4/DiagnosticReport', draft('PA and lateral.', 'Small round opacity in the left upper zone.', ''), rad)).json;
  assert.equal((await s.call('GET', `/api/pacs/studies/${study.id}`, undefined, rad)).json.study.status, 'draft');
  const unsigned = await s.call('POST', `/fhir/R4/DiagnosticReport/${report.id}/$transition`, { to: 'final' }, rad);
  assert.equal(unsigned.status, 422);
  assert.match(unsigned.json.issue[0].diagnostics, /Technique, Findings and Impression are all required/);
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${report.id}/$release`, {}, rad)).status, 409, 'drafts cannot be released');

  const saved = (await s.call('PUT', `/fhir/R4/DiagnosticReport/${report.id}`, { ...report, conclusion: '12 mm nodule, left upper zone. CT advised.' }, rad)).json;
  const signed = (await s.call('POST', `/fhir/R4/DiagnosticReport/${saved.id}/$transition`, { to: 'final' }, rad)).json;
  assert.equal(signed.status, 'final');
  assert.equal(signed.resultsInterpreter[0].display, 'dr-reader');
  assert.ok(signed.issued);
  const tamper = await s.call('PUT', `/fhir/R4/DiagnosticReport/${signed.id}`, { ...signed, conclusion: 'Normal.' }, rad);
  assert.equal(tamper.status, 422);
  assert.match(tamper.json.issue[0].diagnostics, /signed report is locked/);

  const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].code.coding[0].code, tasks[0].status, tasks[0].owner.display, tasks[0].focus.reference], ['report-signed', 'requested', 'Dr Referrer', `DiagnosticReport/${signed.id}`]);
  assert.match(tasks[0].description, /12 mm nodule/);
  const done = (await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}`)).json;
  assert.equal(done.status, 'completed');
  assert.deepEqual((await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}/_history`)).json.entry.map((e) => e.resource.extension.find((x) => x.url.endsWith('lifecycle')).valueCode), ['completed', 'report-signed', 'active']);
  const after = (await s.call('GET', `/api/pacs/studies/${study.id}`, undefined, rad)).json;
  assert.deepEqual([after.study.status, after.study.lock], ['read', null], 'signing releases the reading lock');
  const metrics = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, rad)).json.metrics;
  assert.deepEqual([metrics.readToday, metrics.byPriority.routine.count, metrics.withinTargetPercent], [1, 1, 100]);

  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}&_released=true`)).json.total, 0);
  await s.call('POST', `/fhir/R4/DiagnosticReport/${signed.id}/$release`, {}, rad);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport?patient=${p.id}&_released=true&status=final`)).json.total, 1);

  const addendum = (await s.call('POST', '/fhir/R4/DiagnosticReport', draft('', '', '', { extension: [{ url: F, valueString: '' }, { url: 'urn:hospital-desktop:addendum-of', valueString: `DiagnosticReport/${signed.id}` }] }), rad)).json;
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${addendum.id}/$transition`, { to: 'final' }, rad)).status, 422, 'an empty addendum cannot be signed');
  await s.call('PUT', `/fhir/R4/DiagnosticReport/${addendum.id}`, { ...addendum, extension: [{ url: F, valueString: 'Compared with prior: nodule is new.' }, { url: 'urn:hospital-desktop:addendum-of', valueString: `DiagnosticReport/${signed.id}` }] }, rad);
  await s.call('POST', `/fhir/R4/DiagnosticReport/${addendum.id}/$transition`, { to: 'final' }, rad);
  const view = (await s.call('GET', `/api/pacs/studies/${study.id}`, undefined, rad)).json;
  assert.equal(view.report.status, 'appended');
  assert.equal(view.report.conclusion, '12 mm nodule, left upper zone. CT advised.', 'the original text is unchanged');
  assert.equal(view.addenda.length, 1);
  assert.equal((await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.total, 2, 'the addendum also notifies the Inbox');
  assert.ok(view.report.meta.tag.some((t) => t.code === 'released'), 'the report stays released after an addendum');
  await s.close();
});

test(`[${BACKEND}] NIfTI import: .nii.gz becomes a DICOM series linked to the patient`, async () => {
  const { s, p } = await setup();
  const header = new Uint8Array(352);
  const view = new DataView(header.buffer);
  view.setInt32(0, 348, true);
  [3, 8, 8, 24, 1, 1, 1, 1].forEach((d, i) => view.setInt16(40 + i * 2, d, true));
  view.setInt16(70, 4, true); view.setInt16(72, 16, true);
  [1, 1, 1, 2].forEach((x, i) => view.setFloat32(76 + i * 4, x, true));
  view.setFloat32(108, 352, true);
  header.set([0x6e, 0x2b, 0x31, 0], 344);
  const data = Int16Array.from({ length: 8 * 8 * 24 }, (_, i) => i % 500);
  const nii = Buffer.concat([Buffer.from(header), Buffer.from(data.buffer)]);
  const r = await fetch(`${s.base}/dicom-web/nifti?mrn=${mrnOf(p)}&modality=MR&description=Brain`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Role': 'physician' }, body: gzipSync(nii) });
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([out.slices, out.stored, out.dims], [24, 24, [8, 8, 24]]);
  const study = (await s.call('GET', `/fhir/R4/ImagingStudy/${out.study}`)).json;
  assert.deepEqual([study.modality[0].code, study.numberOfInstances, study.description], ['MR', 24, 'Brain']);
  assert.equal((await fetch(`${s.base}/dicom-web/nifti?mrn=N999999`, { method: 'POST', body: nii })).status, 422);
  assert.equal((await fetch(`${s.base}/dicom-web/nifti?mrn=${mrnOf(p)}`, { method: 'POST', body: Buffer.alloc(500) })).status, 422);
  await s.close();
});

test(`[${BACKEND}] compressed instances: RLE is decoded in Node, JPEG fragments are stored and served byte for byte, the series carries the transfer syntax`, async () => {
  const { s, p, stow, phantom, rad } = await setup();
  const { write, parse: parseDicom, pixels: pixelsOf, rleEncodeFrame, generateUid, COMPRESSED_TS, SOP_CLASS } = await import('../viewers/dicom/dicom.js');
  const ct = phantom().find((f) => f.folder.includes('ct') || f.name.includes('ct')) || phantom()[0];
  const header = parseDicom(ct.bytes);
  const frame = Int16Array.from({ length: 16 * 12 }, (_, i) => (i % 12 < 6 ? -1000 : 400) + (i % 3));
  const base = (extra) => ({ SOPClassUID: SOP_CLASS.CT, SOPInstanceUID: generateUid(), StudyInstanceUID: generateUid(), SeriesInstanceUID: generateUid(), Modality: 'CT', PatientName: 'Imaging^Synthetic', PatientID: mrnOf(p), StudyDate: '20260105', StudyTime: '090000', AccessionNumber: 'ACC-RLE', StudyDescription: 'Compressed test', SeriesNumber: '1', InstanceNumber: '1', PixelSpacing: ['1', '1'], ImagePositionPatient: ['0', '0', '0'], ImageOrientationPatient: ['1', '0', '0', '0', '1', '0'], SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2', Rows: 16, Columns: 12, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 1, RescaleIntercept: '0', RescaleSlope: '1', WindowCenter: '40', WindowWidth: '400', ...extra });
  assert.ok(header.transferSyntax, 'the phantom parses');
  const rle = write(base({ PixelData: { encapsulated: true, fragments: [rleEncodeFrame(frame)] } }), { transferSyntax: COMPRESSED_TS.RLE });
  const fakeJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const jpeg = write(base({ AccessionNumber: 'ACC-JPG', SamplesPerPixel: 3, PhotometricInterpretation: 'YBR_FULL_422', PlanarConfiguration: 0, BitsAllocated: 8, BitsStored: 8, HighBit: 7, PixelRepresentation: 0, PixelData: { encapsulated: true, fragments: [fakeJpeg] } }), { transferSyntax: COMPRESSED_TS.JPEG_BASELINE });
  const r = await stow([rle, jpeg]);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.equal(r.json.summary.stored, 2);
  const rows = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, rad)).json.rows;
  const rleStudy = rows.find((x) => x.accession === 'ACC-RLE');
  const jpgStudy = rows.find((x) => x.accession === 'ACC-JPG');
  const detail = (await s.call('GET', `/api/pacs/studies/${rleStudy.id}`, undefined, rad)).json;
  assert.deepEqual([detail.study.series[0].transferSyntax, detail.study.series[0].compression], [COMPRESSED_TS.RLE, 'RLE lossless']);
  assert.equal((await s.call('GET', `/api/pacs/studies/${jpgStudy.id}`, undefined, rad)).json.study.series[0].compression, 'JPEG baseline');
  const served = async (bytes) => { const f = parseDicom(bytes); const res = await fetch(`${s.base}/dicom-web/wado?requestType=WADO&studyUID=${f.str('StudyInstanceUID')}&seriesUID=${f.str('SeriesInstanceUID')}&objectUID=${f.str('SOPInstanceUID')}&contentType=application/dicom`); return new Uint8Array(await res.arrayBuffer()); };
  assert.deepEqual(Array.from(await served(rle)), Array.from(rle), 'RLE bytes are served unchanged');
  const decoded = pixelsOf(parseDicom(await served(rle)));
  assert.deepEqual(Array.from(decoded.frame(0)), Array.from(frame), 'RLE decodes to the original pixels');
  const jpegBack = parseDicom(await served(jpeg));
  assert.deepEqual(Array.from(jpegBack.get('PixelData').fragments[0]), Array.from(fakeJpeg), 'JPEG fragments are served byte for byte');
  assert.throws(() => pixelsOf(jpegBack), /browser viewer/);
  await s.close();
});

test(`[${BACKEND}] image annotations: measurements persist as preliminary Observations on the study, by roles that may create Observations, and are cancelled on removal`, async () => {
  const { s, p, stow, phantom, rad } = await setup();
  await stow(phantom().map((f) => f.bytes));
  const rows = (await s.call('GET', '/api/pacs/worklist?queue=all', undefined, rad)).json.rows;
  const study = rows.find((x) => x.modality === 'CT');
  const body = { kind: 'length', series: 'uid-1', plane: 'axial', frame: 19, points: [[10, 20], [40, 60]], mm: 35.4, engine: 'canvas' };
  const made = await s.call('POST', `/api/pacs/studies/${study.id}/annotations`, body, rad);
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.kind, made.json.value, made.json.unit, made.json.frame, made.json.points], ['length', 35.4, 'mm', 19, [[10, 20], [40, 60]]]);
  const angle = await s.call('POST', `/api/pacs/studies/${study.id}/annotations`, { kind: 'angle', series: 'uid-1', plane: 'axial', frame: 2, points: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], degrees: 42.123, engine: 'cs3d', space: 'world' }, { 'X-Role': 'physician', 'X-User-Id': 'dr-one' });
  assert.equal(angle.status, 201, angle.text);
  assert.deepEqual([angle.json.value, angle.json.unit, angle.json.engine, angle.json.space], [42.12, 'deg', 'cs3d', 'world']);
  assert.equal((await s.call('POST', `/api/pacs/studies/${study.id}/annotations`, { kind: 'roi', points: [[0, 0]] }, rad)).status, 422);
  const refused = await s.call('POST', `/api/pacs/studies/${study.id}/annotations`, body, { 'X-Role': 'janitor', 'X-User-Id': 'j-1' }); // every known role may create Observations now; an unknown role may not
  assert.equal(refused.status, 403, refused.text);
  const list = (await s.call('GET', `/api/pacs/studies/${study.id}/annotations`, undefined, rad)).json.annotations;
  assert.equal(list.length, 2);
  const obs = (await s.call('GET', `/fhir/R4/Observation/${made.json.id}`)).json;
  assert.equal(obs.status, 'preliminary');
  assert.equal(obs.derivedFrom[0].reference, `ImagingStudy/${study.id}`);
  assert.equal(obs.category[0].coding[0].code, 'image-measurement');
  assert.equal(obs.subject.reference, `Patient/${p.id}`);
  assert.equal((await s.call('DELETE', `/api/pacs/studies/${study.id}/annotations/${made.json.id}`, undefined, rad)).status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/Observation/${made.json.id}`)).json.status, 'cancelled');
  assert.equal((await s.call('GET', `/api/pacs/studies/${study.id}/annotations`, undefined, rad)).json.annotations.length, 1);
  assert.equal((await s.call('DELETE', `/api/pacs/studies/${study.id}/annotations/${made.json.id}`, undefined, rad)).status, 404);
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((x) => x.did.type);
  assert.ok(steps.includes('image.annotate') && steps.includes('image.annotation.remove'), 'annotation writes are logged');
  await s.close();
});
