import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, lab, BACKEND } from './support/helpers.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const LOINC = 'http://loinc.org';
const DUP = 'urn:hospital-desktop:duplicate-override-reason';
const ALLERGY = 'urn:hospital-desktop:allergy-override-reason';
const medication = (pid, code, display, extension) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${pid}` },
  medicationCodeableConcept: { coding: [{ system: RX, code, display }] }, ...(extension ? { extension } : {}),
});
const order = (pid, extension) => ({
  resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${pid}` },
  code: { coding: [{ system: LOINC, code: '24323-8', display: 'CMP' }] }, ...(extension ? { extension } : {}),
});
const allergy = (pid, code, display, extra = {}) => ({
  resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${pid}` },
  clinicalStatus: { coding: [{ code: 'active' }] }, type: 'allergy', category: ['medication'], criticality: 'high',
  code: { coding: [{ system: RX, code, display }] },
  reaction: [{ manifestation: [{ coding: [{ system: 'http://snomed.info/sct', code: '39579001', display: 'Anaphylaxis' }] }], severity: 'severe' }],
  ...extra,
});
const alertCodes = (r) => r.json.issue.map((i) => i.details?.coding?.[0]?.code);

async function setup() {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient())).json;
  return { s, p };
}

test(`[${BACKEND}] duplicate order: blocked with the existing order date; override needs a typed reason and is audited`, async () => {
  const { s, p } = await setup();
  const first = (await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id))).json;
  const dup = await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id));
  assert.equal(dup.status, 409);
  assert.deepEqual(alertCodes(dup), ['duplicate-order']);
  assert.match(dup.json.issue[0].diagnostics, /already active.*ordered \d{4}-\d{2}-\d{2}/);
  assert.equal(dup.json.issue[0].extension.find((e) => e.url === 'existing').valueReference.reference, `ServiceRequest/${first.id}`);
  assert.equal((await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, [{ url: DUP, valueString: ' ' }]))).status, 409, 'an empty reason is not a reason');

  const ok = await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, [{ url: DUP, valueString: 'repeat after haemolysed sample' }]));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.extension.find((e) => e.url === DUP).valueString, 'repeat after haemolysed sample');
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  const override = steps.find((t) => t.did.type === 'safety.override');
  assert.equal(override.did.args.alert, 'duplicate-order');
  assert.equal(override.why, 'repeat after haemolysed sample');
  const audits = (await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.map((e) => e.resource.outcomeDesc);
  assert.ok(audits.some((d) => /safety override \(duplicate-order\)/.test(d)));

  await s.call('POST', `/fhir/R4/ServiceRequest/${first.id}/$transition`, { to: 'revoked', reason: 'test' });
  await s.call('POST', `/fhir/R4/ServiceRequest/${ok.json.id}/$transition`, { to: 'revoked', reason: 'test' });
  assert.equal((await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id))).status, 201, 'no alert once earlier orders are closed');
  await s.close();
});

test(`[${BACKEND}] allergy conflict: same substance and same class are blocked; override reason is stored and audited`, async () => {
  const { s, p } = await setup();
  await s.call('POST', '/fhir/R4/AllergyIntolerance', allergy(p.id, '7984', 'Penicillin V'));
  const same = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '7984', 'Penicillin V'));
  assert.equal(same.status, 409);
  assert.deepEqual(alertCodes(same), ['allergy-conflict']);
  assert.match(same.json.issue[0].diagnostics, /high-criticality allergy to Penicillin V.*Anaphylaxis.*same substance/);
  const cls = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '723', 'Amoxicillin'));
  assert.equal(cls.status, 409);
  assert.match(cls.json.issue[0].diagnostics, /same class \(penicillins\)/);
  assert.equal((await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '29046', 'Lisinopril'))).status, 201, 'unrelated drug is fine');
  assert.equal((await s.call('GET', `/fhir/R4/MedicationRequest?patient=${p.id}`)).json.total, 1, 'blocked orders were not written');

  const ok = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '723', 'Amoxicillin', [{ url: ALLERGY, valueString: 'tolerated amoxicillin in 2024, allergy entry disputed' }]));
  assert.equal(ok.status, 201);
  assert.match(ok.json.extension.find((e) => e.url === ALLERGY).valueString, /tolerated/);
  const override = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.find((t) => t.did.type === 'safety.override');
  assert.equal(override.did.args.alert, 'allergy-conflict');
  assert.ok((await s.call('GET', '/fhir/R4/AuditEvent')).json.entry.some((e) => /safety override \(allergy-conflict\)/.test(e.resource.outcomeDesc)));
  await s.close();
});

test(`[${BACKEND}] duplicate and allergy alerts are reported together; inactive allergies do not fire`, async () => {
  const { s, p } = await setup();
  const a = (await s.call('POST', '/fhir/R4/AllergyIntolerance', allergy(p.id, '5640', 'Ibuprofen'))).json;
  await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '7258', 'Naproxen', [{ url: ALLERGY, valueString: 'benefit outweighs risk' }]));
  const both = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '7258', 'Naproxen'));
  assert.equal(both.status, 409);
  assert.deepEqual(alertCodes(both).sort(), ['allergy-conflict', 'duplicate-order']);
  const partial = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '7258', 'Naproxen', [{ url: DUP, valueString: 'second course' }]));
  assert.deepEqual(alertCodes(partial), ['allergy-conflict'], 'each alert needs its own override');

  await s.call('PUT', `/fhir/R4/AllergyIntolerance/${a.id}`, { ...a, clinicalStatus: { coding: [{ code: 'inactive' }] } });
  const after = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '5640', 'Ibuprofen'));
  assert.equal(after.status, 201);
  await s.close();
});

test(`[${BACKEND}] safety checks apply to agents on a branch exactly as to humans`, async () => {
  const { s, p } = await setup();
  await s.call('POST', '/fhir/R4/AllergyIntolerance', allergy(p.id, '7984', 'Penicillin V'));
  await s.call('POST', '/agent-ops/agents', { id: 'test-agent', name: 'Test agent', version: '1.0', scopes: [{ type: 'MedicationRequest', interactions: ['create'] }], adapter: { kind: 'stub', stub: 'report-drafter' } });
  const run = (await s.call('POST', '/agent-ops/runs', { mode: 'sandbox', agentId: 'test-agent' })).json;
  const agent = { 'X-Agent-Id': 'test-agent', 'X-Run-Id': run.id, 'Idempotency-Key': 'allergy-check-1' };
  const blocked = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '723', 'Amoxicillin'), agent);
  assert.equal(blocked.status, 409);
  assert.deepEqual(alertCodes(blocked), ['allergy-conflict']);
  await s.close();
});

test(`[${BACKEND}] critical result: flagged HH, badge until acknowledged, release blocked until acknowledged`, async () => {
  const { s, p } = await setup();
  const k = { code: { coding: [{ system: LOINC, code: '2823-3', display: 'Potassium' }] } };
  const r = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 6.9, { ...k, valueQuantity: { value: 6.9, unit: 'mmol/L' } }))).json;
  assert.equal(r.interpretation[0].coding[0].code, 'HH');
  assert.ok(r.meta.tag.some((t) => t.code === 'critical-unacknowledged'));
  let badges = (await s.call('GET', '/api/badges')).json;
  assert.equal(badges.criticalUnacknowledged.length, 1);
  assert.equal(badges.criticalUnacknowledged[0].flag, 'HH');

  assert.equal((await s.call('POST', `/fhir/R4/Observation/${r.id}/$release`, {})).status, 409, 'not final yet');
  await s.call('POST', `/fhir/R4/Observation/${r.id}/$transition`, { to: 'final' });
  const blocked = await s.call('POST', `/fhir/R4/Observation/${r.id}/$release`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.issue[0].details.coding[0].code, 'critical-unacknowledged');
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_released=true`)).json.total, 0);

  const ack = await s.call('POST', `/fhir/R4/Observation/${r.id}/$acknowledge`, { comment: 'called the ward' });
  assert.ok(ack.json.meta.tag.some((t) => t.code === 'acknowledged'));
  badges = (await s.call('GET', '/api/badges')).json;
  assert.equal(badges.criticalUnacknowledged.length, 0);
  const released = await s.call('POST', `/fhir/R4/Observation/${r.id}/$release`, {});
  assert.equal(released.status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/Observation?patient=${p.id}&_released=true&status=final`)).json.total, 1);

  const current = (await s.call('GET', `/fhir/R4/Observation/${r.id}`)).json;
  const corrected = (await s.call('PUT', `/fhir/R4/Observation/${r.id}`, { ...current, status: 'corrected', valueQuantity: { value: 7.4, unit: 'mmol/L' } })).json;
  assert.ok(corrected.meta.tag.some((t) => t.code === 'critical-unacknowledged'), 'a corrected critical value needs a fresh acknowledgment');
  const normal = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 1.0))).json;
  assert.equal((await s.call('POST', `/fhir/R4/Observation/${normal.id}/$acknowledge`, {})).status, 409);
  const actions = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.map((t) => t.did.type);
  assert.ok(actions.includes('result.acknowledge') && actions.includes('portal.release'));
  await s.close();
});

test(`[${BACKEND}] unsigned notes are counted until signed; hide removes a note from the portal`, async () => {
  const { s, p } = await setup();
  const n = (await s.call('POST', '/fhir/R4/DocumentReference', {
    resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${p.id}` },
    type: { coding: [{ system: LOINC, code: '11506-3', display: 'Progress note' }] }, content: [{ attachment: { contentType: 'text/plain', data: 'bm90ZQ==' } }],
  })).json;
  assert.equal((await s.call('GET', '/api/badges')).json.unsignedNotes.length, 1);
  assert.equal((await s.call('POST', `/fhir/R4/DocumentReference/${n.id}/$release`, {})).status, 409, 'drafts cannot be released');
  await s.call('POST', `/fhir/R4/DocumentReference/${n.id}/$transition`, { to: 'final' });
  assert.equal((await s.call('GET', '/api/badges')).json.unsignedNotes.length, 0);
  await s.call('POST', `/fhir/R4/DocumentReference/${n.id}/$release`, {});
  assert.equal((await s.call('GET', `/fhir/R4/DocumentReference?patient=${p.id}&_released=true&docstatus=final`)).json.total, 1);
  await s.call('POST', `/fhir/R4/DocumentReference/${n.id}/$release`, { released: false });
  assert.equal((await s.call('GET', `/fhir/R4/DocumentReference?patient=${p.id}&_released=true`)).json.total, 0);
  await s.close();
});

test(`[${BACKEND}] friction: advisories are off at low, rule-based at realistic, frequent at high; safety alerts ignore friction`, async () => {
  const { s, p } = await setup();
  const get = async (context) => (await s.call('GET', `/api/advisories?patient=${p.id}&context=${context}`)).json;
  assert.equal((await s.call('GET', '/api/friction')).json.friction, 'low', 'outside a session friction is low');
  for (const c of ['chart-open', 'prescribe']) assert.deepEqual((await get(c)).advisories, [], 'no advisory pop-ups by default');

  await s.call('PUT', '/api/friction', { level: 'low' });
  for (const c of ['chart-open', 'prescribe', 'order', 'sign-note']) assert.deepEqual((await get(c)).advisories, []);

  await s.call('PUT', '/api/friction', { level: 'high' });
  const high = await get('prescribe');
  assert.deepEqual(high.advisories.map((a) => a.id).sort(), ['allergies-not-documented', 'formulary-notice', 'renal-function']);
  assert.deepEqual(await get('prescribe'), high, 'deterministic for the same chart state');

  await s.call('PUT', '/api/friction', { level: 'realistic' });
  const realistic = (await get('prescribe')).advisories;
  assert.ok(realistic.length <= 1);
  assert.ok(realistic.every((a) => ['allergies-not-documented', 'renal-function'].includes(a.id)), 'no generic advisories at realistic');
  assert.equal((await s.call('PUT', '/api/friction', { level: 'none' })).status, 422);

  const enact = await s.call('POST', '/api/advisories/respond', { id: 'renal-function', choice: 'enact', patient: p.id });
  assert.match(enact.json.task, /^Task\//);
  await s.call('POST', '/api/advisories/respond', { id: 'formulary-notice', choice: 'ignore', patient: p.id });
  const responses = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((t) => t.did.type === 'advisory.respond');
  assert.deepEqual(responses.map((t) => t.did.args.choice), ['enact', 'ignore']);
  assert.equal((await s.call('GET', `/fhir/R4/Task?patient=${p.id}`)).json.total, 1);

  await s.call('PUT', '/api/friction', { level: 'low' });
  await s.call('POST', '/fhir/R4/AllergyIntolerance', allergy(p.id, '7984', 'Penicillin V'));
  assert.equal((await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, '723', 'Amoxicillin'))).status, 409, 'allergy check still fires at low friction');
  await s.close();
});
