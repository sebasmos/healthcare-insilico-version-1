// IEEE 11073 SDC bedside devices (docs/STANDARDS.md): a simulated monitor, ventilator and pump send their MDIB
// and reports; the hospital gets Device (MDS > VMD > channel), DeviceMetric and Observation records, NEWS2
// picks up the monitor's vital signs, and alarms become DetectedIssues that clear. Nameless and synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { createSimDevice } from '../standards/server/sdc-sim.mjs';
import { readMdib } from '../standards/server/sdc.mjs';

const R = { 'X-Role': 'researcher', 'X-User-Id': 'res-1' };
const KEY = 'test-sdc-key-0123456789abcdef0123';

test('the simulator MDIB reads back as MDS, VMD, channel, metrics, alert and patient context', () => {
  const d = createSimDevice({ kind: 'ventilator', mrn: 'N350001' });
  const m = readMdib(d.mdib(1_700_000_000_000));
  assert.deepEqual(m.devices.map((x) => x.level), ['mds', 'vmd', 'channel']);
  assert.equal(m.metrics.length, 4); assert.equal(m.alerts[0].priority, 'Hi'); assert.equal(m.patient, 'N350001');
  assert.equal(m.metrics.find((x) => x.code === '151976').category, 'Set', 'PEEP is a setting');
});

test('SDC devices feed the chart: Device tree, DeviceMetrics, vital signs with NEWS2, and alarms on and off', async () => {
  process.env.SDC_GATEWAY_KEY = KEY;
  const s = await startTestServer();
  try {
    const G = { 'X-Gateway-Key': KEY };
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: '1950-01-01', identifier: [{ system: 'urn:hospital-desktop:mrn', type: { coding: [{ code: 'MR' }] }, value: 'N350001' }] }, R)).json;
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const mon = createSimDevice({ kind: 'monitor', mrn: 'N350001', seed: 4 }); const vent = createSimDevice({ kind: 'ventilator', mrn: 'N350001', seed: 5 }); const pump = createSimDevice({ kind: 'pump', mrn: 'N350001', seed: 6 });
    assert.equal((await s.call('POST', '/api/sdc/report', { mds: mon.mds, xml: mon.metrics(t0) }, G)).status, 409, 'a report before the MDIB is refused');
    for (const d of [mon, vent, pump]) { const r = await s.call('POST', '/api/sdc/mdib', { xml: d.mdib(t0) }, G); assert.equal(r.status, 200, r.text); assert.equal(r.json.patient, p.id); }
    assert.equal((await s.call('POST', '/api/sdc/mdib', { xml: mon.mdib(t0) }, { 'X-Role': 'nurse', 'X-User-Id': 'n1' })).status, 403, 'only the device gateway posts');
    assert.equal((await s.call('POST', '/api/sdc/mdib', { xml: mon.mdib(t0) }, { 'X-Gateway-Key': 'x'.repeat(KEY.length) })).status, 401);
    const devices = (await s.call('GET', '/fhir/R4/Device', undefined, R)).json.entry.map((e) => e.resource);
    assert.equal(devices.length, 9, 'three devices, each MDS > VMD > channel');
    const mdsMon = devices.find((d) => d.type.text === 'Patient monitor'); assert.equal(mdsMon.patient.reference, `Patient/${p.id}`);
    assert.ok(devices.some((d) => d.parent?.reference === `Device/${mdsMon.id}`));
    const metrics = (await s.call('GET', '/fhir/R4/DeviceMetric', undefined, R)).json.entry.map((e) => e.resource); assert.equal(metrics.length, 12);
    const r = await s.call('POST', '/api/sdc/report', { mds: mon.mds, xml: mon.metrics(t0 + 60_000, { hr: 131, rr: 26, spo2: 89, sys: 88, temp: 38.6 }) }, G); assert.equal(r.status, 200, r.text);
    const obs = (await s.call('GET', `/fhir/R4/Observation?patient=Patient/${p.id}`, undefined, R)).json.entry.map((e) => e.resource);
    const hr = obs.filter((o) => o.code.coding.some((c) => c.code === '8867-4')).sort((a, b) => a.effectiveDateTime.localeCompare(b.effectiveDateTime)).at(-1);
    assert.equal(hr.valueQuantity.value, 131); assert.match(hr.device.reference, /^DeviceMetric\//); assert.equal(hr.category[0].coding[0].code, 'vital-signs');
    assert.ok(obs.some((o) => o.code.coding.some((c) => c.code === '157784')), 'pump rate recorded with its MDC code');
    const flow = await s.call('POST', '/api/nursing/flowsheet', { patient: p.id, at: new Date(t0 + 60_000).toISOString(), vitals: {}, assessments: { consciousness: 'A', o2device: 'Room air' } }, { 'X-Role': 'nurse', 'X-User-Id': 'nurse-1' });
    assert.ok([200, 201].includes(flow.status), flow.text);
    assert.ok(flow.json.news2.total >= 7, `the device vital signs plus the nurse's two assessments give a high NEWS2: ${JSON.stringify(flow.json.news2)}`);
    let a = await s.call('POST', '/api/sdc/report', { mds: vent.mds, xml: vent.alarm(true, t0 + 120_000) }, G); assert.equal(a.json.alarms[0].on, true);
    let issue = (await s.call('GET', `/fhir/R4/DetectedIssue/${a.json.alarms[0].id}`, undefined, R)).json; assert.equal(issue.status, 'preliminary'); assert.equal(issue.severity, 'high');
    a = await s.call('POST', '/api/sdc/report', { mds: vent.mds, xml: vent.alarm(false, t0 + 180_000) }, G);
    issue = (await s.call('GET', `/fhir/R4/DetectedIssue/${a.json.alarms[0].id}`, undefined, R)).json; assert.equal(issue.status, 'cancelled', 'the alarm clears');
  } finally { await s.close(); delete process.env.SDC_GATEWAY_KEY; }
});
