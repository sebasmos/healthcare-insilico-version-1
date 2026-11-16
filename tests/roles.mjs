// The four roles (redesign of 2026-11-12): Physician, Nurse and Researcher see
// every app with full access; the patient sees only the Portal. The detailed
// framework rules are tested under the earlier profiles in roles-detailed.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, BACKEND } from './support/helpers.mjs';
import { ROLES, PARKED_ROLES, APPS, EHR_NAV, CHART_TABS, permissionFor, mayWrite, orderModeRequired } from '../platform/server/roles.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const as = (role, user = `${role}-one`) => ({ 'X-Role': role, 'X-User-Id': user });
const STAFF = ['physician', 'nurse', 'researcher'];

test('the map: four roles plus two for the payer side; staff have every app, screen and tab with full access; the patient has only the Portal and My work in the Agent Dashboard', () => {
  assert.deepEqual(ROLES.map((r) => r.id), ['physician', 'nurse', 'researcher', 'patient', 'payer-medical-director', 'coder'], 'six roles');
  for (const id of STAFF) {
    const perm = permissionFor(id);
    assert.deepEqual([...perm.apps].sort(), [...APPS].sort(), `${id}: every app`);
    assert.deepEqual(perm.nav, EHR_NAV, `${id}: every EHR screen`);
    assert.deepEqual(perm.chartTabs, CHART_TABS, `${id}: every chart tab`);
    assert.deepEqual(perm.readOnlyTabs, [], `${id}: no read-only tabs`);
    assert.deepEqual(perm.readOnlyApps, [], `${id}: no read-only apps`);
    assert.equal(perm.readOnly, false, `${id}: not read-only`);
    assert.equal(perm.writes, '*', `${id}: full access`);
    assert.ok(perm.apps.includes(perm.landing.app), `${id}: landing is in apps`);
  }
  const pt = permissionFor('patient');
  assert.deepEqual(pt.apps, ['portal', 'agent-ops']); // the Agent Dashboard shows a patient only My work
  assert.equal(pt.landing.app, 'portal');
  assert.notEqual(pt.writes, '*', 'the patient is still restricted');
  assert.equal(permissionFor('pharmacist'), null, 'a removed role is unknown');
  assert.ok(PARKED_ROLES.some((r) => r.id === 'pharmacist'), 'the detailed profiles are kept in code');
});

test('mayWrite: staff may do every write, including signing, co-signing and the operations; the patient may not', () => {
  for (const id of STAFF) {
    for (const [type, interaction, opts] of [['MedicationRequest', 'create'], ['MedicationRequest', 'verify'], ['ServiceRequest', 'cosign'], ['Observation', 'transition', { signing: true, categories: ['laboratory'] }], ['DiagnosticReport', 'sign'], ['Location', 'create'], ['Observation', '$release'], ['Observation', '$acknowledge'], ['Claim', 'create']]) {
      assert.ok(mayWrite(id, type, interaction, opts), `${id}: ${interaction} ${type}`);
    }
    assert.equal(orderModeRequired(id, 'MedicationRequest'), false, `${id}: prescribes without a verbal-order detour`);
  }
  assert.ok(mayWrite('patient', 'Communication', 'create'));
  assert.ok(!mayWrite('patient', 'MedicationRequest', 'create') && !mayWrite('patient', 'Location', 'create') && !mayWrite('patient', 'Observation', '$release'));
  assert.ok(!mayWrite('nobody', 'Task', 'create'));
});

test(`[${BACKEND}] GET /auth/roles serves the roles; staff may write anywhere; the patient and unknown roles are refused and logged`, async () => {
  const s = await startTestServer();
  const { roles, apps } = (await s.call('GET', '/auth/roles')).json;
  assert.deepEqual(roles.map((r) => r.id), ['physician', 'nurse', 'researcher', 'patient', 'payer-medical-director', 'coder'], 'six roles');
  assert.deepEqual(apps, APPS);
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Fourroles'))).json;
  const med = { resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${p.id}` }, medicationCodeableConcept: { coding: [{ system: RX, code: '723', display: 'Amoxicillin' }] }, requester: { display: 'Dr Order' } };
  const DRUGS = { physician: ['723', 'Amoxicillin'], nurse: ['161', 'Acetaminophen'], researcher: ['5640', 'Ibuprofen'] };
  for (const id of STAFF) {
    const [code, display] = DRUGS[id];
    const r = await s.call('POST', '/fhir/R4/MedicationRequest', { ...med, medicationCodeableConcept: { coding: [{ system: RX, code, display }] } }, as(id));
    assert.equal(r.status, 201, `${id} prescribes: ${r.text}`);
    assert.equal((r.json.extension || []).some((e) => e.url === 'urn:hospital-desktop:pending-cosign'), false, `${id}: no co-signature needed`);
  }
  const study = await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, description: 'Chest X-ray' }, as('researcher'));
  assert.equal(study.status, 201, 'the researcher writes outside Agent Dashboard');
  const opened = await s.call('POST', `/api/pacs/studies/${study.json.id}/open`, {}, as('researcher', 'res-one'));
  assert.equal(opened.json.lock.by, 'res-one', 'the researcher takes the reading lock like any reader');
  const fresh = (code, display) => ({ ...med, medicationCodeableConcept: { coding: [{ system: RX, code, display }] } });
  const refused = await s.call('POST', '/fhir/R4/MedicationRequest', fresh('6809', 'Metformin'), as('patient'));
  assert.equal(refused.status, 403);
  assert.match(refused.json.issue[0].diagnostics, /A patient cannot prescribe/);
  const removed = await s.call('POST', '/fhir/R4/MedicationRequest', fresh('29046', 'Lisinopril'), as('pharmacist'));
  assert.equal(removed.status, 403);
  assert.match(removed.json.issue[0].diagnostics, /Unknown role "pharmacist". Known roles: physician, nurse, researcher, patient/);
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'role.refuse');
  assert.ok(steps.some((x) => x.did.args.role === 'patient') && steps.some((x) => x.did.args.role === 'pharmacist'), 'refusals are logged');
  await s.close();
});
