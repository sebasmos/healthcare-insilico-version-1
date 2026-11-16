// Lab app: the specimen lifecycle with collection scans, receipt
// and rejection with a recollect task, result entry with reference flags
// and delta checks, two-step verification, auto-verification, critical
// "phoned to" records, QC blocking release, turnaround, and role rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { deltaCheck, leveyJennings, accessionNumber, benchFor } from '../lab/server/lab.mjs';

const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const tech1 = { 'X-Role': 'nurse', 'X-User-Id': 'mlt-one' };
const tech2 = { 'X-Role': 'nurse', 'X-User-Id': 'mlt-two' };
const LOINC = 'http://loinc.org';
const labOrder = (pid, code, display, priority = 'routine') => ({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority, subject: { reference: `Patient/${pid}` }, authoredOn: '2026-05-01T09:00:00.000Z', code: { coding: [{ system: LOINC, code, display }], text: display }, category: [{ coding: [{ system: 'urn:hospital-desktop:order-category', code: 'laboratory' }] }], requester: { display: 'Dr One' } });

test('delta check, Levey-Jennings rules, accession numbers and bench routing', () => {
  assert.equal(deltaCheck('2160-0', 1.0, { valueQuantity: { value: 0.9 } }), null, 'inside the 30% limit');
  const d = deltaCheck('2160-0', 2.0, { valueQuantity: { value: 1.0 }, effectiveDateTime: '2026-04-30T09:00:00Z' });
  assert.equal(d.change, 1);
  assert.match(d.message, /100% change/);
  const lj = leveyJennings([{ value: 10 }, { value: 10.5 }, { value: 12.5 }], { mean: 10, sd: 1 });
  assert.deepEqual([lj.last.z, lj.outOfRange, lj.rules.includes('1-2s')], [2.5, true, true]);
  assert.equal(leveyJennings([{ value: 10.2 }], { mean: 10, sd: 1 }).outOfRange, false);
  assert.equal(accessionNumber('2026-05-01T09:00:00Z', [{ accessionIdentifier: { value: 'A26-00001' } }]), 'A26-00002');
  assert.deepEqual([benchFor(['718-7']), benchFor(['2160-0'])], ['haematology', 'chemistry']);
});

test(`[${BACKEND}] lifecycle: order → collect with scans → transit → receive (accession, bench) → results with flags and delta → second technologist verifies → order completes; worklists and turnaround`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Labcase'))).json;
    const mrn = p.identifier.find((i) => i.type?.coding?.some((c) => c.code === 'MR')).value;
    // a previous final creatinine for the delta check
    const prev = (await s.call('POST', '/fhir/R4/Observation', { resourceType: 'Observation', status: 'preliminary', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code: { coding: [{ system: LOINC, code: '2160-0', display: 'Creatinine' }] }, subject: { reference: `Patient/${p.id}` }, effectiveDateTime: '2026-04-20T09:00:00Z', valueQuantity: { value: 1.0, unit: 'mg/dL' } }, doc)).json;
    assert.equal((await s.call('POST', `/fhir/R4/Observation/${prev.id}/$transition`, { to: 'final' }, doc)).status, 200);
    const order = (await s.call('POST', '/fhir/R4/ServiceRequest', labOrder(p.id, '24323-8', 'Comprehensive metabolic panel (CMP)', 'stat'), doc)).json;
    let wl = (await s.call('GET', '/api/lab/worklist', undefined, tech1)).json;
    assert.equal(wl.pendingCollection.length, 1);
    let r = await s.call('POST', '/api/lab/specimens/collect', { order: order.id, patientScan: 'N999999', tubeLabel: order.id }, nurse);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Wrong patient/);
    r = await s.call('POST', '/api/lab/specimens/collect', { order: order.id, patientScan: mrn, tubeLabel: order.id, type: 'Blood' }, nurse);
    assert.equal(r.status, 201, r.text);
    const sid = r.json.id;
    assert.equal(r.json.extension.find((e) => e.url === 'urn:hospital-desktop:lifecycle').valueCode, 'collected');
    r = await s.call('POST', '/api/lab/specimens/collect', { order: order.id, patientScan: mrn, tubeLabel: order.id }, nurse);
    assert.equal(r.status, 409, 'one specimen per order');
    clock.advance(10 * 60000);
    assert.equal((await s.call('POST', `/api/lab/specimens/${sid}/in-transit`, {}, nurse)).status, 200);
    wl = (await s.call('GET', '/api/lab/worklist', undefined, tech1)).json;
    assert.equal(wl.pendingReceipt.length, 1);
    assert.equal(wl.pendingCollection.length, 0);
    r = await s.call('POST', `/api/lab/specimens/${sid}/received`, { bench: 'chemistry' }, tech1);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.accessionIdentifier.value, /^A26-\d{5}$/);
    wl = (await s.call('GET', '/api/lab/worklist?bench=chemistry', undefined, tech1)).json;
    assert.equal(wl.inProcess.length, 1);
    assert.equal((await s.call('GET', '/api/lab/worklist?bench=haematology', undefined, tech1)).json.inProcess.length, 0);
    r = await s.call('POST', `/api/lab/specimens/${sid}/results`, { values: { '2160-0': 2.4, '2823-3': 6.5, '2345-7': 95 } }, tech1);
    assert.equal(r.status, 201, r.text);
    const creat = r.json.written.find((x) => x.code === '2160-0');
    assert.equal(creat.status, 'preliminary');
    assert.equal(creat.flag, 'H');
    assert.match(creat.delta, /Delta check/);
    const k = r.json.written.find((x) => x.code === '2823-3');
    assert.equal(k.flag, 'HH');
    const page = (await s.call('GET', `/api/lab/specimens/${sid}`, undefined, tech1)).json;
    assert.equal(page.state, 'resulted');
    assert.equal(page.analytes.find((a) => a.code === '2160-0').previous.value, 1.0);
    r = await s.call('POST', `/api/lab/specimens/${sid}/verify`, {}, tech1);
    assert.equal(r.status, 409, 'the enterer cannot verify');
    r = await s.call('POST', `/api/lab/specimens/${sid}/verify`, {}, { 'X-Role': 'patient', 'X-User-Id': 'pt-one' });
    assert.equal(r.status, 403, 'a patient does not sign laboratory results (staff roles all may)');
    clock.advance(20 * 60000);
    r = await s.call('POST', `/api/lab/specimens/${sid}/verify`, { comment: 'Checked against the previous' }, tech2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.verified.length, 3);
    assert.ok(r.json.verified.some((x) => x.critical));
    const after = (await s.call('GET', `/api/lab/specimens/${sid}`, undefined, tech2)).json;
    assert.equal(after.state, 'verified');
    assert.equal((await s.call('GET', `/fhir/R4/ServiceRequest/${order.id}`)).json.status, 'completed', 'signing every result completes the order');
    wl = (await s.call('GET', '/api/lab/worklist', undefined, tech1)).json;
    assert.equal(wl.turnaround.stat.count, 1);
    assert.equal(wl.turnaround.stat.meanMinutes, 30);
    assert.equal(wl.turnaround.stat.withinTargetPercent, 100);
    assert.equal(wl.criticals.length, 1, 'the critical potassium waits to be phoned');
    // Phone the critical value
    r = await s.call('POST', `/api/lab/results/${wl.criticals[0].id}/phone`, { to: 'Dr One', readBack: false }, tech2);
    assert.equal(r.status, 422);
    r = await s.call('POST', `/api/lab/results/${wl.criticals[0].id}/phone`, { to: 'Dr One', readBack: true }, tech2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.phoned.to, 'Dr One');
    assert.equal((await s.call('GET', '/api/lab/worklist', undefined, tech1)).json.criticals.length, 0);
    const badges = (await s.call('GET', '/api/badges')).json;
    assert.ok(badges.criticalUnacknowledged.some((x) => x.id === wl.criticals[0].id), 'the physician still has to acknowledge it');
    // Correct a verified result
    r = await s.call('POST', `/api/lab/results/${creat.id}/correct`, { value: 2.2, reason: 'Transcription error' }, tech2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'corrected');
    assert.equal((await s.call('GET', `/api/lab/specimens/${sid}`, undefined, tech2)).json.state, 'corrected');
    const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
    for (const t of ['specimen.collect', 'specimen.received', 'lab.result', 'lab.verify', 'lab.phone', 'lab.correct']) assert.ok(steps.includes(t), t);
  } finally { await s.close(); }
});

test(`[${BACKEND}] rejection at receipt sends a recollect task to the nurse; auto-verification releases in-range results and QC out of range blocks verification; agents are refused`, async () => {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Rejectcase'))).json;
    const mrn = p.identifier.find((i) => i.type?.coding?.some((c) => c.code === 'MR')).value;
    const o1 = (await s.call('POST', '/fhir/R4/ServiceRequest', labOrder(p.id, '58410-2', 'Complete blood count (CBC)'), doc)).json;
    const s1 = (await s.call('POST', '/api/lab/specimens/collect', { order: o1.id, patientScan: mrn, tubeLabel: o1.id }, nurse)).json;
    let r = await s.call('POST', `/api/lab/specimens/${s1.id}/rejected`, { reason: 'haemolysed' }, tech1);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'unsatisfactory');
    const tasks = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource);
    assert.ok(tasks.some((t) => t.code.coding[0].code === 'recollect' && /haemolysed/.test(t.code.text)));
    const wl = (await s.call('GET', '/api/lab/worklist', undefined, tech1)).json;
    assert.ok(wl.pendingCollection.some((x) => x.id === o1.id), 'a rejected specimen puts the order back for collection');
    const list = (await s.call('GET', `/api/nursing/worklist?patient=${p.id}`, undefined, nurse)).json.patients[0];
    assert.ok(list.items.some((i) => i.kind === 'task' && /Recollect/.test(i.label)));
    // Auto-verification
    r = await s.call('PUT', '/api/lab/autoverify', { autoVerify: ['2345-7'] }, tech1);
    assert.equal(r.status, 200, r.text);
    const o2 = (await s.call('POST', '/fhir/R4/ServiceRequest', labOrder(p.id, '2345-7', 'Glucose'), doc)).json;
    const s2 = (await s.call('POST', '/api/lab/specimens/collect', { order: o2.id, patientScan: mrn, tubeLabel: o2.id }, nurse)).json;
    await s.call('POST', `/api/lab/specimens/${s2.id}/received`, { bench: 'chemistry' }, tech1);
    r = await s.call('POST', `/api/lab/specimens/${s2.id}/results`, { values: { '2345-7': 90 } }, tech1);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.autoVerified.length, 1);
    assert.equal(r.json.written[0].status, 'final');
    const auto = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'lab.autoverify');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].who.id, 'auto-verification');
    // Out of range value is not auto-verified; QC out of range blocks verification
    const o3 = (await s.call('POST', '/fhir/R4/ServiceRequest', labOrder(p.id, '2345-7', 'Glucose'), doc)).json;
    const s3 = (await s.call('POST', '/api/lab/specimens/collect', { order: o3.id, patientScan: mrn, tubeLabel: o3.id }, nurse)).json;
    await s.call('POST', `/api/lab/specimens/${s3.id}/received`, {}, tech1);
    r = await s.call('POST', '/api/lab/qc', { analyte: '2345-7', analyser: 'Analyser 1', level: 'Level 1', mean: 100, sd: 2, value: 105 }, tech1);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.outOfRange, true);
    r = await s.call('POST', `/api/lab/specimens/${s3.id}/results`, { values: { '2345-7': 180 } }, tech1);
    assert.equal(r.json.autoVerified.length, 0, 'out of range is never auto-verified');
    r = await s.call('POST', `/api/lab/specimens/${s3.id}/verify`, {}, tech2);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Quality control/);
    r = await s.call('POST', '/api/lab/qc', { analyte: '2345-7', analyser: 'Analyser 1', level: 'Level 1', mean: 100, sd: 2, value: 101 }, tech1);
    assert.equal(r.json.outOfRange, false);
    r = await s.call('POST', `/api/lab/specimens/${s3.id}/verify`, {}, tech2);
    assert.equal(r.status, 200, r.text);
    const qc = (await s.call('GET', '/api/lab/qc?analyte=2345-7', undefined, tech1)).json;
    assert.equal(qc.series.length, 1);
    assert.equal(qc.series[0].points.length, 2);
    const agent = await s.call('POST', '/api/lab/specimens/collect', { order: o3.id, patientScan: mrn, tubeLabel: o3.id }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': 'live' });
    assert.equal(agent.status, 403);
    const asOf = await s.call('GET', `/api/lab/specimens/${s3.id}?_asOf=2026-05-01T08:00:00.000Z`, undefined, tech1);
    assert.equal(asOf.status, 404, 'time travel: the specimen did not exist yet');
  } finally { await s.close(); }
});
