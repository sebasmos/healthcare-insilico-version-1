// Finer ablation: one lab test, medications, and everything after a moment; a person in a masked session sees the
// same hidden chart as an ablated agent; the live chart is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, testClock } from './support/helpers.mjs';
import { validateOverlays, describeOverlay } from '../agent-operations/server/ablation.mjs';

test('new overlays validate and read in plain words', () => {
  const o = validateOverlays([{ type: 'hide', what: 'labs', code: '2524-7' }, { type: 'hide', what: 'meds' }, { type: 'hide', what: 'later', after: '2150-01-06T00:00:00Z' }]);
  assert.deepEqual(o.map(describeOverlay), ['Hidden: Lactate (2524-7) results', 'Hidden: medications (orders, administrations, dispenses)', 'Hidden: everything recorded after 2150-01-06 00:00']);
  assert.throws(() => validateOverlays([{ type: 'hide', what: 'later' }]), /needs "after"/);
});

test('a masked session for a person hides the chosen parts; the live chart keeps them', async () => {
  const s = await startTestServer({ clock: testClock('2026-03-01T09:00:00.000Z') });
  try {
    const pid = randomUUID(); const lab = (code, v, day) => ({ resourceType: 'Observation', id: randomUUID(), status: 'final', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code }] }, subject: { reference: `Patient/${pid}` }, effectiveDateTime: `2150-01-0${day}T08:00:00Z`, valueQuantity: { value: v } });
    await s.store.transaction(async (tx) => {
      await tx.save('Patient', { resourceType: 'Patient', id: pid, identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700201' }], gender: 'female', birthDate: '2090-01-01' }, { updatedBy: 'import' });
      for (const o of [lab('2524-7', 4.1, 2), lab('2823-3', 3.9, 2), lab('2823-3', 5.6, 8)]) await tx.save('Observation', o, { updatedBy: 'import' });
      await tx.save('MedicationRequest', { resourceType: 'MedicationRequest', id: randomUUID(), status: 'active', intent: 'order', subject: { reference: `Patient/${pid}` }, medicationCodeableConcept: { text: 'Drug' }, authoredOn: '2150-01-02T09:00:00Z' }, { updatedBy: 'import' });
    });
    const me = { 'X-Role': 'researcher', 'X-User-Id': 'researcher-1' };
    const out = await s.call('POST', '/agent-ops/ablation/mask', { patient: `Patient/${pid}`, overlays: [{ type: 'hide', what: 'labs', code: '2524-7' }, { type: 'hide', what: 'meds' }, { type: 'hide', what: 'later', after: '2150-01-05T00:00:00Z' }] }, me);
    assert.equal(out.status, 201, out.text);
    const inRun = { ...me, 'X-Run-Id': out.json.runId };
    const vals = async (type, hdr, branch) => ((await s.call('GET', `/fhir/R4/${type}?patient=${pid}${branch ? `&_branch=${branch}` : ''}`, undefined, hdr)).json.entry || []).map((e) => e.resource.valueQuantity?.value ?? e.resource.resourceType);
    assert.deepEqual(await vals('Observation', inRun, out.json.branch), [3.9], 'lactate hidden, the later potassium hidden, the early potassium shown');
    assert.deepEqual(await vals('MedicationRequest', inRun, out.json.branch), [], 'medications hidden');
    assert.equal((await vals('Observation', me)).length, 3, 'the live chart is unchanged');
    assert.equal((await vals('MedicationRequest', me)).length, 1);
  } finally { await s.close(); }
});
