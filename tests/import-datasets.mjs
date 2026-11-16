// bring-your-own data. Synthea-shaped FHIR import (conditional
// references, SNOMED problems, UUID identifiers, --assign-mrn, per-type counts),
// DICOM patient mapping (--patient, --create-patients, STOW ?patient=), WFDB ECG
// import (format 16 round trip, format 212 refused), the dataset register, the
// source flags and the confirmation guard. Every fixture is generated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTestStore, startTestServer, tempDir, BACKEND } from './support/helpers.mjs';
import { importFhirPaths, listImportFiles } from '../platform/server/importer.mjs';
import { importDicomFiles, importEcgFolder, SOURCE_ID_URL } from '../platform/server/import-media.mjs';
import { ingestInstances } from '../pacs/server/dicom.mjs';
import { parseHeader, readRecord, toObservation, leadOf, WfdbError, MDC_SYSTEM, ECG_SOURCE_URL } from '../ecg/server/wfdb.mjs';
import { readRegister, recordDataset, datasetsForPatients, fileListChecksum, relativeFiles, HTEST, RESTRICTED_URL } from '../platform/server/datasets.mjs';
import { HTEST as HITL_HTEST } from '../agent-operations/server/hitl.mjs';
import { ensureLiveRun } from '../platform/server/audit.mjs';
import { buildPhantom } from './support/phantom.mjs';
import { REPO_ROOT } from '../platform/server/db/index.mjs';

const sqliteOnly = { skip: process.env.TEST_BACKEND === 'postgres' };
const SYNTHEA = 'https://github.com/synthetichealth/synthea';
const NPI = 'http://hl7.org/fhir/sid/us-npi';
const SNOMED = 'http://snomed.info/sct';
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (resource, id) => ({ fullUrl: `urn:uuid:${id}`, resource: { id, ...resource } });

// ---------- Synthea-shaped fixture ----------
function writeSynthea(dir) {
  const org = uuid(1);
  const loc = uuid(2);
  const npi = '9999999101';
  fs.writeFileSync(path.join(dir, 'hospitalInformation1700000000000.json'), JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: [
    entry({ resourceType: 'Organization', identifier: [{ system: SYNTHEA, value: org }], active: true, name: 'SYNTHETIC GENERAL HOSPITAL' }, org),
    entry({ resourceType: 'Location', identifier: [{ system: SYNTHEA, value: loc }], status: 'active', name: 'SYNTHETIC GENERAL HOSPITAL', managingOrganization: { reference: `Organization?identifier=${SYNTHEA}|${org}`, display: 'SYNTHETIC GENERAL HOSPITAL' } }, loc),
  ] }));
  fs.writeFileSync(path.join(dir, 'practitionerInformation1700000000000.json'), JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: [
    entry({ resourceType: 'Practitioner', identifier: [{ system: NPI, value: npi }], active: true, name: [{ family: 'Synthdoc', given: ['Test'] }] }, uuid(3)),
    entry({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner?identifier=${NPI}|${npi}`, display: 'Dr. Example Clinician' }, organization: { reference: `Organization?identifier=${SYNTHEA}|${org}`, display: 'SYNTHETIC GENERAL HOSPITAL' }, location: [{ reference: `Location?identifier=${SYNTHEA}|${loc}` }] }, uuid(4)),
  ] }));
  const patientBundle = (n, family, snomed, display) => {
    const p = uuid(10 * n);
    const enc = uuid(10 * n + 1);
    return { resourceType: 'Bundle', type: 'transaction', entry: [
      entry({ resourceType: 'Patient', identifier: [{ system: SYNTHEA, value: p }, { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical Record Number' }] }, system: 'http://hospital.smarthealth.org', value: p }], name: [{ use: 'official', family, given: ['Test'] }], gender: 'female', birthDate: '1961-02-03' }, p),
      entry({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `urn:uuid:${p}` }, participant: [{ individual: { reference: `Practitioner?identifier=${NPI}|${npi}`, display: 'Dr. Example Clinician' } }], period: { start: '2020-05-01T09:00:00Z', end: '2020-05-01T09:30:00Z' }, location: [{ location: { reference: `Location?identifier=${SYNTHEA}|${loc}` } }], serviceProvider: { reference: `Organization?identifier=${SYNTHEA}|${org}`, display: 'SYNTHETIC GENERAL HOSPITAL' } }, enc),
      entry({ resourceType: 'Condition', clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: { coding: [{ system: SNOMED, code: snomed, display }], text: display }, subject: { reference: `urn:uuid:${p}` }, encounter: { reference: `urn:uuid:${enc}` }, onsetDateTime: '2020-05-01T09:00:00Z', recordedDate: '2020-05-01T09:00:00Z' }, uuid(10 * n + 2)),
      entry({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: `urn:uuid:${p}` }, medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '310798', display: 'Hydrochlorothiazide 25 MG Oral Tablet' }] }, requester: { reference: `Practitioner?identifier=${NPI}|0000000000`, display: 'Dr. Example Unknown' }, authoredOn: '2020-05-01T09:10:00Z' }, uuid(10 * n + 3)),
      entry({ resourceType: 'Claim', status: 'active', use: 'claim', patient: { reference: `urn:uuid:${p}` }, provider: { reference: `Organization?identifier=${SYNTHEA}|${org}` } }, uuid(10 * n + 4)),
      entry({ resourceType: 'ExplanationOfBenefit', status: 'active', patient: { reference: `urn:uuid:${p}` } }, uuid(10 * n + 5)),
      entry({ resourceType: 'Provenance', target: [{ reference: `urn:uuid:${p}` }], recorded: '2020-05-01T09:30:00Z', agent: [{ who: { reference: `Practitioner?identifier=${NPI}|${npi}` } }] }, uuid(10 * n + 6)),
    ] };
  };
  fs.writeFileSync(path.join(dir, 'Zzsynthea_One_a.json'), JSON.stringify(patientBundle(1, 'Zzsynthea', '59621000', 'Essential hypertension (disorder)')));
  fs.writeFileSync(path.join(dir, 'Zzsynthea_Two_b.json'), JSON.stringify(patientBundle(2, 'Zzsynthetwo', '44054006', 'Diabetes mellitus type 2 (disorder)')));
  return { org, loc, npi, practitioner: uuid(3), patients: [uuid(10), uuid(20)] };
}

test(`[${BACKEND}] synthea import: reference bundles first, conditional references resolved or dropped, SNOMED kept, claims skipped, counts per type`, async () => {
  const s = await startTestServer();
  const dir = tempDir('hd-synthea-');
  const ids = writeSynthea(dir);
  assert.deepEqual(listImportFiles([dir]).map((f) => path.basename(f).split('1700')[0].split('_')[0]), ['hospitalInformation', 'practitionerInformation', 'Zzsynthea', 'Zzsynthea'], 'hospital and practitioner bundles load before patient bundles');
  const report = await importFhirPaths(s.store, [dir], { assignMrn: true, synthetic: true, source: 'Synthea' });
  assert.equal(report.files, 4);
  assert.equal(report.quarantined, 0, JSON.stringify(report.errors));
  assert.equal(report.unsupported, 6, 'two claims, two explanations of benefit and two provenance records are skipped');
  assert.deepEqual(report.byType.Claim, { seen: 2, written: 0, unchanged: 0, unsupported: 2, quarantined: 0 });
  assert.deepEqual(report.byType.Patient, { seen: 2, written: 2, unchanged: 0, unsupported: 0, quarantined: 0 });
  assert.deepEqual(report.byType.Encounter, { seen: 2, written: 2, unchanged: 0, unsupported: 0, quarantined: 0 });
  assert.deepEqual(report.patients.sort(), ids.patients);
  assert.equal(report.mrnsAssigned, 2);
  assert.equal(report.referencesResolved, 10, 'location (1), role (3), two encounters (3 each)');
  assert.equal(report.referencesDropped, 2, 'the unknown requester on each medication request');

  const role = await s.store.get('PractitionerRole', uuid(4));
  assert.equal(role.practitioner.reference, `Practitioner/${ids.practitioner}`);
  assert.equal(role.organization.reference, `Organization/${ids.org}`);
  const encounter = await s.store.get('Encounter', uuid(11));
  assert.equal(encounter.participant[0].individual.reference, `Practitioner/${ids.practitioner}`);
  assert.equal(encounter.serviceProvider.reference, `Organization/${ids.org}`);
  assert.equal(encounter.location[0].location.reference, `Location/${ids.loc}`);
  const rx = await s.store.get('MedicationRequest', uuid(13));
  assert.deepEqual(rx.requester, { display: 'Dr. Example Unknown' }, 'no match: the display stays, the reference goes');
  const condition = await s.store.get('Condition', uuid(12));
  assert.deepEqual(condition.code.coding.map((c) => c.system), [SNOMED], 'problems keep their SNOMED coding; no ICD-10 is invented');
  assert.equal(JSON.stringify(condition).includes('icd-10'), false);

  const [p1, p2] = await Promise.all(ids.patients.map((id) => s.store.get('Patient', id)));
  assert.match(p1.identifier[0].value, /^N\d{6}$/, 'the house MRN comes first so every MRN helper finds it');
  assert.equal(p1.identifier[0].system, 'urn:hospital-desktop:mrn');
  assert.ok(p1.identifier.some((i) => i.system === 'http://hospital.smarthealth.org' && i.value === ids.patients[0]), 'the source MR identifier is kept');
  assert.notEqual(p1.identifier[0].value, p2.identifier[0].value, 'the counter does not clash');
  assert.deepEqual(p1.meta.security, [HTEST], '--synthetic tags the patient with HTEST');
  assert.deepEqual(HTEST, HITL_HTEST, 'same label shape as the human-in-the-loop and red-team code');

  const found = (await s.call('GET', `/fhir/R4/Patient?identifier=${p1.identifier[0].value}`)).json;
  assert.equal(found.entry.length, 1, 'search by the house MRN works for imported patients');
  assert.equal(found.entry[0].resource.id, ids.patients[0]);
  const everything = (await s.call('GET', `/fhir/R4/Patient/${ids.patients[0]}/$everything`)).json;
  assert.ok(everything.entry.some((e) => e.resource.resourceType === 'Condition'), 'the chart holds the imported problem');

  const again = await importFhirPaths(s.store, [dir], { assignMrn: true, synthetic: true, source: 'Synthea' });
  assert.equal(again.written, 0);
  assert.equal(again.unchanged, report.written, 'rerun changes nothing, even though MRNs were generated');
  assert.equal(again.mrnsAssigned, 0);
  assert.equal((await s.store.history('Patient', ids.patients[0])).length, 1);
  await s.close();
});

test(`[${BACKEND}] source flags: --restricted adds the restricted-source extension and wins over synthetic; neither flag means no tag`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const dir = tempDir('hd-flags-');
  const ids = writeSynthea(dir);
  await importFhirPaths(store, [dir], { restricted: true, synthetic: true, source: 'Restricted set' });
  const p = await store.get('Patient', ids.patients[0]);
  assert.deepEqual(p.extension, [{ url: RESTRICTED_URL, valueString: 'Restricted set' }]);
  assert.deepEqual(p.meta.security, [HTEST], 'both facts are recorded');
  assert.equal(p.identifier[0].value, ids.patients[0], 'without --assign-mrn the identifiers are untouched');
  const plain = tempDir('hd-plain-');
  const ids2 = writeSynthea(plain);
  const { store: store2 } = await openTestStore();
  await ensureLiveRun(store2);
  await importFhirPaths(store2, [plain], {});
  const q = await store2.get('Patient', ids2.patients[0]);
  assert.equal(q.extension, undefined);
  assert.equal(q.meta?.security, undefined);
  await store.close();
  await store2.close();
});

// ---------- DICOM patient mapping ----------
const chestOnly = (opts) => buildPhantom(opts).filter((f) => f.folder !== 'ct-chest');
function writeImages(dir, sets) {
  for (const [sub, files] of Object.entries(sets)) for (const f of files) { fs.mkdirSync(path.join(dir, sub, f.folder), { recursive: true }); fs.writeFileSync(path.join(dir, sub, f.folder, f.name), f.bytes); }
}

test(`[${BACKEND}] dicom: --patient attaches every study to one patient; --create-patients registers one per header PatientID; reruns reuse them`, async () => {
  process.env.DICOM_DIR = path.join(tempDir('hd-dicom-map-'), 'dicom');
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const target = await store.save('Patient', { resourceType: 'Patient', name: [{ family: 'Zztarget', given: ['Synthetic'] }], identifier: [{ type: { coding: [{ code: 'MR' }] }, system: 'urn:hospital-desktop:mrn', value: 'N777001' }] }, { updatedBy: 'test' });
  const dir = tempDir('hd-public-dicom-');
  writeImages(dir, { a: chestOnly({ mrn: 'PUB-0001', name: 'Anon^One', birthDate: '19550607', sex: 'M' }), b: chestOnly({ mrn: 'PUB-0002', name: 'Anon^Two', birthDate: '', sex: '' }) });

  const refused = await importDicomFiles(store, dir, {});
  assert.equal(refused.failed, 4, 'without an override the wrong-patient check refuses every file');
  assert.match(refused.problems[0], /PatientID "PUB-0001" does not match the MRN of any patient/);

  const one = await importDicomFiles(store, dir, { patient: 'N777001', tags: { synthetic: true, source: 'public' } });
  assert.deepEqual([one.stored, one.failed, one.studies.size, one.patients], [4, 0, 4, [target.id]]);
  const studies = await store.query('ImagingStudy');
  assert.ok(studies.every((st) => st.subject.reference === `Patient/${target.id}`));
  assert.deepEqual(studies.map((st) => st.identifier.find((i) => i.system === 'urn:dicom:patient-id').value).sort(), ['PUB-0001', 'PUB-0001', 'PUB-0002', 'PUB-0002'], 'the stored header PatientID is kept');
  assert.ok(studies.every((st) => st.extension.some((e) => e.url === 'urn:hospital-desktop:patient-override' && e.valueString.includes(`Patient/${target.id}`))));
  const logged = (await store.query('TraceStep')).filter((t) => t.did.type === 'dicom.store');
  assert.ok(logged.length >= 4 && logged.every((t) => t.did.args.patientOverride === `Patient/${target.id}` && /^PUB-000[12]$/.test(t.did.args.headerPatientId)), 'the override is in the log');
  await assert.rejects(importDicomFiles(store, dir, { patient: 'N000000' }), /No patient has MRN "N000000"/);

  const dir2 = tempDir('hd-public-dicom2-');
  writeImages(dir2, { a: chestOnly({ mrn: 'PUB-0003', name: 'Anon^Three', birthDate: '19550607', sex: 'M' }), b: chestOnly({ mrn: 'PUB-0004', name: 'Anon^Four', birthDate: '', sex: '' }) });
  const dry = await importDicomFiles(store, dir2, { createPatients: true, dryRun: true });
  assert.deepEqual([dry.stored, dry.created, (await store.query('Patient')).length], [4, 2, 1], 'a dry run counts the patients it would create and writes none');
  const made = await importDicomFiles(store, dir2, { createPatients: true, tags: { synthetic: true, restricted: true, source: 'public' } });
  assert.deepEqual([made.stored, made.created, made.reused, made.patients.length], [4, 2, 0, 2]);
  const created = (await store.query('Patient')).filter((p) => p.id !== target.id).sort((a, b) => String(a.identifier?.[0]?.value).localeCompare(String(b.identifier?.[0]?.value)));
  assert.ok(created.length === 2 && created.every((p) => /^Patient /.test(p.name[0].text)), JSON.stringify(created.map((p) => p.name)));
  assert.deepEqual(created.map((p) => [p.birthDate, p.gender]), [['1955-06-07', 'male'], [undefined, undefined]], 'birth date and sex come from the header when present');
  assert.ok(created.every((p) => /^N\d{6}$/.test(p.identifier[0].value) && p.identifier.some((i) => i.system === SOURCE_ID_URL)));
  assert.ok(created.every((p) => p.meta.security[0].code === 'HTEST' && p.extension[0].url === RESTRICTED_URL));
  const byHeader = new Map(created.map((p) => [p.identifier.find((i) => i.system === SOURCE_ID_URL).value, p.id]));
  for (const st of (await store.query('ImagingStudy')).filter((x) => x.subject.reference !== `Patient/${target.id}`)) {
    assert.equal(st.subject.reference, `Patient/${byHeader.get(`Imaging:${st.identifier.find((i) => i.system === 'urn:dicom:patient-id').value}`)}`);
  }
  const rerun = await importDicomFiles(store, dir2, { createPatients: true });
  assert.deepEqual([rerun.stored, rerun.duplicate, rerun.created, rerun.reused, (await store.query('Patient')).length], [0, 4, 0, 2, 3], 'a rerun reuses the created patients');
  await store.close();
});

function multipart(files) {
  const boundary = 'test-boundary-a1';
  const chunks = [];
  for (const f of files) chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(f), Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/related; type="application/dicom"; boundary=${boundary}` };
}

test(`[${BACKEND}] STOW-RS ?patient= attaches to the chosen patient and logs the override; without it the header must match an MRN`, async () => {
  process.env.DICOM_DIR = path.join(tempDir('hd-stow-map-'), 'dicom');
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', name: [{ family: 'Zzstow', given: ['Synthetic'] }], gender: 'female', birthDate: '1970-01-01' })).json;
  const files = chestOnly({ mrn: 'PUB-0009', name: 'Anon^Nine' }).map((f) => f.bytes);
  const stow = async (query, body) => { const m = multipart(body); const r = await fetch(`${s.base}/dicom-web/studies${query}`, { method: 'POST', headers: { 'Content-Type': m.type, 'X-Role': 'physician', 'X-User-Id': 'dr-reader' }, body: m.body }); return { status: r.status, json: await r.json() }; };
  const plain = await stow('', [files[0]]);
  assert.equal(plain.status, 409);
  assert.match(plain.json.summary.failed[0].reason, /does not match the MRN of any patient/);
  assert.equal((await stow('?patient=nobody', [files[0]])).status, 422);
  const ok = await stow(`?patient=${p.id}`, files);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.summary.stored, 2);
  const studies = (await s.call('GET', `/fhir/R4/ImagingStudy?patient=${p.id}`)).json.entry.map((e) => e.resource);
  assert.equal(studies.length, 2);
  assert.ok(studies.every((st) => st.identifier.some((i) => i.system === 'urn:dicom:patient-id' && i.value === 'PUB-0009')));
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'dicom.store');
  assert.equal(steps.length, 2);
  assert.ok(steps.every((t) => t.did.args.patientOverride === `Patient/${p.id}` && t.did.args.headerPatientId === 'PUB-0009' && t.who.id === 'dr-reader'));
  await s.close();
});

// ---------- WFDB ----------
/** A small WFDB writer (format 16) so the reader is tested against real bytes. */
function writeWfdb(dir, name, { fs: rate = 360, seconds = 2, leads = ['MLII', 'V5'], format = '16', gain = 200, baseline = 0, baseTime = '12:30:00', baseDate = '05/06/2024', comment = '# 69 M 1085 1629 x1' } = {}) {
  const n = rate * seconds;
  const samples = leads.map((_, k) => Int16Array.from({ length: n }, (__, t) => baseline + Math.round(600 * Math.sin((2 * Math.PI * (k + 1) * t) / rate))));
  const buf = Buffer.alloc(n * leads.length * 2);
  for (let t = 0; t < n; t += 1) for (let k = 0; k < leads.length; k += 1) buf.writeInt16LE(samples[k][t], (t * leads.length + k) * 2);
  fs.writeFileSync(path.join(dir, `${name}.dat`), buf);
  const header = [`${name} ${leads.length} ${rate} ${n} ${baseTime} ${baseDate}`, ...leads.map((lead) => `${name}.dat ${format} ${gain}(${baseline})/mV 16 ${baseline} 0 0 0 ${lead}`), comment].join('\n');
  fs.writeFileSync(path.join(dir, `${name}.hea`), `${header}\n`);
  return samples;
}

test('wfdb: header parsing, lead mapping and a format 16 round trip into the A.8 Observation shape', () => {
  const dir = tempDir('hd-wfdb-');
  const samples = writeWfdb(dir, '100', { leads: ['MLII', 'V5'], baseline: 1024 });
  const header = parseHeader(fs.readFileSync(path.join(dir, '100.hea'), 'utf8'));
  assert.deepEqual([header.name, header.nsig, header.fs, header.nsamp, header.baseTime, header.baseDate], ['100', 2, 360, 720, '12:30:00', '05/06/2024']);
  assert.deepEqual(header.signals.map((s) => [s.format, s.gain, s.baseline, s.units, s.description]), [['16', 200, 1024, 'mV', 'MLII'], ['16', 200, 1024, 'mV', 'V5']]);
  const record = readRecord(dir, '100');
  assert.deepEqual([...record.signals[0].samples], [...samples[0]]);
  assert.deepEqual([...record.signals[1].samples], [...samples[1]], 'interleaved signals come apart correctly');
  assert.deepEqual(['I', 'ii', 'MLII', 'aVR', 'AVL', 'v6', 'Lead V1', 'ABP', 'RESP'].map(leadOf), ['I', 'II', 'II', 'aVR', 'aVL', 'V6', 'V1', null, null]);

  const { observation: o, truncated } = toObservation(record, { patientId: 'p1', importedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(truncated, { leads: 0, seconds: false });
  assert.equal(o.resourceType, 'Observation');
  assert.equal(o.status, 'final');
  assert.equal(o.category[0].coding[0].code, 'procedure');
  assert.deepEqual(o.code.coding[0], { system: 'http://loinc.org', code: '11524-6', display: 'EKG study' });
  assert.equal(o.subject.reference, 'Patient/p1');
  assert.equal(o.effectiveDateTime, '2024-06-05T12:30:00.000Z', 'base time and date from the header');
  assert.deepEqual(o.extension, [{ url: ECG_SOURCE_URL, valueString: 'wfdb:100' }]);
  assert.equal(o.component.length, 2);
  assert.deepEqual(o.component[0].code.coding[0], { system: MDC_SYSTEM, code: '131330', display: 'II' });
  assert.deepEqual(o.component[1].code.coding[0], { system: MDC_SYSTEM, code: '131339', display: 'V5' });
  const sd = o.component[0].valueSampledData;
  assert.deepEqual([sd.origin, sd.period, sd.factor, sd.dimensions], [{ value: 0, unit: 'mV' }, Math.round((1000 / 360) * 1e6) / 1e6, 0.005, 1]);
  const data = sd.data.split(' ').map(Number);
  assert.equal(data.length, 720);
  assert.ok(data.every(Number.isInteger));
  assert.deepEqual(data.slice(0, 720), [...samples[0]].map((v) => v - 1024), 'the baseline is subtracted so origin is 0 mV; mV = value * factor');
  assert.deepEqual([sd.lowerLimit, sd.upperLimit], [Math.min(...data), Math.max(...data)]);

  const other = toObservation({ ...record, signals: record.signals.map((s) => ({ ...s, description: 'ABP' })) }, { patientId: 'p1', importedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(other.observation.component[0].code.coding[0], { system: MDC_SYSTEM, code: '0', display: 'ABP' }, 'unknown signals are kept with code 0');
  const long = { ...record, fs: 10, signals: Array.from({ length: 14 }, (_, i) => ({ ...record.signals[0], description: `s${i}`, samples: new Int16Array(400) })) };
  const cut = toObservation(long, { patientId: 'p1', importedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(cut.truncated, { leads: 2, seconds: true });
  assert.equal(cut.observation.component.length, 12);
  assert.equal(cut.observation.component[0].valueSampledData.data.split(' ').length, 300, '30 seconds at 10 Hz');

  writeWfdb(dir, '201', { format: '212' });
  assert.throws(() => readRecord(dir, '201'), (err) => err instanceof WfdbError && /format 212; only format 16/.test(err.message));
  fs.writeFileSync(path.join(dir, 'seg.hea'), 'seg/3 2 360 720\n');
  assert.throws(() => parseHeader(fs.readFileSync(path.join(dir, 'seg.hea'), 'utf8')), /multi-segment/);
});

test(`[${BACKEND}] ecg import: one Observation per record, --create-patients and --patient, format 212 refused, rerun unchanged`, async () => {
  const { store } = await openTestStore();
  await ensureLiveRun(store);
  const dir = tempDir('hd-wfdb-import-');
  writeWfdb(dir, '100', { leads: ['MLII', 'V5'] });
  writeWfdb(dir, '101', { leads: ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'], seconds: 1, comment: '# 44 F' });
  writeWfdb(dir, '203', { format: '212' });
  await assert.rejects(importEcgFolder(store, dir, {}), /--patient <MRN> or --create-patients/);
  const t = await importEcgFolder(store, dir, { createPatients: true, tags: { synthetic: true, source: 'ecg-set' } });
  assert.deepEqual([t.records, t.written, t.unchanged, t.failed, t.created, t.truncated], [3, 2, 0, 1, 2, 0]);
  assert.match(t.problems[0], /^203: record 203 uses format 212; only format 16/);
  const patients = (await store.query('Patient')).sort((a, b) => a.name[0].text.localeCompare(b.name[0].text));
  assert.deepEqual(patients.map((p) => [/^Patient /.test(p.name[0].text), p.gender]), [[true, 'male'], [true, 'female']], 'sex comes from the PhysioNet comment line');
  assert.ok(patients.every((p) => /^N\d{6}$/.test(p.identifier[0].value) && p.meta.security[0].code === 'HTEST'));
  const obs = await store.query('Observation');
  assert.equal(obs.length, 2);
  const twelve = obs.find((o) => o.component.length === 12);
  assert.deepEqual(twelve.component.map((c) => c.code.coding[0].code), ['131329', '131330', '131331', '131332', '131333', '131334', '131335', '131336', '131337', '131338', '131339', '131340']);
  assert.ok(obs.every((o) => o.code.coding[0].code === '11524-6' && o.status === 'final' && /^Patient\//.test(o.subject.reference)));
  assert.equal((await store.query('TraceStep')).filter((x) => x.did.type === 'import.ecg').length, 2);
  const again = await importEcgFolder(store, dir, { createPatients: true });
  assert.deepEqual([again.written, again.unchanged, again.created, again.reused], [0, 2, 0, 2]);
  assert.equal((await store.query('Patient')).length, 2);

  const mrn = patients[0].identifier[0].value;
  const dir2 = tempDir('hd-wfdb-import2-');
  writeWfdb(dir2, 'rec1', { leads: ['II'] });
  const one = await importEcgFolder(store, dir2, { patient: mrn });
  assert.deepEqual([one.written, one.patients], [1, [patients[0].id]]);
  assert.equal((await store.query('Observation', { patient: `Patient/${patients[0].id}` })).length, 2);
  await assert.rejects(importEcgFolder(store, dir2, { patient: 'N999999' }), /No patient has MRN/);
  await store.close();
});

// ---------- Dataset register ----------
test('dataset register: entries are upserted by kind and file-list checksum, patients accumulate, lookups cut to the manifest fields', () => {
  const file = path.join(tempDir('hd-register-'), 'datasets.json');
  assert.deepEqual(readRegister(file), []);
  const files = relativeFiles(['/x/set'], ['/x/set/b.json', '/x/set/sub/a.json']);
  assert.deepEqual(files, ['b.json', path.join('sub', 'a.json')]);
  const sum = fileListChecksum(files);
  assert.equal(sum, fileListChecksum([path.join('sub', 'a.json'), 'b.json']), 'order does not matter');
  const e1 = recordDataset({ kind: 'fhir', source: 'Synthea', licence: 'Apache 2.0', files: 2, checksum: sum, synthetic: true, patients: ['p1'], importedAt: '2026-01-01T00:00:00Z' }, file);
  assert.deepEqual(e1, { id: `fhir-${sum.slice(0, 12)}`, source: 'Synthea', licence: 'Apache 2.0', kind: 'fhir', files: 2, checksum: sum, importedAt: '2026-01-01T00:00:00Z', synthetic: true, restricted: false, patients: ['p1'] });
  recordDataset({ kind: 'fhir', source: 'Synthea', licence: 'Apache 2.0', files: 2, checksum: sum, synthetic: true, patients: ['p2'], importedAt: '2026-01-02T00:00:00Z' }, file);
  recordDataset({ kind: 'dicom', source: 'Public CT', licence: null, files: 40, checksum: 'abc', restricted: true, patients: ['p3'] }, file);
  const all = readRegister(file);
  assert.equal(all.length, 2);
  assert.deepEqual([all[0].patients, all[0].importedAt, all[1].restricted], [['p1', 'p2'], '2026-01-02T00:00:00Z', true]);
  assert.deepEqual(datasetsForPatients(['Patient/p2', 'p9'], file), [{ source: 'Synthea', licence: 'Apache 2.0', kind: 'fhir', importedAt: '2026-01-02T00:00:00Z' }]);
  assert.deepEqual(datasetsForPatients([], file), []);
  assert.throws(() => recordDataset({ kind: 'csv', source: 'x', files: 0, checksum: 'a' }, file), /Unknown dataset kind/);
});

test('import CLI: the reminder, the confirmation guard (exit 2 naming the flag, not needed for --dry-run or a known source), register entries and GET /api/datasets', sqliteOnly, async () => {
  const dir = tempDir('hd-cli-guard-');
  const env = { ...process.env, DB_BACKEND: 'sqlite', SQLITE_FILE: path.join(dir, 'app.sqlite'), DICOM_DIR: path.join(dir, 'dicom'), DATASETS_FILE: path.join(dir, 'datasets.json') };
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'import.mjs'), ...args], { env, encoding: 'utf8' }) }; } catch (err) { return { code: err.status, out: `${err.stdout}${err.stderr}` }; } };
  const fhirDir = path.join(dir, 'synthea'); fs.mkdirSync(fhirDir);
  const ids = writeSynthea(fhirDir);
  const ecgDir = path.join(dir, 'ecg'); fs.mkdirSync(ecgDir);
  writeWfdb(ecgDir, 'r1', { leads: ['II'] });

  const refused = run('--fhir', fhirDir, '--source', 'Synthea');
  assert.equal(refused.code, 2);
  assert.match(refused.out, /Reminder: only synthetic or public de-identified data may be loaded/);
  assert.match(refused.out, /Source "Synthea" has not been imported before. Add --i-confirm-not-real-patient-data/);
  assert.equal(fs.existsSync(env.DATASETS_FILE), false);
  assert.equal(fs.existsSync(env.SQLITE_FILE), false, 'the guard runs before the database is opened');

  const dry = run('--fhir', fhirDir, '--source', 'Synthea', '--dry-run', '--assign-mrn');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Dry run: 4 files, 18 resources seen/);
  assert.match(dry.out, /would write: 12/);
  assert.match(dry.out, /per type/);
  assert.match(dry.out, /Claim\s+2 \/ 0 \/ 0 \/ 2 \/ 0/);
  assert.equal(fs.existsSync(env.DATASETS_FILE), false, 'a dry run writes no register entry');

  const first = run('--fhir', fhirDir, '--source', 'Synthea', '--licence', 'Apache 2.0', '--assign-mrn', '--synthetic', '--i-confirm-not-real-patient-data');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /written: 12/);
  assert.match(first.out, /patients: 2, MRNs assigned: 2/);
  assert.match(first.out, /register: fhir-[0-9a-f]{12} \(Synthea, Apache 2.0, synthetic\)/);
  const second = run('--fhir', fhirDir, '--source', 'Synthea', '--assign-mrn', '--synthetic');
  assert.equal(second.code, 0, 'a known source needs no confirmation');
  assert.match(second.out, /unchanged \(skipped\): 12/);
  assert.equal(run('--ecg', ecgDir, '--create-patients', '--source', 'ECG set').code, 2, 'a new source name needs the flag again');
  const ecg = run('--ecg', ecgDir, '--create-patients', '--source', 'ECG set', '--restricted', '--i-confirm-not-real-patient-data');
  assert.equal(ecg.code, 0, ecg.out);
  assert.match(ecg.out, /ECG import: 1 WFDB records/);
  assert.match(ecg.out, /patients created: 1/);
  assert.match(ecg.out, /register: ecg-[0-9a-f]{12} \(ECG set, restricted\)/);
  assert.equal(run('--dicom', path.join(dir, 'nowhere'), '--patient', 'N1', '--create-patients', '--i-confirm-not-real-patient-data').code, 2, '--patient and --create-patients cannot be combined');

  const register = JSON.parse(fs.readFileSync(env.DATASETS_FILE, 'utf8'));
  assert.equal(register.length, 2);
  assert.deepEqual(register.map((e) => [e.kind, e.source, e.licence, e.files, e.synthetic, e.restricted, e.patients.length]), [['fhir', 'Synthea', 'Apache 2.0', 4, true, false, 2], ['ecg', 'ECG set', null, 2, false, true, 1]]);
  assert.deepEqual(register[0].patients, ids.patients);
  assert.match(register[0].checksum, /^[0-9a-f]{64}$/);

  process.env.DATASETS_FILE = env.DATASETS_FILE;
  const s = await startTestServer({ file: env.SQLITE_FILE });
  try {
    const r = await s.call('GET', '/api/datasets');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.datasets.map((e) => e.id), register.map((e) => e.id));
    assert.equal((await s.call('POST', '/api/datasets', {})).status, 404, 'read-only');
  } finally { await s.close(); delete process.env.DATASETS_FILE; }
});
