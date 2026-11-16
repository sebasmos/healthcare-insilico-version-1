// Time machine: a practice copy cut at a moment in the patient's care shows the chart as it stood then, even for
// imported data whose recording time is the import day. What is written on the copy shows; the live chart is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, testClock } from './support/helpers.mjs';

test('rewind to a moment in care, write on the copy, the live chart is unchanged', async () => {
  const s = await startTestServer({ clock: testClock('2026-03-01T09:00:00.000Z') });
  try {
    const pid = randomUUID(); const obs = (day, v) => ({ resourceType: 'Observation', id: randomUUID(), status: 'final', code: { text: 'Heart rate' }, subject: { reference: `Patient/${pid}` }, effectiveDateTime: `2150-01-${day}T08:00:00Z`, valueQuantity: { value: v } });
    await s.store.transaction(async (tx) => {
      await tx.save('Patient', { resourceType: 'Patient', id: pid, identifier: [{ system: 'urn:hospital-desktop:mrn', value: 'N700101' }], gender: 'male', birthDate: '2090-02-10' }, { updatedBy: 'import' });
      for (const [d, v] of [['02', 70], ['05', 90], ['09', 120]]) await tx.save('Observation', obs(d, v), { updatedBy: 'import' });
    });
    const hdr = { 'X-Role': 'researcher', 'X-User-Id': 'researcher-1' };
    const made = await s.call('POST', '/agent-ops/branches', { parentBranch: 'main', kind: 'sandbox', careAt: '2150-01-06T00:00:00Z' }, hdr);
    assert.equal(made.status, 201, made.text); assert.equal(made.json.careCap, '2150-01-06T00:00:00.000Z');
    const on = (b) => s.call('GET', `/fhir/R4/Observation?patient=${pid}&_branch=${b}`, undefined, hdr).then((r) => (r.json.entry || []).map((e) => e.resource.valueQuantity.value).sort((a, b2) => a - b2));
    assert.deepEqual(await on(made.json.id), [70, 90], 'only what had happened by 6 January');
    assert.equal((await s.call('GET', `/fhir/R4/Patient/${pid}?_branch=${made.json.id}`, undefined, hdr)).status, 200, 'the patient (no clinical time) is there');
    const w = await s.call('POST', `/fhir/R4/Observation?_branch=${made.json.id}`, { ...obs('05', 0), id: undefined, effectiveDateTime: '2150-01-05T20:00:00Z', valueQuantity: { value: 95 } }, hdr);
    assert.ok([200, 201].includes(w.status), w.text);
    assert.deepEqual(await on(made.json.id), [70, 90, 95], 'a write on the copy shows there');
    assert.deepEqual(await on('main'), [70, 90, 120], 'the live chart is unchanged');
  } finally { await s.close(); }
});
