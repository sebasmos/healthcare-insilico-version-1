// The MAR: a dose cannot be given before pharmacy verification,
// the five rights are checked on the server, the late window, the witness
// for high-alert drugs, PRN follow-up, not-given reasons, the allergy
// recheck, entered-in-error by the recorder only, and agents never administer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { dueTimes, cellState, sectionOf, shiftWindow } from '../ehr/server/nursing.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LIFECYCLE = 'urn:hospital-desktop:lifecycle';
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const rph = { 'X-Role': 'nurse', 'X-User-Id': 'rph-one-a' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const order = (pid, code, display, { frequency = 'TID', dose = 500, unit = 'mg', route = 'oral' } = {}) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority: 'routine', subject: { reference: `Patient/${pid}` }, requester: { display: 'Dr One' },
  medicationCodeableConcept: { coding: [{ system: RX, code, display }], text: display }, extension: [{ url: LIFECYCLE, valueCode: 'pending-verification' }],
  dosageInstruction: [{ text: `${dose} ${unit} ${route} ${frequency}`, timing: { code: { text: frequency } }, route: { text: route }, doseAndRate: [{ doseQuantity: { value: dose, unit } }], ...(frequency === 'PRN' ? { asNeededBoolean: true } : {}) }],
});

async function setup() {
  const clock = testClock('2026-05-01T16:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Marcase'))).json;
  const mrn = p.identifier.find((i) => i.type?.coding?.some((c) => c.code === 'MR')).value;
  const place = async (code, display, options) => { const r = await s.call('POST', '/fhir/R4/MedicationRequest', order(p.id, code, display, options), doc); assert.equal(r.status, 201, r.text); return r.json; };
  const verify = async (o) => { const r = await s.call('POST', `/api/pharmacy/orders/${o.id}/decision`, { decision: 'verify', reasoning: 'Checked against allergies and renal function' }, rph); assert.equal(r.status, 200, r.text); return r.json; };
  const give = (o, body, headers = nurse) => s.call('POST', '/api/nursing/mar/administer', { order: o.id, patientScan: mrn, medicationScan: o.medicationCodeableConcept.coding[0].code, outcome: 'given', dose: 500, unit: 'mg', route: 'oral', due: clock.now(), ...body }, headers);
  return { s, p, mrn, clock, place, verify, give };
}

test('due times follow the frequency schedule inside the window; once is due at its authored time; PRN and infusions have no scheduled cells', () => {
  const window = shiftWindow(new Date('2026-05-01T16:00:00.000Z'));
  const tid = { id: 'a', authoredOn: '2026-04-30T00:00:00.000Z', dosageInstruction: [{ timing: { code: { text: 'TID' } } }] };
  const dues = dueTimes(tid, window.start, window.end);
  assert.ok(dues.length >= 1 && dues.length <= 3, `TID gives between one and three dues in a 12 hour shift (${dues.length})`);
  for (const d of dues) assert.ok(d >= window.start && d < window.end);
  const once = { id: 'b', authoredOn: '2026-05-01T16:30:00.000Z', dosageInstruction: [{ timing: { code: { text: 'once' } } }] };
  assert.deepEqual(dueTimes(once, '2026-05-01T16:00:00.000Z', '2026-05-02T04:00:00.000Z'), ['2026-05-01T16:30:00.000Z']);
  assert.equal(sectionOf({ dosageInstruction: [{ timing: { code: { text: 'PRN' } }, asNeededBoolean: true }] }), 'prn');
  assert.equal(sectionOf({ dosageInstruction: [{ text: 'Heparin infusion', doseAndRate: [{ rateQuantity: { value: 18 } }] }] }), 'continuous');
  assert.deepEqual(dueTimes({ dosageInstruction: [{ timing: { code: { text: 'PRN' } }, asNeededBoolean: true }] }, window.start, window.end), []);
});

test('cell state: due, missed after the late window, given, late, held, refused and not given', () => {
  const o = { id: 'o1' };
  const due = '2026-05-01T16:00:00.000Z';
  const admin = (status, extra = {}) => ({ request: { reference: 'MedicationRequest/o1' }, status, _recordedAt: '2026-05-01T16:05:00.000Z', ...extra, extension: [{ url: 'urn:hospital-desktop:due-time', valueString: due }, ...(extra.extension || [])] });
  assert.equal(cellState(o, due, [], '2026-05-01T16:30:00.000Z').state, 'due');
  assert.equal(cellState(o, due, [], '2026-05-01T17:01:00.000Z').state, 'missed');
  assert.equal(cellState(o, due, [admin('completed')], '2026-05-01T18:00:00.000Z').state, 'given');
  assert.equal(cellState(o, due, [admin('completed', { extension: [{ url: 'urn:hospital-desktop:late-minutes', valueString: '75' }] })], '2026-05-01T18:00:00.000Z').state, 'late');
  assert.equal(cellState(o, due, [admin('on-hold')], '2026-05-01T18:00:00.000Z').state, 'held');
  assert.equal(cellState(o, due, [admin('not-done', { statusReason: [{ text: 'refused: patient declined' }] })], '2026-05-01T18:00:00.000Z').state, 'refused');
  assert.equal(cellState(o, due, [admin('not-done', { statusReason: [{ text: 'not-given: nil by mouth' }] })], '2026-05-01T18:00:00.000Z').state, 'not-given');
  assert.equal(cellState(o, due, [admin('entered-in-error')], '2026-05-01T18:00:00.000Z').state, 'missed', 'an erroneous record does not count');
});

test(`[${BACKEND}] a medication cannot be given until pharmacy has verified it; once verified a correct scan is recorded as completed`, async () => {
  const { s, p, place, verify, give } = await setup();
  try {
    const o = await place('723', 'Amoxicillin');
    let r = await give(o, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not been verified/);
    await verify(o);
    r = await give(o, {});
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.administration.status, 'completed');
    assert.equal(r.json.administration.dosage.dose.value, 500);
    const grid = (await s.call('GET', `/api/nursing/mar?patient=${p.id}`, undefined, nurse)).json;
    const row = grid.rows.find((x) => x.id === o.id);
    assert.equal(row.verified, true);
    assert.equal(row.givenThisShift.length, 1);
    const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'mar.given');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].who.role, 'nurse');
  } finally { await s.close(); }
});

test(`[${BACKEND}] five rights: a wrong patient, medication, dose, route or time is refused with what failed; a typed reason overrides and is logged`, async () => {
  const { s, place, verify, give, clock } = await setup();
  try {
    const o = await verify(await place('723', 'Amoxicillin')) && (await s.call('GET', '/fhir/R4/MedicationRequest')).json.entry[0].resource;
    let r = await give(o, { patientScan: 'N999999' });
    assert.equal(r.status, 409);
    assert.equal(r.json.issues[0].details.coding[0].code, 'patient');
    r = await give(o, { medicationScan: '7984' });
    assert.equal(r.json.issues[0].details.coding[0].code, 'medication');
    r = await give(o, { dose: 250 });
    assert.equal(r.json.issues[0].details.coding[0].code, 'dose');
    r = await give(o, { route: 'intravenous' });
    assert.equal(r.json.issues[0].details.coding[0].code, 'route');
    r = await give(o, { due: new Date(Date.parse(clock.now()) - 3 * 3600000).toISOString() });
    assert.equal(r.json.issues[0].details.coding[0].code, 'time');
    r = await give(o, { dose: 250, override: 'Pharmacy advised half dose by phone' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.overrides, ['dose']);
    const overrides = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'safety.override');
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].did.args.alert, 'five-rights:dose');
    assert.equal(overrides[0].why, 'Pharmacy advised half dose by phone');
  } finally { await s.close(); }
});

test(`[${BACKEND}] late window: a dose given more than 60 minutes after it was due is recorded as late`, async () => {
  const { s, p, place, verify, give, clock } = await setup();
  try {
    const o = await place('723', 'Amoxicillin'); await verify(o);
    const due = clock.now();
    clock.advance(50 * 60000);
    const r = await give(o, { due, override: 'late' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.late, false, 'inside the window: on time');
    clock.advance(30 * 60000);
    const later = await give(o, { due: new Date(Date.parse(clock.now()) - 80 * 60000).toISOString(), override: 'Patient was off the ward for imaging' });
    assert.equal(later.status, 201, later.text);
    assert.equal(later.json.late, true);
    const grid = (await s.call('GET', `/api/nursing/mar?patient=${p.id}`, undefined, nurse)).json;
    assert.ok(grid.rows.find((x) => x.id === o.id).givenThisShift.length >= 1);
  } finally { await s.close(); }
});

test(`[${BACKEND}] high-alert medications need a witness who is a different person`, async () => {
  const { s, place, verify, give } = await setup();
  try {
    const o = await place('5224', 'Heparin', { dose: 5000, unit: 'units', route: 'subcutaneous' }); await verify(o);
    const body = { dose: 5000, unit: 'units', route: 'subcutaneous' };
    let r = await give(o, body);
    assert.equal(r.status, 422);
    assert.match(r.json.error, /high-alert/);
    r = await give(o, { ...body, witness: 'rn-one' });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /different person/);
    r = await give(o, { ...body, witness: 'rn-two' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.administration.performer[1].actor.display, 'rn-two');
  } finally { await s.close(); }
});

test(`[${BACKEND}] PRN: a reason is required and a follow-up assessment task is created; held, refused and not given need reasons`, async () => {
  const { s, p, place, verify, give } = await setup();
  try {
    const prn = await place('7052', 'Morphine', { frequency: 'PRN', dose: 2, unit: 'mg', route: 'intravenous' }); await verify(prn);
    const body = { dose: 2, unit: 'mg', route: 'intravenous', witness: 'rn-two', due: undefined };
    let r = await give(prn, body);
    assert.equal(r.status, 422);
    assert.match(r.json.error, /PRN/);
    r = await give(prn, { ...body, prnReason: 'Pain 7 of 10' });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.followUp, /^Task\//);
    const task = (await s.call('GET', `/fhir/R4/${r.json.followUp}`)).json;
    assert.equal(task.code.coding[0].code, 'prn-follow-up');
    const o = await place('723', 'Amoxicillin'); await verify(o);
    for (const outcome of ['held', 'refused', 'not-given']) {
      r = await give(o, { outcome });
      assert.equal(r.status, 422, `${outcome} without a reason`);
      r = await give(o, { outcome, reason: 'Nil by mouth before surgery' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.administration.status, outcome === 'held' ? 'on-hold' : 'not-done');
    }
    const list = (await s.call('GET', `/api/nursing/worklist?patient=${p.id}`, undefined, nurse)).json.patients[0];
    assert.ok(list.items.some((i) => i.kind === 'assessment'), 'the PRN follow-up is on the work list');
  } finally { await s.close(); }
});

test(`[${BACKEND}] allergy conflict is rechecked at administration and needs an override`, async () => {
  const { s, p, place, verify, give } = await setup();
  try {
    const o = await place('723', 'Amoxicillin'); await verify(o);
    const a = await s.call('POST', '/fhir/R4/AllergyIntolerance', { resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, criticality: 'high', code: { coding: [{ system: RX, code: '723', display: 'Amoxicillin' }] }, reaction: [{ manifestation: [{ coding: [{ display: 'Anaphylaxis' }] }] }] }, doc);
    assert.equal(a.status, 201, a.text);
    let r = await give(o, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.issues[0].details.coding[0].code, 'allergy');
    r = await give(o, { override: 'Desensitised, physician at bedside' });
    assert.equal(r.status, 201, r.text);
    const overrides = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'safety.override');
    assert.equal(overrides[overrides.length - 1].did.args.alert, 'allergy-at-administration');
  } finally { await s.close(); }
});

test(`[${BACKEND}] entered-in-error only by the recorder with a reason; agents and physicians never administer`, async () => {
  const { s, place, verify, give } = await setup();
  try {
    const o = await place('723', 'Amoxicillin'); await verify(o);
    const given = (await give(o, {})).json.administration;
    let r = await s.call('POST', `/api/nursing/mar/${given.id}/error`, { reason: 'Wrong patient chart open' }, { 'X-Role': 'nurse', 'X-User-Id': 'rn-other' });
    assert.equal(r.status, 403);
    r = await s.call('POST', `/api/nursing/mar/${given.id}/error`, {}, nurse);
    assert.equal(r.status, 422);
    r = await s.call('POST', `/api/nursing/mar/${given.id}/error`, { reason: 'Wrong patient chart open' }, nurse);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'entered-in-error');
    r = await give(o, {}, { 'X-Role': 'patient', 'X-User-Id': 'pt-one' });
    assert.equal(r.status, 403, 'a patient does not administer (staff roles all may)');
    const agentTry = await s.call('POST', '/fhir/R4/MedicationAdministration', { resourceType: 'MedicationAdministration', status: 'completed', subject: { reference: given.subject.reference }, medicationCodeableConcept: given.medicationCodeableConcept }, { 'X-Agent-Id': 'report-drafter', 'X-Run-Id': 'live' });
    assert.equal(agentTry.status, 403);
  } finally { await s.close(); }
});
