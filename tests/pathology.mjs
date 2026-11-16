// Pathology: specimen hierarchy, accession numbers, the
// report lifecycle, sign-out rules, add-on stains through the lab, critical
// diagnosis documentation, the reading lock and role refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestServer, tempDir, patient, BACKEND } from './support/helpers.mjs';
import { caseAccession, normaliseParts, turnaround, pathologySignIssue, PATH_URLS } from '../pathology/server/pathology.mjs';

const pathol = { 'X-Role': 'physician', 'X-User-Id': 'dr-path' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const lab = { 'X-Role': 'nurse', 'X-User-Id': 'tech-1' };
const HTEST = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' };

async function setup() {
  process.env.SLIDES_DIR = path.join(tempDir('hd-path-'), 'slides');
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', { ...patient('Pathcase'), meta: { security: [HTEST] } })).json;
  const order = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'urgent', subject: { reference: `Patient/${p.id}` }, authoredOn: new Date().toISOString(), requester: { display: 'Dr One' }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'pathology' }] }], code: { coding: [{ system: 'http://loinc.org', code: '11529-5', display: 'Surgical pathology' }], text: 'Surgical pathology' }, reasonCode: [{ text: 'Pigmented lesion, rule out melanoma' }] }, doc)).json;
  const report = (extra = {}) => ({ resourceType: 'DiagnosticReport', status: 'preliminary', category: [{ coding: [{ system: 'urn:hospital-desktop:category', code: 'pathology' }] }], code: { text: 'Surgical pathology' }, subject: { reference: `Patient/${p.id}` }, basedOn: [{ reference: `ServiceRequest/${order.id}` }], effectiveDateTime: new Date().toISOString(), ...extra });
  return { s, p, order, report };
}

test('rules: accession numbers, part and block labels, turnaround targets and sign-out issues', () => {
  assert.equal(caseAccession('2026-03-01T00:00:00Z', []), 'S26-00001');
  assert.equal(caseAccession('2026-03-01T00:00:00Z', [{ accessionIdentifier: { value: 'S26-00001' } }, { accessionIdentifier: { value: 'S26-00002' } }]), 'S26-00003');
  const parts = normaliseParts([{ description: 'Skin', blocks: [{ slides: ['HE', 'PAS'] }, {}] }, {}]);
  assert.deepEqual(parts.map((p) => [p.label, p.blocks.map((b) => [b.label, b.slides.map((s) => s.display)])]), [['A', [['A1', ['H&E', 'PAS']], ['A2', ['H&E']]]], ['B', [['B1', ['H&E']]]]]);
  assert.throws(() => normaliseParts([{ blocks: [{ slides: ['Unobtainium'] }] }]), /Unknown stain/);
  assert.throws(() => normaliseParts([]), /1 to 26 parts/);
  const c = { receivedTime: '2026-03-01T08:00:00Z' };
  assert.deepEqual(turnaround(c, '2026-03-02T08:00:00Z', '2026-03-03T00:00:00Z', 'routine'), { minutes: 1440, target: 2880, over: false });
  assert.equal(turnaround(c, null, '2026-03-03T08:00:00Z', 'stat').over, true);
  assert.match(pathologySignIssue({ conclusion: '' }), /final diagnosis/);
  assert.match(pathologySignIssue({ conclusion: 'Benign naevus', extension: [{ url: PATH_URLS.critical, valueBoolean: true }] }), /who was told/);
  assert.equal(pathologySignIssue({ conclusion: 'Benign naevus' }), null);
  assert.match(pathologySignIssue({ extension: [{ url: PATH_URLS.addendumOf, valueString: 'DiagnosticReport/x' }] }), /addendum needs text/);
});

test(`[${BACKEND}] accessioning builds case, parts, blocks and slides; the order is noted; the worklist and case page describe it; patients are refused (staff roles all may)`, async () => {
  const { s, p, order } = await setup();
  const before = await s.call('GET', '/api/pathology/worklist', undefined, pathol);
  assert.equal(before.json.pendingOrders.length, 1);
  const refused = await s.call('POST', '/api/pathology/cases', { order: order.id, type: 'Biopsy', parts: [{}] }, { 'X-Role': 'patient', 'X-User-Id': 'pt-one' });
  assert.equal(refused.status, 403, refused.text);
  const made = await s.call('POST', '/api/pathology/cases', { order: order.id, type: 'Biopsy', parts: [{ description: 'Skin, left forearm', blocks: [{ slides: ['HE', 'PAS'] }] }, { description: 'Skin, margin' }], gross: 'A 4 mm punch of skin.' }, pathol);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.accession, 'S26-00001');
  assert.deepEqual(made.json.tree.map((t) => [t.label, t.blocks.map((b) => [b.label, b.slides.length])]), [['A', [['A1', 2]]], ['B', [['B1', 1]]]]);
  assert.equal((await s.call('POST', '/api/pathology/cases', { order: order.id, type: 'Biopsy', parts: [{}] }, pathol)).status, 409, 'one case per order');
  assert.equal((await s.call('POST', '/api/pathology/cases', { patient: p.id, type: 'Sandwich', parts: [{}] }, pathol)).status, 422);
  const specimens = (await s.call('GET', `/fhir/R4/Specimen?patient=${p.id}`)).json.entry.map((e) => e.resource);
  assert.equal(specimens.length, 1 + 2 + 2 + 3);
  const c = specimens.find((x) => x.accessionIdentifier?.value === 'S26-00001');
  assert.equal(c.extension.find((e) => e.url === 'urn:hospital-desktop:lifecycle').valueCode, 'received');
  const slide = specimens.find((x) => x.identifier?.[0]?.value === 'A1-2');
  assert.equal(slide.extension.find((e) => e.url === PATH_URLS.stain).valueCoding.display, 'PAS');
  assert.equal(specimens.find((x) => `Specimen/${x.id}` === slide.parent[0].reference).identifier[0].value, 'A1');
  const d = await s.call('GET', `/api/pathology/cases/${made.json.id}`, undefined, doc);
  assert.equal(d.status, 200, d.text);
  assert.deepEqual([d.json.case.accession, d.json.case.state, d.json.case.status, d.json.case.priority, d.json.case.gross, d.json.case.order.reason, d.json.case.stains.sort()], ['S26-00001', 'received', 'unread', 'urgent', 'A 4 mm punch of skin.', 'Pigmented lesion, rule out melanoma', ['H&E', 'PAS']]);
  assert.match((await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}`)).json.note[0].text, /Accessioned as S26-00001/);
  const wl = await s.call('GET', '/api/pathology/worklist', undefined, pathol);
  assert.deepEqual([wl.json.rows.length, wl.json.pendingOrders.length, wl.json.rows[0].slideCount, wl.json.rows[0].slidesWithImages], [1, 0, 3, 0]);
  assert.equal((await s.call('PUT', `/api/pathology/cases/${made.json.id}/gross`, { text: 'Revised gross.' }, pathol)).status, 200);
  assert.equal((await s.call('GET', `/api/pathology/cases/${made.json.id}`, undefined, pathol)).json.case.gross, 'Revised gross.');
  await s.close();
});

test(`[${BACKEND}] sign-out: a final diagnosis is required, a critical diagnosis must document who was told, only pathologists sign, the clinician is notified, the case is resulted, an addendum follows, release is separate`, async () => {
  const { s, p, order, report } = await setup();
  const made = (await s.call('POST', '/api/pathology/cases', { order: order.id, type: 'Biopsy', parts: [{}] }, pathol)).json;
  const rep = await s.call('POST', '/fhir/R4/DiagnosticReport', report({ specimen: [{ reference: `Specimen/${made.id}` }], extension: [{ url: PATH_URLS.micro, valueString: 'Nests of atypical melanocytes.' }, { url: PATH_URLS.critical, valueBoolean: true }] }), pathol);
  assert.equal(rep.status, 201, rep.text);
  assert.equal((await s.call('GET', `/api/pathology/cases/${made.id}`, undefined, pathol)).json.case.status, 'draft');
  const sign = (headers = pathol) => s.call('POST', `/fhir/R4/DiagnosticReport/${rep.json.id}/$transition`, { to: 'final' }, headers);
  let r = await sign(); assert.equal(r.status, 422); assert.match(r.text, /final diagnosis is required/);
  let cur = (await s.call('PUT', `/fhir/R4/DiagnosticReport/${rep.json.id}`, { ...rep.json, conclusion: 'Malignant melanoma, Breslow 0.6 mm.' }, pathol)).json;
  r = await sign(); assert.equal(r.status, 422); assert.match(r.text, /who was told and when/);
  cur = (await s.call('PUT', `/fhir/R4/DiagnosticReport/${rep.json.id}`, { ...cur, extension: [...cur.extension, { url: PATH_URLS.criticalTold, valueString: JSON.stringify({ to: 'Dr One', at: new Date().toISOString(), readBack: true }) }] }, pathol)).json;
  assert.equal((await sign({ 'X-Role': 'patient', 'X-User-Id': 'pt-one' })).status, 403, 'a patient may not sign');
  r = await sign(); assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'final');
  const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource).filter((t) => t.code?.coding?.[0]?.code === 'report-signed');
  assert.deepEqual([tasks.length, tasks[0].code.text, tasks[0].owner.display], [1, 'Pathology report signed', 'Dr One']);
  const c = (await s.call('GET', `/fhir/R4/Specimen/${made.id}`)).json;
  assert.equal(c.extension.find((e) => e.url === 'urn:hospital-desktop:lifecycle').valueCode, 'resulted');
  const locked = await s.call('PUT', `/fhir/R4/DiagnosticReport/${rep.json.id}`, { ...r.json, conclusion: 'Changed' }, pathol);
  assert.equal(locked.status, 422, 'a signed report is locked');
  const add = await s.call('POST', '/fhir/R4/DiagnosticReport', report({ specimen: [{ reference: `Specimen/${made.id}` }], extension: [{ url: PATH_URLS.findings, valueString: 'Immunostains support the diagnosis.' }, { url: PATH_URLS.addendumOf, valueString: `DiagnosticReport/${rep.json.id}` }] }), pathol);
  assert.equal(add.status, 201, add.text);
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${add.json.id}/$transition`, { to: 'final' }, pathol)).status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/DiagnosticReport/${rep.json.id}`)).json.status, 'appended');
  const d = (await s.call('GET', `/api/pathology/cases/${made.id}`, undefined, doc)).json;
  assert.deepEqual([d.case.status, d.report.status, d.addenda.length, d.case.turnaroundMinutes >= 0], ['read', 'appended', 1, true]);
  const wl = (await s.call('GET', '/api/pathology/worklist?queue=all', undefined, pathol)).json;
  assert.deepEqual([wl.rows[0].status, wl.metrics.signedToday, wl.counts.my], ['read', 1, 0]);
  assert.equal((await s.call('POST', `/fhir/R4/DiagnosticReport/${rep.json.id}/$release`, { released: true }, pathol)).status, 200);
  await s.close();
});
