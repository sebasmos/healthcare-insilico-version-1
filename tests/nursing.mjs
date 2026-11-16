// Nurse tabs: work list derivation, intake and output totals,
// order acknowledgement, education records, care plans and goals, and the
// role rules around them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { ioTotals, worklistFor } from '../ehr/server/nursing.mjs';

const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const LOINC = 'http://loinc.org';

const io = (code, mL, at, direction) => ({ status: 'final', category: [{ coding: [{ code: 'intake-output' }] }], code: { coding: [{ system: 'urn:hospital-desktop:intake-output', code }] }, valueQuantity: { value: mL }, effectiveDateTime: at, direction });

test('intake and output totals per shift and per 24 hours with a running balance', () => {
  const now = new Date('2026-05-01T20:00:00');
  const t = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const obs = [io('oral', 120, t(8)), io('iv', 900, t(10)), io('urine', 500, t(12)), io('iv', 200, t(19)), io('urine', 300, t(19))];
  const totals = ioTotals(obs, now.toISOString());
  assert.equal(totals.last24h.in, 1220);
  assert.equal(totals.last24h.out, 800);
  assert.equal(totals.last24h.balance, 420);
  assert.equal(totals.currentShift.id, 'night');
  assert.deepEqual([totals.currentShift.in, totals.currentShift.out], [200, 300]);
  assert.deepEqual([totals.previousShift.in, totals.previousShift.out], [1020, 500]);
  assert.equal(totals.sinceAdmission.balance, 420);
});

test('work list: medications due, vitals due, orders to acknowledge, specimens to collect and open tasks, overdue flagged, time ordered', () => {
  const now = '2026-05-01T20:00:00.000Z';
  const list = worklistFor({
    patient: { id: 'p1', name: [{ family: 'Ward', given: ['Test'] }], identifier: [{ type: { coding: [{ code: 'MR' }] }, value: 'N100001' }] },
    encounter: { id: 'e1', location: [{ status: 'active', location: { display: 'Medical ward / Room 1 / Bed A' } }] },
    orders: [
      { id: 'o1', resourceType: 'ServiceRequest', status: 'active', authoredOn: '2026-05-01T18:00:00.000Z', code: { text: 'CBC' }, category: [{ coding: [{ code: 'laboratory' }] }], extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'active' }] },
      { id: 'o2', resourceType: 'ServiceRequest', status: 'active', authoredOn: '2026-05-01T19:50:00.000Z', code: { text: 'Chest X-ray' }, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'active' }, { url: 'urn:hospital-desktop:nurse-acknowledged', valueString: 'rn at t' }] },
    ],
    medOrders: [], admins: [],
    observations: [{ status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: LOINC, code: '8867-4' }] }, effectiveDateTime: '2026-05-01T14:00:00.000Z', valueQuantity: { value: 80 } }],
    tasks: [{ id: 't1', status: 'requested', code: { coding: [{ code: 'news2-escalation' }], text: 'NEWS2 6' }, authoredOn: '2026-05-01T19:00:00.000Z', priority: 'urgent' }],
    now,
  });
  assert.equal(list.unit, 'Medical ward / Room 1 / Bed A');
  const kinds = list.items.map((i) => i.kind);
  assert.ok(kinds.includes('acknowledge') && kinds.includes('specimen') && kinds.includes('vitals') && kinds.includes('escalation'));
  assert.ok(!list.items.some((i) => i.ref === 'ServiceRequest/o2' && i.kind === 'acknowledge'), 'an acknowledged order is not listed again');
  const vitals = list.items.find((i) => i.kind === 'vitals');
  assert.equal(vitals.due, '2026-05-01T18:00:00.000Z');
  assert.equal(vitals.overdue, true);
  assert.equal(list.items.find((i) => i.kind === 'acknowledge').overdue, true);
  for (let i = 1; i < list.items.length; i += 1) assert.ok(list.items[i - 1].due <= list.items[i].due, 'time ordered');
  assert.ok(list.overdue >= 3);
});

test(`[${BACKEND}] nurse tabs end to end: I/O entry and totals, order acknowledgement, education, care plan with goals and a shift evaluation, work list across a unit; role refusals`, async () => {
  const clock = testClock('2026-05-01T16:00:00.000Z');
  const s = await startTestServer({ clock });
  try {
    const p = (await s.call('POST', '/fhir/R4/Patient', patient('Nursecase'))).json;
    const enc = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP', display: 'inpatient' }, subject: { reference: `Patient/${p.id}` }, period: { start: clock.now() }, location: [{ status: 'active', location: { display: 'Medical ward / Room 1 / Bed A' } }] }, doc)).json;
    assert.ok(enc.id);
    // Intake and output
    let r = await s.call('POST', '/api/nursing/io', { patient: p.id, item: 'oral', mL: 150 }, nurse);
    assert.equal(r.status, 201, r.text);
    r = await s.call('POST', '/api/nursing/io', { patient: p.id, item: 'urine', mL: 400 }, nurse);
    assert.equal(r.status, 201, r.text);
    r = await s.call('POST', '/api/nursing/io', { patient: p.id, item: 'coffee', mL: 1 }, nurse);
    assert.equal(r.status, 422);
    r = await s.call('GET', `/api/nursing/io?patient=${p.id}`, undefined, nurse);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.currentShift.in, r.json.currentShift.out, r.json.sinceAdmission.balance], [150, 400, -250]);
    assert.equal(r.json.entries.length, 2);
    // Orders to acknowledge
    const o = (await s.call('POST', '/fhir/R4/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, code: { coding: [{ system: LOINC, code: '58410-2', display: 'CBC' }], text: 'CBC' }, category: [{ coding: [{ code: 'laboratory' }] }], authoredOn: clock.now() }, doc)).json;
    let list = (await s.call('GET', `/api/nursing/worklist?patient=${p.id}`, undefined, nurse)).json.patients[0];
    assert.ok(list.items.some((i) => i.kind === 'acknowledge' && i.ref === `ServiceRequest/${o.id}`));
    assert.ok(list.items.some((i) => i.kind === 'specimen'));
    r = await s.call('POST', `/api/nursing/orders/${o.id}/acknowledge`, {}, nurse);
    assert.equal(r.status, 200, r.text);
    list = (await s.call('GET', `/api/nursing/worklist?patient=${p.id}`, undefined, nurse)).json.patients[0];
    assert.ok(!list.items.some((i) => i.kind === 'acknowledge'));
    // Unit work list
    const unit = (await s.call('GET', '/api/nursing/worklist?unit=Medical', undefined, nurse)).json;
    assert.equal(unit.patients.length, 1);
    assert.equal(unit.patients[0].patient.id, p.id);
    assert.equal((await s.call('GET', '/api/nursing/worklist?unit=Surgical', undefined, nurse)).json.patients.length, 0);
    // Education
    r = await s.call('POST', '/api/nursing/education', { patient: p.id, topic: 'Medication use', to: 'Patient', method: 'Teach-back', understanding: 'Verbalised understanding', followUp: true }, nurse);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.category.coding[0].code, 'education');
    r = await s.call('POST', '/api/nursing/education', { patient: p.id, topic: 'Diet' }, nurse);
    assert.equal(r.status, 422);
    // Care plan and goals
    const goal = (await s.call('POST', '/fhir/R4/Goal', { resourceType: 'Goal', lifecycleStatus: 'active', description: { text: 'Mobilise to chair twice daily' }, subject: { reference: `Patient/${p.id}` }, target: [{ dueDate: '2026-05-03' }] }, nurse));
    assert.equal(goal.status, 201, goal.text);
    const plan = (await s.call('POST', '/fhir/R4/CarePlan', { resourceType: 'CarePlan', status: 'active', intent: 'plan', subject: { reference: `Patient/${p.id}` }, title: 'Post-operative nursing plan', goal: [{ reference: `Goal/${goal.json.id}` }], activity: [{ detail: { status: 'in-progress', description: 'Assist with mobilisation' } }] }, nurse));
    assert.equal(plan.status, 201, plan.text);
    r = await s.call('POST', `/api/nursing/careplans/${plan.json.id}/evaluate`, { text: 'Sat out in chair for 30 minutes, tolerated well' }, nurse);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.note.length, 1);
    r = await s.call('POST', `/fhir/R4/Goal/${goal.json.id}/$transition`, { to: 'completed' }, nurse);
    assert.equal(r.status, 200, r.text);
    r = await s.call('POST', `/fhir/R4/Goal/${goal.json.id}/$transition`, { to: 'active' }, nurse);
    assert.equal(r.status, 422, 'a completed goal is terminal');
    // Role rules: a researcher may read but not write; a scheduler may not record I/O
    r = await s.call('GET', `/api/nursing/io?patient=${p.id}`, undefined, { 'X-Role': 'researcher' });
    assert.equal(r.status, 200);
    r = await s.call('POST', '/api/nursing/io', { patient: p.id, item: 'oral', mL: 10 }, { 'X-Role': 'patient' });
    assert.equal(r.status, 403);
    const refusals = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'role.refuse');
    assert.ok(refusals.length >= 1);
    // Time travel: the I/O totals as of before the entries are empty
    r = await s.call('GET', `/api/nursing/io?patient=${p.id}&_asOf=2026-05-01T15:59:00.000Z`, undefined, nurse);
    assert.equal(r.status, 404, 'the patient did not exist yet at that time');
  } finally { await s.close(); }
});
