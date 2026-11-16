// Dispensing: the MedicationDispense machine, the dispense queue,
// lot and expiry, the controlled-drug second checker, label data and the ward view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LIFECYCLE = 'urn:hospital-desktop:lifecycle';
const rph = { 'X-Role': 'nurse', 'X-User-Id': 'rph-one-a' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const ext = (r, url) => (r.extension || []).find((e) => e.url === url)?.valueString;
const med = (pid, code, display, { priority = 'routine', dose = 5, unit = 'mg', route = 'oral', frequency = 'Q6H', encounter = null } = {}) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority, subject: { reference: `Patient/${pid}` }, requester: { display: 'Dr One' }, ...(encounter ? { encounter: { reference: `Encounter/${encounter}` } } : {}),
  medicationCodeableConcept: { coding: [{ system: RX, code, display }] }, extension: [{ url: LIFECYCLE, valueCode: 'pending-verification' }],
  dosageInstruction: [{ text: `${dose} ${unit} ${route} ${frequency}`, timing: { code: { text: frequency } }, route: { text: route }, doseAndRate: [{ doseQuantity: { value: dose, unit } }] }],
});

async function setup() {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Ward', { name: [{ family: 'Ward', given: ['Test'] }] }))).json;
  // An inpatient on a named unit.
  const enc = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP', display: 'inpatient' }, subject: { reference: `Patient/${p.id}` }, location: [{ location: { display: 'Ward 3B' }, status: 'active' }] })).json;
  const verified = async (code, display, options = {}) => {
    const o = (await s.call('POST', '/fhir/R4/MedicationRequest', med(p.id, code, display, { encounter: enc.id, ...options }), doc)).json;
    const v = await s.call('POST', `/api/pharmacy/orders/${o.id}/decision`, { decision: 'verify', reasoning: 'checked' }, rph);
    assert.equal(v.status, 200, v.text);
    return v.json.order;
  };
  const move = (id, to, reason, headers = rph) => s.call('POST', `/fhir/R4/MedicationDispense/${id}/$transition`, { to, reason }, headers);
  return { s, p, enc, clock, verified, move };
}

test(`[${BACKEND}] machine: preparation → in-progress → completed; on-hold, cancelled, declined, stopped and entered-in-error per FHIR R4; reasons required`, async () => {
  const { s, p, verified, move } = await setup();
  const o = await verified('161', 'Acetaminophen', { dose: 650 });
  const body = { resourceType: 'MedicationDispense', status: 'preparation', subject: { reference: `Patient/${p.id}` }, medicationCodeableConcept: o.medicationCodeableConcept, authorizingPrescription: [{ reference: `MedicationRequest/${o.id}` }] };
  assert.equal((await s.call('POST', '/fhir/R4/MedicationDispense', { ...body, status: 'completed' }, rph)).status, 422, 'cannot be created completed');
  assert.equal((await s.call('POST', '/fhir/R4/MedicationDispense', { ...body, medicationCodeableConcept: undefined }, rph)).status, 422, 'medication is required');
  const d = (await s.call('POST', '/fhir/R4/MedicationDispense', body, rph)).json;
  assert.equal(d.status, 'preparation');
  assert.equal((await move(d.id, 'stopped', 'x')).status, 422, 'stopped only from in progress');
  assert.equal((await move(d.id, 'cancelled')).status, 422, 'reason required');
  assert.equal((await move(d.id, 'in-progress')).json.status, 'in-progress');
  assert.equal((await move(d.id, 'on-hold')).json.status, 'on-hold');
  assert.equal((await move(d.id, 'in-progress')).json.status, 'in-progress');
  assert.equal((await move(d.id, 'completed')).json.status, 'completed');
  assert.equal((await move(d.id, 'in-progress')).status, 422, 'completed is final except entered-in-error');
  assert.equal((await move(d.id, 'entered-in-error')).status, 422);
  assert.equal((await move(d.id, 'entered-in-error', 'wrong patient label')).json.status, 'entered-in-error');
  for (const [to, from] of [['declined', 'preparation'], ['cancelled', 'preparation'], ['stopped', 'in-progress']]) {
    const x = (await s.call('POST', '/fhir/R4/MedicationDispense', { ...body, status: from }, rph)).json;
    assert.equal((await move(x.id, to)).status, 422, `${to} needs a reason`);
    assert.equal((await move(x.id, to, 'test')).json.status, to);
  }
  assert.equal((await s.call('POST', '/fhir/R4/MedicationDispense', body, { 'X-Role': 'patient', 'X-User-Id': 'pt-one' })).status, 403, 'a patient does not dispense (staff roles all may)');
  assert.equal((await s.call('POST', '/fhir/R4/MedicationDispense', body, { 'X-Role': 'janitor' })).status, 403, 'an unknown role does not dispense');
  await s.close();
});

test(`[${BACKEND}] dispense queue and fill: only verified inpatient orders, lot and expiry recorded, label data, one dispense per order`, async () => {
  const { s, p, clock, verified } = await setup();
  const waiting = (await s.call('POST', '/fhir/R4/MedicationRequest', med(p.id, '6809', 'Metformin'), doc)).json;
  const outpatient = (await s.call('POST', '/fhir/R4/Patient', patient('Clinic'))).json;
  const outOrder = (await s.call('POST', '/fhir/R4/MedicationRequest', med(outpatient.id, '83367', 'Atorvastatin', { frequency: 'nightly' }), doc)).json;
  assert.equal((await s.call('POST', `/api/pharmacy/orders/${outOrder.id}/decision`, { decision: 'verify', reasoning: 'checked' }, rph)).status, 200);
  const o = await verified('161', 'Acetaminophen', { dose: 650 });
  let q = (await s.call('GET', '/api/pharmacy/dispense', undefined, rph)).json;
  assert.deepEqual(q.toFill.map((r) => r.id), [o.id], 'the waiting order and the outpatient order are not listed');
  assert.deepEqual([q.toFill[0].patient.unit, q.toFill[0].verified.by, q.toFill[0].controlled], ['Ward 3B', 'rph-one-a', false]);
  assert.deepEqual((await s.call('GET', '/api/pharmacy/dispense?setting=all', undefined, rph)).json.toFill.map((r) => r.id).sort(), [o.id, outOrder.id].sort());
  assert.equal((await s.call('POST', '/api/pharmacy/dispense', { orderId: waiting.id }, rph)).status, 409, 'not verified');
  const started = await s.call('POST', '/api/pharmacy/dispense', { orderId: o.id, quantity: 20, daysSupply: 5, lot: 'L-2201' }, rph);
  assert.equal(started.status, 201, started.text);
  const d = started.json;
  assert.deepEqual([d.status, d.quantity.value, d.daysSupply.value, ext(d, 'urn:hospital-desktop:lot'), d.performer[0].actor.display, d.authorizingPrescription[0].reference, d.context.reference], ['preparation', 20, 5, 'L-2201', 'rph-one-a', `MedicationRequest/${o.id}`, `Encounter/${d.context.reference.split('/')[1]}`]);
  assert.equal((await s.call('POST', '/api/pharmacy/dispense', { orderId: o.id }, rph)).status, 409, 'one open dispense per order');
  q = (await s.call('GET', '/api/pharmacy/dispense', undefined, rph)).json;
  assert.deepEqual([q.toFill.length, q.inProgress.map((r) => r.id)], [0, [d.id]]);
  const complete = (body) => s.call('POST', `/api/pharmacy/dispenses/${d.id}/complete`, body, rph);
  assert.equal((await complete({})).status, 422, 'expiry required');
  assert.equal((await complete({ expiry: 'soon' })).status, 422);
  assert.equal((await complete({ expiry: '2026-04' })).status, 422, 'an expired lot is not dispensed');
  clock.advance(60000);
  const done = await complete({ expiry: '2027-03', quantity: 20, checkedBy: 'rph-two-b' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.status, ext(done.json, 'urn:hospital-desktop:expiry'), ext(done.json, 'urn:hospital-desktop:checked-by'), done.json.whenHandedOver], ['completed', '2027-03', 'rph-two-b', clock.now()]);
  const history = (await s.call('GET', `/fhir/R4/MedicationDispense/${d.id}/_history`)).json.entry.map((e) => e.resource.status);
  assert.deepEqual(history, ['completed', 'in-progress', 'preparation']);
  const label = (await s.call('GET', `/api/pharmacy/dispenses/${d.id}/label`, undefined, rph)).json;
  assert.deepEqual([label.patient.name, label.patient.mrn !== null, label.medication, label.dose, label.route, label.frequency, label.routeText, label.frequencyText, label.lot, label.expiry, label.filledBy, label.checkedBy, label.printed], [`Patient ${label.patient.mrn}`, true, 'Acetaminophen', { value: 650, unit: 'mg' }, 'oral', 'Q6H', 'by mouth', 'every 6 hours', 'L-2201', '2027-03', 'rph-one-a', 'rph-two-b', false]);
  q = (await s.call('GET', '/api/pharmacy/dispense', undefined, rph)).json;
  assert.deepEqual([q.inProgress.length, q.recent.map((r) => r.id)], [0, [d.id]]);
  const actions = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
  for (const a of ['pharmacy.dispense', 'pharmacy.dispense.fill', 'pharmacy.dispense.complete']) assert.ok(actions.includes(a), a);
  await s.close();
});

test(`[${BACKEND}] controlled drugs need a second checker, a different person from the filler, before completion`, async () => {
  const { s, p, verified, move } = await setup();
  const o = await verified('7052', 'Morphine', { dose: 2, route: 'intravenous', frequency: 'Q4H', priority: 'stat' });
  assert.equal((await s.call('GET', '/api/pharmacy/dispense', undefined, rph)).json.toFill[0].controlled, true);
  const d = (await s.call('POST', '/api/pharmacy/dispense', { orderId: o.id, lot: 'M-9', expiry: '2027-01' }, rph)).json;
  const complete = (body) => s.call('POST', `/api/pharmacy/dispenses/${d.id}/complete`, body, rph);
  const none = await complete({});
  assert.equal(none.status, 422);
  assert.match(none.json.error, /second checker/);
  const same = await complete({ checkedBy: 'rph-one-a' });
  assert.equal(same.status, 422);
  assert.match(same.json.error, /different person/);
  assert.equal((await s.call('GET', `/fhir/R4/MedicationDispense/${d.id}`)).json.status, 'preparation', 'nothing moved');
  // The rule holds on the FHIR surface as well.
  const current = (await s.call('GET', `/fhir/R4/MedicationDispense/${d.id}`)).json;
  assert.equal((await move(d.id, 'completed')).status, 422);
  const viaPut = await s.call('PUT', `/fhir/R4/MedicationDispense/${d.id}`, { ...current, status: 'completed', extension: [...current.extension, { url: 'urn:hospital-desktop:checked-by', valueString: 'RPH-ONE-A' }] }, rph);
  assert.equal(viaPut.status, 422, 'case does not make a different person');
  const ok = await complete({ checkedBy: 'rph-two-b' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'completed');
  // A plain tablet needs no checker.
  const t = await verified('161', 'Acetaminophen', { dose: 650 });
  const d2 = (await s.call('POST', '/api/pharmacy/dispense', { orderId: t.id }, rph)).json;
  assert.equal((await s.call('POST', `/api/pharmacy/dispenses/${d2.id}/complete`, { lot: 'A1', expiry: '2027-01' }, rph)).json.status, 'completed');
  await s.close();
});

test(`[${BACKEND}] ward view: completed dispenses grouped by the patient's unit, "not yet given" until the MAR records administrations`, async () => {
  const { s, p, verified } = await setup();
  const other = (await s.call('POST', '/fhir/R4/Patient', patient('Unitless'))).json;
  await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'in-progress', class: { code: 'IMP' }, subject: { reference: `Patient/${other.id}` } });
  const fill = async (order) => {
    const d = (await s.call('POST', '/api/pharmacy/dispense', { orderId: order.id, lot: 'L1', expiry: '2027-01' }, rph)).json;
    assert.equal((await s.call('POST', `/api/pharmacy/dispenses/${d.id}/complete`, { checkedBy: 'rph-two-b' }, rph)).status, 200);
    return d;
  };
  const a = await fill(await verified('161', 'Acetaminophen', { dose: 650 }));
  const b = await fill(await verified('26225', 'Ondansetron', { dose: 4, frequency: 'Q8H' }));
  const o2 = (await s.call('POST', '/fhir/R4/MedicationRequest', med(other.id, '6809', 'Metformin', { frequency: 'BID' }), doc)).json;
  const v2 = await s.call('POST', `/api/pharmacy/orders/${o2.id}/decision`, { decision: 'verify', reasoning: 'checked' }, rph);
  assert.equal(v2.status, 200, v2.text + JSON.stringify(o2));
  const c = await fill(o2);
  const pending = (await s.call('POST', '/api/pharmacy/dispense', { orderId: (await verified('4603', 'Furosemide', { dose: 40, frequency: 'daily' })).id }, rph)).json;
  const w = (await s.call('GET', '/api/pharmacy/wards', undefined, rph)).json;
  assert.deepEqual(w.units.map((u) => [u.unit, u.count]), [['Ward 3B', 2], ['No unit assigned', 1]]);
  assert.deepEqual(w.units[0].rows.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.deepEqual([w.units[1].rows[0].id, w.units[1].rows[0].patient.name], [c.id, `Patient ${w.units[1].rows[0].patient.mrn}`]);
  assert.ok(w.units.every((u) => u.rows.every((r) => r.given === false)), 'nothing is marked given until the MAR exists');
  assert.ok(!w.units.some((u) => u.rows.some((r) => r.id === pending.id)), 'a dispense still in preparation is not on the ward');
  assert.equal(w.total, 3);
  await s.close();
});
