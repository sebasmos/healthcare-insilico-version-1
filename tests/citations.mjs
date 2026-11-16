// The citation checker on seeded outputs: a cited record must exist,
// belong to the right patient, have been visible at that moment, and support the claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations, supports } from '../agent-operations/server/citations.mjs';

const records = {
  'Observation/k1': { resourceType: 'Observation', id: 'k1', _patient: 'Patient/p1', _recordedAt: '2025-03-01T08:00:00.000Z', code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, valueQuantity: { value: 6.9, unit: 'mmol/L' } },
  'Observation/k2': { resourceType: 'Observation', id: 'k2', _patient: 'Patient/p1', _recordedAt: '2025-03-01T12:00:00.000Z', code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: 'Potassium' }] }, valueQuantity: { value: 4.1, unit: 'mmol/L' } },
  'Observation/other': { resourceType: 'Observation', id: 'other', _patient: 'Patient/p2', _recordedAt: '2025-03-01T08:00:00.000Z', code: { coding: [{ code: '2823-3', display: 'Potassium' }] }, valueQuantity: { value: 6.9, unit: 'mmol/L' } },
  'AllergyIntolerance/a1': { resourceType: 'AllergyIntolerance', id: 'a1', patient: { reference: 'Patient/p1' }, _recordedAt: '2025-01-01T00:00:00.000Z', code: { coding: [{ code: '7984', display: 'Penicillin V' }], text: 'Penicillin V' } },
  'DocumentReference/n1': { resourceType: 'DocumentReference', id: 'n1', _patient: 'Patient/p1', _recordedAt: '2025-02-01T00:00:00.000Z', content: [{ attachment: { data: Buffer.from('Sudden severe headache on warfarin.').toString('base64') } }] },
  'PayerPolicy/pol-advanced-imaging': { resourceType: 'PayerPolicy', id: 'pol-advanced-imaging', criteriaText: 'Head CT is covered when there is a red-flag feature.' },
};
const read = async (ref) => records[ref] || null;
const ctx = { read, patientRef: 'Patient/p1', at: '2025-03-01T10:00:00.000Z', shared: ['PayerPolicy'] };

test('a claim with an exact value and code is valid only when the cited record carries both', async () => {
  assert.deepEqual(supports(records['Observation/k1'], { text: 'K 6.9', value: 6.9, code: '2823-3', unit: 'mmol/L' }), { ok: true, why: 'value matches' });
  assert.match(supports(records['Observation/k1'], { text: 'K 6.5', value: 6.5, code: '2823-3' }).why, /value is 6.9, not 6.5/);
  assert.match(supports(records['Observation/k1'], { text: 'Sodium 6.9', value: 6.9, code: '2951-2' }).why, /does not carry code 2951-2/);
  assert.match(supports(records['Observation/k1'], { text: 'K', value: 6.9, unit: 'mg/dL' }).why, /unit is mmol\/L/);
  assert.equal(supports(records['AllergyIntolerance/a1'], { text: 'Allergic to penicillin' }).ok, true);
  assert.equal(supports(records['AllergyIntolerance/a1'], { text: 'Allergic to latex' }).ok, false);
  assert.equal(supports(records['DocumentReference/n1'], { text: 'She takes warfarin' }).ok, true);
});

test('seeded outputs: uncited, invented, wrong patient, not yet visible and unsupported claims are each caught and named', async () => {
  const good = await checkCitations([{ text: 'Potassium is 6.9 mmol/L', cites: ['Observation/k1'], value: 6.9, code: '2823-3' }, { text: 'Allergic to penicillin', cites: ['AllergyIntolerance/a1'] }, { text: 'The policy covers head CT with a red-flag feature', cites: ['PayerPolicy/pol-advanced-imaging'] }], ctx);
  assert.deepEqual(good, { claims: 3, cited: 3, valid: 3, uncited: 0, score: 1, passed: true, problems: [] });
  const bad = await checkCitations([
    { text: 'Potassium is 6.9', cites: [] },
    { text: 'Creatinine is 3.2', cites: ['Observation/made-up'], value: 3.2 },
    { text: 'Potassium is 6.9', cites: ['Observation/other'], value: 6.9 },
    { text: 'Potassium is 4.1', cites: ['Observation/k2'], value: 4.1 },
    { text: 'Potassium is 5.0', cites: ['Observation/k1'], value: 5.0 },
    { text: 'Potassium is 6.9', cites: ['Observation/k1', 'DocumentReference/n1'], value: 6.9 },
    { text: 'Criterion 7 of the policy is met', cites: ['PayerPolicy/pol-made-up'] },
  ], ctx);
  assert.deepEqual([bad.claims, bad.cited, bad.valid, bad.uncited, bad.passed, bad.score], [7, 6, 1, 1, false, 0.143]);
  assert.deepEqual(bad.problems.map((p) => [p.claim, p.problem]), [[0, 'uncited'], [1, 'does-not-exist'], [2, 'wrong-patient'], [3, 'not-visible-yet'], [4, 'does-not-support'], [6, 'does-not-exist']], 'claim 5 is fine: one of its two records supports it');
  assert.match(bad.problems[3].detail, /after the claim/);
  assert.deepEqual(await checkCitations([], ctx), { claims: 0, cited: 0, valid: 0, uncited: 0, score: null, passed: false, problems: [] });
  assert.equal((await checkCitations([{ text: 'x', cites: ['not a ref'] }], ctx)).problems[0].problem, 'does-not-exist');
});
