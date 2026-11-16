import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, lab, BACKEND } from './support/helpers.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';
const medication = (pid, code = '29046', display = 'Lisinopril', extra = {}) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${pid}` },
  medicationCodeableConcept: { coding: [{ system: RX, code, display }] }, ...extra,
});
const order = (pid, code = '24323-8', display = 'CMP', extra = {}) => ({
  resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${pid}` },
  category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: LOINC, code, display }] }, ...extra,
});
const note = (pid, text = 'S: cough. O: clear. A: URI. P: fluids.') => ({
  resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${pid}` },
  type: { coding: [{ system: LOINC, code: '11506-3', display: 'Progress note' }] },
  content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(text).toString('base64') } }],
});
const vital = (pid, code, value, unit) => ({
  resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }],
  code: { coding: [{ system: LOINC, code }] }, subject: { reference: `Patient/${pid}` },
  effectiveDateTime: '2026-06-01T09:00:00.000Z', valueQuantity: { value, unit },
});

async function setup() {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  const move = (type, id, to, reason) => s.call('POST', `/fhir/R4/${type}/${id}/$transition`, { to, reason });
  const lifecycle = (r) => r.extension?.find((e) => e.url === 'urn:hospital-desktop:lifecycle')?.valueCode;
  return { s, p, move, lifecycle };
}

// Part A.3 restored pharmacy verification (SPEC 5a): ordered → pending-verification → active. Only the pharmacy
// decision route (tests/pharmacy.mjs) moves an order to active; here the machine itself is checked.
test(`[${BACKEND}] medication: ordered → pending-verification → (active only through pharmacy) | rejected; hold, resume, discontinue`, async () => {
  const { s, p, move, lifecycle } = await setup();
  const created = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id));
  assert.equal(created.status, 201);
  assert.equal(lifecycle(created.json), 'ordered');
  const id = created.json.id;

  assert.equal((await move('MedicationRequest', id, 'active')).status, 422, 'no longer a direct move: verification comes first');
  assert.equal((await move('MedicationRequest', id, 'on-hold')).status, 422, 'cannot hold before it is active');
  const pending = (await move('MedicationRequest', id, 'pending-verification')).json;
  assert.deepEqual([lifecycle(pending), pending.status], ['pending-verification', 'draft']);
  const unverified = await move('MedicationRequest', id, 'active');
  assert.equal(unverified.status, 422, 'a $transition cannot verify');
  assert.match(unverified.json.issue[0].diagnostics, /pharmacy verification/);
  const forged = await s.call('PUT', `/fhir/R4/MedicationRequest/${id}`, { ...pending, status: 'active', extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'active' }, { url: 'urn:hospital-desktop:verified', valueString: 'me at now' }] });
  assert.equal(forged.status, 422, 'a plain PUT cannot forge the verification record');
  assert.equal((await move('MedicationRequest', id, 'rejected')).status, 422, 'rejection needs a reason');
  const rejected = (await move('MedicationRequest', id, 'rejected', 'duplicate therapy')).json;
  assert.deepEqual([lifecycle(rejected), rejected.status], ['rejected', 'cancelled']);
  assert.equal((await move('MedicationRequest', id, 'active')).status, 422, 'terminal state');

  // Verified through the pharmacy route, then the active-order moves as before.
  const second = (await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '6809', 'Metformin', { extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'pending-verification' }] }))).json;
  assert.equal(lifecycle(second), 'pending-verification', 'an order may be created directly in pending-verification');
  const verified = await s.call('POST', `/api/pharmacy/orders/${second.id}/decision`, { decision: 'verify', reasoning: 'dose and renal function checked' }, { 'X-Role': 'nurse', 'X-User-Id': 'rph-one' });
  assert.equal(verified.status, 200, verified.text);
  const active = (await s.call('GET', `/fhir/R4/MedicationRequest/${second.id}`)).json;
  assert.deepEqual([lifecycle(active), active.status], ['active', 'active']);
  assert.match(active.extension.find((e) => e.url === 'urn:hospital-desktop:verified').valueString, /^rph-one at 20/);
  assert.equal((await move('MedicationRequest', second.id, 'on-hold')).json.status, 'on-hold');
  assert.equal((await move('MedicationRequest', second.id, 'active')).json.status, 'active');
  const noReason = await move('MedicationRequest', second.id, 'discontinued');
  assert.equal(noReason.status, 422);
  assert.match(noReason.json.issue[0].diagnostics, /reason is required/);
  const stopped = (await move('MedicationRequest', second.id, 'discontinued', 'cough')).json;
  assert.deepEqual([lifecycle(stopped), stopped.status], ['discontinued', 'stopped']);
  assert.equal(stopped.extension.find((e) => e.url === 'urn:hospital-desktop:status-reason').valueString, 'cough');
  assert.ok(stopped.extension.some((e) => e.url === 'urn:hospital-desktop:verified'), 'the verification record is carried through later moves');
  assert.equal((await move('MedicationRequest', second.id, 'active')).status, 422, 'terminal state');

  const direct = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '4603', 'Furosemide', { status: 'active' }));
  assert.equal(direct.status, 422, 'cannot be created already active');
  const put = await s.call('PUT', `/fhir/R4/MedicationRequest/${second.id}`, { ...stopped, status: 'active', extension: [] });
  assert.equal(put.status, 422, 'a plain PUT cannot bypass the machine');
  assert.equal((await s.call('GET', `/fhir/R4/MedicationRequest/${second.id}/_history`)).json.entry.length, 5);
  await s.close();
});

test(`[${BACKEND}] order and result: prelim → final sign-off completes the order; cancel is revoked with a reason`, async () => {
  const { s, p, move, lifecycle } = await setup();
  const o = (await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id))).json;
  const basedOn = [{ reference: `ServiceRequest/${o.id}` }];
  assert.equal((await s.call('POST', '/fhir/R4/Observation', lab(p.id, 1.0, { status: 'final', basedOn }))).status, 422, 'a lab cannot be created final');
  const r1 = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 1.0, { basedOn }))).json;
  const r2 = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 4.2, { basedOn, code: { coding: [{ system: LOINC, code: '2823-3' }] } }))).json;
  assert.equal(r1.interpretation[0].coding[0].code, 'N');
  assert.equal(r1.referenceRange[0].high.value, 1.3);

  await move('Observation', r1.id, 'final');
  assert.equal(lifecycle((await s.call('GET', `/fhir/R4/ServiceRequest/${o.id}`)).json), 'active', 'still waiting for the second result');
  await move('Observation', r2.id, 'final');
  const done = (await s.call('GET', `/fhir/R4/ServiceRequest/${o.id}`)).json;
  assert.deepEqual([lifecycle(done), done.status], ['completed', 'completed']);
  const versions = (await s.call('GET', `/fhir/R4/ServiceRequest/${o.id}/_history`)).json.entry.map((e) => lifecycle(e.resource));
  assert.deepEqual(versions, ['completed', 'results-received', 'active']);

  const silent = await s.call('PUT', `/fhir/R4/Observation/${r1.id}`, { ...(await s.call('GET', `/fhir/R4/Observation/${r1.id}`)).json, valueQuantity: { value: 9, unit: 'mg/dL' } });
  assert.equal(silent.status, 422, 'a final value cannot change silently');
  const current = (await s.call('GET', `/fhir/R4/Observation/${r1.id}`)).json;
  const corrected = await s.call('PUT', `/fhir/R4/Observation/${r1.id}`, { ...current, status: 'corrected', valueQuantity: { value: 1.2, unit: 'mg/dL' } });
  assert.equal(corrected.status, 200);
  const history = (await s.call('GET', `/fhir/R4/Observation/${r1.id}/_history`)).json.entry.map((e) => [e.resource.status, e.resource.valueQuantity.value]);
  assert.deepEqual(history, [['corrected', 1.2], ['final', 1], ['preliminary', 1]], 'the prior version is kept');

  const o2 = (await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, '58410-2', 'CBC'))).json;
  assert.equal((await move('ServiceRequest', o2.id, 'revoked')).status, 422);
  const revoked = (await move('ServiceRequest', o2.id, 'revoked', 'ordered in error')).json;
  assert.equal(revoked.status, 'revoked');
  assert.equal((await move('ServiceRequest', o2.id, 'active')).status, 422);
  assert.equal((await move('ServiceRequest', o.id, 'revoked', 'x')).status, 422, 'a completed order cannot be revoked');
  await s.close();
});

test(`[${BACKEND}] note: draft → final → amended; a signed note cannot be edited, only addended`, async () => {
  const { s, p, move } = await setup();
  const draft = (await s.call('POST', '/fhir/R4/DocumentReference', note(p.id))).json;
  const edited = await s.call('PUT', `/fhir/R4/DocumentReference/${draft.id}`, { ...draft, content: note(p.id, 'revised draft').content });
  assert.equal(edited.status, 200, 'drafts are editable');
  const signed = (await move('DocumentReference', draft.id, 'final')).json;
  assert.equal(signed.docStatus, 'final');
  const tamper = await s.call('PUT', `/fhir/R4/DocumentReference/${draft.id}`, { ...signed, content: note(p.id, 'changed after signing').content });
  assert.equal(tamper.status, 422);
  assert.match(tamper.json.issue[0].diagnostics, /cannot be edited/);
  assert.equal((await move('DocumentReference', draft.id, 'preliminary')).status, 422);

  const addendum = (await s.call('POST', '/fhir/R4/DocumentReference', { ...note(p.id, 'Addendum: culture negative.'), relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${draft.id}` } }] })).json;
  assert.equal((await s.call('GET', `/fhir/R4/DocumentReference/${draft.id}`)).json.docStatus, 'final', 'unsigned addendum does not amend');
  await move('DocumentReference', addendum.id, 'final');
  const parent = (await s.call('GET', `/fhir/R4/DocumentReference/${draft.id}`)).json;
  assert.equal(parent.docStatus, 'amended');
  assert.equal(parent.content[0].attachment.data, signed.content[0].attachment.data, 'original text is untouched');
  assert.equal((await s.call('POST', '/fhir/R4/DocumentReference', { ...note(p.id), docStatus: 'final' })).status, 422, 'a note cannot be created already signed');
  await s.close();
});

test(`[${BACKEND}] encounter and appointment lifecycles`, async () => {
  const { s, p, move } = await setup();
  const enc = (await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'planned', class: { code: 'AMB' }, subject: { reference: `Patient/${p.id}` } })).json;
  assert.equal((await move('Encounter', enc.id, 'finished')).status, 422);
  for (const to of ['arrived', 'in-progress', 'finished']) assert.equal((await move('Encounter', enc.id, to)).json.status, to);
  assert.equal((await move('Encounter', enc.id, 'cancelled')).status, 422);
  assert.equal((await s.call('POST', '/fhir/R4/Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${p.id}` } })).status, 422);

  const appt = (await s.call('POST', '/fhir/R4/Appointment', { resourceType: 'Appointment', status: 'booked', start: '2026-07-01T09:00:00Z', end: '2026-07-01T09:30:00Z', participant: [{ actor: { reference: `Patient/${p.id}` }, status: 'accepted' }] })).json;
  assert.equal((await move('Appointment', appt.id, 'fulfilled')).status, 422);
  assert.equal((await move('Appointment', appt.id, 'arrived')).json.status, 'arrived');
  assert.equal((await move('Appointment', appt.id, 'fulfilled')).json.status, 'fulfilled');
  assert.equal((await s.call('GET', `/fhir/R4/Appointment?patient=${p.id}`)).json.total, 1, 'appointments are indexed by patient');
  await s.close();
});

test(`[${BACKEND}] every transition writes an AuditEvent and a TraceStep with from and to`, async () => {
  const { s, p, move } = await setup();
  const m = (await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id))).json;
  await move('MedicationRequest', m.id, 'pending-verification');
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  const step = steps.at(-1);
  assert.equal(step.did.type, 'fhir.transition');
  assert.deepEqual([step.did.args.from, step.did.args.to], ['ordered', 'pending-verification']);
  assert.deepEqual(step.saw.resources, [{ ref: `MedicationRequest/${m.id}`, versionId: '1' }]);
  const audits = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry;
  assert.match(audits.at(-1).resource.outcomeDesc, /ordered → pending-verification/);
  await s.close();
});

test(`[${BACKEND}] patient registration: MRN is generated as N plus six digits and duplicates are refused`, async () => {
  const { s, p } = await setup();
  const mrn = (pt) => pt.identifier.find((i) => i.type.coding[0].code === 'MR').value;
  assert.match(mrn(p), /^N\d{6}$/);
  const second = (await s.call('POST', '/fhir/R4/Patient', patient('Second'))).json;
  assert.equal(Number(mrn(second).slice(1)), Number(mrn(p).slice(1)) + 1);
  const dup = await s.call('POST', '/fhir/R4/Patient', patient('Dup', { identifier: [{ type: { coding: [{ code: 'MR' }] }, value: mrn(p) }] }));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.issue[0].details.coding[0].code, 'duplicate-mrn');
  assert.equal((await s.call('POST', '/fhir/R4/Patient', patient('Bad', { identifier: [{ type: { coding: [{ code: 'MR' }] }, value: '12345' }] }))).status, 422);
  assert.equal((await s.call('GET', `/fhir/R4/Patient?identifier=${mrn(second)}`)).json.entry[0].resource.id, second.id);
  await s.close();
});

test(`[${BACKEND}] vitals: range flags, auto-BMI, and no portal release until explicitly released`, async () => {
  const { s, p } = await setup();
  const tx = await s.call('POST', '/fhir/R4', { resourceType: 'Bundle', type: 'transaction', entry: [
    { request: { method: 'POST', url: 'Observation' }, resource: vital(p.id, '8867-4', 118, '/min') },
    { request: { method: 'POST', url: 'Observation' }, resource: vital(p.id, '29463-7', 80, 'kg') },
    { request: { method: 'POST', url: 'Observation' }, resource: vital(p.id, '8302-2', 180, 'cm') },
  ] });
  assert.equal(tx.status, 200);
  assert.equal(tx.json.entry[0].resource.interpretation[0].coding[0].code, 'H');
  const all = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&category=vital-signs`)).json.entry.map((e) => e.resource);
  const bmi = all.filter((o) => o.code.coding[0].code === '39156-5');
  assert.equal(bmi.length, 1, 'exactly one BMI for one height and weight pair');
  assert.equal(bmi[0].valueQuantity.value, 24.7);
  assert.equal(bmi[0].derivedFrom.length, 2);
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_released=true`)).json.total, 0, 'vitals are not released automatically');
  for (const o of all) assert.equal((await s.call('POST', `/fhir/R4/Observation/${o.id}/$release`, {})).status, 200);
  const released = (await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_released=true`)).json;
  assert.equal(released.total, 4, 'released vitals are visible to the portal');
  assert.ok(released.entry.every((e) => e.resource.meta.tag.some((t) => t.code === 'released')));

  const bad = await s.call('POST', '/fhir/R4', { resourceType: 'Bundle', type: 'transaction', entry: [
    { request: { method: 'POST', url: 'Observation' }, resource: vital(p.id, '9279-1', 16, '/min') },
    { request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation' } },
  ] });
  assert.equal(bad.status, 422);
  assert.match(bad.json.issue[0].diagnostics, /Entry 1/);
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}`)).json.total, 4, 'a failed transaction writes nothing');
  await s.close();
});

test(`[${BACKEND}] bed (Location): available → occupied → cleaning → available, reserved and blocked branches, reasons, and only beds have a lifecycle`, async () => {
  const { s, move, lifecycle } = await setup();
  const bd = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'bd' }] };
  const created = await s.call('POST', '/fhir/R4/Location', { resourceType: 'Location', status: 'active', name: 'Bed 1', physicalType: bd }, { 'X-Role': 'nurse' });
  assert.equal(created.status, 201, created.text);
  assert.equal(lifecycle(created.json), 'available', 'a new bed is available');
  assert.equal(created.json.operationalStatus.code, 'U');
  assert.ok(created.json.extension.some((e) => e.url === 'urn:hospital-desktop:state-since'), 'time in state is stamped');
  const id = created.json.id;
  const bad = await s.call('POST', '/fhir/R4/Location', { resourceType: 'Location', status: 'active', name: 'Bed 2', physicalType: bd, extension: [{ url: 'urn:hospital-desktop:lifecycle', valueCode: 'occupied' }] }, { 'X-Role': 'nurse' });
  assert.equal(bad.status, 422, 'a bed cannot be created occupied');
  const as = { 'X-Role': 'nurse' };
  const step = async (to, reason, status = 200) => { const r = await s.call('POST', `/fhir/R4/Location/${id}/$transition`, { to, reason }, as); assert.equal(r.status, status, `${to}: ${r.text}`); return r.json; };
  await step('cleaning', undefined, 422);
  assert.equal((await step('occupied')).operationalStatus.code, 'O');
  await step('available', undefined, 422);
  await step('reserved', undefined, 422);
  await step('blocked', 'x', 422);
  assert.equal((await step('cleaning')).operationalStatus.code, 'K');
  await step('occupied', undefined, 422);
  await step('blocked', undefined, 422);
  assert.equal((await step('blocked', 'Mattress replaced')).operationalStatus.code, 'C');
  await step('available', undefined, 422);
  await step('available', 'Mattress replaced', 422);
  await step('cleaning', 'Done', 422);
  assert.equal(lifecycle(await step('available', 'Mattress fitted')), 'available');
  await step('reserved');
  await step('blocked', 'No', 422);
  await step('available');
  await step('reserved');
  assert.equal(lifecycle(await step('occupied')), 'occupied');
  const ward = await s.call('POST', '/fhir/R4/Location', { resourceType: 'Location', status: 'active', name: 'Ward', physicalType: { coding: [{ code: 'wa' }] } }, as);
  assert.equal(ward.status, 201);
  assert.equal(ward.json.operationalStatus, undefined, 'a ward gets no bed state');
  assert.equal((await s.call('POST', `/fhir/R4/Location/${ward.json.id}/$transition`, { to: 'occupied' }, as)).status, 422, 'only beds have a lifecycle');
  await s.close();
});
