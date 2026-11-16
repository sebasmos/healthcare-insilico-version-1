// Consent on every read path (docs/STANDARDS.md): a deny Consent stops reads and searches for research, agents,
// apps and outbound feeds, leaves direct care alone unless it names TREAT, and break-the-glass is logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { createConsent, purposeOf } from '../standards/server/consent.mjs';

const R = { 'X-Role': 'researcher', 'X-User-Id': 'res-1' };
const D = { 'X-Role': 'physician', 'X-User-Id': 'doc-1' };
const C = { 'X-Role': 'coder', 'X-User-Id': 'coder-1' };

test('purpose of use follows who is asking', () => {
  assert.equal(purposeOf({ actor: { kind: 'human', role: 'physician' } }), 'TREAT');
  assert.equal(purposeOf({ actor: { kind: 'agent', role: 'agent' } }), 'HRESCH');
  assert.equal(purposeOf({ actor: { kind: 'human', role: 'researcher' } }), 'HRESCH');
  assert.equal(purposeOf({ actor: { kind: 'human', role: 'physician' }, smart: { system: true } }), 'HOPERAT');
  assert.equal(purposeOf({ actor: { role: 'patient' } }), 'PATRQT');
});

test('a deny Consent blocks research, billing and summaries but not care; TREAT consent needs break-the-glass', async () => {
  const s = await startTestServer();
  try {
    const mk = async (b) => (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'female', birthDate: b }, R)).json;
    const p1 = await mk('1960-01-01'); const p2 = await mk('1970-01-01');
    for (const p of [p1, p2]) assert.equal((await s.call('POST', '/fhir/R4/Condition', { resourceType: 'Condition', subject: { reference: `Patient/${p.id}` }, code: { text: 'x' }, clinicalStatus: { coding: [{ code: 'active' }] } }, R)).status, 201);
    const consent = (await s.call('POST', '/fhir/R4/Consent', { resourceType: 'Consent', status: 'active', scope: { coding: [{ code: 'patient-privacy' }] }, category: [{ text: 'privacy' }], patient: { reference: `Patient/${p1.id}` }, provision: { type: 'deny' } }, R)).json;
    assert.ok(consent.id, JSON.stringify(consent));
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, R)).status, 403, 'research read is refused');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, C)).status, 403, 'operations read is refused');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, D)).status, 200, 'direct care still reads');
    assert.equal((await s.call('GET', `/fhir/R5/Patient/${p1.id}`, undefined, R)).status, 403, 'R5 too');
    const rows = (await s.call('GET', '/fhir/R4/Condition', undefined, R)).json.entry.map((e) => e.resource.subject.reference);
    assert.ok(rows.includes(`Patient/${p2.id}`) && !rows.includes(`Patient/${p1.id}`), 'search leaves the patient out');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}/$summary`, undefined, R)).status, 403, 'IPS summary is refused');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p2.id}/$summary`, undefined, R)).status, 200);
    const { _seq, ...c } = (await s.call('GET', `/fhir/R4/Consent/${consent.id}`, undefined, D)).json;
    assert.equal((await s.call('PUT', `/fhir/R4/Consent/${consent.id}`, { ...c, provision: { type: 'deny', purpose: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' }] } }, R)).status, 200);
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, D)).status, 403, 'a TREAT consent stops care reads');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, { ...D, 'X-Break-Glass': 'Unconscious in ED' })).status, 200, 'break the glass');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${p1.id}`, undefined, R)).status, 200, 'a TREAT-only consent no longer covers research');
    const checker = createConsent(s.store);
    assert.ok(await checker.blocked(p1.id, { actor: { role: 'physician' } }));
    assert.equal(await checker.blocked(p1.id, { actor: { role: 'patient', patientId: p1.id } }), null, 'the patient sees their own record');
  } finally { await s.close(); }
});
