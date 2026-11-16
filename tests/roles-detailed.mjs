// The role framework under the earlier detailed profiles (ROLE_MAP=detailed),
// kept so permissions can be added back: the permission map itself, server
// enforcement of writes per role, nurse-entered orders and co-signature,
// the read-only researcher, and unknown roles.
import './support/detailed-roles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, patient, lab, BACKEND } from './support/helpers.mjs';
import { ROLES, APPS, EHR_NAV, CHART_TABS, permissionFor, mayWrite, orderModeRequired, ORDER_MODE_URL, PENDING_COSIGN_URL, COSIGNED_BY_URL } from '../platform/server/roles.mjs';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const as = (role, user = `${role}-one`) => ({ 'X-Role': role, 'X-User-Id': user });
const extOf = (r, url) => (r.extension || []).find((e) => e.url === url);
const medication = (pid, extra = {}, [code, display] = ['723', 'Amoxicillin']) => ({
  resourceType: 'MedicationRequest', status: 'draft', intent: 'order', subject: { reference: `Patient/${pid}` },
  medicationCodeableConcept: { coding: [{ system: RX, code, display }] }, requester: { display: 'Dr Order' }, ...extra,
});
const order = (pid, extra = {}) => ({
  resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${pid}` },
  category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '24323-8', display: 'CMP' }] }, requester: { display: 'Dr Order' }, ...extra,
});
const note = (pid) => ({
  resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: `Patient/${pid}` },
  type: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }] }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('note').toString('base64') } }],
});
const mode = (value) => ({ extension: [{ url: ORDER_MODE_URL, valueCode: value }] });
const refusals = async (s) => (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps.filter((x) => x.did.type === 'role.refuse');

test('the map: every role has apps, landing, nav, chart tabs and writes; landing is in apps; app ids are known', () => {
  const ids = ROLES.map((r) => r.id);
  for (const expected of ['physician', 'nurse', 'pharmacist', 'radiologist', 'technologist', 'labtech', 'bedmanager', 'scheduler', 'billing', 'patient', 'researcher', 'administrator']) assert.ok(ids.includes(expected), expected);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const r of ROLES) {
    const p = permissionFor(r.id);
    assert.ok(r.label && p.apps.length && p.landing?.app && p.landing?.hash && Array.isArray(p.nav) && Array.isArray(p.chartTabs) && Array.isArray(p.readOnlyTabs), r.id);
    assert.ok(p.writes === '*' || typeof p.writes === 'object', r.id);
    assert.ok(p.apps.includes(p.landing.app), `${r.id}: landing app ${p.landing.app} must be in its apps`);
    for (const app of p.apps) assert.ok(APPS.includes(app), `${r.id}: unknown app ${app}`);
    for (const id of p.nav) assert.ok(EHR_NAV.includes(id), `${r.id}: unknown nav ${id}`);
    for (const id of p.chartTabs) assert.ok(CHART_TABS.includes(id), `${r.id}: unknown chart tab ${id}`);
    for (const id of p.readOnlyTabs) assert.ok(p.chartTabs.includes(id), `${r.id}: read-only tab ${id} must be a visible tab`);
  }
  assert.equal(permissionFor('nobody'), null);
  assert.deepEqual(permissionFor('nurse').chartTabs, ['summary', 'review', 'results', 'worklist', 'mar', 'flowsheets', 'io', 'notes', 'education', 'careplan', 'orders', 'ecg'], 'the nurse tab bar order from plan A.4, then the ECG tab from A.8');
  assert.deepEqual(permissionFor('physician').readOnlyTabs, ['mar', 'flowsheets', 'io']);
  assert.ok(permissionFor('researcher').readOnly && permissionFor('researcher').chartTabs.length === CHART_TABS.length);
  assert.equal(permissionFor('administrator').writes, '*');
});

test('mayWrite: interactions, signing by category, order mode and operations', () => {
  assert.ok(mayWrite('physician', 'MedicationRequest', 'create'));
  assert.ok(!mayWrite('nurse', 'MedicationRequest', 'create'), 'a nurse cannot prescribe outright');
  assert.ok(mayWrite('nurse', 'MedicationRequest', 'create', { orderMode: true }), 'but may enter a verbal order');
  assert.ok(orderModeRequired('nurse', 'ServiceRequest') && !orderModeRequired('physician', 'ServiceRequest'));
  assert.ok(mayWrite('nurse', 'Observation', 'create', { signing: true, categories: ['vital-signs'] }), 'vitals are recorded final');
  assert.ok(!mayWrite('nurse', 'Observation', 'transition', { signing: true, categories: ['laboratory'] }), 'a nurse does not sign lab results');
  assert.ok(mayWrite('labtech', 'Observation', 'transition', { signing: true, categories: ['laboratory'] }));
  assert.ok(mayWrite('physician', 'Observation', '$acknowledge') && mayWrite('nurse', 'Observation', '$acknowledge') && !mayWrite('nurse', 'Observation', '$release'));
  assert.ok(mayWrite('administrator', 'Anything', 'create') && !mayWrite('researcher', 'Task', 'create') && !mayWrite('nobody', 'Task', 'create'));
  assert.ok(mayWrite('physician', 'ServiceRequest', 'cosign') && !mayWrite('nurse', 'ServiceRequest', 'cosign'));
});

test(`[${BACKEND}] GET /auth/roles serves the expanded map, every app's built flag and the app list`, async () => {
  const s = await startTestServer();
  const { roles, built, apps } = (await s.call('GET', '/auth/roles')).json;
  assert.deepEqual(apps, APPS);
  for (const app of APPS) assert.equal(typeof built[app], 'boolean', app);
  const researcher = roles.find((r) => r.id === 'researcher');
  assert.ok(Array.isArray(researcher.nav) && Array.isArray(researcher.chartTabs), 'wildcards are expanded for the browser');
  assert.equal(roles.length, ROLES.length);
  await s.close();
});

test(`[${BACKEND}] one refused write per role, each answered 403 and logged as role.refuse with an AuditEvent of outcome 4`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Roles'))).json;
  const prelim = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 1.1))).json;
  const forbidden = {
    physician: ['POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` } }],
    nurse: ['POST', `/fhir/R4/Observation/${prelim.id}/$transition`, { to: 'final' }],
    pharmacist: ['POST', '/fhir/R4/MedicationRequest', medication(p.id)],
    radiologist: ['POST', '/fhir/R4/ServiceRequest', order(p.id)],
    technologist: ['POST', '/fhir/R4/DocumentReference', note(p.id)],
    labtech: ['POST', '/fhir/R4/MedicationRequest', medication(p.id)],
    bedmanager: ['POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, code: { text: 'Cough' } }],
    scheduler: ['POST', '/fhir/R4/ServiceRequest', order(p.id)],
    billing: ['POST', '/fhir/R4/DocumentReference', note(p.id)],
    patient: ['POST', '/fhir/R4/MedicationRequest', medication(p.id)],
    researcher: ['POST', '/fhir/R4/DocumentReference', note(p.id)],
  };
  for (const [role, [method, path, body]] of Object.entries(forbidden)) {
    const r = await s.call(method, path, body, as(role));
    assert.equal(r.status, 403, `${role}: ${r.text}`);
    assert.match(r.json.issue[0].diagnostics, /cannot/, role);
  }
  const admin = await s.call('POST', '/fhir/R4/DocumentReference', note(p.id), as('administrator'));
  assert.equal(admin.status, 201, 'the administrator may do everything a human may do');
  const steps = await refusals(s);
  assert.equal(steps.length, Object.keys(forbidden).length, 'one role.refuse step per refusal');
  for (const role of Object.keys(forbidden)) {
    const step = steps.find((x) => x.did.args.role === role);
    assert.ok(step, role);
    assert.equal(step.who.role, role);
    assert.ok(step.did.args.type && step.did.args.interaction && step.auditEvent, 'args carry type and interaction; an AuditEvent is linked');
    const audit = (await s.call('GET', `/fhir/R4/${step.auditEvent}`)).json;
    assert.equal(audit.outcome, '4');
  }
  // The refusal is not a record: nothing was written for the refused roles.
  assert.equal((await s.call('GET', `/fhir/R4/MedicationRequest?patient=${p.id}`)).json.total, 0);
  await s.close();
});

test(`[${BACKEND}] nurse-entered orders: mode required, pending co-signature set and protected, physician co-signs, nurse may not, safety alerts still fire`, async () => {
  const s = await startTestServer();
  const nurse = as('nurse', 'nurse-one');
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Cosign'))).json;
  const missing = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id), nurse);
  assert.equal(missing.status, 422, missing.text);
  assert.match(missing.json.issue[0].diagnostics, /verbal, telephone or protocol/);
  assert.equal((await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, mode('shouted')), nurse)).status, 422, 'an unknown mode is refused');

  const entered = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, mode('telephone')), nurse);
  assert.equal(entered.status, 201, entered.text);
  const med = entered.json;
  assert.equal(extOf(med, PENDING_COSIGN_URL).valueBoolean, true, 'the server adds the pending flag');
  assert.equal(extOf(med, ORDER_MODE_URL).valueCode, 'telephone');
  assert.equal(med.requester.display, 'Dr Order', 'the ordering physician is kept');
  // Every medication order goes through pharmacy: the nurse-entered order is sent to the verification queue at once.
  assert.equal((await s.call('POST', `/fhir/R4/MedicationRequest/${med.id}/$transition`, { to: 'pending-verification' })).status, 200, 'sent to pharmacy at once');

  // A plain update cannot clear the flag; only $cosign can.
  const current = (await s.call('GET', `/fhir/R4/MedicationRequest/${med.id}`)).json;
  const forged = await s.call('PUT', `/fhir/R4/MedicationRequest/${med.id}`, { ...current, extension: current.extension.filter((e) => e.url !== PENDING_COSIGN_URL) }, nurse);
  assert.equal(forged.status, 200);
  assert.equal(extOf(forged.json, PENDING_COSIGN_URL).valueBoolean, true, 'the flag is carried over');

  const byNurse = await s.call('POST', `/fhir/R4/MedicationRequest/${med.id}/$cosign`, {}, nurse);
  assert.equal(byNurse.status, 403);
  assert.match(byNurse.json.issue[0].diagnostics, /cannot co-sign/);
  const signed = await s.call('POST', `/fhir/R4/MedicationRequest/${med.id}/$cosign`, {}, as('physician', 'dr-order'));
  assert.equal(signed.status, 200, signed.text);
  assert.equal(extOf(signed.json, PENDING_COSIGN_URL).valueBoolean, false);
  assert.match(extOf(signed.json, COSIGNED_BY_URL).valueString, /^dr-order \(physician\) at 20/);
  assert.equal((await s.call('POST', `/fhir/R4/MedicationRequest/${med.id}/$cosign`, {}, as('physician'))).status, 409, 'co-signed once');
  const steps = (await s.call('GET', '/agent-ops/trace?runId=live')).json.steps;
  assert.ok(steps.some((x) => x.did.type === 'order.cosign' && x.who.id === 'dr-order'), 'order.cosign is logged');
  assert.ok(steps.some((x) => x.did.type === 'role.refuse' && x.did.args.interaction === 'cosign' && x.who.role === 'nurse'));

  // Safety alerts fire for the nurse exactly as for a physician: the allergy check runs before the role check.
  assert.equal((await s.call('POST', '/fhir/R4/AllergyIntolerance', { resourceType: 'AllergyIntolerance', patient: { reference: `Patient/${p.id}` }, clinicalStatus: { coding: [{ code: 'active' }] }, code: { coding: [{ system: RX, code: '7980', display: 'Penicillin' }] } })).status, 201);
  const conflict = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, mode('verbal'), ['7980', 'Penicillin V']), nurse);
  assert.equal(conflict.status, 409, conflict.text);
  assert.ok(conflict.json.issue.some((i) => i.details?.coding?.[0]?.code === 'allergy-conflict'), conflict.text);
  const noMode = await s.call('POST', '/fhir/R4/MedicationRequest', medication(p.id, {}, ['7980', 'Penicillin V']), nurse);
  assert.equal(noMode.status, 409, 'the safety alert comes first even when the mode is missing');
  assert.ok(noMode.json.issue.some((i) => i.details?.coding?.[0]?.code === 'allergy-conflict'), noMode.text);

  // A verbal lab order from the nurse waits for co-signature too, and a scheduler cannot enter one at all.
  const sr = await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, mode('protocol')), nurse);
  assert.equal(sr.status, 201, sr.text);
  assert.equal(extOf(sr.json, PENDING_COSIGN_URL).valueBoolean, true);
  // A different test, so the duplicate-order check (which runs first) does not answer before the role check.
  assert.equal((await s.call('POST', '/fhir/R4/ServiceRequest', order(p.id, { ...mode('protocol'), code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine' }] } }), as('scheduler'))).status, 403);
  assert.equal((await s.call('POST', `/fhir/R4/ServiceRequest/${sr.json.id}/$cosign`, {}, as('administrator'))).status, 200);
  assert.equal((await s.call('POST', `/fhir/R4/Patient/${p.id}/$cosign`, {}, as('physician'))).status, 405, 'only orders are co-signed');
  await s.close();
});

test(`[${BACKEND}] researcher is read-only, not blind; $release and $acknowledge are refused for roles that may not; unknown roles are refused with the known ids`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Readonly'))).json;
  const prelim = (await s.call('POST', '/fhir/R4/Observation', lab(p.id, 9.5))).json;
  const signed = await s.call('POST', `/fhir/R4/Observation/${prelim.id}/$transition`, { to: 'final' });
  assert.equal(signed.status, 200, signed.text);
  const critical = signed.json;
  const researcher = as('researcher', 'rae');
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}`, undefined, researcher)).status, 200);
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}/$everything`, undefined, researcher)).status, 200);
  assert.equal((await s.call('GET', '/api/pacs/worklist', undefined, researcher)).status, 200);
  const refused = await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, code: { text: 'Cough' } }, researcher);
  assert.equal(refused.status, 403);
  assert.match(refused.json.issue[0].diagnostics, /read-only outside Agent Dashboard/);
  assert.equal((await s.call('POST', '/api/advisories/respond', { id: 'flu-vaccine', choice: 'enact', patient: p.id }, researcher)).status, 403, 'helper routes that write records use the same map');
  assert.equal((await s.call('POST', '/api/advisories/respond', { id: 'flu-vaccine', choice: 'ignore', patient: p.id }, researcher)).status, 200, 'ignoring writes no record');

  assert.equal((await s.call('POST', `/fhir/R4/Observation/${critical.id}/$release`, { released: true }, as('nurse'))).status, 403, 'a nurse cannot release to the portal');
  assert.equal((await s.call('POST', `/fhir/R4/Observation/${critical.id}/$acknowledge`, {}, as('scheduler'))).status, 403, 'a scheduler cannot acknowledge a critical result');
  assert.equal((await s.call('POST', `/fhir/R4/Observation/${critical.id}/$acknowledge`, {}, as('nurse'))).status, 200, 'a nurse may acknowledge');
  assert.equal((await s.call('POST', `/fhir/R4/Observation/${critical.id}/$release`, { released: true }, as('physician'))).status, 200);

  const unknown = await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, code: { text: 'Cough' } }, as('janitor'));
  assert.equal(unknown.status, 403);
  assert.match(unknown.json.issue[0].diagnostics, /Unknown role "janitor". Known roles: physician, nurse, pharmacist/);
  assert.equal((await s.call('GET', `/fhir/R4/Patient/${p.id}`, undefined, as('janitor'))).status, 200, 'reads are never refused');
  const steps = await refusals(s);
  assert.ok(steps.some((x) => x.did.args.role === 'janitor' && x.did.args.unknown === true));
  assert.ok(steps.some((x) => x.did.args.role === 'researcher' && x.did.args.path === '/api/advisories/respond'), 'helper-route refusals are logged too');
  await s.close();
});

test(`[${BACKEND}] PACS: a read-only role opens a study without taking the reading lock; priority needs a role that may change studies`, async () => {
  const s = await startTestServer();
  const p = (await s.call('POST', '/fhir/R4/Patient', patient('Pacsroles'))).json;
  const study = (await s.call('POST', '/fhir/R4/ImagingStudy', { resourceType: 'ImagingStudy', status: 'available', subject: { reference: `Patient/${p.id}` }, description: 'Chest X-ray' }, as('technologist'))).json;
  const opened = await s.call('POST', `/api/pacs/studies/${study.id}/open`, {}, as('researcher'));
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json, { lock: null, readOnly: true });
  assert.equal((await s.call('GET', `/api/pacs/studies/${study.id}`)).json.study.lock, null, 'no lock was taken');
  assert.equal((await s.call('PUT', `/api/pacs/studies/${study.id}/priority`, { priority: 'stat' }, as('researcher'))).status, 403);
  assert.equal((await s.call('PUT', `/api/pacs/studies/${study.id}/priority`, { priority: 'stat' }, as('technologist'))).status, 200);
  const rad = await s.call('POST', `/api/pacs/studies/${study.id}/open`, {}, as('radiologist', 'dr-reader'));
  assert.equal(rad.json.lock.by, 'dr-reader');
  await s.close();
});
