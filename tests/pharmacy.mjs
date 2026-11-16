// Pharmacy verification: lifecycle and migration, the queue, the
// review lock, the review payload and its automatic checks, each decision,
// the query round trip, metrics, the emergency override and the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, testClock, patient, BACKEND } from './support/helpers.mjs';
import { migrateVerified, isVerified, emergencyOverride, verificationState, egfrCkdEpi2021 } from '../pharmacy/server/pharmacy.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';
const LIFECYCLE = 'urn:hospital-desktop:lifecycle';
const rph = { 'X-Role': 'nurse', 'X-User-Id': 'rph-one-a' };
const doc = { 'X-Role': 'physician', 'X-User-Id': 'dr-one' };
const nurse = { 'X-Role': 'nurse', 'X-User-Id': 'rn-one' };
const pt = { 'X-Role': 'patient', 'X-User-Id': 'pt-one' };
const ext = (r, url) => (r.extension || []).find((e) => e.url === url);
const lifecycle = (r) => ext(r, LIFECYCLE)?.valueCode;
const med = (pid, code, display, { priority = 'routine', dose = 500, unit = 'mg', route = 'oral', frequency = 'TID', state = 'pending-verification', extra = {} } = {}) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', priority, subject: { reference: `Patient/${pid}` }, requester: { display: 'Dr One' },
  medicationCodeableConcept: { coding: [{ system: RX, code, display }] }, extension: [{ url: LIFECYCLE, valueCode: state }, ...(extra.extension || [])],
  dosageInstruction: [{ text: `${dose} ${unit} ${route} ${frequency}`, timing: { code: { text: frequency } }, route: { text: route }, doseAndRate: [{ doseQuantity: { value: dose, unit } }] }],
});
const obs = (pid, code, display, value, unit, category = 'laboratory', status = 'final') => ({
  resourceType: 'Observation', status, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: category }] }],
  code: { coding: [{ system: LOINC, code, display }] }, subject: { reference: `Patient/${pid}` }, effectiveDateTime: '2026-05-01T08:00:00Z', valueQuantity: { value, unit },
});
const steps = async (s, type) => (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => !type || t.did.type === type);

async function setup() {
  const clock = testClock('2026-05-01T09:00:00.000Z');
  const s = await startTestServer({ clock });
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Pharm', { gender: 'female', birthDate: '1966-05-01' }))).json;
  const order = async (code, display, options, headers = doc) => { const r = await s.call('POST', '/fhir/R4/MedicationRequest', med(p.id, code, display, options), headers); assert.equal(r.status, 201, r.text); return r.json; };
  const decide = (id, body, headers = rph) => s.call('POST', `/api/pharmacy/orders/${id}/decision`, body, headers);
  const review = async (id, headers = rph) => { const r = await s.call('GET', `/api/pharmacy/orders/${id}/review`, undefined, headers); assert.equal(r.status, 200, r.text); return r.json; };
  const queue = async (which = 'all', headers = rph) => (await s.call('GET', `/api/pharmacy/queue?queue=${which}`, undefined, headers)).json;
  return { s, p, clock, order, decide, review, queue };
}

test('eGFR: CKD-EPI 2021 without a race term; missing inputs give null', () => {
  assert.equal(egfrCkdEpi2021({ creatinine: 1.0, age: 60, sex: 'female' }), 64);
  assert.equal(egfrCkdEpi2021({ creatinine: 1.0, age: 60, sex: 'male' }), 86);
  assert.equal(egfrCkdEpi2021({ creatinine: 2.0, age: 70, sex: 'male' }), 35);
  assert.equal(egfrCkdEpi2021({ creatinine: 0.6, age: 25, sex: 'female' }), 128);
  assert.equal(egfrCkdEpi2021({ creatinine: null, age: 60, sex: 'female' }), null);
  assert.equal(egfrCkdEpi2021({ creatinine: 1.0, age: null, sex: 'female' }), null);
});

test(`[${BACKEND}] lifecycle: created straight into pending-verification; a pre-existing active order is migrated as verified once`, async () => {
  const { s, p, order } = await setup();
  const o = await order('723', 'Amoxicillin');
  assert.equal(lifecycle(o), 'pending-verification');
  assert.equal(o.status, 'draft');
  assert.equal(verificationState(o), 'awaiting');
  assert.ok(!isVerified(o));
  // An order that was active before verification existed (written straight into the store, as an import or an older build would).
  await s.store.save('MedicationRequest', { resourceType: 'MedicationRequest', id: 'legacy-1', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, medicationCodeableConcept: { coding: [{ system: RX, code: '6809', display: 'Metformin' }] } }, { updatedBy: 'test' });
  assert.equal(await migrateVerified(s.store), 1);
  const migrated = (await s.call('GET', '/fhir/R4/MedicationRequest/legacy-1')).json;
  assert.ok(isVerified(migrated));
  assert.match(ext(migrated, 'urn:hospital-desktop:verified').valueString, /^migrated: active before pharmacy verification existed$/);
  assert.equal(lifecycle(o), 'pending-verification', 'the waiting order is untouched');
  const log = await steps(s, 'pharmacy.migrate');
  assert.equal(log.length, 1);
  assert.equal(log[0].did.args.count, 1);
  assert.equal(await migrateVerified(s.store), 0, 'nothing left to migrate');
  assert.equal((await steps(s, 'pharmacy.migrate')).length, 1, 'no step when there was nothing to do');
  assert.equal((await s.call('GET', '/fhir/R4/MedicationRequest/legacy-1/_history')).json.entry.length, 2);
  await s.close();
});

test(`[${BACKEND}] queue: overrides first, then STAT, then by age; turnaround targets flag "over target"; my queue hides orders locked by others; lock and take-over`, async () => {
  const { s, p, clock, order, queue } = await setup();
  const routineOld = await order('161', 'Acetaminophen', { priority: 'routine', dose: 650, frequency: 'Q6H' });
  clock.advance(10 * 60000);
  const stat = await order('7052', 'Morphine', { priority: 'stat', dose: 2, route: 'intravenous', frequency: 'Q4H' });
  clock.advance(5 * 60000);
  const urgent = await order('2193', 'Ceftriaxone', { priority: 'urgent', dose: 1, unit: 'g', route: 'intravenous', frequency: 'daily' });
  clock.advance(5 * 60000);
  const routineNew = await order('6809', 'Metformin', { priority: 'routine', frequency: 'BID' });
  let q = await queue('all');
  assert.deepEqual(q.rows.map((r) => r.id), [stat.id, urgent.id, routineOld.id, routineNew.id]);
  const row = q.rows[0];
  assert.deepEqual([row.patient.name, row.patient.mrn !== null, row.patient.unit, row.medication, row.dose, row.route, row.frequency, row.prescriber, row.priority], [`Patient ${row.patient.mrn}`, true, 'No unit assigned', 'Morphine', { value: 2, unit: 'mg' }, 'intravenous', 'Q4H', 'Dr One', 'stat']);
  assert.deepEqual([row.ageMinutes, row.targetMinutes, row.overTarget], [10, 15, false]);
  assert.deepEqual(q.rows.map((r) => r.overTarget), [false, false, false, false]);
  clock.advance(50 * 60000);
  q = await queue('all');
  assert.deepEqual(q.rows.map((r) => [r.ageMinutes, r.overTarget]), [[60, true], [55, true], [70, true], [50, false]], 'STAT over 15 min, urgent over 30, routine over 60');

  // Opening locks the order to this pharmacist; another pharmacist sees it only in "All" until they take it over.
  const open = await s.call('POST', `/api/pharmacy/orders/${stat.id}/open`, {}, rph);
  assert.equal(open.status, 200, open.text);
  assert.equal(open.json.lock.by, 'rph-one-a');
  const other = { 'X-Role': 'nurse', 'X-User-Id': 'rph-two-b' };
  const busy = await s.call('POST', `/api/pharmacy/orders/${stat.id}/open`, {}, other);
  assert.equal(busy.status, 423);
  assert.equal(busy.json.lock.by, 'rph-one-a');
  assert.ok(!(await queue('my', other)).rows.some((r) => r.id === stat.id), 'hidden from the other pharmacist\'s queue');
  assert.ok((await queue('my', rph)).rows.some((r) => r.id === stat.id));
  assert.equal((await queue('all', other)).rows.find((r) => r.id === stat.id).lock.by, 'rph-one-a');
  const taken = await s.call('POST', `/api/pharmacy/orders/${stat.id}/open`, { force: true }, other);
  assert.equal(taken.status, 200);
  assert.equal(taken.json.lock.by, 'rph-two-b');
  assert.equal((await steps(s, 'pharmacy.open')).at(-1).did.args.tookOver, 'rph-one-a');
  assert.equal((await s.call('POST', `/api/pharmacy/orders/${stat.id}/close`, {}, other)).json.lock, null);
  // A read-only role opens without a lock.
  const ro = await s.call('POST', `/api/pharmacy/orders/${stat.id}/open`, {}, { 'X-Role': 'patient' });
  assert.deepEqual([ro.status, ro.json.readOnly, ro.json.lock], [200, true, null]);
  assert.equal((await s.call('GET', `/fhir/R4/MedicationRequest/${stat.id}`)).json._lock, undefined, 'the lock is never in the FHIR response');
  await s.close();
});

test(`[${BACKEND}] review: allergies, current medications, weight, creatinine with eGFR, potassium, INR and glucose beside the order`, async () => {
  const { s, p, order, review } = await setup();
  await s.call('POST', '/fhir/R4/AllergyIntolerance', { resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: RX, code: '7984', display: 'Penicillin V' }] }, criticality: 'high' });
  for (const [code, name, value, unit, cat] of [['29463-7', 'Body weight', 80, 'kg', 'vital-signs'], ['2160-0', 'Creatinine', 1.0, 'mg/dL', 'laboratory'], ['2823-3', 'Potassium', 5.4, 'mmol/L', 'laboratory'], ['6301-6', 'INR', 2.5, '{ratio}', 'laboratory'], ['2345-7', 'Glucose', 140, 'mg/dL', 'laboratory']]) {
    const r = await s.call('POST', '/fhir/R4/Observation', obs(p.id, code, name, value, unit, cat, cat === 'laboratory' ? 'preliminary' : 'final'));
    assert.equal(r.status, 201, r.text);
  }
  const active = await order('29046', 'Lisinopril', { dose: 10, frequency: 'daily' });
  await s.call('POST', `/api/pharmacy/orders/${active.id}/decision`, { decision: 'verify', reasoning: 'fine' }, rph);
  const o = await order('4603', 'Furosemide', { dose: 40, frequency: 'daily' });
  const r = await review(o.id);
  assert.equal(r.order.id, o.id);
  assert.equal(r.state, 'awaiting');
  assert.equal(r.patient.name, `Patient ${r.patient.mrn}`);
  assert.equal(r.age, 60);
  assert.equal(r.allergies.length, 1);
  assert.deepEqual(r.currentMeds.map((m) => m.id), [active.id], 'this order is not its own current medication');
  assert.deepEqual([r.weight.value, r.weight.unit], [80, 'kg']);
  assert.deepEqual([r.creatinine.value, r.creatinine.status], [1.0, 'preliminary']);
  assert.deepEqual([r.egfr.value, r.egfr.unit, r.egfr.from.sex], [64, 'mL/min/1.73m2', 'female']);
  assert.match(r.egfr.formula, /estimated, unverified formula/);
  assert.deepEqual([r.labs.potassium.value, r.labs.potassium.flag, r.labs.inr.value, r.labs.glucose.value], [5.4, 'H', 2.5, 140]);
  assert.equal(r.setting, 'outpatient');
  assert.equal(r.tables.unverified, true);
  assert.deepEqual(r.issues, [], 'furosemide raises nothing in the starter tables');
  await s.close();
});

test(`[${BACKEND}] checks: allergy, duplicate therapy, drug interaction, dose range (single, daily, per kg, renal) and wrong route each become a DetectedIssue, stored once`, async () => {
  const { s, p, order, review } = await setup();
  const issues = async (o, headers) => (await review(o.id, headers)).issues;
  const codes = (list) => list.map((i) => i.code).sort();
  // Allergy: penicillin allergy, amoxicillin ordered (same class), with the override reason the prescriber typed.
  await s.call('POST', '/fhir/R4/AllergyIntolerance', { resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: RX, code: '7984', display: 'Penicillin V' }] }, criticality: 'high' });
  const amox = await order('723', 'Amoxicillin', { extra: { extension: [{ url: 'urn:hospital-desktop:allergy-override-reason', valueString: 'tolerated before' }] } });
  let found = await issues(amox);
  assert.deepEqual(codes(found), ['allergy']);
  assert.deepEqual([found[0].severity, found[0].status], ['high', 'preliminary']);
  assert.match(found[0].detail, /same class \(penicillins\)/);
  assert.ok(found[0].implicated.some((x) => x.startsWith('AllergyIntolerance/')));
  assert.equal((await issues(amox)).length, 1, 'a second review does not store the finding twice');
  const stored = (await s.call('GET', `/fhir/R4/DetectedIssue?patient=${p.id}`)).json;
  assert.equal(stored.total, 1);
  assert.deepEqual([stored.entry[0].resource.code.coding[0].system, stored.entry[0].resource.code.coding[0].code, stored.entry[0].resource.patient.reference], ['urn:hospital-desktop:detected-issue', 'allergy', `Patient/${p.id}`]);
  assert.ok((await steps(s, 'pharmacy.check')).length === 1);

  // Duplicate therapy: same class as a waiting order, plus an interaction: warfarin + aspirin, and warfarin + ibuprofen by class.
  const warfarin = await order('11289', 'Warfarin', { dose: 5, frequency: 'daily' });
  const aspirin = await order('1191', 'Aspirin', { dose: 81, frequency: 'daily' });
  found = await issues(aspirin);
  assert.deepEqual(codes(found), ['drug-interaction']);
  assert.match(found[0].detail, /Warfarin \+ Aspirin.*unverified/);
  assert.ok(found[0].implicated.includes(`MedicationRequest/${warfarin.id}`));
  const ibuprofen = await order('5640', 'Ibuprofen', { dose: 400, frequency: 'TID', extra: {} });
  found = await issues(ibuprofen);
  assert.deepEqual(codes(found), ['drug-interaction', 'duplicate-therapy'], 'NSAID class: duplicate of aspirin, interaction with warfarin by class');
  assert.match(found.find((i) => i.code === 'duplicate-therapy').detail, /same class: nsaids/);
  const sameDrug = await order('5640', 'Ibuprofen', { dose: 400, frequency: 'TID', extra: { extension: [{ url: 'urn:hospital-desktop:duplicate-override-reason', valueString: 'second course' }] } });
  assert.equal((await issues(sameDrug)).find((i) => i.code === 'duplicate-therapy' && i.severity === 'high').detail.includes('same drug'), true);

  // Dose range: single and daily maxima, per kg with a weight, renal with a creatinine.
  const big = await order('161', 'Acetaminophen', { dose: 1500, frequency: 'Q4H' });
  found = await issues(big);
  assert.deepEqual(codes(found), ['dose-range', 'dose-range']);
  assert.ok(found.some((i) => /above the starter-table maximum single dose of 1000 mg/.test(i.detail)));
  assert.ok(found.some((i) => /Daily dose 9000 mg/.test(i.detail)));
  const grams = await order('2193', 'Ceftriaxone', { dose: 3, unit: 'g', route: 'intravenous', frequency: 'daily' });
  assert.match((await issues(grams))[0].detail, /Dose 3000 mg is above/, 'grams are converted');
  await s.call('POST', '/fhir/R4/Observation', obs(p.id, '29463-7', 'Body weight', 50, 'kg', 'vital-signs'));
  assert.equal((await s.call('POST', '/fhir/R4/Observation', obs(p.id, '2160-0', 'Creatinine', 2.5, 'mg/dL', 'laboratory', 'preliminary'))).status, 201);
  const vanc = await order('11124', 'Vancomycin', { dose: 1500, route: 'intravenous', frequency: 'BID' });
  found = await issues(vanc);
  assert.ok(found.some((i) => /30 mg\/kg at 50 kg/.test(i.detail)), JSON.stringify(found));
  assert.ok(found.some((i) => /estimated eGFR 21 is below 50/.test(i.detail)), JSON.stringify(found));
  // Wrong route: a tablet given intravenously.
  const route = await order('83367', 'Atorvastatin', { dose: 40, route: 'intravenous', frequency: 'nightly' });
  found = await issues(route);
  assert.deepEqual(codes(found), ['wrong-route']);
  assert.match(found[0].detail, /not valid for the tablet form/);
  // A role that may not create DetectedIssues still sees the findings, unsaved.
  const seen = await issues(route, nurse);
  assert.equal(seen.length, 1);
  assert.equal((await s.call('GET', `/fhir/R4/DetectedIssue?patient=${p.id}`)).json.entry.filter((e) => e.resource.implicated.some((x) => x.reference === `MedicationRequest/${route.id}`)).length, 1);
  await s.close();
});

test(`[${BACKEND}] decisions: verify, verify with a change (prescriber notice), reject (reason, notice), query round trip; checks closed with the outcome; everything logged with the reasoning`, async () => {
  const { s, p, clock, order, decide, review } = await setup();
  const get = async (id) => (await s.call('GET', `/fhir/R4/MedicationRequest/${id}`)).json;
  assert.equal((await decide('nope', { decision: 'verify', reasoning: 'x y z' })).status, 404);
  const a = await order('29046', 'Lisinopril', { dose: 10, frequency: 'daily' });
  assert.equal((await decide(a.id, { decision: 'approve', reasoning: 'checked' })).status, 422);
  assert.equal((await decide(a.id, { decision: 'verify', reasoning: 'ok' })).status, 422, 'reasoning must be at least 3 characters');
  await s.call('POST', `/api/pharmacy/orders/${a.id}/open`, {}, rph);
  clock.advance(7 * 60000);
  const v = await decide(a.id, { decision: 'verify', reasoning: 'dose, renal function and interactions reviewed' });
  assert.equal(v.status, 200, v.text);
  assert.deepEqual([v.json.state, v.json.minutes, v.json.order.status], ['verified', 7, 'active']);
  const verified = await get(a.id);
  assert.ok(isVerified(verified));
  assert.equal(ext(verified, 'urn:hospital-desktop:verified').valueString, `rph-one-a at ${clock.now()}`);
  assert.equal(ext(verified, 'urn:hospital-desktop:verification-note').valueString, 'dose, renal function and interactions reviewed');
  assert.equal(verified._lock, undefined);
  assert.equal((await s.call('GET', '/api/pharmacy/queue?queue=all', undefined, rph)).json.rows.length, 0, 'the lock was released and the order left the queue');
  assert.equal((await decide(a.id, { decision: 'verify', reasoning: 'again' })).status, 409, 'already decided');
  let step = (await steps(s, 'pharmacy.verify'))[0];
  assert.deepEqual([step.why, step.did.args.priority, step.did.args.minutes, step.did.args.withinTarget, step.who.id], ['dose, renal function and interactions reviewed', 'routine', 7, true, 'rph-one-a']);
  assert.ok(step.auditEvent);

  // Verify with a change: the order's dose changes, the prescriber gets a Task in the Inbox.
  const b = await order('161', 'Acetaminophen', { dose: 1500, frequency: 'Q6H' });
  assert.equal((await review(b.id)).issues.length, 2, 'two dose-range findings');
  assert.equal((await decide(b.id, { decision: 'verify-with-change', reasoning: 'above maximum', change: {} })).status, 422);
  const vc = await decide(b.id, { decision: 'verify-with-change', reasoning: 'single dose reduced to the maximum', change: { dose: 1000 } });
  assert.equal(vc.status, 200, vc.text);
  const changed = await get(b.id);
  assert.deepEqual([changed.status, changed.dosageInstruction[0].doseAndRate[0].doseQuantity.value, changed.dosageInstruction[0].text], ['active', 1000, '1000 mg by mouth every 6 hours']);
  assert.ok(isVerified(changed));
  const notice = (await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.map((e) => e.resource).find((t) => t.code.coding[0].code === 'prescriber-notice');
  assert.deepEqual([notice.owner.display, notice.focus.reference, notice.status], ['Dr One', `MedicationRequest/${b.id}`, 'requested']);
  assert.match(notice.description, /verified with change \(dose 1000\)/);
  const closed = (await s.call('GET', `/fhir/R4/DetectedIssue?patient=${p.id}`)).json.entry.map((e) => e.resource).filter((i) => i.implicated.some((x) => x.reference === `MedicationRequest/${b.id}`));
  assert.deepEqual(closed.map((i) => i.status), ['final', 'final']);
  assert.match(closed[0].mitigation[0].action.text, /^verify-with-change: single dose reduced/);
  assert.equal(closed[0].mitigation[0].author.display, 'rph-one-a');
  assert.deepEqual((await steps(s, 'pharmacy.verify-change'))[0].did.args.change, { dose: 1000 });

  // Reject: the order is rejected with the reason, a notice goes to the prescriber.
  const c = await order('36567', 'Simvastatin', { dose: 20, frequency: 'nightly' });
  assert.equal((await decide(c.id, { decision: 'reject', reasoning: 'not indicated' })).status, 422, 'a reason is required');
  const rj = await decide(c.id, { decision: 'reject', reasoning: 'patient already on atorvastatin at home', reason: 'duplicate statin' });
  assert.equal(rj.status, 200, rj.text);
  const rejected = await get(c.id);
  assert.deepEqual([lifecycle(rejected), rejected.status, ext(rejected, 'urn:hospital-desktop:status-reason').valueString, verificationState(rejected)], ['rejected', 'cancelled', 'duplicate statin', 'rejected']);
  assert.ok(!isVerified(rejected));
  assert.equal((await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.entry.filter((e) => e.resource.code.coding[0].code === 'prescriber-notice').length, 2);
  assert.equal((await steps(s, 'pharmacy.reject'))[0].did.args.reason, 'duplicate statin');

  // Query: the order waits with the question; the prescriber answers; the flag clears; then verification.
  const d = await order('8591', 'Potassium chloride', { dose: 20, unit: 'mEq', frequency: 'daily' });
  assert.equal((await decide(d.id, { decision: 'query', reasoning: 'need the indication' })).status, 422, 'a message is required');
  const q = await decide(d.id, { decision: 'query', reasoning: 'potassium is 5.4', message: 'Potassium was 5.4 this morning. Do you still want this?' });
  assert.equal(q.status, 200, q.text);
  assert.equal(q.json.state, 'queried');
  assert.deepEqual([q.json.communication.topic.text, q.json.communication.sender.display, q.json.communication.recipient[0].display], [`MedicationRequest/${d.id}`, 'rph-one-a', 'Dr One']);
  let waiting = await get(d.id);
  assert.equal(lifecycle(waiting), 'pending-verification');
  assert.equal(ext(waiting, 'urn:hospital-desktop:queried').valueString, 'Potassium was 5.4 this morning. Do you still want this?');
  const qrow = (await s.call('GET', '/api/pharmacy/queue?queue=all', undefined, rph)).json.rows.find((r) => r.id === d.id);
  assert.deepEqual([qrow.state, qrow.queried], ['queried', 'Potassium was 5.4 this morning. Do you still want this?']);
  assert.equal((await decide(d.id, { decision: 'query', reasoning: 'again', message: 'second question' })).status, 409, 'one open question at a time');
  assert.equal((await s.call('POST', `/api/pharmacy/orders/${d.id}/answer`, { message: 'Yes, repeat potassium first.' }, { 'X-Role': 'patient', 'X-User-Id': 'pt-one' })).status, 403, 'a patient does not answer a pharmacy query');
  const ans = await s.call('POST', `/api/pharmacy/orders/${d.id}/answer`, { message: 'Yes, repeat potassium first.' }, doc);
  assert.equal(ans.status, 200, ans.text);
  assert.equal(ans.json.reply.inResponseTo[0].reference, `Communication/${q.json.communication.id}`);
  waiting = await get(d.id);
  assert.equal(ext(waiting, 'urn:hospital-desktop:queried'), undefined, 'answered');
  assert.equal(verificationState(waiting), 'awaiting');
  assert.equal((await s.call('POST', `/api/pharmacy/orders/${d.id}/answer`, { message: 'again' }, doc)).status, 409);
  const thread = (await review(d.id)).thread;
  assert.deepEqual(thread.map((c) => c.category[0].coding[0].code), ['pharmacy-query', 'pharmacy-answer']);
  assert.equal((await decide(d.id, { decision: 'verify', reasoning: 'prescriber confirmed, repeat potassium ordered' })).status, 200);
  const actions = (await steps(s)).map((t) => t.did.type);
  for (const a of ['pharmacy.open', 'pharmacy.verify', 'pharmacy.verify-change', 'pharmacy.reject', 'pharmacy.query', 'pharmacy.answer', 'pharmacy.check', 'pharmacy.check.close', 'pharmacy.notice']) assert.ok(actions.includes(a), a);
  assert.equal((await steps(s, 'pharmacy.answer'))[0].why, 'Yes, repeat potassium first.');
  await s.close();
});

test(`[${BACKEND}] metrics: verified today, mean turnaround by priority, share within target, interventions`, async () => {
  const { s, clock, order, decide } = await setup();
  const stat = await order('7052', 'Morphine', { priority: 'stat', dose: 2, route: 'intravenous', frequency: 'Q4H' });
  const routine = await order('161', 'Acetaminophen', { dose: 650, frequency: 'Q6H' });
  const slow = await order('6809', 'Metformin', { frequency: 'BID' });
  const bad = await order('36567', 'Simvastatin', { dose: 20, frequency: 'nightly' });
  const ask = await order('29046', 'Lisinopril', { dose: 10, frequency: 'daily' });
  clock.advance(10 * 60000);
  assert.equal((await decide(stat.id, { decision: 'verify', reasoning: 'stat reviewed' })).status, 200);
  clock.advance(20 * 60000);
  assert.equal((await decide(routine.id, { decision: 'verify-with-change', reasoning: 'rounded', change: { dose: 500 } })).status, 200);
  clock.advance(60 * 60000);
  assert.equal((await decide(slow.id, { decision: 'verify', reasoning: 'late but fine' })).status, 200);
  assert.equal((await decide(bad.id, { decision: 'reject', reasoning: 'duplicate', reason: 'duplicate statin' })).status, 200);
  assert.equal((await decide(ask.id, { decision: 'query', reasoning: 'why', message: 'Indication?' })).status, 200);
  const m = (await s.call('GET', '/api/pharmacy/metrics', undefined, rph)).json.metrics;
  assert.equal(m.verifiedToday, 3);
  assert.deepEqual(m.byPriority.stat, { count: 1, meanMinutes: 10, target: 15 });
  assert.deepEqual(m.byPriority.routine, { count: 2, meanMinutes: 60, target: 60 }, '30 and 90 minutes');
  assert.deepEqual(m.byPriority.urgent, { count: 0, meanMinutes: null, target: 30 });
  assert.equal(m.withinTargetPercent, 67);
  assert.deepEqual(m.interventions, { changed: 1, rejected: 1, queried: 1, total: 3 });
  assert.deepEqual((await s.call('GET', '/api/pharmacy/queue?queue=all', undefined, rph)).json.metrics.verifiedToday, 3, 'the queue carries the same strip');
  await s.close();
});

test(`[${BACKEND}] emergency override: a nurse may give a STAT dose before verification with a logged reason; routine orders and patients are refused; the order stays in the queue at the top`, async () => {
  const { s, order, queue, decide } = await setup();
  const routine = await order('161', 'Acetaminophen', { dose: 650, frequency: 'Q6H' });
  const stat = await order('7052', 'Morphine', { priority: 'stat', dose: 2, route: 'intravenous', frequency: 'Q4H' });
  const first = await order('2193', 'Ceftriaxone', { priority: 'stat', dose: 1, unit: 'g', route: 'intravenous', frequency: 'daily' });
  const go = (id, body, headers = nurse) => s.call('POST', `/api/pharmacy/orders/${id}/emergency-override`, body, headers);
  assert.equal((await go(stat.id, {})).status, 422, 'reason required');
  assert.equal((await go(routine.id, { reason: 'patient in pain' })).status, 422, 'routine orders wait');
  const refused = await go(stat.id, { reason: 'chest pain' }, pt);
  assert.equal(refused.status, 403);
  assert.ok((await steps(s, 'role.refuse')).some((t) => t.who.role === 'patient'));
  const ok = await go(stat.id, { reason: 'severe pain, physician at bedside' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.override.by, ok.json.override.reason], ['rn-one (nurse)', 'severe pain, physician at bedside']);
  const o = (await s.call('GET', `/fhir/R4/MedicationRequest/${stat.id}`)).json;
  assert.equal(lifecycle(o), 'pending-verification', 'still waiting for the pharmacist');
  assert.equal(verificationState(o), 'override');
  assert.equal(emergencyOverride(o).reason, 'severe pain, physician at bedside');
  const log = (await steps(s, 'safety.override'))[0];
  assert.deepEqual([log.did.args.alert, log.why, log.who.role], ['unverified-stat', 'severe pain, physician at bedside', 'nurse']);
  assert.equal((await go(stat.id, { reason: 'again' })).status, 409, 'recorded once');
  const q = await queue('all');
  assert.equal(q.rows[0].id, stat.id, 'the overridden order is first, above the older STAT order');
  assert.equal(q.rows[1].id, first.id);
  assert.ok(q.rows[0].override);
  // A physician may record one too; the retrospective review then verifies as usual and the override stays on the record.
  const byDoc = await go(first.id, { reason: 'sepsis bundle' }, doc);
  assert.equal(byDoc.status, 200, byDoc.text);
  assert.equal((await decide(stat.id, { decision: 'verify', reasoning: 'retrospective review: appropriate' })).status, 200);
  assert.ok(emergencyOverride((await s.call('GET', `/fhir/R4/MedicationRequest/${stat.id}`)).json));
  await s.close();
});

test(`[${BACKEND}] refusals: a patient cannot verify or prescribe, an unknown role cannot verify, an agent cannot verify, dispense, close a check or move an order out of pending-verification`, async () => {
  const { s, p, order, decide } = await setup();
  const o = await order('161', 'Acetaminophen', { dose: 650, frequency: 'Q6H' });
  // Staff roles all may verify now (four roles, 2026-11-12); the refusals are the patient's and an unknown role's.
  const byPatient = await decide(o.id, { decision: 'verify', reasoning: 'looks fine' }, pt);
  assert.equal(byPatient.status, 403);
  assert.match(byPatient.json.error, /patient cannot verify a prescription/);
  assert.equal((await decide(o.id, { decision: 'query', reasoning: 'asking', message: 'why?' }, pt)).status, 403, 'a query is a verification decision too');
  const byUnknown = await decide(o.id, { decision: 'verify', reasoning: 'my own order' }, { 'X-Role': 'janitor', 'X-User-Id': 'j-1' });
  assert.equal(byUnknown.status, 403, 'an unknown role does not verify');
  const prescribe = await s.call('POST', '/fhir/R4/MedicationRequest', med(p.id, '6809', 'Metformin', {}), pt);
  assert.equal(prescribe.status, 403);
  assert.match(prescribe.json.issue[0].diagnostics, /patient cannot prescribe/);
  assert.equal((await steps(s, 'role.refuse')).length, 4);

  await s.call('POST', '/agent-ops/agents', { id: 'rx-agent', name: 'Rx agent', version: '1.0', scopes: [{ type: 'MedicationRequest', interactions: ['create', 'update'] }, { type: 'DetectedIssue', interactions: ['create', 'update'] }, { type: 'Task', interactions: ['create'] }], adapter: { kind: 'stub', stub: 'report-drafter' } });
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'rx-agent' })).json;
  let n = 0;
  const agent = () => ({ 'X-Agent-Id': 'rx-agent', 'X-Run-Id': run.id, 'Idempotency-Key': `rx-${n += 1}` });
  const direct = await s.call('POST', `/api/pharmacy/orders/${o.id}/decision`, { decision: 'verify', reasoning: 'agent says yes' }, agent());
  assert.equal(direct.status, 403);
  assert.equal(direct.json.code, 'forbidden');
  assert.equal((await s.call('POST', '/api/pharmacy/dispense', { orderId: o.id }, agent())).status, 403);
  const current = (await s.call('GET', `/fhir/R4/MedicationRequest/${o.id}?_branch=${run.branch}`, undefined, agent())).json;
  const move = await s.call('PUT', `/fhir/R4/MedicationRequest/${o.id}?_branch=${run.branch}`, { ...current, status: 'active', extension: [{ url: LIFECYCLE, valueCode: 'active' }] }, agent());
  assert.equal(move.status, 403);
  assert.match(move.json.issue[0].diagnostics, /out of pending-verification/);
  const forge = await s.call('PUT', `/fhir/R4/MedicationRequest/${o.id}?_branch=${run.branch}`, { ...current, extension: [...current.extension, { url: 'urn:hospital-desktop:verified', valueString: 'agent at now' }] }, agent());
  assert.equal(forge.status, 403);
  const dispense = await s.call('POST', `/fhir/R4/MedicationDispense?_branch=${run.branch}`, { resourceType: 'MedicationDispense', status: 'preparation', subject: { reference: `Patient/${p.id}` }, medicationCodeableConcept: current.medicationCodeableConcept, authorizingPrescription: [{ reference: `MedicationRequest/${o.id}` }] }, agent());
  assert.equal(dispense.status, 403);
  assert.match(dispense.json.issue[0].diagnostics, /may not dispense/);
  assert.equal((await s.call('POST', '/agent-ops/agents', { id: 'bad-agent', name: 'Bad', version: '1', scopes: [{ type: 'MedicationDispense', interactions: ['create'] }], adapter: { kind: 'stub', stub: 'report-drafter' } })).status, 422, 'no agent can be given dispense scope');
  const check = await s.call('POST', `/fhir/R4/DetectedIssue?_branch=${run.branch}`, { resourceType: 'DetectedIssue', status: 'preliminary', patient: { reference: `Patient/${p.id}` }, code: { coding: [{ system: 'urn:hospital-desktop:detected-issue', code: 'allergy' }] }, implicated: [{ reference: `MedicationRequest/${o.id}` }] }, agent());
  assert.equal(check.status, 201, 'an agent may record a finding');
  const close = await s.call('PUT', `/fhir/R4/DetectedIssue/${check.json.id}?_branch=${run.branch}`, { ...check.json, mitigation: [{ action: { text: 'verify' } }] }, agent());
  assert.equal(close.status, 403);
  assert.match(close.json.issue[0].diagnostics, /may not close a pharmacy check/);
  const rules = (await s.call('GET', `/agent-ops/trace?runId=${run.id}`)).json.steps.filter((t) => t.did.type === 'envelope.reject').map((t) => t.did.args.rule);
  assert.deepEqual(rules, ['out-of-scope', 'out-of-scope', 'verification', 'verification', 'dispense', 'verification']);
  assert.equal(lifecycle((await s.call('GET', `/fhir/R4/MedicationRequest/${o.id}`)).json), 'pending-verification', 'nothing changed on main');
  await s.close();
});
