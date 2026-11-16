// ICH E2B(R3) adverse event export from surveillance reports (docs/STANDARDS.md): the ICSR carries the case,
// reporter, nameless patient, reaction with seriousness and outcome, the AI agent as suspect product, and the
// narrative; it reads back to the same fields. Synthetic and nameless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/helpers.mjs';
import { toIcsr, readIcsr } from '../standards/server/e2b.mjs';

test('E2B(R3) ICSR -> fields -> ICSR round trip', () => {
  const r = { caseId: 'AE-000001', filedAt: '2026-11-01T10:00:00Z', occurredAt: '2026-11-01T09:30:00Z', severity: 'life-threatening', harm: 'unsafe', narrative: 'The draft suggested a dose ten times too high; caught by the nurse.', reporterRole: 'nurse', agent: 'dose-helper', version: '3', sex: 'female', ageYears: 56.4 };
  const xml = toIcsr(r, { now: '2026-11-02T00:00:00Z' });
  assert.match(xml, /<MCCI_IN200100UV01 /); assert.match(xml, /PORR_IN049016UV/); assert.match(xml, /<name nullFlavor="MSK"\/>/);
  const back = readIcsr(xml);
  assert.deepEqual(back, { caseId: 'AE-000001', filedAt: '2026-11-01T10:00:00Z', occurredAt: '2026-11-01T09:30:00Z', severity: 'life-threatening', outcomeCode: '2', harm: 'unsafe', narrative: r.narrative, reporterQualification: '3', agent: 'dose-helper', version: '3', sex: 'female', ageYears: 56, patientName: 'MSK' });
  assert.equal(toIcsr({ ...r, ...back, reporterRole: 'nurse', ageYears: 56 }, { now: '2026-11-02T00:00:00Z' }), toIcsr({ ...r, ageYears: 56 }, { now: '2026-11-02T00:00:00Z' }));
});

test('a surveillance report exports as E2B(R3) for staff only, with the narrative optional', async () => {
  const s = await startTestServer();
  try {
    const D = { 'X-Role': 'physician', 'X-User-Id': 'physician-1' };
    const p = (await s.call('POST', '/fhir/R4/Patient', { resourceType: 'Patient', gender: 'male', birthDate: '1960-01-01' }, D)).json;
    const made = await s.call('POST', '/agent-ops/surveillance/reports', { narrative: 'The summary left out a known allergy.', reachedPatient: 'caught-before', severity: 'moderate', harm: 'omitted', patient: p.id }, D);
    assert.ok([200, 201].includes(made.status), made.text); const id = made.json.id;
    const r = await fetch(`${s.base}/agent-ops/surveillance/reports/${id}/e2b`, { headers: D });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /xml/);
    const back = readIcsr(await r.text());
    assert.equal(back.harm, 'omitted'); assert.equal(back.sex, 'male'); assert.equal(back.reporterQualification, '1'); assert.equal(back.patientName, 'MSK'); assert.match(back.narrative, /allergy/);
    assert.equal(readIcsr(await (await fetch(`${s.base}/agent-ops/surveillance/reports/${id}/e2b?narrative=false`, { headers: D })).text()).narrative, '');
    assert.equal((await fetch(`${s.base}/agent-ops/surveillance/reports/${id}/e2b`, { headers: { 'X-Role': 'patient', 'X-User-Id': 'pt-1' } })).status, 403);
  } finally { await s.close(); }
});
